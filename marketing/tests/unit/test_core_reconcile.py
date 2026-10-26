"""Reconcile scenarios: sleeping Mac, missed slots, IG late rule, quiet hours, budget, disk, buffer."""
from __future__ import annotations

import json
from datetime import timedelta

from _core_fakes import ist, make_world, pending_approval, video_state

from ksm import ledger
from ksm.db import kv_get
from ksm.models import Decision
from ksm.reconcile import purge, tick


def approve(conn, w, vid, action="approve"):
    a = pending_approval(conn, vid)
    w.deps.decisions.put(Decision(a["id"], action, tuple(w.deps.settings.platforms)))
    return a["id"]


def vid_of(conn, series):
    return conn.execute("SELECT id FROM videos WHERE series = ? ORDER BY id LIMIT 1", (series,)).fetchone()["id"]


def pub_states(conn, vid):
    return {r["platform"]: r["state"] for r in conn.execute("SELECT * FROM publications WHERE video_id = ?", (vid,))}


def test_sleep_over_24h_resends_cards_marks_missed_no_duplicates(ksm_home, settings, conn):
    w = make_world(ksm_home, settings, evergreen_min=1)
    for i in range(4):                                     # mandi A + evergreen buffer video B
        tick(conn, w.deps, ist(2026, 10, 16, 21, 40 + i))
    a, b = vid_of(conn, "mandi"), vid_of(conn, "rabi_guide")
    assert video_state(conn, a) == video_state(conn, b) == "AWAITING_APPROVAL"
    approve(conn, w, a)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 50))
    assert pub_states(conn, a) == {"yt": "SCHEDULED", "fb": "SCHEDULED", "ig": "PUBLISH_DUE"}
    old_b = pending_approval(conn, b)["id"]
    sent_before = len(w.tg.sent)

    # The Mac sleeps 26 h: the 07:00 slot, its 10:00 IG cut-off and the 19:00 slot all pass.
    wake = ist(2026, 10, 17, 23, 45)
    rep = tick(conn, w.deps, wake, woke=True)

    # A was scheduled on YouTube/Facebook before sleeping: those went out on time, exactly once.
    assert pub_states(conn, a) == {"yt": "VERIFIED", "fb": "VERIFIED", "ig": "EXPIRED"}
    assert video_state(conn, a) == "PARTIAL"
    assert sorted(w.remote.posts) == [("fb", a), ("yt", a)]
    # B's card was superseded and re-sent; exactly one welcome-back message.
    assert rep.resent == 1
    new_b = pending_approval(conn, b)
    assert new_b["id"] != old_b
    assert conn.execute("SELECT status FROM approvals WHERE id = ?", (old_b,)).fetchone()["status"] == "superseded"
    welcome = [t for _, t in w.tg.sent[sent_before:] if "परत सुरू" in t]
    assert len(welcome) == 1
    # The 19:00 slot of the 17th was missed and is never backfilled.
    assert "2026-10-17@advisory" in rep.missed
    assert conn.execute("SELECT state, video_id FROM slots WHERE id = '2026-10-17@advisory'").fetchone()["state"] == "missed"

    # Another tick does not post again or resend again.
    tick(conn, w.deps, wake + timedelta(minutes=1))
    assert sorted(w.remote.posts) == [("fb", a), ("yt", a)]
    assert pending_approval(conn, b)["id"] == new_b["id"]


def test_time_sensitive_video_awaiting_approval_is_missed_after_sleep(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 41))
    a = vid_of(conn, "mandi")
    card = pending_approval(conn, a)
    tick(conn, w.deps, ist(2026, 10, 17, 11, 0), woke=True)
    assert video_state(conn, a) == "MISSED"
    assert conn.execute("SELECT status FROM approvals WHERE id = ?", (card["id"],)).fetchone()["status"] == "expired"
    assert not w.remote.posts


def test_slots_that_passed_while_not_running_are_recorded_missed(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    w.guards.production_ok = False                      # keep the test about slots only
    tick(conn, w.deps, ist(2026, 10, 16, 8, 0))
    rep = tick(conn, w.deps, ist(2026, 10, 21, 8, 0), woke=True)
    states = dict(conn.execute("SELECT id, state FROM slots").fetchall())
    for d in ("2026-10-18", "2026-10-19", "2026-10-20"):
        assert states[f"{d}@fresh"] == "missed" and states[f"{d}@advisory"] == "missed"
    assert states["2026-10-21@advisory"] == "open"
    assert "2026-10-19@fresh" in rep.missed
    assert conn.execute("SELECT COUNT(*) FROM videos").fetchone()[0] == 0     # never backfilled


def test_ig_publishes_late_before_cutoff(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 41))
    a = vid_of(conn, "mandi")
    approve(conn, w, a)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 50))
    tick(conn, w.deps, ist(2026, 10, 17, 8, 30), woke=True)        # asleep at 07:00, awake before 10:00
    assert pub_states(conn, a)["ig"] == "PUBLISHED"
    tick(conn, w.deps, ist(2026, 10, 17, 8, 31))
    assert video_state(conn, a) == "DONE" and w.remote.count("ig", a) == 1


def test_ig_evergreen_after_cutoff_moves_to_next_free_slot(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    w.planning.fresh_ready = False                     # 18 Oct morning slot stays free
    for i in range(3):
        tick(conn, w.deps, ist(2026, 10, 17, 9, 5 + i))   # evening slot of the 17th opens at 09:00
    ev = vid_of(conn, "rabi_guide")
    assert conn.execute("SELECT id FROM slots WHERE video_id = ?", (ev,)).fetchone()["id"] == "2026-10-17@advisory"
    approve(conn, w, ev)
    tick(conn, w.deps, ist(2026, 10, 17, 9, 20))
    assert pub_states(conn, ev) == {"yt": "SCHEDULED", "fb": "SCHEDULED", "ig": "PUBLISH_DUE"}

    tick(conn, w.deps, ist(2026, 10, 17, 22, 0), woke=True)      # slept through 19:00 and the 21:30 cut-off
    st = pub_states(conn, ev)
    assert st["yt"] == st["fb"] == "VERIFIED" and st["ig"] == "PUBLISH_DUE"
    pub = conn.execute("SELECT id FROM publications WHERE video_id = ? AND platform = 'ig'", (ev,)).fetchone()
    moved = json.loads(kv_get(conn, f"pubslot:{pub['id']}"))
    assert moved["id"] == "2026-10-18@fresh"
    assert w.remote.count("ig", ev) == 0

    tick(conn, w.deps, ist(2026, 10, 18, 7, 1))
    tick(conn, w.deps, ist(2026, 10, 18, 7, 2))
    assert w.remote.count("ig", ev) == 1 and video_state(conn, ev) == "DONE"


def test_post_now_inside_quiet_hours_waits_until_they_end(ksm_home, settings, conn):
    w = make_world(ksm_home, settings, evergreen_min=1)
    w.planning.fresh_ready = False
    for i in range(3):
        tick(conn, w.deps, ist(2026, 10, 16, 22, 40 + i))
    ev = vid_of(conn, "rabi_guide")
    assert video_state(conn, ev) == "AWAITING_APPROVAL"
    approve(conn, w, ev, action="post_now")
    tick(conn, w.deps, ist(2026, 10, 16, 23, 0))
    assert w.remote.count("ig", ev) == 0
    assert all(s in ("SCHEDULED", "PUBLISH_DUE") for s in pub_states(conn, ev).values())
    sched = conn.execute("SELECT scheduled_for FROM publications WHERE video_id = ? AND platform = 'yt'",
                         (ev,)).fetchone()["scheduled_for"]
    assert sched.startswith("2026-10-17T00:00")                    # 05:30 IST
    tick(conn, w.deps, ist(2026, 10, 17, 3, 0))
    assert w.remote.count("ig", ev) == 0
    tick(conn, w.deps, ist(2026, 10, 17, 5, 31))
    tick(conn, w.deps, ist(2026, 10, 17, 5, 32))
    assert w.remote.count("ig", ev) == 1 and video_state(conn, ev) == "DONE"


def test_budget_exhausted_stops_production_but_approved_still_publishes(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 41))
    a = vid_of(conn, "mandi")
    approve(conn, w, a)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 50))
    ledger.record(conn, "anthropic", "writer", 2000, now=ist(2026, 10, 16, 21, 55))
    calls = dict(w.pipe.calls)

    rep = tick(conn, w.deps, ist(2026, 10, 17, 9, 5))              # evening slot opens: nothing is made
    assert rep.created == [] and w.pipe.calls == calls
    tick(conn, w.deps, ist(2026, 10, 17, 9, 6))
    assert video_state(conn, a) == "DONE" and len(w.remote.posts) == 3
    assert ledger.budget_state(conn, w.deps.settings, ist(2026, 10, 17, 9, 6)) == "exhausted"


def test_disk_guard_stops_production(ksm_home, settings, conn):
    w = make_world(ksm_home, settings, evergreen_min=2)
    w.guards.production_ok = False
    rep = tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    assert rep.created == [] and rep.steps == 0
    assert conn.execute("SELECT COUNT(*) FROM videos").fetchone()[0] == 0


def test_render_waits_under_memory_pressure(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    w.guards.render_ok = False
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    assert video_state(conn, vid_of(conn, "mandi")) == "CHECKED"           # stops before TTS
    assert "synthesize" not in w.pipe.calls


def test_evergreen_buffer_fills_a_fresh_slot_without_data(ksm_home, settings, conn):
    w = make_world(ksm_home, settings, evergreen_min=1)
    w.planning.fresh_ready = False
    for i in range(3):
        tick(conn, w.deps, ist(2026, 10, 16, 21, 35 + i))          # buffer video made + carded
    ev = vid_of(conn, "rabi_guide")
    approve(conn, w, ev)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    assert video_state(conn, ev) == "APPROVED"                      # waits, unbound
    tick(conn, w.deps, ist(2026, 10, 16, 22, 31))                   # fresh wait (2 h) over: buffer used
    assert conn.execute("SELECT video_id FROM slots WHERE id = '2026-10-17@fresh'").fetchone()["video_id"] == ev
    assert video_state(conn, ev) == "PUBLISHING"
    assert conn.execute("SELECT COUNT(*) FROM videos WHERE series = 'mandi'").fetchone()[0] == 0


def test_purge_retention(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 41))
    a = vid_of(conn, "mandi")
    approve(conn, w, a)
    for t in (ist(2026, 10, 16, 21, 50), ist(2026, 10, 17, 7, 1), ist(2026, 10, 17, 7, 2)):
        tick(conn, w.deps, t)
    rev = conn.execute("SELECT * FROM revisions WHERE video_id = ?", (a,)).fetchone()
    from pathlib import Path
    master, preview = Path(rev["master_path"]), Path(rev["preview_path"])
    assert master.exists() and preview.exists()
    purge(conn, ksm_home, ist(2026, 10, 17, 12, 0))
    assert master.exists() and preview.exists()                     # < 1 day after the decision
    purge(conn, ksm_home, ist(2026, 10, 18, 0, 0))
    assert master.exists() and not preview.exists()
    purge(conn, ksm_home, ist(2026, 10, 20, 8, 0))
    assert not master.exists()
    assert conn.execute("SELECT master_path FROM revisions WHERE video_id = ?", (a,)).fetchone()[0] is None


def test_purge_aggressive_ignores_waiting_periods(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 41))
    a = vid_of(conn, "mandi")
    approve(conn, w, a, action="skip")
    tick(conn, w.deps, ist(2026, 10, 16, 21, 42))
    stray = ksm_home.work_dir / "v999"
    stray.mkdir(parents=True)
    rev = conn.execute("SELECT * FROM revisions WHERE video_id = ?", (a,)).fetchone()
    from pathlib import Path
    assert purge(conn, ksm_home, ist(2026, 10, 16, 21, 43), aggressive=True) >= 3
    assert not stray.exists() and not Path(rev["master_path"]).exists()


def test_approval_tap_while_budget_exhausted_is_not_applied(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 41))
    a = vid_of(conn, "mandi")
    card = approve(conn, w, a)
    ledger.record(conn, "anthropic", "writer", 2000, now=ist(2026, 10, 16, 21, 42))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 43))
    assert conn.execute("SELECT status FROM approvals WHERE id = ?", (card,)).fetchone()["status"] == "expired"
    assert video_state(conn, a) == "QA_PASSED" and pending_approval(conn, a) is None
    assert not w.remote.posts
