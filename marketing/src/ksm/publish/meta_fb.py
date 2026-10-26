"""Facebook Page Reels publisher (Graph API video_reels, pinned v26.0).

Crash safety: the video_id from upload_phase=start is committed before any bytes go
out. One video_id can become at most one Reel, so every later run reuses it:
re-sending bytes or re-checking status can never create a second post, and the
video's publishing_phase tells us whether `finish` already ran.
"""
from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

from ..config import Settings
from ..db import parse_iso
from ..models import PubState, Slot
from .common import (GRAPH_URL, GRAPH_VERSION, RUPLOAD_URL, VERIFY_RECHECK, BasePublisher, MetaSession,
                     PublishError, caption_for, meta_settings, record_intent, record_result, verify_overdue)

# Meta requires scheduled_publish_time > 10 min ahead; one extra minute absorbs clock/latency skew.
SCHEDULE_MIN_LEAD = timedelta(minutes=11)
SCHEDULE_MAX_LEAD = timedelta(days=29)
VERIFY_GRACE = timedelta(minutes=5)
UPLOAD_POLL = timedelta(minutes=1)
VERIFY_GIVE_UP_TEXT = "24 h after its slot; check it in Meta Business Suite"


def _phase(status: dict, name: str) -> str:
    return str((status.get(name) or {}).get("status") or "")


def finish_already_ran(status: dict) -> bool:
    """True once `finish` has been accepted. A scheduled Reel may still report
    publishing_phase.status 'not_started', so publish_status is checked as well."""
    pub = status.get("publishing_phase") or {}
    return (pub.get("status") not in (None, "", "not_started")
            or pub.get("publish_status") in ("scheduled", "published")
            or status.get("video_status") == "scheduled")


class FacebookPublisher(BasePublisher):
    platform = "fb"

    def __init__(self, http: httpx.Client, meta: MetaSession, settings: Settings):
        self.http = http
        self.meta = meta
        self.settings = settings

    @property
    def ai_flag(self) -> bool:
        """Only sent once the day-0 test shows Facebook accepts it."""
        return bool(meta_settings(self.settings).get("fb_ai_flag_supported"))

    def planned_outcome(self, *, now: datetime, slot: Slot) -> tuple[PubState, datetime | None]:
        lead = slot.publish_at - now
        if SCHEDULE_MIN_LEAD <= lead <= SCHEDULE_MAX_LEAD:
            return PubState.SCHEDULED, slot.publish_at
        return PubState.PUBLISHED, None

    def _finish_params(self, video_id: str, revision_row: Any, now: datetime, slot: Slot) -> dict:
        state, when = self.planned_outcome(now=now, slot=slot)
        data: dict[str, Any] = {"upload_phase": "finish", "video_id": video_id,
                                "description": caption_for(revision_row, "fb")}
        if state is PubState.SCHEDULED and when is not None:
            data |= {"video_state": "SCHEDULED", "scheduled_publish_time": str(int(when.timestamp()))}
        else:
            data["video_state"] = "PUBLISHED"
        if self.ai_flag:
            data["is_ai_generated"] = "true"
        return data

    def describe(self, pub_row: Any, revision_row: Any, *, now: datetime, slot: Slot) -> list[dict]:
        return [
            {"method": "POST", "url": f"{GRAPH_URL}/<page-id>/video_reels", "data": {"upload_phase": "start"}},
            {"method": "POST", "url": f"{RUPLOAD_URL}/video-upload/{GRAPH_VERSION}/<video-id>",
             "file": revision_row["master_path"]},
            {"method": "GET", "url": f"{GRAPH_URL}/<video-id>", "params": {"fields": "status"}},
            {"method": "POST", "url": f"{GRAPH_URL}/<page-id>/video_reels",
             "data": self._finish_params("<video-id>", revision_row, now, slot)},
        ]

    def _status(self, video_id: str, token: str) -> dict:
        return self.meta.call("GET", f"/{video_id}", token=token, params={"fields": "status"},
                              what="video status").get("status") or {}

    def _advance(self, conn: sqlite3.Connection, row: sqlite3.Row, revision_row: Any, *,
                 now: datetime, slot: Slot) -> str:
        ids = self.meta.ids()
        token = ids.page_token
        if row["state"] in (PubState.SCHEDULED, PubState.PUBLISHED, PubState.UPLOADED) and row["remote_id"]:
            return self._verify(conn, row, token, now, slot)

        video_id = row["container_id"]
        if not video_id:
            record_intent(conn, row["id"], state=PubState.UPLOADING)
            started = self.meta.call("POST", f"/{ids.page_id}/video_reels", token=token,
                                     data={"upload_phase": "start"}, what="video_reels start")
            video_id = str(started["video_id"])
            record_intent(conn, row["id"], container_id=video_id, container_created_at=now)

        status = self._status(video_id, token)
        if finish_already_ran(status):
            return self._finished(conn, row["id"], video_id, status, now, slot)
        if "error" in (_phase(status, "uploading_phase"), _phase(status, "processing_phase")):
            raise PublishError(f"Facebook video {video_id} failed: {status}", fatal=True)

        if _phase(status, "uploading_phase") != "complete":
            path = Path(revision_row["master_path"] or "")
            if not path.is_file():
                raise PublishError(f"master file missing: {path}", fatal=True)
            self.meta.rupload(f"{RUPLOAD_URL}/video-upload/{GRAPH_VERSION}/{video_id}", token=token,
                              data=path.read_bytes(), what="fb rupload")
            status = self._status(video_id, token)
            if _phase(status, "uploading_phase") != "complete":
                record_intent(conn, row["id"], state=PubState.UPLOADING, next_attempt_at=now + UPLOAD_POLL)
                return PubState.UPLOADING.value

        if slot.publish_at - now > SCHEDULE_MAX_LEAD:
            # Beyond Meta's scheduling window: wait (bytes stay uploaded) rather than publish early.
            record_intent(conn, row["id"], state=PubState.UPLOADING,
                          next_attempt_at=slot.publish_at - SCHEDULE_MAX_LEAD)
            return PubState.UPLOADING.value
        state, when = self.planned_outcome(now=now, slot=slot)
        # remote_id = video_id from here on: the Reel's id is the video id.
        record_intent(conn, row["id"], remote_id=video_id, scheduled_for=when)
        self.meta.call("POST", f"/{ids.page_id}/video_reels", token=token,
                       data=self._finish_params(video_id, revision_row, now, slot), what="video_reels finish")
        fields: dict[str, Any] = {"state": state, "remote_id": video_id, "scheduled_for": when}
        if state is PubState.PUBLISHED:
            fields["published_at"] = now
        record_result(conn, row["id"], **fields)
        self._permalink(conn, row["id"], video_id, token)
        return state.value

    def _finished(self, conn: sqlite3.Connection, pub_id: int, video_id: str, status: dict,
                  now: datetime, slot: Slot) -> str:
        """`finish` already ran (we crashed before recording it): adopt what Facebook says."""
        pub = status.get("publishing_phase") or {}
        published = pub.get("status") == "complete" and pub.get("publish_status") != "scheduled"
        state = PubState.PUBLISHED if published or slot.publish_at <= now else PubState.SCHEDULED
        fields: dict[str, Any] = {"state": state, "remote_id": video_id}
        if state is PubState.SCHEDULED:
            fields["scheduled_for"] = slot.publish_at
        else:
            fields["published_at"] = now
        record_result(conn, pub_id, **fields)
        return state.value

    def _permalink(self, conn: sqlite3.Connection, pub_id: int, video_id: str, token: str) -> None:
        try:
            link = self.meta.call("GET", f"/{video_id}", token=token, params={"fields": "permalink_url"},
                                  what="permalink").get("permalink_url")
        except (PublishError, httpx.TransportError):
            return  # cosmetic; retried by _verify
        if link:
            record_intent(conn, pub_id, permalink=f"https://www.facebook.com{link}" if link.startswith("/") else link)

    def _verify(self, conn: sqlite3.Connection, row: sqlite3.Row, token: str, now: datetime, slot: Slot) -> str:
        due_at = parse_iso(row["scheduled_for"])
        if row["state"] == PubState.SCHEDULED and due_at and now < due_at + VERIFY_GRACE:
            record_intent(conn, row["id"], next_attempt_at=due_at + VERIFY_GRACE)
            return row["state"]
        try:
            status = self._status(row["remote_id"], token)
        except (PublishError, httpx.TransportError) as e:
            if verify_overdue(row, now, slot):
                raise PublishError(f"Facebook Reel {row['remote_id']} could not be verified: {e}", fatal=True) from e
            record_intent(conn, row["id"], next_attempt_at=now + VERIFY_RECHECK)
            return row["state"]
        if "error" in (_phase(status, "processing_phase"), _phase(status, "publishing_phase")):
            raise PublishError(f"Facebook Reel {row['remote_id']} failed: {status}", fatal=True)
        if _phase(status, "publishing_phase") == "complete" and status.get("video_status") in ("ready", None):
            if not row["permalink"]:
                self._permalink(conn, row["id"], row["remote_id"], token)
            record_result(conn, row["id"], state=PubState.VERIFIED, published_at=row["published_at"] or now)
            return PubState.VERIFIED.value
        if verify_overdue(row, now, slot):
            raise PublishError(f"Facebook Reel {row['remote_id']} not live {VERIFY_GIVE_UP_TEXT}: {status}", fatal=True)
        record_intent(conn, row["id"], next_attempt_at=now + VERIFY_RECHECK)
        return row["state"]
