"""Instagram Reels publisher (Graph API via Facebook Login, resumable container upload).

Instagram has no scheduled publishing, so the container is prepared ahead (never more
than 20 h before the slot: containers expire after 24 h) and `media_publish` runs when
the slot is due and the Mac is awake.

Crash safety: the container id is committed before bytes go out and before
`media_publish`. Every run first asks the container for its status_code; PUBLISHED
means a previous run published it and we crashed before recording, so we look the
post up (caption + timestamp) instead of publishing again.
"""
from __future__ import annotations

import sqlite3
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from ..clock import in_quiet_hours
from ..config import Settings
from ..db import log_event, parse_iso
from ..models import PubState, Slot
from .common import (GRAPH_URL, GRAPH_VERSION, RUPLOAD_URL, VERIFY_RECHECK, BasePublisher, MetaSession,
                     PublishError, caption_for, count_events, load_pub, record_intent, record_result, verify_overdue)

CONTAINER_LEAD = timedelta(hours=20)      # earliest container creation before the slot
CONTAINER_MAX_AGE = timedelta(hours=23)   # Meta expires containers at 24 h; stay clear of it
STATUS_POLL = timedelta(minutes=1)        # Meta asks for at most one status poll per minute
QUIET_RECHECK = timedelta(minutes=15)
LIMIT_RECHECK = timedelta(hours=1)
MAX_CONTAINERS = 3                        # first + 2 recreations
RECOVERY_SKEW = timedelta(minutes=10)


def _norm(s: str | None) -> str:
    return " ".join(unicodedata.normalize("NFC", s or "").split())


class InstagramPublisher(BasePublisher):
    platform = "ig"

    def __init__(self, http: httpx.Client, meta: MetaSession, settings: Settings):
        self.http = http
        self.meta = meta
        self.settings = settings

    # ── Planning / dry run ────────────────────────────────────────────────────

    def planned_outcome(self, *, now: datetime, slot: Slot) -> tuple[PubState, datetime | None]:
        if now > slot.late_until:
            return PubState.EXPIRED, None
        if now < slot.publish_at or in_quiet_hours(now, self.settings.quiet_hours):
            return PubState.PUBLISH_DUE, None
        return PubState.PUBLISHED, None

    def _container_params(self, revision_row: Any) -> dict:
        return {"media_type": "REELS", "upload_type": "resumable", "caption": caption_for(revision_row, "ig"),
                "share_to_feed": "true", "is_ai_generated": "true"}

    def describe(self, pub_row: Any, revision_row: Any, *, now: datetime, slot: Slot) -> list[dict]:
        return [
            {"method": "POST", "url": f"{GRAPH_URL}/<ig-user-id>/media", "data": self._container_params(revision_row),
             "not_before": (slot.publish_at - CONTAINER_LEAD).isoformat()},
            {"method": "POST", "url": f"{RUPLOAD_URL}/ig-api-upload/{GRAPH_VERSION}/<container-id>",
             "file": revision_row["master_path"]},
            {"method": "GET", "url": f"{GRAPH_URL}/<container-id>", "params": {"fields": "status_code"}},
            {"method": "GET", "url": f"{GRAPH_URL}/<ig-user-id>/content_publishing_limit"},
            {"method": "POST", "url": f"{GRAPH_URL}/<ig-user-id>/media_publish",
             "data": {"creation_id": "<container-id>"}, "not_before": slot.publish_at.isoformat(),
             "not_after": slot.late_until.isoformat()},
        ]

    # ── Flow ──────────────────────────────────────────────────────────────────

    def _advance(self, conn: sqlite3.Connection, row: sqlite3.Row, revision_row: Any, *,
                 now: datetime, slot: Slot) -> str:
        ids = self.meta.ids()
        if not ids.ig_user_id:
            raise PublishError("no Instagram business account linked to the Facebook Page", fatal=True)
        token = self.meta.system_token()
        if row["remote_id"]:
            return self._verify(conn, row, token, now, slot)

        cid = row["container_id"]
        created = parse_iso(row["container_created_at"])
        if cid and created and now - created > CONTAINER_MAX_AGE:
            code = self._status_code(cid, token)
            if code == "PUBLISHED":
                return self._recover(conn, row, ids.ig_user_id, token, revision_row, now)
            cid = None  # too old to trust: start a fresh container
        if not cid:
            if now > slot.late_until:
                return self._expire(conn, row["id"], "Instagram cut-off passed before a container was ready")
            if now < slot.publish_at - CONTAINER_LEAD:
                record_intent(conn, row["id"], state=PubState.PENDING,
                              next_attempt_at=slot.publish_at - CONTAINER_LEAD)
                return PubState.PENDING.value
            cid = self._create_container(conn, row, ids.ig_user_id, token, revision_row, now)

        if not count_events(conn, "ig_uploaded", pub_id=row["id"], container_id=cid):
            path = Path(revision_row["master_path"] or "")
            if not path.is_file():
                raise PublishError(f"master file missing: {path}", fatal=True)
            try:
                self.meta.rupload(f"{RUPLOAD_URL}/ig-api-upload/{GRAPH_VERSION}/{cid}", token=token,
                                  data=path.read_bytes(), what="ig rupload")
            except PublishError:
                # A crash between upload and bookkeeping makes us re-send; if Meta refuses
                # because it already has the bytes, the container status says so.
                if self._status_code(cid, token) not in ("FINISHED", "PUBLISHED"):
                    raise
            log_event(conn, "ig_uploaded", row["video_id"], pub_id=row["id"], container_id=cid)

        code = self._status_code(cid, token)
        if code == "PUBLISHED":
            return self._recover(conn, row, ids.ig_user_id, token, revision_row, now)
        if code in ("ERROR", "EXPIRED"):
            if count_events(conn, "ig_container", pub_id=row["id"]) >= MAX_CONTAINERS:
                raise PublishError(f"Instagram container {cid} {code} after {MAX_CONTAINERS} containers", fatal=True)
            record_intent(conn, row["id"], container_id=None, container_created_at=None,
                          last_error=f"container {cid} {code}; recreating")
            return self._advance(conn, load_pub(conn, row["id"]), revision_row, now=now, slot=slot)
        if code != "FINISHED":  # IN_PROGRESS
            record_intent(conn, row["id"], state=PubState.UPLOADING, next_attempt_at=now + STATUS_POLL)
            return PubState.UPLOADING.value
        return self._publish_when_due(conn, row, ids.ig_user_id, token, cid, revision_row, now, slot)

    def _create_container(self, conn: sqlite3.Connection, row: sqlite3.Row, ig_user: str, token: str,
                          revision_row: Any, now: datetime) -> str:
        if count_events(conn, "ig_container", pub_id=row["id"]) >= MAX_CONTAINERS:
            raise PublishError(f"Instagram: {MAX_CONTAINERS} containers already used", fatal=True)
        record_intent(conn, row["id"], state=PubState.UPLOADING)
        res = self.meta.call("POST", f"/{ig_user}/media", token=token, data=self._container_params(revision_row),
                             what="ig create container")
        cid = str(res["id"])
        record_intent(conn, row["id"], container_id=cid, container_created_at=now)
        log_event(conn, "ig_container", row["video_id"], pub_id=row["id"], container_id=cid)
        return cid

    def _status_code(self, cid: str, token: str) -> str:
        return str(self.meta.call("GET", f"/{cid}", token=token, params={"fields": "status_code,status"},
                                  what="ig container status").get("status_code") or "")

    def _publish_when_due(self, conn: sqlite3.Connection, row: sqlite3.Row, ig_user: str, token: str, cid: str,
                          revision_row: Any, now: datetime, slot: Slot) -> str:
        if now < slot.publish_at:
            record_intent(conn, row["id"], state=PubState.PUBLISH_DUE, next_attempt_at=slot.publish_at)
            return PubState.PUBLISH_DUE.value
        if now > slot.late_until:
            return self._expire(conn, row["id"], "Instagram cut-off passed before publishing")
        if in_quiet_hours(now, self.settings.quiet_hours):
            record_intent(conn, row["id"], state=PubState.PUBLISH_DUE, next_attempt_at=now + QUIET_RECHECK)
            return PubState.PUBLISH_DUE.value

        lim = self.meta.call("GET", f"/{ig_user}/content_publishing_limit", token=token,
                             params={"fields": "config,quota_usage"}, what="ig publishing limit")
        data = (lim.get("data") or [{}])[0]
        total = (data.get("config") or {}).get("quota_total")
        if total is not None and int(data.get("quota_usage") or 0) >= int(total):
            raise PublishError(f"Instagram publishing limit reached ({data.get('quota_usage')}/{total})",
                               retry_at=now + LIMIT_RECHECK, count=False)

        record_intent(conn, row["id"], state=PubState.PUBLISH_DUE)
        try:
            res = self.meta.call("POST", f"/{ig_user}/media_publish", token=token, data={"creation_id": cid},
                                 what="ig media_publish")
        except PublishError:
            # A previous publish whose response was lost may not have shown up in status_code yet;
            # Meta then refuses this one. Never treat that as FATAL: find the post instead.
            if self._status_code(cid, token) == "PUBLISHED":
                return self._recover(conn, load_pub(conn, row["id"]), ig_user, token, revision_row, now)
            raise
        record_result(conn, row["id"], state=PubState.PUBLISHED, remote_id=str(res["id"]), published_at=now)
        return self._fetch_permalink(conn, row["id"], str(res["id"]), token, now)

    def _recover(self, conn: sqlite3.Connection, row: sqlite3.Row, ig_user: str, token: str,
                 revision_row: Any, now: datetime) -> str:
        """Container says PUBLISHED but we never recorded the media id: find it, never re-publish."""
        res = self.meta.call("GET", f"/{ig_user}/media", token=token,
                             params={"fields": "id,caption,timestamp,permalink", "limit": "25"}, what="ig media list")
        want = _norm(caption_for(revision_row, "ig"))
        since = (parse_iso(row["container_created_at"]) or now) - RECOVERY_SKEW
        for m in res.get("data") or []:
            ts = _parse_ig_ts(m.get("timestamp"))
            if _norm(m.get("caption")) == want and (ts is None or ts >= since):
                state = PubState.VERIFIED if m.get("permalink") else PubState.PUBLISHED
                record_result(conn, row["id"], state=state, remote_id=str(m["id"]),
                              published_at=ts or now, permalink=m.get("permalink"))
                return state.value
        raise PublishError(f"container {row['container_id']} is PUBLISHED but the post was not found yet")

    def _fetch_permalink(self, conn: sqlite3.Connection, pub_id: int, media_id: str, token: str,
                         now: datetime) -> str:
        try:
            link = self.meta.call("GET", f"/{media_id}", token=token, params={"fields": "permalink"},
                                  what="ig permalink").get("permalink")
        except (PublishError, httpx.TransportError):
            record_intent(conn, pub_id, next_attempt_at=now + VERIFY_RECHECK)
            return PubState.PUBLISHED.value
        record_result(conn, pub_id, state=PubState.VERIFIED, permalink=link)
        return PubState.VERIFIED.value

    def _verify(self, conn: sqlite3.Connection, row: sqlite3.Row, token: str, now: datetime, slot: Slot) -> str:
        state = self._fetch_permalink(conn, row["id"], row["remote_id"], token, now)
        if state != PubState.VERIFIED and verify_overdue(row, now, slot):
            raise PublishError(f"Instagram post {row['remote_id']} could not be read back for 24 h; "
                               "check it in the Instagram app", fatal=True)
        return state

    def _expire(self, conn: sqlite3.Connection, pub_id: int, why: str) -> str:
        record_result(conn, pub_id, state=PubState.EXPIRED, last_error=why)
        return PubState.EXPIRED.value


def _parse_ig_ts(s: str | None) -> datetime | None:
    """IG timestamps look like '2026-10-17T01:30:05+0000'."""
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S%z")
    except ValueError:
        return parse_iso(s)
