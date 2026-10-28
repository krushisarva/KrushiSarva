"""End-to-end orchestration with fakes and a fake clock: slot → plan → script → checks → voice →
render → approval card → decision → publications → DONE, plus redo, crashes, edits and guards."""
from __future__ import annotations

import json
from datetime import timedelta

import pytest
from _core_fakes import SimulatedCrash, ist, make_world, pending_approval, video_state

from ksm.db import open_db
from ksm.models import Decision
from ksm.reconcile import tick
from ksm.statemachine import advance

PROD = [ist(2026, 10, 16, 21, 40 + i) for i in range(6)]      # evening before the 17 Oct fresh slot
AFTER_SLOT = [ist(2026, 10, 17, 7, 1 + i) for i in range(4)]  # 07:00 IST publish time has passed


def safe_tick(paths, world, now, woke=False):
    """One tick on a fresh connection (like a restarted process); a SimulatedCrash is a kill."""
    c = open_db(paths.db)
    try:
        return tick(c, world.deps, now, woke=woke)
    except SimulatedCrash:
        return None
    finally:
        c.close()


def approve_pending(conn, world, video_id, action="approve", **kw):
    a = pending_approval(conn, video_id)
    assert a is not None, "no pending approval"
    world.deps.decisions.put(Decision(a["id"], action, tuple(world.deps.settings.platforms), **kw))
    return a["id"]


def fresh_video_id(conn) -> int:
    return conn.execute("SELECT id FROM videos WHERE series = 'mandi'").fetchone()["id"]


def test_end_to_end_slot_to_done(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    rep = tick(conn, w.deps, PROD[0])
    vid = fresh_video_id(conn)
    assert rep.created == [vid] and rep.heavy == 1
    assert video_state(conn, vid) == "VOICED"                      # one heavy step per tick
    assert conn.execute("SELECT state FROM slots WHERE id = '2026-10-17@fresh'").fetchone()["state"] == "filled"

    tick(conn, w.deps, PROD[1])
    assert video_state(conn, vid) == "AWAITING_APPROVAL"
    rev = conn.execute("SELECT * FROM revisions WHERE video_id = ?", (vid,)).fetchone()
    appr = pending_approval(conn, vid)
    assert appr["content_hash"] == rev["content_hash"] and len(appr["nonce"]) >= 6
    assert not (ksm_home.video_work(vid)).exists()                 # work dir purged after QA
    checks = json.loads(rev["checks_json"])
    assert checks["deterministic"]["ok"] and checks["factcheck"]["ok"] and checks["qa"]["ok"]

    approve_pending(conn, w, vid)
    tick(conn, w.deps, PROD[2])
    pubs = {r["platform"]: r["state"] for r in conn.execute("SELECT * FROM publications WHERE video_id = ?", (vid,))}
    assert pubs == {"yt": "SCHEDULED", "fb": "SCHEDULED", "ig": "PUBLISH_DUE"}
    assert w.remote.posts.count(("ig", vid)) == 0

    for t in AFTER_SLOT:
        tick(conn, w.deps, t)
    assert video_state(conn, vid) == "DONE"
    assert sorted(w.remote.posts) == [("fb", vid), ("ig", vid), ("yt", vid)]
    spend = conn.execute("SELECT SUM(cost_inr) AS s FROM cost_ledger WHERE video_id = ?", (vid,)).fetchone()["s"]
    assert spend > 13   # writer + factcheck + tts


def test_failed_checks_redo_then_pass(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    w.pipe.bad_scripts = 1
    tick(conn, w.deps, PROD[0])
    vid = fresh_video_id(conn)
    v = conn.execute("SELECT * FROM videos WHERE id = ?", (vid,)).fetchone()
    assert v["redo_count"] == 1
    assert w.pipe.calls["write_script"] == 2                       # redo happened in the same tick
    assert conn.execute("SELECT COUNT(*) FROM revisions WHERE video_id = ?", (vid,)).fetchone()[0] == 2
    assert v["state"] == "VOICED"


def test_blocked_after_max_redos(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    w.pipe.bad_scripts = 99
    tick(conn, w.deps, PROD[0])
    vid = fresh_video_id(conn)
    assert video_state(conn, vid) == "BLOCKED"
    assert w.pipe.calls["write_script"] == settings.max_redos + 1
    alerts = [json.loads(r["json"])["message"] for r in conn.execute("SELECT json FROM events WHERE kind = 'alert'")]
    assert any("number_not_in_payload" in a for a in alerts)
    assert any("स्लॉट" not in a for a in alerts)
    assert w.tg.sent, "the alert was delivered to Telegram"


def test_too_long_narration_goes_back_to_writer(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    w.pipe.narration_s = 70
    tick(conn, w.deps, PROD[0])
    vid = fresh_video_id(conn)
    v = conn.execute("SELECT * FROM videos WHERE id = ?", (vid,)).fetchone()
    # voice step sent it back to the writer; the rewrite was checked again in the same tick
    assert v["redo_count"] == 1 and v["state"] == "CHECKED" and w.pipe.calls["write_script"] == 2
    assert conn.execute("SELECT COUNT(*) FROM events WHERE kind = 'state' AND video_id = ?"
                        " AND json_extract(json, '$.to') = 'NEEDS_REDO'", (vid,)).fetchone()[0] == 1


CRASH_POINTS = ["write_script", "run_checks", "factcheck", "synthesize", "render", "probe", "send_card",
                "publish_yt", "publish_ig", "publish_fb"]


@pytest.mark.parametrize("point", CRASH_POINTS)
def test_crash_injection_exactly_one_post(ksm_home, settings, point):
    w = make_world(ksm_home, settings, crash=point)
    for t in PROD:
        safe_tick(ksm_home, w, t)
    conn = open_db(ksm_home.db)
    vid = fresh_video_id(conn)
    approve_pending(conn, w, vid)
    for t in [ist(2026, 10, 16, 22, 0), ist(2026, 10, 16, 22, 1), *AFTER_SLOT, ist(2026, 10, 17, 7, 10)]:
        safe_tick(ksm_home, w, t)
    assert w.crash.fired, f"crash point {point} never reached"
    assert video_state(conn, vid) == "DONE"
    for p in ("yt", "ig", "fb"):
        assert w.remote.count(p, vid) == 1, p
    assert conn.execute("SELECT COUNT(*) FROM publications WHERE video_id = ?", (vid,)).fetchone()[0] == 3
    statuses = [r["status"] for r in conn.execute(
        "SELECT a.status FROM approvals a JOIN revisions r ON r.id = a.revision_id WHERE r.video_id = ?", (vid,))]
    assert statuses.count("approved") == 1 and "pending" not in statuses
    conn.close()


def test_edit_creates_new_revision_and_needs_new_approval(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    tick(conn, w.deps, PROD[0])
    tick(conn, w.deps, PROD[1])
    vid = fresh_video_id(conn)
    old = approve_pending(conn, w, vid, action="edit", edit_field="yt_title", edit_value="नवीन शीर्षक")
    tick(conn, w.deps, PROD[2])
    revs = conn.execute("SELECT * FROM revisions WHERE video_id = ? ORDER BY rev_no", (vid,)).fetchall()
    assert [r["rev_no"] for r in revs] == [1, 2]
    assert json.loads(revs[1]["metadata_json"])["yt"]["title"] == "नवीन शीर्षक"
    assert revs[0]["content_hash"] != revs[1]["content_hash"] and revs[0]["master_sha256"] == revs[1]["master_sha256"]
    new = pending_approval(conn, vid)
    assert new["revision_id"] == revs[1]["id"] and video_state(conn, vid) == "AWAITING_APPROVAL"

    # A late tap on the old card does nothing.
    w.deps.decisions.put(Decision(old, "approve", ("yt",)))
    tick(conn, w.deps, PROD[3])
    assert video_state(conn, vid) == "AWAITING_APPROVAL"

    approve_pending(conn, w, vid)
    tick(conn, w.deps, PROD[4])
    assert {r["revision_id"] for r in conn.execute("SELECT revision_id FROM publications WHERE video_id = ?", (vid,))} \
        == {revs[1]["id"]}


def test_skip_and_founder_redo(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    tick(conn, w.deps, PROD[0])
    tick(conn, w.deps, PROD[1])
    vid = fresh_video_id(conn)
    approve_pending(conn, w, vid, action="redo", reason="भाषा")
    tick(conn, w.deps, PROD[2])
    v = conn.execute("SELECT * FROM videos WHERE id = ?", (vid,)).fetchone()
    assert "founder_redo" in (v["feedback"] or "") or v["state"] in ("SCRIPTED", "CHECKED", "VOICED")
    assert w.pipe.calls["write_script"] == 2
    for t in PROD[3:]:
        tick(conn, w.deps, t)
    approve_pending(conn, w, vid, action="skip")
    tick(conn, w.deps, ist(2026, 10, 16, 22, 0))
    assert video_state(conn, vid) == "REJECTED"
    assert conn.execute("SELECT video_id, state FROM slots WHERE id = '2026-10-17@fresh'").fetchone()["state"] in (
        "open", "filled")
    assert not w.remote.posts


def test_never_publish_without_matching_approval(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    tick(conn, w.deps, PROD[0])
    tick(conn, w.deps, PROD[1])
    vid = fresh_video_id(conn)
    approve_pending(conn, w, vid)
    # The bytes changed after the tap (e.g. a re-render): the approval no longer matches.
    conn.execute("UPDATE revisions SET content_hash = 'tampered' WHERE video_id = ?", (vid,))
    tick(conn, w.deps, PROD[2])
    assert not w.remote.posts
    assert conn.execute("SELECT COUNT(*) FROM publications").fetchone()[0] == 0


def test_advance_runs_one_step_and_ignores_terminal(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    from ksm.reconcile import create_video
    from ksm.models import VideoPlan
    vid = create_video(conn, VideoPlan("mandi", "t1", None, False, False, None, {"x": 1}), PROD[0])
    assert advance(conn, vid, w.deps, PROD[0]) == "DATA_READY"
    assert advance(conn, vid, w.deps, PROD[0]) == "SCRIPTED"
    conn.execute("UPDATE videos SET state = 'DONE' WHERE id = ?", (vid,))
    assert advance(conn, vid, w.deps, PROD[0]) == "DONE"


def test_step_errors_retry_then_block(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    from ksm.models import VideoPlan
    from ksm.reconcile import create_video

    def boom(*a, **k):
        raise RuntimeError("provider down")
    w.deps.fns["write_script"] = boom
    vid = create_video(conn, VideoPlan("mandi", "t2", None, False, False, None, {"x": 1}), PROD[0])
    t = PROD[0]
    advance(conn, vid, w.deps, t)                       # DATA_READY
    for wait in (0, 2, 4, 8):                           # failures back off 2, 4, 8, 16 min
        t += timedelta(minutes=wait)
        assert advance(conn, vid, w.deps, t) == "DATA_READY"
        assert advance(conn, vid, w.deps, t + timedelta(seconds=30)) == "DATA_READY"   # backing off: no call
    assert advance(conn, vid, w.deps, t + timedelta(minutes=16)) == "BLOCKED"
    assert conn.execute("SELECT COUNT(*) FROM events WHERE kind = 'step_error' AND video_id = ?", (vid,)).fetchone()[0] == 5
