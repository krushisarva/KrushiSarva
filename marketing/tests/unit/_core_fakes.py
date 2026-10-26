"""Fakes for the core (planner/statemachine/reconcile/daemon) tests.

Every collaborator owned by another module is replaced here, so these tests exercise the
orchestration only: no network, no ffmpeg, no Keychain, no real Telegram.
"""
from __future__ import annotations

import dataclasses
import json
import secrets as _secrets
import wave
from contextlib import nullcontext
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ksm.clock import in_quiet_hours
from ksm.db import iso, log_event
from ksm.guards import GuardState
from ksm.models import (ApprovalStatus, CheckReport, Decision, Issue, PubState, QAReport, RenderOutputs,
                        SentenceAudio, SlotKind, Timeline, VideoPlan, VideoScript)
from ksm.statemachine import Deps


class SimulatedCrash(BaseException):
    """Stands in for kill -9 / power loss: not an Exception, so nothing in ksm swallows it."""


def utc(y: int, mo: int, d: int, h: int = 0, mi: int = 0) -> datetime:
    return datetime(y, mo, d, h, mi, tzinfo=timezone.utc)


def ist(y: int, mo: int, d: int, h: int = 0, mi: int = 0) -> datetime:
    """IST wall time -> UTC."""
    return utc(y, mo, d, h, mi) - timedelta(hours=5, minutes=30)


class Crasher:
    """Raises SimulatedCrash on the first call of the named point (once)."""

    def __init__(self, point: str | None = None):
        self.point = point
        self.fired = False

    def maybe(self, point: str) -> None:
        if point == self.point and not self.fired:
            self.fired = True
            raise SimulatedCrash(point)


# ── script / checks / voice / render ──────────────────────────────────────────


def make_script(tag: str = "ok") -> VideoScript:
    seg = {"voice_mr": "सोयाबीनचा भाव पाहा.", "onscreen_mr": "सोयाबीन", "visual": {"kind": "title"}}
    pt = {"title": f"सोयाबीन बाजारभाव {tag}", "description": "निवेदन: AI आवाज", "caption": "बाजारभाव",
          "hashtags": ["#बाजारभाव"], "tags": ["soybean"]}
    return VideoScript.model_validate({
        "hook": {"voice_mr": f"आजचा बाजारभाव {tag}", "onscreen_mr": "आजचा बाजारभाव"},
        "segments": [seg, seg, seg], "cta_mr": "फॉलो करा.",
        "platform": {"yt": pt, "ig": pt, "fb": pt}, "claims": [],
        "sources_onscreen_mr": "स्रोत: Agmarknet",
    })


@dataclasses.dataclass
class Pipeline:
    crash: Crasher = dataclasses.field(default_factory=Crasher)
    bad_scripts: int = 0              # the first N scripts fail deterministic checks
    narration_s: float = 40.0
    calls: dict[str, int] = dataclasses.field(default_factory=dict)

    def _count(self, name: str) -> None:
        self.calls[name] = self.calls.get(name, 0) + 1

    def write_script(self, client, *, settings, series_cfg, plan, glossary, recent_titles, feedback):
        self._count("write_script")
        self.crash.maybe("write_script")
        tag = "BAD" if self.calls["write_script"] <= self.bad_scripts else "ok"
        return make_script(tag), {"cost_inr": 10.0, "input_tokens": 1000, "output_tokens": 500,
                                  "prompt_version": "writer.v1"}

    def run_checks(self, script, payload, *, series, app_cta_url, extra_allowed=frozenset()):
        self._count("run_checks")
        self.crash.maybe("run_checks")
        if "BAD" in script.hook.voice_mr:
            return CheckReport([Issue("number_not_in_payload", "9999 not in payload", True, "hook.voice_mr")])
        return CheckReport()

    def factcheck(self, client, *, settings, plan, script, web):
        self._count("factcheck")
        self.crash.maybe("factcheck")
        return CheckReport(), {"cost_inr": 3.0}

    def synthesize(self, script, tts, out_dir: Path):
        self._count("synthesize")
        out_dir.mkdir(parents=True, exist_ok=True)
        wav = out_dir / "narration.wav"
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(1), w.setsampwidth(2), w.setframerate(8000), w.writeframes(b"\0\0" * 80)
        self.crash.maybe("synthesize")
        return Timeline([SentenceAudio("x", wav, self.narration_s, -1)], 0.18, wav)

    @staticmethod
    def timeline_to_dict(tl: Timeline) -> dict:
        return {"gap_s": tl.gap_s, "narration_wav": str(tl.narration_wav),
                "sentences": [{"text": s.text, "wav": str(s.wav), "duration_s": s.duration_s,
                               "segment_index": s.segment_index} for s in tl.sentences]}

    @staticmethod
    def timeline_from_dict(d: dict) -> Timeline:
        return Timeline([SentenceAudio(s["text"], Path(s["wav"]), s["duration_s"], s["segment_index"])
                         for s in d["sentences"]], d["gap_s"], Path(d["narration_wav"]))

    def render(self, script, timeline, plan, work_dir: Path, out_dir: Path, *, assets_dir):
        self._count("render")
        work_dir.mkdir(parents=True, exist_ok=True)
        (work_dir / "card0.png").write_bytes(b"png")
        out = {}
        for name in ("master.mp4", "preview.mp4", "cover.jpg"):
            p = out_dir / name
            p.write_bytes(f"{name}:{plan.topic_key}:{script.hook.voice_mr}".encode())
            out[name] = p
        self.crash.maybe("render")
        return RenderOutputs(out["master.mp4"], out["preview.mp4"], out["cover.jpg"], out_dir / "a.ass", 41.0)

    def probe(self, master: Path) -> QAReport:
        self._count("probe")
        self.crash.maybe("probe")
        return QAReport(ok=True)


# ── approvals / telegram ──────────────────────────────────────────────────────


class FakeTelegram:
    def __init__(self):
        self.sent: list[tuple[int, str]] = []
        self.closed: list[list[int]] = []
        self._id = 1000

    def send_message(self, chat_id, text, reply_markup=None, parse_mode="HTML") -> int:
        self._id += 1
        self.sent.append((self._id, text))
        return self._id


class FakeApprove:
    """Mirrors the approve module's DB contract: a card = a pending approval row (nonce,
    content_hash) plus two messages; an older pending approval of the same revision is superseded."""

    def __init__(self, tg: FakeTelegram, crash: Crasher):
        self.tg = tg
        self.crash = crash
        self.cards: list[int] = []

    def owner(self, conn):
        return (42, 4200)

    def send_card(self, conn, tg, *, chat_id, revision_row, video_row, slot_row, settings, platforms=None,
                  cost_inr=None, now=None):
        platforms = platforms or json.loads(revision_row["metadata_json"]).get("platforms") or list(settings.platforms)
        conn.execute("UPDATE approvals SET status = 'superseded' WHERE revision_id = ? AND status = 'pending'",
                     (revision_row["id"],))
        cur = conn.execute(
            "INSERT INTO approvals(revision_id, content_hash, nonce, status, platforms_json, sent_at) VALUES (?,?,?,?,?,?)",
            (revision_row["id"], revision_row["content_hash"], _secrets.token_hex(3), "pending",
             json.dumps(platforms), iso(now)))
        self.crash.maybe("send_card")
        ids = [tg.send_message(chat_id, "video"), tg.send_message(chat_id, "details")]
        conn.execute("UPDATE approvals SET message_ids_json = ? WHERE id = ?", (json.dumps(ids), cur.lastrowid))
        self.cards.append(int(cur.lastrowid))
        return int(cur.lastrowid)

    def close_card(self, tg, chat_id, message_ids, status_text):
        tg.closed.append(list(message_ids))

    @staticmethod
    def pending_decisions(conn):
        rows = conn.execute("SELECT decision_json FROM approvals WHERE status = 'pending' AND decision_json IS NOT NULL")
        out = []
        for r in rows:
            d = json.loads(r["decision_json"])
            d["platforms"] = tuple(d.get("platforms") or ())
            out.append(Decision(**d))
        return out


# ── publishers ────────────────────────────────────────────────────────────────


class FakeRemote:
    """The platforms' side: every post that exists, keyed so a re-upload would be visible."""

    def __init__(self):
        self.posts: list[tuple[str, int]] = []

    def count(self, platform: str, video_id: int) -> int:
        return self.posts.count((platform, video_id))


class FakePublisher:
    """yt/fb: schedule when the slot is >=15 min ahead, else post now; verify after the slot.
    ig: no scheduling; publishes at the slot, never in quiet hours, expires after late_until.
    Idempotent like the real ones: the remote id is looked up before posting again."""

    def __init__(self, platform: str, remote: FakeRemote, settings, crash: Crasher):
        self.platform = platform
        self.remote = remote
        self.settings = settings
        self.crash = crash

    def _set(self, conn, pub_id: int, **f: Any) -> None:
        conn.execute(f"UPDATE publications SET {', '.join(f'{k} = ?' for k in f)} WHERE id = ?", (*f.values(), pub_id))
        log_event(conn, "publish_state", None, pub_id=pub_id, **{k: str(v) for k, v in f.items()})

    def ensure(self, conn, pub_row, revision_row, *, now, slot) -> str:
        row = conn.execute("SELECT * FROM publications WHERE id = ?", (pub_row["id"],)).fetchone()
        st = row["state"]
        vid = row["video_id"]
        if st in ("VERIFIED", "FATAL", "SKIPPED", "EXPIRED"):
            return st
        if st in ("SCHEDULED", "PUBLISHED"):
            if now >= slot.publish_at:
                self._set(conn, row["id"], state=PubState.VERIFIED.value)
                return "VERIFIED"
            return st
        if self.platform == "ig":
            if now > slot.late_until:
                self._set(conn, row["id"], state="EXPIRED")
                return "EXPIRED"
            if now < slot.publish_at or in_quiet_hours(now, self.settings.quiet_hours):
                self._set(conn, row["id"], state="PUBLISH_DUE")
                return "PUBLISH_DUE"
        already = self.remote.count(self.platform, vid) > 0      # recovery: find the earlier post
        if not already:
            self.remote.posts.append((self.platform, vid))
            self.crash.maybe(f"publish_{self.platform}")
        sched = self.platform != "ig" and slot.publish_at >= now + timedelta(minutes=15)
        self._set(conn, row["id"], state="SCHEDULED" if sched else "PUBLISHED",
                  remote_id=f"{self.platform}-{vid}", scheduled_for=iso(slot.publish_at) if sched else None,
                  published_at=None if sched else iso(now))
        return "SCHEDULED" if sched else "PUBLISHED"


# ── planning / guards ─────────────────────────────────────────────────────────


@dataclasses.dataclass
class Planning:
    fresh_ready: bool = True
    evergreen_n: int = 0

    def plan_slot(self, conn, slot, now, settings):
        if slot.kind == SlotKind.FRESH and self.fresh_ready:
            d = slot.slot_date - timedelta(days=1)
            return VideoPlan("mandi", f"mandi-{d}", d, evergreen=False, time_sensitive=True,
                             fresh_until=slot.late_until, payload={"data_date": d.isoformat(), "modal": 4950})
        return self.plan_evergreen(conn, now, settings, seed=slot.id)

    def plan_evergreen(self, conn, now, settings, *, seed, kind=None):
        self.evergreen_n += 1
        return VideoPlan("rabi_guide", f"adv-{self.evergreen_n}", None, evergreen=True, time_sensitive=False,
                         fresh_until=None, payload={"facts": [f"fact {self.evergreen_n}"]})

    def fresh_data_ready(self, conn, slot_date: date) -> bool:
        return self.fresh_ready


@dataclasses.dataclass
class Guards:
    production_ok: bool = True
    render_ok: bool = True
    purge_needed: bool = False

    def __call__(self, conn, settings, *, now=None):
        from ksm.ledger import budget_state
        budget = budget_state(conn, settings, now)
        ok = self.production_ok and budget != "exhausted"
        return GuardState(production_ok=ok, render_ok=ok and self.render_ok, purge_needed=self.purge_needed,
                          reasons=[] if ok else ["guard"], budget=budget)


@dataclasses.dataclass
class World:
    deps: Deps
    pipe: Pipeline
    tg: FakeTelegram
    approve: FakeApprove
    remote: FakeRemote
    planning: Planning
    guards: Guards
    crash: Crasher


def make_world(paths, settings, *, platforms=("yt", "ig", "fb"), crash: str | None = None,
               evergreen_min: int = 0, **settings_over) -> World:
    settings = dataclasses.replace(settings, platforms=tuple(platforms), dry_run=False,
                                   evergreen_min_approved=evergreen_min, **settings_over)
    crasher = Crasher(crash)
    pipe, tg, remote, planning, guards = Pipeline(crash=crasher), FakeTelegram(), FakeRemote(), Planning(), Guards()
    appr = FakeApprove(tg, crasher)
    fns = {
        "write_script": pipe.write_script, "factcheck": pipe.factcheck, "run_checks": pipe.run_checks,
        "build_glossary": lambda cfg: {}, "synthesize": pipe.synthesize, "timeline_to_dict": pipe.timeline_to_dict,
        "timeline_from_dict": pipe.timeline_from_dict, "render": pipe.render, "probe": pipe.probe,
        "send_card": appr.send_card, "close_card": appr.close_card, "owner": appr.owner,
        "pending_decisions": appr.pending_decisions, "plan_slot": planning.plan_slot,
        "plan_evergreen": planning.plan_evergreen, "fresh_data_ready": planning.fresh_data_ready,
        "guards": guards, "fetch_mandi": lambda conn, deps, now: [],
    }
    import queue
    deps = Deps(settings=settings, paths=paths, fns=fns,
                clients={"claude": object(), "tts": object(), "telegram": tg},
                publishers={p: FakePublisher(p, remote, settings, crasher) for p in platforms},
                keep_awake=nullcontext, decisions=queue.Queue())
    return World(deps, pipe, tg, appr, remote, planning, guards, crasher)


def pending_approval(conn, video_id: int):
    return conn.execute("SELECT a.* FROM approvals a JOIN revisions r ON r.id = a.revision_id"
                        " WHERE r.video_id = ? AND a.status = ? ORDER BY a.id DESC",
                        (video_id, ApprovalStatus.PENDING.value)).fetchone()


def video_state(conn, video_id: int) -> str:
    return conn.execute("SELECT state FROM videos WHERE id = ?", (video_id,)).fetchone()["state"]
