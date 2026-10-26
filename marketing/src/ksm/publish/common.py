"""Shared publishing machinery.

Every publisher follows "record intent -> external call -> record result": any id
that would let us find a half-finished remote object again (YouTube session URI,
Facebook video id, Instagram container id) is committed to `publications` BEFORE
the call that could create a second copy, so a crash or kill at any point is
recovered by the next `ensure()` instead of posting twice.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from typing import Any, Callable, Protocol

import httpx

from ..config import Settings
from ..db import iso, log_event, parse_iso, tx
from ..models import PubState, Slot

GRAPH_VERSION = "v26.0"
GRAPH_URL = f"https://graph.facebook.com/{GRAPH_VERSION}"
RUPLOAD_URL = "https://rupload.facebook.com"

TIMEOUT = httpx.Timeout(30.0, connect=10.0)
UPLOAD_TIMEOUT = httpx.Timeout(600.0, connect=10.0)

BACKOFF_S: tuple[int, ...] = (60, 300, 1800, 7200)   # 1m, 5m, 30m, 2h (then 2h)
MAX_ATTEMPTS = 6
VERIFY_RECHECK = timedelta(minutes=15)
# Stop polling a post that never reads back as public: FATAL + alert instead of polling forever
# (the remote id stays recorded, so the founder can check it by hand).
VERIFY_GIVE_UP = timedelta(hours=24)

AI_DISCLOSURE = "निवेदन: AI आवाज"

# States in which a publisher has nothing left to do.
FINAL_STATES = frozenset({PubState.VERIFIED, PubState.FATAL, PubState.SKIPPED, PubState.EXPIRED})
# The remote post is known to exist: a transient error must not regress these to RETRY, or the
# next run would re-enter the upload/finish path instead of just verifying.
REMOTE_CONFIRMED = frozenset({PubState.SCHEDULED, PubState.PUBLISHED, PubState.UPLOADED})

_COLUMNS = frozenset({
    "state", "upload_session_uri", "container_id", "container_created_at", "remote_id",
    "scheduled_for", "published_at", "permalink", "attempts", "next_attempt_at", "last_error",
})


class Publisher(Protocol):
    platform: str

    def ensure(self, conn: sqlite3.Connection, pub_row: Any, revision_row: Any, *,
               now: datetime, slot: Slot) -> str: ...


class PublishError(Exception):
    """A failure the publisher understood. fatal -> FATAL now; otherwise RETRY with backoff
    (or at retry_at). count=False for waits that should not burn the attempt budget (quota)."""

    def __init__(self, message: str, *, fatal: bool = False, retry_at: datetime | None = None,
                 alert: bool = False, count: bool = True):
        super().__init__(message)
        self.fatal = fatal
        self.retry_at = retry_at
        self.alert = alert or fatal
        self.count = count


# ── DB bookkeeping ────────────────────────────────────────────────────────────


def _db_value(v: Any) -> Any:
    if isinstance(v, datetime):
        return iso(v)
    if isinstance(v, Enum):
        return v.value
    return v


def _update(conn: sqlite3.Connection, pub_id: int, fields: dict[str, Any]) -> None:
    bad = set(fields) - _COLUMNS
    if bad:
        raise ValueError(f"not publication columns: {sorted(bad)}")
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    with tx(conn):
        conn.execute(f"UPDATE publications SET {sets} WHERE id = ?",
                     (*(_db_value(v) for v in fields.values()), pub_id))


def load_pub(conn: sqlite3.Connection, pub_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub_id,)).fetchone()
    if row is None:
        raise LookupError(f"publication {pub_id} not found")
    return row


def record_intent(conn: sqlite3.Connection, pub_id: int, **fields: Any) -> None:
    """Commit what we are about to do (and any id we must not lose) before the external call."""
    _update(conn, pub_id, fields)


def record_result(conn: sqlite3.Connection, pub_id: int, **fields: Any) -> None:
    """Commit the outcome of an external call. Clears the retry bookkeeping unless given."""
    fields.setdefault("last_error", None)
    fields.setdefault("next_attempt_at", None)
    with tx(conn):
        _update(conn, pub_id, fields)
        if "state" in fields:
            row = load_pub(conn, pub_id)
            log_event(conn, "publish_state", row["video_id"], platform=row["platform"], pub_id=pub_id,
                      state=_db_value(fields["state"]), remote_id=row["remote_id"])


def alert(conn: sqlite3.Connection, row: Any, message: str) -> None:
    """Telegram alerting picks up events of kind 'alert'."""
    log_event(conn, "alert", row["video_id"], source="publish", platform=row["platform"],
              pub_id=row["id"], message=message)


def is_due(row: Any, now: datetime) -> bool:
    nxt = parse_iso(row["next_attempt_at"])
    return nxt is None or nxt <= now


def fail(conn: sqlite3.Connection, pub_id: int, err: PublishError, now: datetime) -> str:
    """Turn an error into RETRY (with backoff) or FATAL after MAX_ATTEMPTS. A non-fatal error on a
    post that already exists remotely (REMOTE_CONFIRMED) keeps its state and only sets the backoff."""
    row = load_pub(conn, pub_id)
    attempts = row["attempts"] + (1 if err.count else 0)
    msg = str(err)[:500]
    if err.fatal or attempts >= MAX_ATTEMPTS:
        state, nxt = PubState.FATAL, None
    else:
        delay = BACKOFF_S[min(max(attempts - 1, 0), len(BACKOFF_S) - 1)]
        keep = row["state"] in REMOTE_CONFIRMED
        state = PubState(row["state"]) if keep else PubState.RETRY
        nxt = err.retry_at or now + timedelta(seconds=delay)
    with tx(conn):
        _update(conn, pub_id, {"state": state, "attempts": attempts, "next_attempt_at": nxt,
                               "last_error": msg})
        log_event(conn, "publish_error", row["video_id"], platform=row["platform"], pub_id=pub_id,
                  state=state.value, attempts=attempts, error=msg)
        if state is PubState.FATAL or err.alert:
            alert(conn, row, f"{row['platform']} publish {state.value}: {msg}")
    return state.value


def verify_overdue(row: Any, now: datetime, slot: Slot) -> bool:
    """True once a published/scheduled post has failed to verify for VERIFY_GIVE_UP past its due time."""
    due = parse_iso(row["scheduled_for"]) or parse_iso(row["published_at"]) or slot.publish_at
    return now > due + VERIFY_GIVE_UP


def count_events(conn: sqlite3.Connection, kind: str, **match: Any) -> int:
    where = " AND ".join(f"json_extract(json, '$.{k}') = ?" for k in match)
    sql = "SELECT COUNT(*) FROM events WHERE kind = ?" + (f" AND {where}" if where else "")
    return conn.execute(sql, (kind, *match.values())).fetchone()[0]


# ── HTTP helpers ──────────────────────────────────────────────────────────────


def body_excerpt(resp: httpx.Response, n: int = 300) -> str:
    try:
        return resp.text[:n]
    except Exception:  # noqa: BLE001 - binary/undecodable bodies
        return "<undecodable>"


def check_response(resp: httpx.Response, what: str) -> httpx.Response:
    """Generic mapping: 2xx ok; 429/5xx retry; any other status fatal."""
    if resp.is_success:
        return resp
    msg = f"{what}: HTTP {resp.status_code} {body_excerpt(resp)}"
    if resp.status_code == 429 or resp.status_code >= 500:
        raise PublishError(msg)
    raise PublishError(msg, fatal=True)


# ── Text composition ──────────────────────────────────────────────────────────


def platform_text(revision_row: Any, platform: str) -> dict:
    """The approved per-platform PlatformText dict from revisions.metadata_json."""
    meta = json.loads(revision_row["metadata_json"] or "{}")
    return dict(meta.get(platform) or {})


def with_hashtags(body: str, hashtags: list[str]) -> str:
    missing = [h if h.startswith("#") else f"#{h}" for h in hashtags]
    missing = [h for h in missing if h not in body]
    return f"{body.rstrip()}\n\n{' '.join(missing)}".strip() if missing else body.strip()


def with_ai_disclosure(body: str) -> str:
    """Every post discloses the AI narration; the writer normally includes it already."""
    return body if "AI आवाज" in body else f"{body.rstrip()}\n\n{AI_DISCLOSURE}".strip()


def caption_for(revision_row: Any, platform: str) -> str:
    t = platform_text(revision_row, platform)
    body = t.get("caption") or t.get("description") or ""
    return with_ai_disclosure(with_hashtags(body, list(t.get("hashtags") or [])))


# ── Meta (Graph API) session ──────────────────────────────────────────────────

_META_TOKEN_CODES = {102, 190}
_META_RETRY_CODES = {1, 2, 4, 17, 32, 341, 613, 9007, 80001, 80002}


def meta_error(resp: httpx.Response, what: str) -> PublishError:
    try:
        err = resp.json().get("error") or {}
    except ValueError:
        err = {}
    code, sub = err.get("code"), err.get("error_subcode")
    msg = f"{what}: HTTP {resp.status_code} code={code} sub={sub} {str(err.get('message', ''))[:200]}"
    if code in _META_TOKEN_CODES:
        return PublishError(msg + " (Meta token invalid: run `ksm secrets set meta`)", fatal=True)
    if err.get("is_transient") or code in _META_RETRY_CODES or resp.status_code == 429 or resp.status_code >= 500:
        return PublishError(msg)
    return PublishError(msg, fatal=True)


@dataclass(frozen=True)
class MetaIds:
    page_id: str
    page_token: str
    ig_user_id: str | None


class MetaSession:
    """System-user token -> Page token + linked IG user id, resolved once per process."""

    def __init__(self, http: httpx.Client, system_token: Callable[[], str], *,
                 page_id: str | None = None, ig_user_id: str | None = None):
        self.http = http
        self._system_token = system_token
        self._page_id = page_id
        self._ig_user_id = ig_user_id
        self._ids: MetaIds | None = None

    def system_token(self) -> str:
        return self._system_token()

    def ids(self) -> MetaIds:
        if self._ids is None:
            data = self.call("GET", "/me/accounts", token=self.system_token(),
                             params={"fields": "id,name,access_token,instagram_business_account"})
            pages = data.get("data") or []
            if self._page_id:
                pages = [p for p in pages if p.get("id") == self._page_id]
            if len(pages) != 1:
                raise PublishError(f"expected exactly one Facebook Page for the system user, got {len(pages)}; "
                                   "set meta.page_id in settings.yaml", fatal=True)
            p = pages[0]
            ig = self._ig_user_id or (p.get("instagram_business_account") or {}).get("id")
            self._ids = MetaIds(page_id=p["id"], page_token=p["access_token"], ig_user_id=ig)
        return self._ids

    def call(self, method: str, path: str, *, token: str, params: dict | None = None,
             data: dict | None = None, what: str | None = None) -> dict:
        # Token in the Authorization header, never the query string: httpx logs every request
        # URL at INFO and the daemon's root logger is INFO, so ?access_token= would land in ksm.log.
        resp = self.http.request(method, GRAPH_URL + path, params=params or None, data=data, timeout=TIMEOUT,
                                 headers={"Authorization": f"Bearer {token}"})
        if not resp.is_success:
            raise meta_error(resp, what or f"{method} {path}")
        return resp.json()

    def rupload(self, url: str, *, token: str, data: bytes, what: str) -> dict:
        resp = self.http.post(url, content=data, timeout=UPLOAD_TIMEOUT, headers={
            "Authorization": f"OAuth {token}", "offset": "0", "file_size": str(len(data)),
        })
        if not resp.is_success:
            raise meta_error(resp, what)
        return resp.json() if resp.content else {}


def meta_settings(settings: Settings) -> dict:
    return dict((settings.raw or {}).get("meta") or {})


# ── Base publisher + dry run ──────────────────────────────────────────────────


class BasePublisher:
    """ensure() = guard + error mapping; subclasses implement _advance() and describe()."""

    platform: str = ""

    def ensure(self, conn: sqlite3.Connection, pub_row: Any, revision_row: Any, *,
               now: datetime, slot: Slot) -> str:
        row = load_pub(conn, pub_row["id"])
        if row["state"] in FINAL_STATES or not is_due(row, now):
            return row["state"]
        try:
            return str(self._advance(conn, row, revision_row, now=now, slot=slot))
        except PublishError as e:
            return fail(conn, row["id"], e, now)
        except httpx.TransportError as e:
            return fail(conn, row["id"], PublishError(f"{self.platform} network error: {e!r}"), now)
        except (sqlite3.Error, AssertionError):
            raise  # our own DB is broken (recording would fail too) / a broken invariant
        except Exception as e:  # noqa: BLE001 - malformed API response (KeyError/ValueError/...)
            # Bounded: counts as an attempt, so a persistent oddity ends FATAL instead of
            # escaping every tick with no backoff.
            return fail(conn, row["id"], PublishError(f"{self.platform} unexpected {type(e).__name__}: {e}"), now)

    def _advance(self, conn: sqlite3.Connection, row: sqlite3.Row, revision_row: Any, *,
                 now: datetime, slot: Slot) -> str:
        raise NotImplementedError

    def describe(self, pub_row: Any, revision_row: Any, *, now: datetime, slot: Slot) -> list[dict]:
        """The requests ensure() would make, secrets omitted (used by dry-run)."""
        raise NotImplementedError

    def planned_outcome(self, *, now: datetime, slot: Slot) -> tuple[PubState, datetime | None]:
        """(state, scheduled_for) a successful run would reach right now."""
        raise NotImplementedError


class DryRunPublisher:
    """Logs the intended requests (events kind 'dry_run') and records the state a real run
    would reach, without touching the network or reading any secret."""

    def __init__(self, inner: BasePublisher):
        self.inner = inner
        self.platform = inner.platform

    def ensure(self, conn: sqlite3.Connection, pub_row: Any, revision_row: Any, *,
               now: datetime, slot: Slot) -> str:
        row = load_pub(conn, pub_row["id"])
        if row["state"] in FINAL_STATES | {PubState.SCHEDULED, PubState.PUBLISHED}:
            return row["state"]
        state, scheduled_for = self.inner.planned_outcome(now=now, slot=slot)
        if row["state"] == state:
            return state.value
        try:  # e.g. an empty YouTube title: fail the way a real run would, not every tick
            requests = self.inner.describe(row, revision_row, now=now, slot=slot)
        except PublishError as e:
            return fail(conn, row["id"], e, now)
        with tx(conn):
            log_event(conn, "dry_run", row["video_id"], platform=self.platform, pub_id=row["id"],
                      result=state.value, requests=requests)
            fields: dict[str, Any] = {"state": state, "scheduled_for": scheduled_for}
            if state is PubState.PUBLISHED:
                fields["published_at"] = now
            if state is PubState.PUBLISH_DUE:
                fields["next_attempt_at"] = slot.publish_at
            record_result(conn, row["id"], **fields)
        return state.value
