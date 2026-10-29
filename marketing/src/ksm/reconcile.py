"""One reconcile tick (plan §4): bring the database in line with the clock.

The Mac sleeps unpredictably, so nothing here assumes the previous tick was a minute ago.
Each tick is idempotent and safe to repeat:
  1. ensure slot rows for the next 48 h (slots that passed while asleep are recorded missed);
  2. apply founder decisions (in-process queue + decisions persisted on approvals);
  3. mark missed slots (never backfilled) and expire stale time-sensitive videos;
  4. fetch Agmarknet when a fresh slot is waiting for data;
  5. fill slots whose production window opened (fresh plan > approved evergreen buffer > new evergreen);
  6. keep the evergreen buffer at settings.evergreen_min_approved;
  7. advance production, at most ONE heavy (TTS/render) step per tick, only if guards allow;
  8. re-send approval cards older than settings.approval_resend_after_hours (all of them on wake);
  9. publish: approved videos get publications, due publications go through the publishers;
 10. retention purge; 11. deliver alerts to Telegram.
"""
from __future__ import annotations

import hashlib
import json
import logging
import queue
import shutil
import sqlite3
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

from .clock import build_slot, ist_date, upcoming_slots
from .db import iso, kv_get, kv_set, log_event, parse_iso, tx
from .models import ApprovalStatus, Decision, Slot, SlotKind, VideoPlan, VideoState
from .paths import Paths
from .statemachine import (HEAVY_FROM, PRE_PUBLISH_STATES, PRODUCTION_STATES, Deps, advance, apply_decision,
                           expire_video, is_stale, latest_revision, slot_from_row)

log = logging.getLogger(__name__)
V = VideoState

HORIZON = timedelta(hours=48)
FETCH_EVERY = timedelta(minutes=30)
FRESH_WAIT = timedelta(hours=2)          # wait this long after produce_from for the day's prices
MAX_STEPS_PER_VIDEO = 12
ALERT_DEDUPE = timedelta(hours=6)
MAX_ALERTS_PER_MESSAGE = 10
PREVIEW_KEEP = timedelta(days=1)
MASTER_KEEP = timedelta(days=3)
BACKFILL_RECORD_DAYS = 14


@dataclass
class TickReport:
    created: list[int] = field(default_factory=list)
    bound: list[tuple[str, int]] = field(default_factory=list)
    steps: int = 0
    heavy: int = 0
    decisions: int = 0
    resent: int = 0
    missed: list[str] = field(default_factory=list)
    expired: list[int] = field(default_factory=list)
    purged: int = 0
    alerts_sent: int = 0
    guard_reasons: list[str] = field(default_factory=list)


# ── slots ─────────────────────────────────────────────────────────────────────


def _insert_slot(conn: sqlite3.Connection, s: Slot, state: str = "open") -> None:
    conn.execute(
        "INSERT OR IGNORE INTO slots(id, slot_date, kind, publish_at, produce_from, approve_by, late_until, state)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (s.id, s.slot_date.isoformat(), s.kind.value, iso(s.publish_at), iso(s.produce_from), iso(s.approve_by),
         iso(s.late_until), state))


def ensure_slots(conn: sqlite3.Connection, now: datetime, deps: Deps, last_tick: datetime | None) -> list[str]:
    """Slot rows for the horizon; slots that came and went while we were not running are
    recorded as missed (for the report) — they are never produced."""
    recorded: list[str] = []
    with tx(conn):
        for s in upcoming_slots(now, deps.settings, HORIZON):
            _insert_slot(conn, s)
        if last_tick is not None:
            start = max(ist_date(last_tick), ist_date(now) - timedelta(days=BACKFILL_RECORD_DAYS))
            d = start
            while d <= ist_date(now):
                for w in deps.settings.slots:
                    s = build_slot(d, w)
                    if last_tick < s.publish_at and s.late_until <= now:
                        if conn.execute("SELECT 1 FROM slots WHERE id = ?", (s.id,)).fetchone() is None:
                            _insert_slot(conn, s, "missed")
                            recorded.append(s.id)
                d += timedelta(days=1)
    return recorded


def mark_missed(conn: sqlite3.Connection, deps: Deps, now: datetime) -> list[str]:
    missed: list[str] = []
    rows = conn.execute("SELECT * FROM slots WHERE state IN ('open','filled') AND late_until <= ?",
                        (iso(now),)).fetchall()
    for s in rows:
        vid = s["video_id"]
        video = conn.execute("SELECT * FROM videos WHERE id = ?", (vid,)).fetchone() if vid else None
        if video is not None and V(video["state"]) not in PRE_PUBLISH_STATES:
            continue   # publishing (or published): the slot was used
        if video is not None and kv_get(conn, f"post_now:{vid}"):
            continue
        if video is not None:
            if video["time_sensitive"]:
                expire_video(conn, video, deps, now, f"slot {s['id']} missed", state=V.MISSED)
            else:   # evergreen: back to the buffer for a later slot
                with tx(conn):
                    conn.execute("UPDATE slots SET video_id = NULL WHERE id = ?", (s["id"],))
                    log_event(conn, "slot_unbound", vid, slot=s["id"])
        with tx(conn):
            conn.execute("UPDATE slots SET state = 'missed', video_id = NULL WHERE id = ? AND state IN ('open','filled')",
                         (s["id"],))
            log_event(conn, "slot_missed", vid, slot=s["id"])
        missed.append(s["id"])
    return missed


def expire_stale(conn: sqlite3.Connection, deps: Deps, now: datetime) -> list[int]:
    states = tuple(s.value for s in PRE_PUBLISH_STATES)
    out = []
    for v in conn.execute(f"SELECT * FROM videos WHERE time_sensitive = 1 AND state IN ({','.join('?' * len(states))})",
                          states).fetchall():
        if is_stale(v, now):
            expire_video(conn, v, deps, now, "fresh_until passed")
            out.append(v["id"])
    return out


# ── data + planning ───────────────────────────────────────────────────────────


def fetch_mandi(conn: sqlite3.Connection, deps: Deps, now: datetime) -> list:
    """Default Agmarknet fetch: today's (IST) rows for Maharashtra into data_snapshots."""
    from .secrets import get_secret
    from .sources.agmarknet import fetch_snapshot, store_snapshot  # lazy: sources module

    rows = fetch_snapshot(deps.client("http"), get_secret("datagov_api_key"), today=ist_date(now))
    return store_snapshot(conn, rows, now=now)


def _open_slots(conn: sqlite3.Connection, now: datetime) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM slots WHERE state = 'open' AND video_id IS NULL AND produce_from <= ? AND late_until > ?"
        " ORDER BY publish_at", (iso(now), iso(now))).fetchall()


def maybe_fetch_mandi(conn: sqlite3.Connection, deps: Deps, now: datetime) -> bool:
    waiting = [s for s in _open_slots(conn, now) if s["kind"] == SlotKind.FRESH.value
               and not deps.fn("fresh_data_ready")(conn, slot_from_row(s).slot_date)]
    if not waiting:
        return False
    last = parse_iso(kv_get(conn, "mandi_fetch_at"))
    if last is not None and now - last < FETCH_EVERY:
        return False
    kv_set(conn, "mandi_fetch_at", iso(now))
    try:
        deps.fn("fetch_mandi")(conn, deps, now)
    except Exception as e:   # noqa: BLE001 - no data means an evergreen fills the slot
        log.warning("mandi fetch failed: %s", e)
        log_event(conn, "mandi_fetch_error", None, error=f"{type(e).__name__}: {e}"[:300])
        return False
    return True


def create_video(conn: sqlite3.Connection, plan: VideoPlan, now: datetime, slot_id: str | None = None) -> int | None:
    """Insert a PLANNED video (optionally bound to a slot). None if the same video already exists."""
    with tx(conn):
        cur = conn.execute(
            "INSERT OR IGNORE INTO videos(series, topic_key, data_date, evergreen, time_sensitive, fresh_until,"
            " payload_json, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (plan.series, plan.topic_key, plan.data_date.isoformat() if plan.data_date else None, int(plan.evergreen),
             int(plan.time_sensitive), iso(plan.fresh_until), json.dumps(plan.payload, ensure_ascii=False, default=str),
             V.PLANNED.value, iso(now), iso(now)))
        if cur.rowcount == 0:
            return None
        vid = int(cur.lastrowid)
        log_event(conn, "video_planned", vid, series=plan.series, topic=plan.topic_key, slot=slot_id)
        if slot_id:
            _bind(conn, slot_id, vid)
    return vid


def _bind(conn: sqlite3.Connection, slot_id: str, video_id: int) -> bool:
    cur = conn.execute("UPDATE slots SET video_id = ?, state = 'filled' WHERE id = ? AND video_id IS NULL AND state = 'open'",
                       (video_id, slot_id))
    if cur.rowcount:
        log_event(conn, "slot_bound", video_id, slot=slot_id)
    return bool(cur.rowcount)


def _unbound_evergreen(conn: sqlite3.Connection, states: tuple[VideoState, ...]) -> list[sqlite3.Row]:
    """Buffer videos not bound to a slot. A 'post now' video is excluded: it publishes at the
    tap, so binding it would leave that slot silently empty (mark_missed skips post-now slots)."""
    vals = tuple(s.value for s in states)
    return conn.execute(
        f"SELECT v.* FROM videos v WHERE v.evergreen = 1 AND v.state IN ({','.join('?' * len(vals))})"
        " AND NOT EXISTS (SELECT 1 FROM slots s WHERE s.video_id = v.id)"
        " AND NOT EXISTS (SELECT 1 FROM kv WHERE kv.key = 'post_now:' || v.id) ORDER BY v.id", vals).fetchall()


def _safe_plan(conn: sqlite3.Connection, what: str, fn) -> VideoPlan | None:  # noqa: ANN001
    """A config error (e.g. a bad advisories.yaml edit) must not stop publishing; it is alerted."""
    try:
        return fn()
    except Exception as e:   # noqa: BLE001
        log.exception("%s failed", what)
        log_event(conn, "alert", None, source="planner",
                  message=f"नियोजन त्रुटी ({what}): {type(e).__name__}: {str(e)[:300]}")
        return None


def fill_slots(conn: sqlite3.Connection, deps: Deps, now: datetime, guard, report: TickReport) -> None:
    for srow in _open_slots(conn, now):
        slot = slot_from_row(srow)
        if (slot.kind == SlotKind.FRESH and not deps.fn("fresh_data_ready")(conn, slot.slot_date)
                and now < slot.produce_from + FRESH_WAIT):
            continue   # the day's prices may still arrive
        plan = None
        if guard.production_ok and now < slot.approve_by:
            plan = _safe_plan(conn, "plan_slot", lambda: deps.fn("plan_slot")(conn, slot, now, deps.settings))
        if plan is not None and not plan.evergreen:
            vid = create_video(conn, plan, now, slot.id)
            if vid:
                report.created.append(vid)
            continue
        # Evergreen: an approved buffer video first, then one still in production, then a new one.
        buffered = _unbound_evergreen(conn, (V.APPROVED,)) or _unbound_evergreen(
            conn, (*PRODUCTION_STATES, V.AWAITING_APPROVAL))
        if buffered:
            with tx(conn):
                if _bind(conn, slot.id, buffered[0]["id"]):
                    report.bound.append((slot.id, buffered[0]["id"]))
            continue
        if plan is not None:
            vid = create_video(conn, plan, now, slot.id)
            if vid:
                report.created.append(vid)


def top_up_buffer(conn: sqlite3.Connection, deps: Deps, now: datetime, guard, report: TickReport) -> None:
    if not guard.production_ok:
        return
    have = len(_unbound_evergreen(conn, (*PRODUCTION_STATES, V.AWAITING_APPROVAL, V.APPROVED)))
    if have >= deps.settings.evergreen_min_approved:
        return
    plan = _safe_plan(conn, "plan_evergreen", lambda: deps.fn("plan_evergreen")(
        conn, now, deps.settings, seed=f"buffer-{ist_date(now)}-{have}", kind=None))
    if plan is not None:
        vid = create_video(conn, plan, now)
        if vid:
            report.created.append(vid)


# ── production ────────────────────────────────────────────────────────────────


def _production_queue(conn: sqlite3.Connection) -> list[int]:
    vals = tuple(s.value for s in PRODUCTION_STATES)
    rows = conn.execute(
        f"SELECT v.id FROM videos v LEFT JOIN slots s ON s.video_id = v.id WHERE v.state IN ({','.join('?' * len(vals))})"
        " ORDER BY s.publish_at IS NULL, s.publish_at, v.id", vals).fetchall()
    return [r["id"] for r in rows]


def produce(conn: sqlite3.Connection, deps: Deps, now: datetime, guard, report: TickReport) -> None:
    """Light steps run freely; at most ONE heavy step (TTS / render) per tick, so the Mac stays
    responsive and a tick never runs for long."""
    if not guard.production_ok:
        return
    for vid in _production_queue(conn):
        for _ in range(MAX_STEPS_PER_VIDEO):
            state = V(conn.execute("SELECT state FROM videos WHERE id = ?", (vid,)).fetchone()["state"])
            if state not in PRODUCTION_STATES:
                break
            if state in HEAVY_FROM:
                if report.heavy or not guard.render_ok:
                    break
                report.heavy += 1
            new = advance(conn, vid, deps, now)
            report.steps += 1
            if new == state:
                break


# ── approvals ─────────────────────────────────────────────────────────────────


def collect_decisions(conn: sqlite3.Connection, deps: Deps) -> list[Decision]:
    out: list[Decision] = []
    if deps.decisions is not None:
        while True:
            try:
                out.append(deps.decisions.get_nowait())
            except queue.Empty:
                break
    try:
        out += deps.fn("pending_decisions")(conn)
    except Exception as e:   # noqa: BLE001
        log.warning("pending_decisions failed: %s", e)
    seen: set[tuple] = set()
    uniq = []
    for d in out:
        key = (d.approval_id, d.action, d.edit_field, d.edit_value)
        if key not in seen:
            seen.add(key)
            uniq.append(d)
    return uniq


def resend_cards(conn: sqlite3.Connection, deps: Deps, now: datetime, woke: bool) -> int:
    """Telegram drops button taps after 24 h, so cards are replaced before then (and all of
    them after a sleep, when the founder's chat is likely full of stale buttons)."""
    cutoff = iso(now - timedelta(hours=deps.settings.approval_resend_after_hours))
    rows = conn.execute(
        "SELECT a.*, r.video_id FROM approvals a JOIN revisions r ON r.id = a.revision_id JOIN videos v ON v.id = r.video_id"
        " WHERE a.status = ? AND a.decision_json IS NULL AND v.state = ?"
        " AND ((? AND a.sent_at < ?) OR a.sent_at IS NULL OR a.sent_at <= ?)",   # not one sent earlier this tick
        (ApprovalStatus.PENDING.value, V.AWAITING_APPROVAL.value, int(woke), iso(now), cutoff)).fetchall()
    if not rows:
        return 0
    _, chat_id = deps.fn("owner")(conn)
    if chat_id is None:
        return 0
    n = 0
    for a in rows:
        video = conn.execute("SELECT * FROM videos WHERE id = ?", (a["video_id"],)).fetchone()
        rev = latest_revision(conn, video["id"])
        if rev is None or rev["id"] != a["revision_id"]:
            continue
        try:
            deps.fn("send_card")(conn, deps.client("telegram"), chat_id=chat_id, revision_row=rev, video_row=video,
                                 slot_row=conn.execute("SELECT * FROM slots WHERE video_id = ?", (video["id"],)).fetchone(),
                                 settings=deps.settings, now=now)
            n += 1
        except Exception as e:   # noqa: BLE001 - retried next tick
            log.warning("re-sending card for video %s failed: %s", video["id"], e)
            log_event(conn, "card_resend_error", video["id"], error=str(e)[:300])
    return n


# ── publishing ────────────────────────────────────────────────────────────────


def publish(conn: sqlite3.Connection, deps: Deps, now: datetime, report: TickReport) -> None:
    for r in conn.execute("SELECT id, state FROM videos WHERE state IN (?, ?) ORDER BY id",
                          (V.APPROVED.value, V.PUBLISHING.value)).fetchall():
        state = advance(conn, r["id"], deps, now)
        report.steps += 1
        if r["state"] == V.APPROVED.value and state == V.PUBLISHING:   # new publications: dispatch now
            advance(conn, r["id"], deps, now)


# ── retention ─────────────────────────────────────────────────────────────────


def _rm(path: str | None) -> bool:
    if not path:
        return False
    p = Path(path)
    try:
        if p.is_dir():
            shutil.rmtree(p)
            return True
        if p.exists():
            p.unlink()
            return True
    except OSError as e:
        log.warning("purge %s failed: %s", p, e)
    return False


def purge(conn: sqlite3.Connection, paths: Paths, now: datetime, *, aggressive: bool = False) -> int:
    """Work dirs once past QA; previews a day after the decision; masters 3 days after every
    platform finished. `aggressive` (disk below purge_disk_gb) drops the waiting periods."""
    n = 0
    preview_keep = timedelta(0) if aggressive else PREVIEW_KEEP
    master_keep = timedelta(0) if aggressive else MASTER_KEEP
    producing = {V.PLANNED.value, V.DATA_READY.value, V.NEEDS_REDO.value, V.SCRIPTED.value, V.CHECKED.value,
                 V.VOICED.value, V.RENDERED.value}
    if paths.work_dir.exists():
        for d in paths.work_dir.iterdir():
            vid = d.name[1:] if d.name.startswith("v") else ""
            row = conn.execute("SELECT state FROM videos WHERE id = ?", (int(vid),)).fetchone() if vid.isdigit() else None
            if row is None or row["state"] not in producing:
                n += _rm(str(d))

    terminal = ("DONE", "PARTIAL", "BLOCKED", "REJECTED", "EXPIRED", "MISSED")
    # Previews: the latest approval was decided (or the video ended) long enough ago.
    for v in conn.execute(
            "SELECT v.id, v.state, v.updated_at, (SELECT MAX(a.decided_at) FROM approvals a JOIN revisions r"
            " ON r.id = a.revision_id WHERE r.video_id = v.id AND a.status IN ('approved','rejected')) AS decided"
            " FROM videos v WHERE EXISTS (SELECT 1 FROM revisions r WHERE r.video_id = v.id AND r.preview_path IS NOT NULL)"
    ).fetchall():
        when = parse_iso(v["decided"]) or (parse_iso(v["updated_at"]) if v["state"] in terminal else None)
        pending = conn.execute("SELECT 1 FROM approvals a JOIN revisions r ON r.id = a.revision_id"
                               " WHERE r.video_id = ? AND a.status = 'pending'", (v["id"],)).fetchone()
        if when is None or pending or now - when < preview_keep:
            continue
        for r in conn.execute("SELECT DISTINCT preview_path FROM revisions WHERE video_id = ? AND preview_path IS NOT NULL",
                              (v["id"],)).fetchall():
            n += _rm(r["preview_path"])
        conn.execute("UPDATE revisions SET preview_path = NULL WHERE video_id = ?", (v["id"],))

    # Masters: only for finished videos (an approved/publishing video still needs its bytes).
    for v in conn.execute(f"SELECT id, updated_at FROM videos WHERE state IN ({','.join('?' * len(terminal))})",
                          terminal).fetchall():
        open_pubs = conn.execute("SELECT 1 FROM publications WHERE video_id = ? AND state NOT IN"
                                 " ('VERIFIED','FATAL','SKIPPED','EXPIRED','PUBLISHED')", (v["id"],)).fetchone()
        last = conn.execute("SELECT MAX(published_at) AS t FROM publications WHERE video_id = ?", (v["id"],)).fetchone()["t"]
        when = max(filter(None, (parse_iso(last), parse_iso(v["updated_at"]))))
        if open_pubs or now - when < master_keep:
            continue
        revs = conn.execute("SELECT id, master_path, cover_path FROM revisions WHERE video_id = ? AND"
                            " (master_path IS NOT NULL OR cover_path IS NOT NULL)", (v["id"],)).fetchall()
        if not revs:
            continue
        dirs = set()
        for r in revs:
            for p in (r["master_path"], r["cover_path"]):
                if p:
                    n += _rm(p)
                    dirs.add(Path(p).parent)
        for d in dirs:
            if d.is_dir() and d.parent == paths.renders_dir and not any(d.iterdir()):
                d.rmdir()
        conn.execute("UPDATE revisions SET master_path = NULL, cover_path = NULL WHERE video_id = ?", (v["id"],))
        log_event(conn, "purged_master", v["id"])
    return n


# ── alerts ────────────────────────────────────────────────────────────────────


def send_alerts(conn: sqlite3.Connection, deps: Deps, now: datetime) -> int:
    cursor = int(kv_get(conn, "alert_cursor") or 0)
    rows = conn.execute("SELECT id, video_id, json FROM events WHERE kind = 'alert' AND id > ? ORDER BY id LIMIT ?",
                        (cursor, MAX_ALERTS_PER_MESSAGE * 5)).fetchall()
    if not rows:
        return 0
    _, chat_id = deps.fn("owner")(conn)
    if chat_id is None:
        return 0
    lines: list[str] = []
    hashes: list[str] = []
    for r in rows:
        msg = str(json.loads(r["json"] or "{}").get("message") or "")
        h = hashlib.sha256(msg.encode()).hexdigest()[:16]
        last = parse_iso(kv_get(conn, f"alert_sent:{h}"))
        if msg and h not in hashes and (last is None or now - last >= ALERT_DEDUPE):
            hashes.append(h)
            lines.append(f"• {msg}")
    if lines:
        shown = lines[:MAX_ALERTS_PER_MESSAGE]
        if len(lines) > len(shown):
            shown.append(f"… आणखी {len(lines) - len(shown)} सूचना (`ksm report` पाहा)")
        try:
            deps.client("telegram").send_message(chat_id, "⚠️ सूचना\n" + "\n".join(shown), None, parse_mode=None)
        except Exception as e:   # noqa: BLE001 - try again next tick
            log.warning("alert delivery failed: %s", e)
            return 0
        # Marked as sent only once delivered, or a failed send would also silence the retry.
        for h in hashes:
            kv_set(conn, f"alert_sent:{h}", iso(now))
    kv_set(conn, "alert_cursor", str(rows[-1]["id"]))
    return len(lines)


GUARD_ALERT_EVERY = timedelta(hours=12)


def guard_alerts(conn: sqlite3.Connection, guard, now: datetime) -> None:  # noqa: ANN001 - GuardState
    """Low disk and budget pressure reach the founder (plan §4 'Alerts'). Rate-limited here, at
    write time, so a guard that stays on for days does not add an event row every tick."""
    msgs = {}
    if any(r.startswith("low disk") for r in guard.reasons):
        msgs["disk"] = f"डिस्क कमी: फक्त {guard.free_gb:.1f} GB मोकळी — नवीन व्हिडिओ बनवणे थांबले. जागा मोकळी करा."
    budget = getattr(guard, "budget", "ok")
    if budget == "exhausted":
        msgs["budget-exhausted"] = "या महिन्याचे बजेट संपले: नवीन व्हिडिओ बनणार नाहीत; आधी मंजूर केलेले प्रकाशित होतील."
    elif budget == "degraded":
        msgs["budget-degraded"] = "बजेटपैकी ८०% खर्च झाला: AI effort कमी केला आहे."
    elif budget == "warn":
        msgs["budget-warn"] = "खर्चाचा वेग जास्त: या गतीने महिना संपण्याआधी बजेट संपेल."
    for kind, msg in msgs.items():
        key = f"guard_alert:{kind}"   # stable per condition (the GB figure in the text changes)
        last = parse_iso(kv_get(conn, key))
        if last is None or now - last >= GUARD_ALERT_EVERY:
            kv_set(conn, key, iso(now))
            log_event(conn, "alert", None, source="guards", message=msg)


def welcome_back(conn: sqlite3.Connection, deps: Deps, slept_h: float | None, resent: int, missed: list[str]) -> None:
    _, chat_id = deps.fn("owner")(conn)
    if chat_id is None:
        return
    slept = f" (सुमारे {slept_h:.0f} तास)" if slept_h else ""
    text = (f"👋 परत सुरू: Mac झोपेत होता{slept}.\n"
            f"🔁 {resent} मंजुरी कार्डे पुन्हा पाठवली (जुनी बटणे आता चालणार नाहीत).\n"
            f"⏭ {len(missed)} स्लॉट चुकले — ते नंतर भरून काढले जाणार नाहीत.")
    try:
        deps.client("telegram").send_message(chat_id, text, None, parse_mode=None)
        log_event(conn, "welcome_back", None, resent=resent, missed=missed)
    except Exception as e:   # noqa: BLE001
        log.warning("welcome-back message failed: %s", e)


# ── the tick ──────────────────────────────────────────────────────────────────


def token_health(conn: sqlite3.Connection, deps: Deps, now: datetime) -> list[str]:
    """Once per IST day: refresh/verify the YouTube and Meta tokens. Doubles as YouTube's
    30-day re-authorisation check. Failures become Telegram alerts."""
    from .clock import ist_date
    from .doctor import live_checks

    today = ist_date(now).isoformat()
    if kv_get(conn, "token_health_day") == today:
        return []
    kv_set(conn, "token_health_day", today)
    import httpx

    with httpx.Client(timeout=30) as http:
        results = [r for r in live_checks(deps.settings, http)
                   if r.name in ("youtube channels.list", "meta debug_token")]
    failed = [f"{r.name}: {r.detail} → {r.hint}" for r in results if r.ok is False]
    for msg in failed:
        log_event(conn, "alert", None, source="token_health", message=f"टोकन तपासणी अयशस्वी: {msg}")
    return failed


def tick(conn: sqlite3.Connection, deps: Deps, now: datetime, woke: bool = False, *,
         slept_s: float | None = None) -> TickReport:
    report = TickReport()
    last = parse_iso(kv_get(conn, "last_tick"))
    guard = deps.fn("guards")(conn, deps.settings, now=now)
    report.guard_reasons = list(guard.reasons)
    guard_alerts(conn, guard, now)

    report.missed += ensure_slots(conn, now, deps, last)
    for d in collect_decisions(conn, deps):
        try:
            report.decisions += int(apply_decision(conn, d, deps, now))
        except Exception as e:   # noqa: BLE001 - a bad decision must not stop the tick
            log.exception("applying decision %s failed", d)
            log_event(conn, "decision_error", None, approval_id=d.approval_id, error=str(e)[:300])
    report.missed += mark_missed(conn, deps, now)
    report.expired += expire_stale(conn, deps, now)
    if guard.production_ok:
        maybe_fetch_mandi(conn, deps, now)
    fill_slots(conn, deps, now, guard, report)
    top_up_buffer(conn, deps, now, guard, report)
    produce(conn, deps, now, guard, report)
    report.resent = resend_cards(conn, deps, now, woke)
    if woke:
        welcome_back(conn, deps, (slept_s / 3600) if slept_s else None, report.resent, report.missed)
    elif report.missed:
        log_event(conn, "alert", None, source="reconcile", message=f"स्लॉट चुकले: {', '.join(report.missed)}")
    publish(conn, deps, now, report)
    if not deps.settings.dry_run:
        try:
            deps.fn("token_health")(conn, deps, now)
        except Exception as e:   # noqa: BLE001 - a health check must never stop the tick
            log.warning("token health check failed: %s", e)
    report.purged = purge(conn, deps.paths, now, aggressive=guard.purge_needed)
    report.alerts_sent = send_alerts(conn, deps, now)
    kv_set(conn, "last_tick", iso(now))
    return report
