"""YouTube Shorts publisher (Data API v3 resumable upload).

Crash safety: the session URI is committed before any byte is sent. On the next run
we ask the session how many bytes it has (`Content-Range: bytes */<size>`): a finished
session answers with the video resource, a partial one with 308 + Range. If the
session is gone we scan the channel's recent uploads for the hidden tag
`ksv-<video_id>-<rev_no>` before uploading again, so one revision never becomes two videos.
"""
from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from ..clock import next_youtube_quota_reset
from ..config import Settings
from ..db import parse_iso
from ..models import PubState, Slot
from .common import (TIMEOUT, UPLOAD_TIMEOUT, VERIFY_RECHECK, BasePublisher, PublishError, alert, body_excerpt,
                     load_pub, platform_text, record_intent, record_result, verify_overdue, with_ai_disclosure,
                     with_hashtags)
from .oauth import AuthError, GoogleAuth

UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
API_URL = "https://www.googleapis.com/youtube/v3"
SCHEDULE_MIN_LEAD = timedelta(minutes=15)
VERIFY_GRACE = timedelta(minutes=5)
QUOTA_REASONS = frozenset({"quotaExceeded", "uploadLimitExceeded", "dailyLimitExceeded"})
MAX_TAG_CHARS = 500
_MAX_RESUMES = 5


def marker_tag(video_id: int, rev_no: int) -> str:
    return f"ksv-{video_id}-{rev_no}"


def fit_tags(tags: list[str], marker: str, limit: int = MAX_TAG_CHARS) -> list[str]:
    """Marker first; drop trailing tags past YouTube's 500-char budget
    (tags with spaces count their quotes, plus one comma between tags)."""
    out: list[str] = []
    used = -1
    for t in [marker, *(t for t in tags if t and t != marker)]:
        cost = len(t) + (2 if " " in t else 0) + 1
        if used + cost > limit:
            break
        out.append(t)
        used += cost
    return out


def rfc3339(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_metadata(text: dict, marker: str, *, publish_at: datetime | None, language: bool = True) -> dict:
    """videos.insert body. Every status field is explicit: the API default is PUBLIC."""
    title = (text.get("title") or "").strip()
    if not title:
        raise PublishError("YouTube title is empty", fatal=True)
    description = with_ai_disclosure(with_hashtags(text.get("description") or "", list(text.get("hashtags") or [])))
    snippet: dict[str, Any] = {
        "title": title, "description": description, "categoryId": "27",
        "tags": fit_tags(list(text.get("tags") or []), marker),
    }
    if language:
        snippet |= {"defaultLanguage": "mr", "defaultAudioLanguage": "mr"}
    status: dict[str, Any] = {
        "privacyStatus": "private" if publish_at else "public",
        "selfDeclaredMadeForKids": False,
        "containsSyntheticMedia": True,
    }
    if publish_at:
        status["publishAt"] = rfc3339(publish_at)
    return {"snippet": snippet, "status": status}


def _error_reason(resp: httpx.Response) -> str:
    try:
        errs = (resp.json().get("error") or {}).get("errors") or []
        return errs[0].get("reason", "") if errs else ""
    except (ValueError, AttributeError):
        return ""


class YouTubePublisher(BasePublisher):
    platform = "yt"

    def __init__(self, http: httpx.Client, auth: GoogleAuth, settings: Settings):
        self.http = http
        self.auth = auth
        self.settings = settings

    # ── HTTP ──────────────────────────────────────────────────────────────────

    def _call(self, method: str, url: str, *, headers: dict | None = None, timeout: Any = TIMEOUT,
              **kw: Any) -> httpx.Response:
        """One request with bearer auth; on 401 refresh the token once, then give up loudly."""
        for force in (False, True):
            try:
                token = self.auth.access_token(force=force)
            except AuthError as e:
                raise PublishError(f"YouTube auth: {e}", fatal=not e.transient) from e
            resp = self.http.request(method, url, headers={**(headers or {}), "Authorization": f"Bearer {token}"},
                                     timeout=timeout, **kw)
            if resp.status_code != 401:
                return resp
        raise PublishError("YouTube 401 after token refresh; run `ksm auth-youtube`", fatal=True)

    def _raise(self, resp: httpx.Response, what: str, now: datetime) -> None:
        reason = _error_reason(resp)
        msg = f"{what}: HTTP {resp.status_code} {reason or body_excerpt(resp)}"
        if reason in QUOTA_REASONS:
            raise PublishError(msg, retry_at=next_youtube_quota_reset(now), count=False)
        if resp.status_code == 429 or resp.status_code >= 500 or reason == "rateLimitExceeded":
            raise PublishError(msg)
        raise PublishError(msg, fatal=True)

    # ── Flow ──────────────────────────────────────────────────────────────────

    def planned_outcome(self, *, now: datetime, slot: Slot) -> tuple[PubState, datetime | None]:
        if slot.publish_at >= now + SCHEDULE_MIN_LEAD:
            return PubState.SCHEDULED, slot.publish_at
        return PubState.PUBLISHED, None

    def describe(self, pub_row: Any, revision_row: Any, *, now: datetime, slot: Slot) -> list[dict]:
        _, publish_at = self.planned_outcome(now=now, slot=slot)
        meta = build_metadata(platform_text(revision_row, "yt"),
                              marker_tag(pub_row["video_id"], revision_row["rev_no"]), publish_at=publish_at)
        return [
            {"method": "POST", "url": UPLOAD_URL, "params": {"uploadType": "resumable", "part": "snippet,status"},
             "json": meta},
            {"method": "PUT", "url": "<session uri>", "file": revision_row["master_path"]},
        ]

    def _advance(self, conn: sqlite3.Connection, row: sqlite3.Row, revision_row: Any, *,
                 now: datetime, slot: Slot) -> str:
        if row["remote_id"]:
            return self._verify(conn, row, now, slot)
        path = Path(revision_row["master_path"] or "")
        if not path.is_file():
            raise PublishError(f"master file missing: {path}", fatal=True)
        marker = marker_tag(row["video_id"], revision_row["rev_no"])

        if row["upload_session_uri"]:
            resource = self._resume(row["upload_session_uri"], path, now)
            if resource is None:  # session gone: did the upload finish before it died?
                resource = self._find_by_marker(marker, now)
                if resource is None:
                    record_intent(conn, row["id"], upload_session_uri=None)
            if resource is not None:
                return self._complete(conn, row["id"], resource, now)

        _, publish_at = self.planned_outcome(now=now, slot=slot)
        record_intent(conn, row["id"], state=PubState.UPLOADING, scheduled_for=publish_at)
        session = self._start_session(platform_text(revision_row, "yt"), marker, publish_at, path, now)
        record_intent(conn, row["id"], upload_session_uri=session)
        resource = self._send(session, path, 0, now)
        if resource is None:
            raise PublishError("YouTube upload session vanished right after creation")
        return self._complete(conn, row["id"], resource, now)

    def _start_session(self, text: dict, marker: str, publish_at: datetime | None, path: Path,
                       now: datetime) -> str:
        headers = {"X-Upload-Content-Length": str(path.stat().st_size), "X-Upload-Content-Type": "video/mp4"}
        params = {"uploadType": "resumable", "part": "snippet,status"}
        for language in (True, False):  # 'mr' as defaultLanguage may be rejected: retry once without
            body = build_metadata(text, marker, publish_at=publish_at, language=language)
            resp = self._call("POST", UPLOAD_URL, params=params, json=body, headers=headers)
            # Only a plain 400 can be the language fields; a 400 uploadLimitExceeded is a quota wait.
            if resp.status_code == 400 and language and _error_reason(resp) not in QUOTA_REASONS:
                continue
            if not resp.is_success:
                self._raise(resp, "videos.insert (session)", now)
            loc = resp.headers.get("Location")
            if not loc:
                raise PublishError("videos.insert returned no session Location")
            return loc
        raise AssertionError("unreachable")

    def _send(self, session: str, path: Path, start: int, now: datetime) -> dict | None:
        """PUT bytes from `start`; follows 308s. Returns the video resource, or None if the session is dead."""
        data = path.read_bytes()
        size = len(data)
        for _ in range(_MAX_RESUMES):
            headers = {"Content-Type": "video/mp4"}
            if start:
                headers["Content-Range"] = f"bytes {start}-{size - 1}/{size}"
            resp = self._call("PUT", session, content=data[start:], headers=headers, timeout=UPLOAD_TIMEOUT)
            if resp.status_code in (200, 201):
                return resp.json()
            if resp.status_code in (404, 410):
                return None
            if resp.status_code != 308:
                self._raise(resp, "upload PUT", now)
            start = _next_byte(resp)
        raise PublishError("YouTube upload did not complete after several resumes")

    def _resume(self, session: str, path: Path, now: datetime) -> dict | None:
        size = path.stat().st_size
        resp = self._call("PUT", session, content=b"", headers={"Content-Range": f"bytes */{size}"})
        if resp.status_code in (200, 201):
            return resp.json()
        if resp.status_code in (404, 410):
            return None
        if resp.status_code != 308:
            self._raise(resp, "upload status query", now)
        return self._send(session, path, _next_byte(resp), now)

    def _find_by_marker(self, marker: str, now: datetime) -> dict | None:
        """Scan the 50 most recent uploads for our hidden tag."""
        r = self._call("GET", f"{API_URL}/channels", params={"part": "contentDetails", "mine": "true"})
        if not r.is_success:
            self._raise(r, "channels.list", now)
        items = r.json().get("items") or []
        if not items:
            raise PublishError("channels.list mine=true returned no channel", fatal=True)
        uploads = items[0]["contentDetails"]["relatedPlaylists"]["uploads"]
        r = self._call("GET", f"{API_URL}/playlistItems",
                       params={"part": "contentDetails", "playlistId": uploads, "maxResults": 50})
        if not r.is_success:
            self._raise(r, "playlistItems.list", now)
        ids = [i["contentDetails"]["videoId"] for i in r.json().get("items") or []]
        if not ids:
            return None
        r = self._call("GET", f"{API_URL}/videos", params={"part": "snippet,status", "id": ",".join(ids)})
        if not r.is_success:
            self._raise(r, "videos.list", now)
        for v in r.json().get("items") or []:
            if marker in (v.get("snippet", {}).get("tags") or []):
                return v
        return None

    def _complete(self, conn: sqlite3.Connection, pub_id: int, resource: dict, now: datetime) -> str:
        vid = resource["id"]
        status = resource.get("status") or {}
        if status.get("privacyStatus") == "public":
            state = PubState.PUBLISHED
        elif status.get("publishAt"):
            state = PubState.SCHEDULED
        else:
            # Uploaded but neither public nor scheduled (e.g. locked private): keep the id, alert.
            state = PubState.UPLOADED
        fields: dict[str, Any] = {"state": state, "remote_id": vid,
                                  "permalink": f"https://www.youtube.com/shorts/{vid}"}
        if state is PubState.PUBLISHED:
            fields["published_at"] = now
        if status.get("publishAt"):
            fields["scheduled_for"] = parse_iso(status["publishAt"])
        record_result(conn, pub_id, **fields)
        if state is PubState.UPLOADED:
            alert(conn, load_pub(conn, pub_id), f"YouTube video {vid} uploaded but not public/scheduled: "
                                                 f"privacy={status.get('privacyStatus')}")
        return state.value

    def _verify(self, conn: sqlite3.Connection, row: sqlite3.Row, now: datetime, slot: Slot) -> str:
        """After the slot, read the video back; VERIFIED once it is public, FATAL (with alert)
        if it still is not VERIFY_GIVE_UP after it was due (e.g. locked private)."""
        state = row["state"]
        due_at = parse_iso(row["scheduled_for"])
        if state == PubState.SCHEDULED and due_at and now < due_at + VERIFY_GRACE:
            record_intent(conn, row["id"], next_attempt_at=due_at + VERIFY_GRACE)
            return state
        try:
            r = self._call("GET", f"{API_URL}/videos", params={"part": "status", "id": row["remote_id"]})
            if not r.is_success:
                self._raise(r, "videos.list (verify)", now)
        except (PublishError, httpx.TransportError) as e:
            if verify_overdue(row, now, slot):
                raise PublishError(f"YouTube video {row['remote_id']} could not be verified: {e}", fatal=True) from e
            record_intent(conn, row["id"], next_attempt_at=now + VERIFY_RECHECK)
            return state
        items = r.json().get("items") or []
        status = items[0].get("status", {}) if items else {}
        if not items or status.get("uploadStatus") in ("rejected", "failed", "deleted"):
            raise PublishError(f"YouTube video {row['remote_id']} missing or {status.get('uploadStatus')}: "
                               f"{status.get('rejectionReason') or status.get('failureReason') or ''}", fatal=True)
        if status.get("privacyStatus") == "public":
            record_result(conn, row["id"], state=PubState.VERIFIED, published_at=row["published_at"] or now)
            return PubState.VERIFIED.value
        if verify_overdue(row, now, slot):
            raise PublishError(f"YouTube video {row['remote_id']} still not public "
                               f"(privacy={status.get('privacyStatus')}); check it in YouTube Studio", fatal=True)
        new = PubState.SCHEDULED if status.get("publishAt") else PubState.UPLOADED
        if new == state:
            record_intent(conn, row["id"], next_attempt_at=now + VERIFY_RECHECK)
        else:
            record_result(conn, row["id"], state=new, next_attempt_at=now + VERIFY_RECHECK)
        return new.value


def _next_byte(resp: httpx.Response) -> int:
    m = re.match(r"bytes=0-(\d+)", resp.headers.get("Range", ""))
    return int(m.group(1)) + 1 if m else 0

