"""Stateful fake YouTube / Graph API servers (respx) and DB builders for test_publish_*.

Each fake counts every external call and can be armed to "crash" right after the
N-th call has been processed server-side: either a hard process death (Crash, a
BaseException nothing in ksm catches) or a lost response (httpx.ReadTimeout).
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs

import httpx

from ksm.clock import build_slot
from ksm.config import _settings_from_dict, load_yaml
from ksm.db import iso, open_db, parse_iso
from ksm.models import Slot
from ksm.paths import REPO_MARKETING_DIR
from ksm.publish.common import load_pub

T0 = datetime(2026, 10, 16, 12, 0, tzinfo=timezone.utc)   # 17:30 IST, day before the morning slot
MASTER_BYTES = b"\x00\x00\x00\x18ftypmp42" + bytes(range(256)) * 40


class Crash(BaseException):
    """Simulated kill -9 right after a call reached the server."""


def make_settings(**over: Any):
    d = load_yaml("settings.yaml", REPO_MARKETING_DIR / "config")
    d = {**d, "dry_run": False, "platforms": ["yt", "fb", "ig"], **over}
    return _settings_from_dict(d)


def morning_slot(settings) -> Slot:
    """2026-10-17 07:00 IST = 01:30 UTC; late_until 10:00 IST."""
    return build_slot(date(2026, 10, 17), settings.slots[0])


METADATA = {
    "yt": {"title": "सोयाबीन भाव लातूर | Soybean mandi price", "description": "आजचे बाजारभाव.\nAI आवाज",
           "hashtags": ["#सोयाबीन", "#बाजारभाव", "#Shorts"], "tags": ["soybean", "mandi bhav", "सोयाबीन"]},
    "ig": {"caption": "लातूर सोयाबीन ₹४,८९२. स्रोत: Agmarknet", "hashtags": ["#सोयाबीन", "#बाजारभाव"]},
    "fb": {"caption": "लातूर सोयाबीन ₹४,८९२. स्रोत: Agmarknet", "hashtags": ["#सोयाबीन"]},
}


def make_db(tmp_path: Path, platforms=("yt", "fb", "ig")):
    conn = open_db(tmp_path / "ksm.db")
    master = tmp_path / "master.mp4"
    master.write_bytes(MASTER_BYTES)
    ts = iso(T0)
    conn.execute("INSERT INTO videos(series, topic_key, data_date, state, created_at, updated_at) "
                 "VALUES ('mandi', 'soybean', '2026-10-15', 'PUBLISHING', ?, ?)", (ts, ts))
    vid = conn.execute("SELECT max(id) FROM videos").fetchone()[0]
    conn.execute("INSERT INTO revisions(video_id, rev_no, script_json, metadata_json, master_path, created_at) "
                 "VALUES (?, 1, '{}', ?, ?, ?)", (vid, json.dumps(METADATA, ensure_ascii=False), str(master), ts))
    rev = conn.execute("SELECT * FROM revisions WHERE video_id = ?", (vid,)).fetchone()
    pubs = {}
    for p in platforms:
        conn.execute("INSERT INTO publications(video_id, revision_id, platform, state) VALUES (?, ?, ?, 'PENDING')",
                     (vid, rev["id"], p))
        pubs[p] = conn.execute("SELECT id FROM publications WHERE video_id = ? AND platform = ?", (vid, p)).fetchone()[0]
    return conn, rev, pubs


def events(conn, kind: str) -> list[dict]:
    return [json.loads(r["json"]) for r in conn.execute("SELECT json FROM events WHERE kind = ? ORDER BY id", (kind,))]


# ── Crash-injection plumbing ──────────────────────────────────────────────────


class FakeBase:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.crash_at: int | None = None
        self.crash_mode = "crash"
        self.crashed = False

    def _after(self, name: str, request: httpx.Request, resp: httpx.Response) -> httpx.Response:
        self.calls.append(name)
        if self.crash_at is not None and len(self.calls) == self.crash_at:
            self.crashed = True
            if self.crash_mode == "crash":
                raise Crash(name)
            raise httpx.ReadTimeout(f"lost response of {name}", request=request)
        return resp

    def handler(self, fn: Callable[[httpx.Request], tuple[str, httpx.Response]]):
        def side_effect(request: httpx.Request) -> httpx.Response:
            name, resp = fn(request)
            return self._after(name, request, resp)
        return side_effect


def form(request: httpx.Request) -> dict[str, str]:
    body = parse_qs(request.content.decode()) if request.content else {}
    q = {k: v for k, v in request.url.params.items()}
    return {**q, **{k: v[0] for k, v in body.items()}}


# ── Fake YouTube ──────────────────────────────────────────────────────────────


class FakeYouTube(FakeBase):
    UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos"
    API = "https://www.googleapis.com/youtube/v3"

    def __init__(self, router) -> None:
        super().__init__()
        self.sessions: dict[str, dict] = {}
        self.videos: dict[str, dict] = {}
        self.tokens = 0
        self.reject_language = False
        self.partial_first_put = False
        self.unauthorized: int = 0          # answer the next N API calls with 401
        self.quota_exceeded = False
        self.quota_response = (403, "quotaExceeded")   # e.g. (400, "uploadLimitExceeded")
        self.init_bodies: list[dict] = []
        router.post("https://oauth2.googleapis.com/token").mock(side_effect=self.handler(self._token))
        router.post(url__startswith=self.UPLOAD).mock(side_effect=self.handler(self._init))
        router.put(url__startswith=self.UPLOAD).mock(side_effect=self.handler(self._put))
        router.get(f"{self.API}/channels").mock(side_effect=self.handler(self._channels))
        router.get(f"{self.API}/playlistItems").mock(side_effect=self.handler(self._playlist))
        router.get(f"{self.API}/videos").mock(side_effect=self.handler(self._videos))

    def _token(self, req):
        self.tokens += 1
        return "token", httpx.Response(200, json={"access_token": f"at-{self.tokens}", "expires_in": 3600})

    def _auth_fail(self, req) -> httpx.Response | None:
        if self.unauthorized:
            self.unauthorized -= 1
            return httpx.Response(401, json={"error": {"code": 401, "errors": [{"reason": "authError"}]}})
        return None

    def _init(self, req):
        if (r := self._auth_fail(req)) is not None:
            return "init", r
        if self.quota_exceeded:
            code, reason = self.quota_response
            return "init", httpx.Response(code, json={"error": {"errors": [{"reason": reason}]}})
        body = json.loads(req.content)
        self.init_bodies.append(body)
        if self.reject_language and "defaultLanguage" in body["snippet"]:
            return "init", httpx.Response(400, json={"error": {"errors": [{"reason": "invalidDefaultLanguage"}]}})
        sid = f"S{len(self.sessions) + 1}"
        self.sessions[sid] = {"meta": body, "size": int(req.headers["X-Upload-Content-Length"]),
                              "data": b"", "video": None, "dead": False}
        return "init", httpx.Response(200, headers={"Location": f"{self.UPLOAD}?uploadType=resumable&upload_id={sid}"})

    def _range(self, s) -> dict:
        return {"Range": f"bytes=0-{len(s['data']) - 1}"} if s["data"] else {}

    def _put(self, req):
        if (r := self._auth_fail(req)) is not None:
            return "put", r
        sid = re.search(r"upload_id=(\w+)", str(req.url)).group(1)
        s = self.sessions[sid]
        if s["dead"]:
            return "put", httpx.Response(404)
        cr = req.headers.get("Content-Range", "")
        if cr.startswith("bytes */"):
            if s["video"]:
                return "status", httpx.Response(200, json=self.videos[s["video"]])
            return "status", httpx.Response(308, headers=self._range(s))
        start = int(re.match(r"bytes (\d+)-", cr).group(1)) if cr else 0
        assert start == len(s["data"]), f"client resumed at {start}, server has {len(s['data'])}"
        chunk = req.content
        if self.partial_first_put:
            self.partial_first_put = False
            chunk = chunk[: len(chunk) // 2]
        s["data"] += chunk
        if len(s["data"]) < s["size"]:
            return "put", httpx.Response(308, headers=self._range(s))
        if not s["video"]:
            vid = f"V{len(self.videos) + 1}"
            st = dict(s["meta"]["status"])
            st.pop("selfDeclaredMadeForKids", None)
            self.videos[vid] = {"id": vid, "snippet": s["meta"]["snippet"], "status": {**st, "uploadStatus": "uploaded"}}
            s["video"] = vid
        return "put", httpx.Response(200, json=self.videos[s["video"]])

    def _channels(self, req):
        return "channels", httpx.Response(200, json={"items": [
            {"id": "UC1", "snippet": {"title": "KrushiSarva"},
             "contentDetails": {"relatedPlaylists": {"uploads": "UU1"}}}]})

    def _playlist(self, req):
        items = [{"contentDetails": {"videoId": v}} for v in reversed(self.videos)]
        return "playlist", httpx.Response(200, json={"items": items})

    def _videos(self, req):
        ids = req.url.params["id"].split(",")
        return "videos", httpx.Response(200, json={"items": [self.videos[i] for i in ids if i in self.videos]})


# ── Fake Graph API (Facebook Page Reels + Instagram) ──────────────────────────


class FakeMeta(FakeBase):
    GRAPH = "https://graph.facebook.com/v26.0"

    def __init__(self, router, *, ig_processing_polls: int = 0) -> None:
        super().__init__()
        self.fb_videos: dict[str, dict] = {}
        self.fb_finish_calls = 0
        self.fb_finish_params: list[dict] = []
        self.containers: dict[str, dict] = {}
        self.container_params: list[dict] = []
        self.media: list[dict] = []
        self.ig_publish_calls = 0
        self.ig_processing_polls = ig_processing_polls
        self.ig_container_error: int = 0     # next N containers end in ERROR
        self.quota_usage = 0
        self.now: datetime = T0              # server clock for IG timestamps
        self.urls: list[str] = []
        self.ig_status_lag = 0               # status_code still says FINISHED for N polls after publish
        self.fail_paths: set[str] = set()    # Graph paths answering 500 (transient outage)
        router.route(host="graph.facebook.com").mock(side_effect=self.handler(self._graph))
        router.route(host="rupload.facebook.com").mock(side_effect=self.handler(self._rupload))

    @property
    def fb_posts(self) -> int:
        return sum(1 for v in self.fb_videos.values() if v["finish"])

    def _err(self, code: int, msg: str, status: int = 400) -> httpx.Response:
        return httpx.Response(status, json={"error": {"code": code, "message": msg}})

    def _graph(self, req):
        path = req.url.path.removeprefix("/v26.0")
        f = form(req)
        assert "access_token" not in f, "token must not travel in the URL/body (httpx logs URLs)"
        auth = req.headers.get("Authorization", "")
        assert auth.startswith("Bearer ") and len(auth) > 7, "Graph call without token"
        f["access_token"] = auth.removeprefix("Bearer ")
        self.urls.append(str(req.url))
        m = req.method
        if path in self.fail_paths:
            return "down", httpx.Response(500, json={"error": {"code": 2, "is_transient": True}})
        if m == "GET" and path == "/me/accounts":
            return "accounts", httpx.Response(200, json={"data": [
                {"id": "P1", "name": "KrushiSarva", "access_token": "PAGE",
                 "instagram_business_account": {"id": "IG1"}}]})
        if m == "POST" and path == "/P1/video_reels":
            assert f["access_token"] == "PAGE"
            if f["upload_phase"] == "start":
                vid = f"FV{len(self.fb_videos) + 1}"
                self.fb_videos[vid] = {"uploaded": False, "finish": None}
                return "fb_start", httpx.Response(200, json={"video_id": vid, "upload_url": "x"})
            self.fb_finish_calls += 1
            self.fb_finish_params.append(f)
            v = self.fb_videos[f["video_id"]]
            if not v["uploaded"]:
                return "fb_finish", self._err(100, "video not uploaded")
            v["finish"] = f
            return "fb_finish", httpx.Response(200, json={"success": True})
        if m == "GET" and path.startswith("/FV"):
            v = self.fb_videos[path[1:]]
            if "permalink_url" in f.get("fields", ""):
                return "fb_permalink", httpx.Response(200, json={"permalink_url": f"/reel/{path[1:]}"})
            fin = v["finish"]
            if fin is None:
                pub = {"status": "not_started"}
            elif fin["video_state"] == "SCHEDULED":
                pub = {"status": "not_started", "publish_status": "scheduled"}
            else:
                pub = {"status": "complete", "publish_status": "published"}
            st = {"video_status": "ready" if v["uploaded"] else "upload_pending",
                  "uploading_phase": {"status": "complete" if v["uploaded"] else "not_started"},
                  "processing_phase": {"status": "complete" if v["uploaded"] else "not_started"},
                  "publishing_phase": pub}
            return "fb_status", httpx.Response(200, json={"id": path[1:], "status": st})
        # Instagram
        if m == "POST" and path == "/IG1/media":
            cid = f"C{len(self.containers) + 1}"
            err = self.ig_container_error > 0
            self.ig_container_error -= 1 if err else 0
            self.containers[cid] = {"uploaded": False, "polls": self.ig_processing_polls, "error": err,
                                    "published": None}
            self.container_params.append(f)
            return "ig_create", httpx.Response(200, json={
                "id": cid, "uri": f"https://rupload.facebook.com/ig-api-upload/v26.0/{cid}"})
        if m == "GET" and path.startswith("/C"):
            c = self.containers[path[1:]]
            if c["published"] and self.ig_status_lag > 0:
                self.ig_status_lag -= 1
                code = "FINISHED"
            elif c["published"]:
                code = "PUBLISHED"
            elif not c["uploaded"]:
                code = "IN_PROGRESS"
            elif c["error"]:
                code = "ERROR"
            elif c["polls"] > 0:
                c["polls"] -= 1
                code = "IN_PROGRESS"
            else:
                code = "FINISHED"
            return "ig_status", httpx.Response(200, json={"id": path[1:], "status_code": code})
        if m == "GET" and path == "/IG1/content_publishing_limit":
            return "ig_limit", httpx.Response(200, json={"data": [
                {"config": {"quota_total": 50, "quota_duration": 86400}, "quota_usage": self.quota_usage}]})
        if m == "POST" and path == "/IG1/media_publish":
            self.ig_publish_calls += 1
            c = self.containers[f["creation_id"]]
            if c["published"]:
                return "ig_publish", self._err(9004, "already published")
            mid = f"M{len(self.media) + 1}"
            c["published"] = mid
            cap = self.container_params[int(f["creation_id"][1:]) - 1]["caption"]
            self.media.insert(0, {"id": mid, "caption": cap, "timestamp": self.now.strftime("%Y-%m-%dT%H:%M:%S+0000"),
                                  "permalink": f"https://www.instagram.com/reel/{mid}/"})
            return "ig_publish", httpx.Response(200, json={"id": mid})
        if m == "GET" and path == "/IG1/media":
            return "ig_list", httpx.Response(200, json={"data": self.media})
        if m == "GET" and path.startswith("/M"):
            return "ig_permalink", httpx.Response(200, json={
                "id": path[1:], "permalink": f"https://www.instagram.com/reel/{path[1:]}/"})
        raise AssertionError(f"unexpected Graph call {m} {req.url}")

    def _rupload(self, req):
        assert req.headers["Authorization"].startswith("OAuth ")
        assert req.headers["offset"] == "0" and int(req.headers["file_size"]) == len(req.content)
        kind, _, oid = req.url.path.strip("/").partition("/v26.0/")
        if kind == "video-upload":
            self.fb_videos[oid]["uploaded"] = True
            return "fb_rupload", httpx.Response(200, json={"success": True})
        assert kind == "ig-api-upload", req.url
        self.containers[oid]["uploaded"] = True
        return "ig_rupload", httpx.Response(200, json={"success": True, "message": "Upload successful."})


# ── Driving ensure() like the reconcile loop would ────────────────────────────


def drive(make_pub: Callable[[], Any], conn, pub_id: int, rev, slot: Slot, now: datetime,
          stop: set[str], *, fake: FakeBase | None = None, max_steps: int = 40) -> tuple[str, datetime]:
    """Call ensure() repeatedly, jumping the clock to next_attempt_at; a Crash restarts the 'process'
    (fresh publisher, no in-memory caches)."""
    pub = make_pub()
    for _ in range(max_steps):
        if fake is not None and isinstance(fake, FakeMeta):
            fake.now = now
        try:
            state = pub.ensure(conn, load_pub(conn, pub_id), rev, now=now, slot=slot)
        except Crash:
            pub = make_pub()
            continue
        if state in stop:
            return state, now
        nxt = parse_iso(load_pub(conn, pub_id)["next_attempt_at"])
        now = max(now + timedelta(seconds=1), nxt or now + timedelta(minutes=1))
    raise AssertionError(f"did not settle; state={load_pub(conn, pub_id)['state']}")


__all__ = ["Crash", "FakeYouTube", "FakeMeta", "T0", "MASTER_BYTES", "make_settings", "morning_slot", "make_db",
           "events", "drive"]
