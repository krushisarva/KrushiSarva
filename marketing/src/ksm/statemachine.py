"""Per-video state machine: `advance()` runs exactly one step for one video.

    PLANNED → DATA_READY → SCRIPTED → CHECKED → VOICED → RENDERED → QA_PASSED → AWAITING_APPROVAL
      ↑ NEEDS_REDO ←──────────┘ (checks failed; BLOCKED after settings.max_redos)
    APPROVED → PUBLISHING → DONE | PARTIAL          (decisions are applied by apply_decision)

Every step commits its result before returning, so a crash between steps resumes from the
last committed state; steps are written so that re-running one after a crash never sends a
second card or creates a second publication (approval/publication rows are looked up first).

Other modules are reached only through `Deps`: their functions resolve lazily to the contract
entry points, and tests replace them (and every client) with fakes.
"""
from __future__ import annotations

import dataclasses
import hashlib
import importlib
import json
import logging
import os
import queue
import shutil
import sqlite3
import subprocess
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, field
from datetime import date, datetime, time as dtime, timedelta
from pathlib import Path
from typing import Any, Callable, Iterator

from .clock import IST, in_quiet_hours, ist_date, upcoming_slots
from .config import Settings
from .db import iso, kv_get, kv_set, log_event, parse_iso, tx
from .ledger import budget_state, record as ledger_record, sarvam_cost_inr, usage_cost_inr, video_spend
from .models import (TERMINAL_VIDEO_STATES, ApprovalStatus, CheckReport, Decision, PubState, Slot, SlotKind,
                     VideoPlan, VideoScript, VideoState)
from .paths import Paths
from .secrets import SecretMissing

log = logging.getLogger(__name__)

V = VideoState
PRODUCTION_STATES = (V.PLANNED, V.DATA_READY, V.NEEDS_REDO, V.SCRIPTED, V.CHECKED, V.VOICED, V.RENDERED,
                     V.QA_PASSED)
PRE_PUBLISH_STATES = (*PRODUCTION_STATES, V.AWAITING_APPROVAL, V.APPROVED)
HEAVY_FROM = frozenset({V.CHECKED, V.VOICED})        # the next step runs TTS / ffmpeg
PAID_FROM = frozenset({V.DATA_READY, V.NEEDS_REDO, V.SCRIPTED, V.CHECKED, V.QA_PASSED})
PUB_FINAL = frozenset({PubState.VERIFIED, PubState.FATAL, PubState.SKIPPED, PubState.EXPIRED})
PUB_REMOTE = frozenset({PubState.SCHEDULED, PubState.PUBLISHED, PubState.UPLOADED, PubState.VERIFIED})
ALL_PLATFORMS = ("yt", "ig", "fb")
MAX_STEP_FAILURES = 5
# Retries back off 2, 4, 8, 16 min: a provider or network blip (Wi-Fi takes a while after a
# wake) does not burn all MAX_STEP_FAILURES attempts in five one-minute ticks and BLOCK the video.
STEP_RETRY_BASE = timedelta(minutes=2)
STEP_RETRY_MAX = timedelta(hours=1)
POST_NOW_WINDOW = timedelta(hours=3)
IMMEDIATE = timedelta(minutes=15)                    # publish_at closer than this = posts right away
HELPLINE = "1800-180-1551"
EDIT_TARGETS = {"yt_title": ("yt", "title"), "ig_caption": ("ig", "caption"), "fb_caption": ("fb", "caption")}


# ── keep the Mac awake during heavy steps ─────────────────────────────────────


@contextmanager
def keep_awake() -> Iterator[None]:
    """`caffeinate -i -w <our pid>`: idle sleep is blocked while we work, and caffeinate exits
    on its own if we crash (so a dead step never keeps the Mac awake)."""
    exe = shutil.which("caffeinate")
    proc = None
    if exe:
        try:
            proc = subprocess.Popen([exe, "-i", "-w", str(os.getpid())],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError:
            proc = None
    try:
        yield
    finally:
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()


# ── dependencies ──────────────────────────────────────────────────────────────

# name -> candidate (module, attribute) pairs, resolved lazily (other agents own these modules).
DEFAULT_FNS: dict[str, tuple[tuple[str, str], ...]] = {
    "write_script": (("ksm.writer", "write_script"),),
    "factcheck": (("ksm.writer", "factcheck"),),
    "build_glossary": (("ksm.writer", "build_glossary"),),
    "run_checks": (("ksm.checks", "run_deterministic"),),
    "synthesize": (("ksm.voice", "synthesize"),),
    "timeline_to_dict": (("ksm.voice", "timeline_to_dict"),),
    "timeline_from_dict": (("ksm.voice", "timeline_from_dict"),),
    "render": (("ksm.render", "render"), ("ksm.render.ffmpeg", "render"), ("ksm.render.pipeline", "render")),
    "probe": (("ksm.render.qa", "probe"), ("ksm.render", "probe")),
    "send_card": (("ksm.approve", "send_card"),),
    "close_card": (("ksm.approve", "close_card"),),
    "owner": (("ksm.approve", "owner"),),
    "pending_decisions": (("ksm.approve", "pending_decisions"),),
    "plan_slot": (("ksm.planner", "plan_slot"),),
    "plan_evergreen": (("ksm.planner", "plan_evergreen"),),
    "fresh_data_ready": (("ksm.planner", "fresh_data_ready"),),
    "guards": (("ksm.guards", "check"),),
    "fetch_mandi": (("ksm.reconcile", "fetch_mandi"),),
    "token_health": (("ksm.reconcile", "token_health"),),
}


def _resolve(name: str) -> Callable:
    errors = []
    for mod, attr in DEFAULT_FNS[name]:
        try:
            fn = getattr(importlib.import_module(mod), attr, None)
        except ImportError as e:
            errors.append(f"{mod}: {e}")
            continue
        if fn is not None:
            return fn
        errors.append(f"{mod} has no {attr}")
    raise RuntimeError(f"pipeline function {name!r} unavailable: {'; '.join(errors)}")


@dataclass
class Deps:
    """Everything a step needs from outside: other modules' functions, API clients, publishers.

    fns/clients override the defaults (tests pass fakes); factories build real clients on first
    use so a missing secret only fails the step that needs it."""

    settings: Settings
    paths: Paths
    fns: dict[str, Callable] = field(default_factory=dict)
    clients: dict[str, Any] = field(default_factory=dict)
    factories: dict[str, Callable[[], Any]] = field(default_factory=dict)
    publishers: dict[str, Any] | None = None
    publisher_factory: Callable[[], dict[str, Any]] | None = None
    keep_awake: Callable[[], AbstractContextManager] = keep_awake
    decisions: "queue.Queue[Decision] | None" = None
    config_dir: Path | None = None

    def fn(self, name: str) -> Callable:
        if name not in self.fns:
            self.fns[name] = _resolve(name)
        return self.fns[name]

    def client(self, name: str) -> Any:
        if name not in self.clients:
            if name not in self.factories:
                raise RuntimeError(f"no client or factory for {name!r}")
            self.clients[name] = self.factories[name]()
        return self.clients[name]

    def get_publishers(self) -> dict[str, Any]:
        if self.publishers is None:
            self.publishers = self.publisher_factory() if self.publisher_factory else {}
        return self.publishers

    @property
    def cfg_dir(self) -> Path:
        return self.config_dir or self.paths.config_dir

    @classmethod
    def real(cls, settings: Settings, paths: Paths) -> "Deps":
        """Production wiring. Nothing here touches the network or the Keychain until used."""
        import httpx

        def claude() -> Any:
            import anthropic

            from .secrets import get_secret
            return anthropic.Anthropic(api_key=get_secret("anthropic_api_key"), max_retries=3)

        def tts() -> Any:
            from .secrets import get_secret
            from .voice import SarvamTTS
            return SarvamTTS(get_secret("sarvam_api_key"), **dict((settings.raw or {}).get("voice") or {}))

        def telegram() -> Any:
            from .approve import TelegramClient
            from .secrets import get_secret
            return TelegramClient(get_secret("telegram_bot_token"))

        def http() -> Any:
            return httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0))

        def publishers() -> dict[str, Any]:
            from .publish import build_publishers
            return build_publishers(settings)

        return cls(settings=settings, paths=paths,
                   factories={"claude": claude, "tts": tts, "telegram": telegram, "http": http},
                   publisher_factory=publishers)


class Hold(Exception):
    """The step cannot run now (budget, pairing); not an error, nothing changes."""


# ── row helpers ───────────────────────────────────────────────────────────────


def video_row(conn: sqlite3.Connection, video_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
    if row is None:
        raise LookupError(f"video {video_id} not found")
    return row


def latest_revision(conn: sqlite3.Connection, video_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM revisions WHERE video_id = ? ORDER BY rev_no DESC LIMIT 1",
                        (video_id,)).fetchone()


def slot_row_of(conn: sqlite3.Connection, video_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM slots WHERE video_id = ?", (video_id,)).fetchone()


def slot_from_row(row: Any) -> Slot:
    return Slot(id=row["id"], slot_date=date.fromisoformat(row["slot_date"]), kind=SlotKind(row["kind"]),
                publish_at=parse_iso(row["publish_at"]), produce_from=parse_iso(row["produce_from"]),
                approve_by=parse_iso(row["approve_by"]), late_until=parse_iso(row["late_until"]))


def slot_to_json(s: Slot) -> str:
    return json.dumps({"id": s.id, "slot_date": s.slot_date.isoformat(), "kind": s.kind.value,
                       "publish_at": iso(s.publish_at), "produce_from": iso(s.produce_from),
                       "approve_by": iso(s.approve_by), "late_until": iso(s.late_until)})


def plan_of(row: Any) -> VideoPlan:
    return VideoPlan(series=row["series"], topic_key=row["topic_key"],
                     data_date=date.fromisoformat(row["data_date"]) if row["data_date"] else None,
                     evergreen=bool(row["evergreen"]), time_sensitive=bool(row["time_sensitive"]),
                     fresh_until=parse_iso(row["fresh_until"]), payload=json.loads(row["payload_json"] or "{}"))


def content_hash(master_sha256: str, metadata_json: str) -> str:
    """What an approval binds to: the exact video bytes plus the exact per-platform metadata."""
    return hashlib.sha256((master_sha256 + metadata_json).encode("utf-8")).hexdigest()


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def alert(conn: sqlite3.Connection, video_id: int | None, message: str) -> None:
    """Telegram alerting (reconcile.send_alerts) picks up events of kind 'alert'."""
    log_event(conn, "alert", video_id, source="statemachine", message=message)


def set_state(conn: sqlite3.Connection, video_id: int, state: VideoState, now: datetime, **fields: Any) -> VideoState:
    cols = {"state": state.value, "updated_at": iso(now), **fields}
    with tx(conn):
        prev = conn.execute("SELECT state FROM videos WHERE id = ?", (video_id,)).fetchone()
        conn.execute(f"UPDATE videos SET {', '.join(f'{k} = ?' for k in cols)} WHERE id = ?",
                     (*cols.values(), video_id))
        log_event(conn, "state", video_id, frm=prev["state"] if prev else None, to=state.value)
    return state


def approved_approval(conn: sqlite3.Connection, revision: Any) -> sqlite3.Row | None:
    """The approved approval of this revision, only if it is bound to the revision's current content."""
    if revision is None or not revision["content_hash"]:
        return None
    return conn.execute(
        "SELECT * FROM approvals WHERE revision_id = ? AND status = ? AND content_hash = ? ORDER BY id DESC LIMIT 1",
        (revision["id"], ApprovalStatus.APPROVED.value, revision["content_hash"]),
    ).fetchone()


def _report_dict(rep: CheckReport) -> dict:
    return {"ok": rep.ok, "issues": [dataclasses.asdict(i) for i in rep.issues]}


def _usage_units(usage: dict) -> dict:
    keys = ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
            "web_search_requests")
    return {k: usage.get(k) for k in keys if usage.get(k)}


# ── sleeping-mac-safe slot resolution ─────────────────────────────────────────


def _quiet_end_after(t: datetime, quiet: tuple[str, str]) -> datetime:
    h, m = (int(x) for x in quiet[1].split(":"))
    local = t.astimezone(IST)
    cand = datetime.combine(local.date(), dtime(h, m), tzinfo=IST)
    if cand <= local:
        cand += timedelta(days=1)
    return cand.astimezone(t.tzinfo)


def avoid_quiet(slot: Slot, settings: Settings) -> Slot:
    """Nothing is published inside quiet hours: a publish time inside them moves to their end."""
    if not in_quiet_hours(slot.publish_at, settings.quiet_hours):
        return slot
    new = _quiet_end_after(slot.publish_at, settings.quiet_hours)
    return dataclasses.replace(slot, publish_at=new, late_until=max(slot.late_until, new + POST_NOW_WINDOW))


def video_slot(conn: sqlite3.Connection, video: Any, settings: Settings) -> Slot | None:
    """The slot a video publishes into: 'post now' overrides its bound slot; None if unbound."""
    raw = kv_get(conn, f"post_now:{video['id']}")
    if raw:
        t = parse_iso(raw)
        s = Slot(id=f"now-{video['id']}", slot_date=ist_date(t), kind=SlotKind.ADVISORY, publish_at=t,
                 produce_from=t, approve_by=t, late_until=t + POST_NOW_WINDOW)
        return avoid_quiet(s, settings)
    row = slot_row_of(conn, video["id"])
    return avoid_quiet(slot_from_row(row), settings) if row else None


def pub_slot(conn: sqlite3.Connection, pub: Any, base: Slot) -> Slot:
    raw = kv_get(conn, f"pubslot:{pub['id']}")
    if not raw:
        return base
    d = json.loads(raw)
    return Slot(id=d["id"], slot_date=date.fromisoformat(d["slot_date"]), kind=SlotKind(d["kind"]),
                publish_at=parse_iso(d["publish_at"]), produce_from=parse_iso(d["produce_from"]),
                approve_by=parse_iso(d["approve_by"]), late_until=parse_iso(d["late_until"]))


def next_free_slot(conn: sqlite3.Connection, now: datetime, settings: Settings) -> Slot | None:
    """Next slot (within 3 days) still far enough ahead to publish into and not taken by a video."""
    for s in upcoming_slots(now, settings, horizon=timedelta(days=3)):
        if s.publish_at <= now + IMMEDIATE or in_quiet_hours(s.publish_at, settings.quiet_hours):
            continue
        row = conn.execute("SELECT video_id, state FROM slots WHERE id = ?", (s.id,)).fetchone()
        if row is None or (row["video_id"] is None and row["state"] == "open"):
            return s
    return None


# ── steps ─────────────────────────────────────────────────────────────────────


def _redo(conn: sqlite3.Connection, video: Any, feedback: str, deps: Deps, now: datetime) -> VideoState:
    n = int(video["redo_count"]) + 1
    if n > deps.settings.max_redos:
        alert(conn, video["id"], f"व्हिडिओ #{video['id']} थांबवला: {n - 1} वेळा पुन्हा लिहूनही तपासणी अयशस्वी.\n"
                                 f"{feedback[:600]}")
        return set_state(conn, video["id"], V.BLOCKED, now, redo_count=n, feedback=feedback,
                         error="checks failed after max redos")
    return set_state(conn, video["id"], V.NEEDS_REDO, now, redo_count=n, feedback=feedback)


def _step_planned(conn: sqlite3.Connection, video: Any, deps: Deps, now: datetime) -> VideoState:
    payload = json.loads(video["payload_json"] or "{}")
    if not payload:
        alert(conn, video["id"], f"व्हिडिओ #{video['id']}: डेटा payload रिकामा; थांबवला.")
        return set_state(conn, video["id"], V.BLOCKED, now, error="empty payload")
    return set_state(conn, video["id"], V.DATA_READY, now)


def _recent_titles(conn: sqlite3.Connection, exclude_video: int, n: int = 12) -> list[str]:
    rows = conn.execute(
        "SELECT json_extract(metadata_json, '$.yt.title') AS t FROM revisions WHERE video_id != ? "
        "ORDER BY id DESC LIMIT ?", (exclude_video, n * 3)).fetchall()
    return list(dict.fromkeys(r["t"] for r in rows if r["t"]))[:n]


def _step_script(conn: sqlite3.Connection, video: Any, deps: Deps, now: datetime) -> VideoState:
    from .planner import series_cfg  # same package, core

    settings = deps.settings
    if budget_state(conn, settings, now) == "degraded":
        settings = dataclasses.replace(settings, writer_effort="low")
    cfg = series_cfg(video["series"], deps.cfg_dir)
    try:
        script, usage = deps.fn("write_script")(
            deps.client("claude"), settings=settings, series_cfg=cfg, plan=plan_of(video),
            glossary=deps.fn("build_glossary")(deps.cfg_dir), recent_titles=_recent_titles(conn, video["id"]),
            feedback=video["feedback"])
    except Exception as e:
        usage = getattr(e, "usage", None)
        if usage:
            ledger_record(conn, "anthropic", "writer", usage_cost_inr(usage, deps.settings), video["id"], now=now,
                          **_usage_units(usage))
        if type(e).__name__ == "ClaudeRefusal":
            alert(conn, video["id"], f"व्हिडिओ #{video['id']}: Claude ने स्क्रिप्ट नाकारली ({e}). थांबवला.")
            return set_state(conn, video["id"], V.BLOCKED, now, error=str(e)[:500])
        raise
    ledger_record(conn, "anthropic", "writer", usage_cost_inr(usage, deps.settings), video["id"], now=now,
                  **_usage_units(usage))
    if not isinstance(script, VideoScript):
        script = VideoScript.model_validate(script)
    meta: dict[str, Any] = {p: getattr(script.platform, p).model_dump() for p in ALL_PLATFORMS}
    meta["yt"]["containsSyntheticMedia"] = True
    meta["ig"]["is_ai_generated"] = True
    meta["fb"]["is_ai_generated"] = True
    meta["platforms"] = list(deps.settings.platforms)
    with tx(conn):
        rev_no = conn.execute("SELECT COALESCE(MAX(rev_no), 0) + 1 AS n FROM revisions WHERE video_id = ?",
                              (video["id"],)).fetchone()["n"]
        conn.execute(
            "INSERT INTO revisions(video_id, rev_no, script_json, metadata_json, prompt_version, created_at)"
            " VALUES (?,?,?,?,?,?)",
            (video["id"], rev_no, script.model_dump_json(), json.dumps(meta, ensure_ascii=False),
             usage.get("prompt_version"), iso(now)))
        return set_state(conn, video["id"], V.SCRIPTED, now, feedback=None, error=None)


def extra_allowed_numbers(video: Any, slot: Slot | None) -> set[str]:
    """Numbers a script may say that are not in the payload: dates it is about and the helpline."""
    out = {HELPLINE}
    days = [d for d in (slot.slot_date if slot else None,
                        date.fromisoformat(video["data_date"]) if video["data_date"] else None) if d]
    for d in days:
        out |= {str(d.day), f"{d.day:02d}", str(d.month), str(d.year), d.isoformat()}
    return out


def _step_check(conn: sqlite3.Connection, video: Any, deps: Deps, now: datetime) -> VideoState:
    from .planner import series_cfg

    rev = latest_revision(conn, video["id"])
    script = VideoScript.model_validate_json(rev["script_json"])
    payload = json.loads(video["payload_json"] or "{}")
    srow = slot_row_of(conn, video["id"])
    det = deps.fn("run_checks")(script, payload, series=video["series"], app_cta_url=deps.settings.app_cta_url,
                                extra_allowed=extra_allowed_numbers(video, slot_from_row(srow) if srow else None))
    checks: dict[str, Any] = {"deterministic": _report_dict(det)}
    report = CheckReport(list(det.issues))
    if det.ok:
        cfg = series_cfg(video["series"], deps.cfg_dir)
        try:
            fc, usage = deps.fn("factcheck")(deps.client("claude"), settings=deps.settings, plan=plan_of(video),
                                             script=script, web=bool(cfg.get("web_factcheck")))
        except Exception as e:
            failed_usage = getattr(e, "usage", None)   # ClaudeError carries the spend of a failed call
            if failed_usage:
                ledger_record(conn, "anthropic", "factcheck", usage_cost_inr(failed_usage, deps.settings),
                              video["id"], now=now, **_usage_units(failed_usage))
            raise
        ledger_record(conn, "anthropic", "factcheck", usage_cost_inr(usage, deps.settings), video["id"], now=now,
                      **_usage_units(usage))
        checks["factcheck"] = _report_dict(fc)
        report.extend(fc)
    with tx(conn):
        conn.execute("UPDATE revisions SET checks_json = ? WHERE id = ?",
                     (json.dumps(checks, ensure_ascii=False), rev["id"]))
        if not report.ok:
            return _redo(conn, video, report.feedback(), deps, now)
        return set_state(conn, video["id"], V.CHECKED, now)


def _work_dir(deps: Deps, video: Any, rev: Any) -> Path:
    return deps.paths.video_work(video["id"]) / f"r{rev['rev_no']}"


def _step_voice(conn: sqlite3.Connection, video: Any, deps: Deps, now: datetime) -> VideoState:
    rev = latest_revision(conn, video["id"])
    script = VideoScript.model_validate_json(rev["script_json"])
    with deps.keep_awake():
        tl = deps.fn("synthesize")(script, deps.client("tts"), _work_dir(deps, video, rev) / "voice")
    chars = sum(len(t) for t in script.narration())
    already = conn.execute(
        "SELECT 1 FROM cost_ledger WHERE video_id = ? AND op = 'tts' AND json_extract(units_json, '$.revision_id') = ?",
        (video["id"], rev["id"])).fetchone()
    if not already:   # clips are cached on disk, so a re-run after a crash is not billed twice
        ledger_record(conn, "sarvam", "tts", sarvam_cost_inr(chars), video["id"], now=now, chars=chars,
                      revision_id=rev["id"])
    if tl.total_s > deps.settings.max_video_seconds:
        return _redo(conn, video, f"- [narration_too_long] narration: spoken audio is {tl.total_s:.1f} s; "
                                  f"the limit is {deps.settings.max_video_seconds:g} s. Shorten the segments.",
                     deps, now)
    with tx(conn):
        conn.execute("UPDATE revisions SET timeline_json = ? WHERE id = ?",
                     (json.dumps(deps.fn("timeline_to_dict")(tl), ensure_ascii=False), rev["id"]))
        return set_state(conn, video["id"], V.VOICED, now)


def _step_render(conn: sqlite3.Connection, video: Any, deps: Deps, now: datetime) -> VideoState:
    rev = latest_revision(conn, video["id"])
    script = VideoScript.model_validate_json(rev["script_json"])
    tl = deps.fn("timeline_from_dict")(json.loads(rev["timeline_json"]))
    out_dir = deps.paths.renders_dir / f"v{video['id']}-r{rev['rev_no']}"
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        with deps.keep_awake():
            out = deps.fn("render")(script, tl, plan_of(video), _work_dir(deps, video, rev), out_dir,
                                    assets_dir=deps.paths.assets_dir)
    except Exception as e:
        # Matched by name: the render module is another agent's and is imported lazily.
        if type(e).__name__ == "ScriptTooLong":    # narration + end card over the cap: rewrite, don't retry
            return _redo(conn, video, f"- [video_too_long] render: {e}", deps, now)
        if type(e).__name__ == "FfmpegMissing":    # setup problem: hold (alerted once), not the video's fault
            raise Hold(str(e)) from None
        raise
    sha = file_sha256(Path(out.master))
    with tx(conn):
        conn.execute(
            "UPDATE revisions SET master_path=?, master_sha256=?, preview_path=?, cover_path=?, duration_s=?,"
            " content_hash=? WHERE id=?",
            (str(out.master), sha, str(out.preview), str(out.cover), float(out.duration_s),
             content_hash(sha, rev["metadata_json"]), rev["id"]))
        return set_state(conn, video["id"], V.RENDERED, now)


def _step_qa(conn: sqlite3.Connection, video: Any, deps: Deps, now: datetime) -> VideoState:
    rev = latest_revision(conn, video["id"])
    qa = deps.fn("probe")(Path(rev["master_path"]))
    checks = json.loads(rev["checks_json"] or "{}")
    checks["qa"] = {"ok": bool(qa.ok), "issues": [{"code": "qa", "message": p, "blocking": True} for p in qa.problems]}
    with tx(conn):
        conn.execute("UPDATE revisions SET checks_json = ? WHERE id = ?",
                     (json.dumps(checks, ensure_ascii=False), rev["id"]))
        if not qa.ok:
            alert(conn, video["id"], f"व्हिडिओ #{video['id']}: रेंडर QA अयशस्वी: {'; '.join(qa.problems)[:500]}")
            return set_state(conn, video["id"], V.BLOCKED, now, error="render QA failed")
        state = set_state(conn, video["id"], V.QA_PASSED, now)
    shutil.rmtree(deps.paths.video_work(video["id"]), ignore_errors=True)   # retention: work dir after QA
    return state


def _step_card(conn: sqlite3.Connection, video: Any, deps: Deps, now: datetime) -> VideoState:
    rev = latest_revision(conn, video["id"])
    pending = conn.execute("SELECT message_ids_json FROM approvals WHERE revision_id = ? AND status = ?",
                           (rev["id"], ApprovalStatus.PENDING.value)).fetchone()
    if pending and json.loads(pending["message_ids_json"] or "[]"):
        return set_state(conn, video["id"], V.AWAITING_APPROVAL, now)   # card went out before a crash
    # No pending approval, or one whose messages never went out (crash mid-send): send_card
    # supersedes the half-sent one, so its buttons can never approve anything.
    _, chat_id = deps.fn("owner")(conn)
    if chat_id is None:
        raise Hold("telegram not paired: run `ksm pair-telegram`")
    deps.fn("send_card")(conn, deps.client("telegram"), chat_id=chat_id, revision_row=rev, video_row=video,
                         slot_row=slot_row_of(conn, video["id"]), settings=deps.settings,
                         cost_inr=video_spend(conn, video["id"]), now=now)
    return set_state(conn, video["id"], V.AWAITING_APPROVAL, now)


def _step_approved(conn: sqlite3.Connection, video: Any, deps: Deps, now: datetime) -> VideoState:
    slot = video_slot(conn, video, deps.settings)
    if slot is None:
        return V.APPROVED          # evergreen buffer: waits for reconcile to bind it to a slot
    rev = latest_revision(conn, video["id"])
    appr = approved_approval(conn, rev)
    if appr is None:   # never publish without an approval bound to this exact content
        alert(conn, video["id"], f"व्हिडिओ #{video['id']}: मंजुरी या आवृत्तीशी जुळत नाही; कार्ड पुन्हा पाठवत आहे.")
        return set_state(conn, video["id"], V.QA_PASSED, now)
    platforms = [p for p in json.loads(appr["platforms_json"] or "[]") if p in ALL_PLATFORMS]
    enabled = set(deps.get_publishers())
    with tx(conn):
        for p in platforms:
            state = PubState.PENDING if p in enabled else PubState.SKIPPED
            conn.execute(
                "INSERT OR IGNORE INTO publications(video_id, revision_id, platform, state, last_error) VALUES (?,?,?,?,?)",
                (video["id"], rev["id"], p, state.value, None if p in enabled else "platform not enabled"))
        return set_state(conn, video["id"], V.PUBLISHING, now)


def _late_rule(conn: sqlite3.Connection, video: Any, pub: Any, slot: Slot, deps: Deps, now: datetime) -> bool:
    """After the slot's cut-off: time-sensitive posts expire, evergreen ones move to the next free
    slot. Applies to Instagram always (it has no scheduling) and to YouTube/Facebook while the
    platform has not got the post yet. Returns True if the publication was changed."""
    if now <= slot.late_until or PubState(pub["state"]) in PUB_FINAL:
        return False
    if pub["platform"] != "ig":
        if pub["remote_id"] or PubState(pub["state"]) in PUB_REMOTE:
            return False   # the platform has it (scheduled or public): nothing left to stop
        if pub["upload_session_uri"] or pub["container_id"]:
            # An interrupted upload: nothing is visible yet, but its session may carry the old
            # publish time, so an evergreen one is left to finish rather than moved. A
            # time-sensitive one must not be completed a day late (stale prices).
            if not video["time_sensitive"]:
                return False
    nxt = None if video["time_sensitive"] else next_free_slot(conn, now, deps.settings)
    with tx(conn):
        if nxt is None:
            conn.execute("UPDATE publications SET state = ?, last_error = ?, next_attempt_at = NULL WHERE id = ?",
                         (PubState.EXPIRED.value, f"cut-off {iso(slot.late_until)} passed", pub["id"]))
            log_event(conn, "publish_state", video["id"], platform=pub["platform"], pub_id=pub["id"],
                      state=PubState.EXPIRED.value, reason="late cut-off")
        else:
            kv_set(conn, f"pubslot:{pub['id']}", slot_to_json(nxt))
            conn.execute("UPDATE publications SET state = ?, next_attempt_at = NULL WHERE id = ?",
                         (PubState.PENDING.value, pub["id"]))
            log_event(conn, "publish_moved", video["id"], platform=pub["platform"], pub_id=pub["id"], slot=nxt.id)
    return True


def _pub_success(pub: Any, slot: Slot, deps: Deps, now: datetime) -> bool:
    st = PubState(pub["state"])
    if st is PubState.VERIFIED:
        return True
    # Dry-run publishers stop at SCHEDULED/PUBLISHED (nothing to verify remotely).
    return deps.settings.dry_run and st in (PubState.PUBLISHED, PubState.SCHEDULED) and now >= slot.publish_at


def _step_publishing(conn: sqlite3.Connection, video: Any, deps: Deps, now: datetime) -> VideoState:
    base = video_slot(conn, video, deps.settings)
    if base is None:
        alert(conn, video["id"], f"व्हिडिओ #{video['id']} प्रकाशित होत आहे पण स्लॉट नाही.")
        raise Hold("publishing video has no slot")
    publishers = deps.get_publishers()
    for pub in conn.execute("SELECT * FROM publications WHERE video_id = ? ORDER BY id", (video["id"],)).fetchall():
        if PubState(pub["state"]) in PUB_FINAL:
            continue
        slot = pub_slot(conn, pub, base)
        if _late_rule(conn, video, pub, slot, deps, now):
            pub = conn.execute("SELECT * FROM publications WHERE id = ?", (pub["id"],)).fetchone()
            if PubState(pub["state"]) in PUB_FINAL:
                continue
            slot = pub_slot(conn, pub, base)
        if (in_quiet_hours(now, deps.settings.quiet_hours) and slot.publish_at <= now + IMMEDIATE
                and PubState(pub["state"]) not in PUB_REMOTE):
            continue   # would post right now, inside quiet hours (verifying a scheduled post is fine)
        rev = conn.execute("SELECT * FROM revisions WHERE id = ?", (pub["revision_id"],)).fetchone()
        if approved_approval(conn, rev) is None:
            alert(conn, video["id"], f"{pub['platform']}: मंजुरी जुळत नाही; प्रकाशन थांबवले.")
            continue
        publisher = publishers.get(pub["platform"])
        if publisher is None:
            conn.execute("UPDATE publications SET state = ?, last_error = ? WHERE id = ?",
                         (PubState.SKIPPED.value, "platform not enabled", pub["id"]))
            continue
        try:
            publisher.ensure(conn, pub, rev, now=now, slot=slot)
        except Exception as e:   # noqa: BLE001 - one platform must not stop the others
            log.exception("publisher %s failed", pub["platform"])
            log_event(conn, "publish_exception", video["id"], platform=pub["platform"], pub_id=pub["id"],
                      error=f"{type(e).__name__}: {e}"[:500])
            alert(conn, video["id"], f"{pub['platform']} प्रकाशन त्रुटी: {type(e).__name__}: {str(e)[:300]}")
    return _finalize(conn, video, base, deps, now)


def _finalize(conn: sqlite3.Connection, video: Any, base: Slot, deps: Deps, now: datetime) -> VideoState:
    pubs = conn.execute("SELECT * FROM publications WHERE video_id = ?", (video["id"],)).fetchall()
    ok, failed, expired, pending = 0, 0, 0, 0
    for p in pubs:
        st = PubState(p["state"])
        if _pub_success(p, pub_slot(conn, p, base), deps, now):
            ok += 1
        elif st is PubState.FATAL:
            failed += 1
        elif st is PubState.EXPIRED:
            expired += 1
        elif st is not PubState.SKIPPED:
            pending += 1
    if pending:
        return V.PUBLISHING
    if ok and not (failed or expired):
        return set_state(conn, video["id"], V.DONE, now)
    if ok:
        alert(conn, video["id"], f"व्हिडिओ #{video['id']}: काही प्लॅटफॉर्मवरच प्रकाशित झाला.")
        return set_state(conn, video["id"], V.PARTIAL, now)
    if failed:
        alert(conn, video["id"], f"व्हिडिओ #{video['id']}: कोणत्याही प्लॅटफॉर्मवर प्रकाशित झाला नाही.")
        return set_state(conn, video["id"], V.BLOCKED, now, error="all publications failed")
    return set_state(conn, video["id"], V.EXPIRED, now, error="all publications expired or skipped")


STEPS: dict[VideoState, Callable[[sqlite3.Connection, Any, Deps, datetime], VideoState]] = {
    V.PLANNED: _step_planned,
    V.DATA_READY: _step_script,
    V.NEEDS_REDO: _step_script,
    V.SCRIPTED: _step_check,
    V.CHECKED: _step_voice,
    V.VOICED: _step_render,
    V.RENDERED: _step_qa,
    V.QA_PASSED: _step_card,
    V.APPROVED: _step_approved,
    V.PUBLISHING: _step_publishing,
}


# ── expiry ────────────────────────────────────────────────────────────────────


def close_pending_cards(conn: sqlite3.Connection, video_id: int, deps: Deps, status: ApprovalStatus,
                        text: str | None) -> None:
    rows = conn.execute(
        "SELECT a.* FROM approvals a JOIN revisions r ON r.id = a.revision_id WHERE r.video_id = ? AND a.status = ?",
        (video_id, ApprovalStatus.PENDING.value)).fetchall()
    if not rows:
        return
    with tx(conn):
        for a in rows:
            conn.execute("UPDATE approvals SET status = ? WHERE id = ? AND status = ?",
                         (status.value, a["id"], ApprovalStatus.PENDING.value))
    _close_cards(conn, deps, [json.loads(a["message_ids_json"] or "[]") for a in rows], text)


def _close_cards(conn: sqlite3.Connection, deps: Deps, message_id_lists: list[list[int]], text: str | None) -> None:
    try:
        _, chat_id = deps.fn("owner")(conn)
        if chat_id is None:
            return
        tg = deps.client("telegram")
        for i, ids in enumerate(message_id_lists):
            deps.fn("close_card")(tg, chat_id, ids, text if i == 0 else None)
    except Exception as e:   # noqa: BLE001 - closing a card is cosmetic; the DB is the truth
        log.warning("closing card failed: %s", e)


def expire_video(conn: sqlite3.Connection, video: Any, deps: Deps, now: datetime, reason: str,
                 state: VideoState = V.EXPIRED) -> VideoState:
    """Stale before publishing: close its card, free its slot (if still ahead) for the buffer."""
    close_pending_cards(conn, video["id"], deps, ApprovalStatus.EXPIRED, f"⌛ कालबाह्य: #{video['id']} ({reason})")
    with tx(conn):
        conn.execute("UPDATE slots SET video_id = NULL, state = 'open' WHERE video_id = ? AND late_until > ?",
                     (video["id"], iso(now)))
        conn.execute("UPDATE slots SET video_id = NULL WHERE video_id = ?", (video["id"],))
        return set_state(conn, video["id"], state, now, error=reason)


def is_stale(video: Any, now: datetime) -> bool:
    fu = parse_iso(video["fresh_until"])
    return bool(video["time_sensitive"]) and fu is not None and now > fu


# ── entry point ───────────────────────────────────────────────────────────────


def advance(conn: sqlite3.Connection, video_id: int, deps: Deps, now: datetime) -> VideoState:
    """Run exactly one step for the video; returns its (possibly unchanged) state."""
    video = video_row(conn, video_id)
    state = VideoState(video["state"])
    if state in TERMINAL_VIDEO_STATES:
        return state
    if state in PRE_PUBLISH_STATES and is_stale(video, now):
        return expire_video(conn, video, deps, now, "fresh_until passed")
    step = STEPS.get(state)
    if step is None:
        return state            # AWAITING_APPROVAL: waits for a decision
    if state in PAID_FROM and budget_state(conn, deps.settings, now) == "exhausted":
        return state            # no new production once the monthly budget is spent
    fail_key = f"stepfail:{video_id}"
    prev = json.loads(kv_get(conn, fail_key) or "{}")
    retry_at = parse_iso(prev.get("retry_at")) if prev.get("state") == state.value else None
    if retry_at is not None and now < retry_at:
        return state            # backing off after a failure (e.g. Wi-Fi not back yet after a wake)
    try:
        new = step(conn, video, deps, now)
    except (Hold, SecretMissing) as h:   # a missing Keychain secret is a setup problem, not the video's
        if kv_get(conn, f"hold:{video_id}") != str(h):
            kv_set(conn, f"hold:{video_id}", str(h))
            alert(conn, video_id, f"व्हिडिओ #{video_id} थांबला: {h}")
        return state
    except Exception as e:   # noqa: BLE001 - a step failure must never kill the daemon
        log.exception("step %s failed for video %s", state.value, video_id)
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        n = prev.get("n", 0) + 1 if prev.get("state") == state.value else 1
        wait = min(STEP_RETRY_BASE * 2 ** (n - 1), STEP_RETRY_MAX)
        kv_set(conn, fail_key, json.dumps({"state": state.value, "n": n, "retry_at": iso(now + wait)}))
        log_event(conn, "step_error", video_id, state=state.value, attempt=n, error=f"{type(e).__name__}: {e}"[:500])
        if n >= MAX_STEP_FAILURES:
            alert(conn, video_id, f"व्हिडिओ #{video_id}: '{state.value}' पायरी {n} वेळा अयशस्वी: {str(e)[:300]}")
            return set_state(conn, video_id, V.BLOCKED, now, error=f"{type(e).__name__}: {e}"[:500])
        conn.execute("UPDATE videos SET error = ? WHERE id = ?", (f"{type(e).__name__}: {e}"[:500], video_id))
        return state
    conn.execute("DELETE FROM kv WHERE key IN (?, ?)", (fail_key, f"hold:{video_id}"))
    return new


# ── founder decisions ─────────────────────────────────────────────────────────


def _edited_metadata(rev: Any, d: Decision) -> dict | None:
    target = EDIT_TARGETS.get(d.edit_field or "")
    if target is None or not (d.edit_value or "").strip():
        return None
    meta = json.loads(rev["metadata_json"] or "{}")
    meta.setdefault(target[0], {})[target[1]] = d.edit_value
    return meta


def _edit_problem(conn: sqlite3.Connection, d: Decision, video: Any, rev: Any, deps: Deps) -> str | None:
    """Why an edit cannot be applied, or None. The founder's text is published as-is, so it
    goes through the same deterministic checks as the writer's (numbers, chemicals, rules,
    limits) — the safety rules hold for every word that is posted, whoever typed it."""
    meta = _edited_metadata(rev, d)
    if meta is None:
        return f"unknown edit field {d.edit_field!r} or empty text"
    data = json.loads(rev["script_json"])
    for p in ALL_PLATFORMS:
        for k, v in (meta.get(p) or {}).items():
            if k in data["platform"][p]:
                data["platform"][p][k] = v
    srow = slot_row_of(conn, video["id"])
    report = deps.fn("run_checks")(
        VideoScript.model_validate(data), json.loads(video["payload_json"] or "{}"), series=video["series"],
        app_cta_url=deps.settings.app_cta_url,
        extra_allowed=extra_allowed_numbers(video, slot_from_row(srow) if srow else None))
    return None if report.ok else report.feedback()


def apply_decision(conn: sqlite3.Connection, d: Decision, deps: Deps, now: datetime) -> bool:
    """Apply one Telegram decision. Idempotent: only a still-pending approval is acted on."""
    if d.action == "toggle_platform":
        return False   # the approve module already persisted the selection on the approval
    appr = conn.execute("SELECT * FROM approvals WHERE id = ?", (d.approval_id,)).fetchone()
    if appr is None or appr["status"] != ApprovalStatus.PENDING.value:
        return False
    rev = conn.execute("SELECT * FROM revisions WHERE id = ?", (appr["revision_id"],)).fetchone()
    video = video_row(conn, rev["video_id"])
    latest = latest_revision(conn, video["id"])
    msg_ids = json.loads(appr["message_ids_json"] or "[]")
    stale = (latest["id"] != rev["id"] or VideoState(video["state"]) != V.AWAITING_APPROVAL
             or not rev["content_hash"] or appr["content_hash"] != rev["content_hash"])
    if stale:
        with tx(conn):
            conn.execute("UPDATE approvals SET status = ? WHERE id = ?", (ApprovalStatus.SUPERSEDED.value, appr["id"]))
            log_event(conn, "decision_stale", video["id"], approval_id=appr["id"], action=d.action)
        _close_cards(conn, deps, [msg_ids], "हे कार्ड जुने आहे")
        return False

    vid = video["id"]
    if d.action == "edit":
        problem = _edit_problem(conn, d, video, rev, deps)
        if problem:
            # Refused: the recorded decision must not stay on a pending approval (it would be
            # re-read every tick and block re-sends), so the card is replaced by a fresh one.
            with tx(conn):
                conn.execute("UPDATE approvals SET status = ? WHERE id = ?",
                             (ApprovalStatus.SUPERSEDED.value, appr["id"]))
                set_state(conn, vid, V.QA_PASSED, now)
                log_event(conn, "decision_refused", vid, approval_id=appr["id"], action=d.action, reason=problem)
            _close_cards(conn, deps, [msg_ids], f"❌ बदल नाकारला: {problem[:600]}\nजुने कार्ड पुन्हा येत आहे.")
            return False
    text: str
    with tx(conn):
        if d.action in ("approve", "post_now"):
            platforms = [p for p in (d.platforms or json.loads(appr["platforms_json"] or "[]")) if p in ALL_PLATFORMS]
            exhausted = budget_state(conn, deps.settings, now) == "exhausted"
            if not platforms or exhausted:
                # Not applied: expire this card; the video goes back to QA_PASSED, which re-sends a
                # card once the step may run again (budget steps are held while exhausted).
                conn.execute("UPDATE approvals SET status = ? WHERE id = ?", (ApprovalStatus.EXPIRED.value, appr["id"]))
                set_state(conn, vid, V.QA_PASSED, now)
                if exhausted:
                    alert(conn, vid, f"बजेट संपले: व्हिडिओ #{vid} ची मंजुरी नोंदवली नाही; पुढच्या महिन्यात कार्ड पुन्हा येईल.")
                text = "बजेट संपले — नंतर पुन्हा कार्ड येईल" if exhausted else "किमान एक प्लॅटफॉर्म निवडा"
                log_event(conn, "decision_refused", vid, approval_id=appr["id"], action=d.action)
            else:
                conn.execute("UPDATE approvals SET status = ?, platforms_json = ?, decided_at = COALESCE(decided_at, ?)"
                             " WHERE id = ? AND status = ?",
                             (ApprovalStatus.APPROVED.value, json.dumps(platforms), iso(now), appr["id"],
                              ApprovalStatus.PENDING.value))
                if d.action == "post_now":
                    kv_set(conn, f"post_now:{vid}", iso(now))
                set_state(conn, vid, V.APPROVED, now)
                text = "⚡ आत्ताच प्रकाशित होत आहे" if d.action == "post_now" else "✅ मंजूर — वेळेवर प्रकाशित होईल"
        elif d.action == "skip":
            conn.execute("UPDATE approvals SET status = ?, decided_at = COALESCE(decided_at, ?) WHERE id = ?",
                         (ApprovalStatus.REJECTED.value, iso(now), appr["id"]))
            conn.execute("UPDATE slots SET video_id = NULL, state = 'open' WHERE video_id = ? AND late_until > ?",
                         (vid, iso(now)))
            conn.execute("UPDATE slots SET video_id = NULL WHERE video_id = ?", (vid,))
            set_state(conn, vid, V.REJECTED, now)
            text = "⏭ वगळले"
        elif d.action == "redo":
            conn.execute("UPDATE approvals SET status = ?, decided_at = COALESCE(decided_at, ?) WHERE id = ?",
                         (ApprovalStatus.REJECTED.value, iso(now), appr["id"]))
            set_state(conn, vid, V.NEEDS_REDO, now,
                      feedback=f"- [founder_redo] The founder rejected this version (reason: {d.reason or 'other'}). "
                               "Write a clearly improved script.")
            text = f"🔄 पुन्हा बनवत आहे ({d.reason})"
        elif d.action == "edit":
            meta = _edited_metadata(rev, d)
            assert meta is not None   # validated by _edit_problem above
            meta_json = json.dumps(meta, ensure_ascii=False)
            n = conn.execute("SELECT MAX(rev_no) + 1 AS n FROM revisions WHERE video_id = ?", (vid,)).fetchone()["n"]
            conn.execute(
                "INSERT INTO revisions(video_id, rev_no, script_json, metadata_json, checks_json, timeline_json,"
                " master_path, master_sha256, preview_path, cover_path, duration_s, content_hash, prompt_version,"
                " created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (vid, n, rev["script_json"], meta_json, rev["checks_json"], rev["timeline_json"], rev["master_path"],
                 rev["master_sha256"], rev["preview_path"], rev["cover_path"], rev["duration_s"],
                 content_hash(rev["master_sha256"] or "", meta_json), rev["prompt_version"], iso(now)))
            conn.execute("UPDATE approvals SET status = ? WHERE id = ?", (ApprovalStatus.SUPERSEDED.value, appr["id"]))
            set_state(conn, vid, V.QA_PASSED, now)   # a new card (new approval) goes out next step
            text = "✏️ बदल नोंदवला; नवीन कार्ड येत आहे"
        else:
            return False
        log_event(conn, "decision_applied", vid, approval_id=appr["id"], action=d.action)
    _close_cards(conn, deps, [msg_ids], text)
    return True


__all__ = ["Deps", "HEAVY_FROM", "Hold", "PRODUCTION_STATES", "advance", "apply_decision", "approved_approval",
           "content_hash", "expire_video", "keep_awake", "latest_revision", "next_free_slot", "plan_of",
           "set_state", "slot_from_row", "slot_to_json", "video_slot"]
