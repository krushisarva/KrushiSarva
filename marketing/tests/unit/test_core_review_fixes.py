"""Regression tests for the core review fixes: late rule on interrupted uploads, unsafe edits,
missing secrets, alert delivery, post-now buffer videos, and the manual-tick lease."""
from __future__ import annotations

import json
import os
from datetime import timedelta

from _core_fakes import FakeTelegram, ist, make_world, pending_approval, video_state

from ksm import cli, daemon
from ksm.db import iso, kv_get, kv_set, log_event, open_db
from ksm.models import CheckReport, Decision, Issue, VideoPlan
from ksm.reconcile import _unbound_evergreen, create_video, send_alerts, tick
from ksm.secrets import SecretMissing
from ksm.statemachine import V, advance


def _vid(conn, series):
    return conn.execute("SELECT id FROM videos WHERE series = ? ORDER BY id LIMIT 1", (series,)).fetchone()["id"]


def _approve(conn, w, vid, action="approve", **kw):
    a = pending_approval(conn, vid)
    w.deps.decisions.put(Decision(a["id"], action, tuple(w.deps.settings.platforms), **kw))
    return a["id"]


def _interrupt_upload(conn, w, vid):
    """The YouTube upload had started (session URI saved) but never finished before the Mac slept."""
    conn.execute("UPDATE publications SET state = 'UPLOADING', upload_session_uri = 'https://upload/s1',"
                 " remote_id = NULL, scheduled_for = NULL WHERE video_id = ? AND platform = 'yt'", (vid,))
    w.remote.posts.clear()


def test_interrupted_upload_of_time_sensitive_video_expires_after_cutoff(ksm_home, settings, conn):
    w = make_world(ksm_home, settings, platforms=("yt",))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 41))
    a = _vid(conn, "mandi")
    _approve(conn, w, a)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 50))
    _interrupt_upload(conn, w, a)

    tick(conn, w.deps, ist(2026, 10, 17, 10, 30), woke=True)       # past the 10:00 cut-off
    pub = conn.execute("SELECT * FROM publications WHERE video_id = ?", (a,)).fetchone()
    assert pub["state"] == "EXPIRED"                               # yesterday's prices are never finished late
    assert not w.remote.posts and video_state(conn, a) == "EXPIRED"


def test_interrupted_upload_before_cutoff_still_completes(ksm_home, settings, conn):
    w = make_world(ksm_home, settings, platforms=("yt",))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 41))
    a = _vid(conn, "mandi")
    _approve(conn, w, a)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 50))
    _interrupt_upload(conn, w, a)

    tick(conn, w.deps, ist(2026, 10, 17, 8, 0), woke=True)
    assert w.remote.count("yt", a) == 1


def test_unsafe_edit_is_refused_and_card_resent(ksm_home, settings, conn):
    w = make_world(ksm_home, settings, platforms=("yt",))
    base_checks = w.deps.fns["run_checks"]

    def run_checks(script, payload, **kw):
        rep = base_checks(script, payload, **kw)
        if "Chlorpyrifos" in script.platform.yt.title:
            rep.issues.append(Issue("chemical_mentioned", "pesticide name", True, "platform.yt.title"))
        return rep
    w.deps.fns["run_checks"] = run_checks
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 41))
    a = _vid(conn, "mandi")
    old = _approve(conn, w, a, action="edit", edit_field="yt_title", edit_value="Chlorpyrifos फवारा")
    tick(conn, w.deps, ist(2026, 10, 16, 21, 45))

    assert conn.execute("SELECT COUNT(*) FROM revisions WHERE video_id = ?", (a,)).fetchone()[0] == 1
    assert conn.execute("SELECT status FROM approvals WHERE id = ?", (old,)).fetchone()["status"] == "superseded"
    new = pending_approval(conn, a)
    assert new is not None and new["id"] != old and video_state(conn, a) == "AWAITING_APPROVAL"
    ev = conn.execute("SELECT json FROM events WHERE kind = 'decision_refused'").fetchone()
    assert "chemical_mentioned" in json.loads(ev["json"])["reason"]

    # An unknown field is refused the same way instead of leaving the decision stuck on the card.
    _approve(conn, w, a, action="edit", edit_field="nope", edit_value="x")
    tick(conn, w.deps, ist(2026, 10, 16, 21, 46))
    assert pending_approval(conn, a)["id"] != new["id"]
    assert conn.execute("SELECT COUNT(*) FROM revisions WHERE video_id = ?", (a,)).fetchone()[0] == 1


def test_edit_is_checked_with_edited_text(ksm_home, settings, conn):
    w = make_world(ksm_home, settings, platforms=("yt",))
    seen = []

    def run_checks(script, payload, **kw):
        seen.append(script.platform.yt.title)
        return CheckReport()
    w.deps.fns["run_checks"] = run_checks
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    tick(conn, w.deps, ist(2026, 10, 16, 21, 41))
    a = _vid(conn, "mandi")
    _approve(conn, w, a, action="edit", edit_field="yt_title", edit_value="नवीन शीर्षक")
    tick(conn, w.deps, ist(2026, 10, 16, 21, 45))
    assert "नवीन शीर्षक" in seen
    assert conn.execute("SELECT COUNT(*) FROM revisions WHERE video_id = ?", (a,)).fetchone()[0] == 2


def test_missing_secret_holds_instead_of_blocking(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)

    def no_key(*a, **k):
        raise SecretMissing("secret 'anthropic_api_key' is not set; run `ksm secrets set anthropic_api_key`")
    w.deps.fns["write_script"] = no_key
    vid = create_video(conn, VideoPlan("mandi", "t9", None, False, False, None, {"x": 1}), ist(2026, 10, 16, 21))
    t = ist(2026, 10, 16, 21)
    advance(conn, vid, w.deps, t)
    for i in range(8):
        assert advance(conn, vid, w.deps, t + timedelta(hours=i)) == V.DATA_READY
    alerts = conn.execute("SELECT COUNT(*) FROM events WHERE kind = 'alert' AND video_id = ?", (vid,)).fetchone()[0]
    assert alerts == 1                                              # one alert, not one per tick


def test_alerts_survive_a_failed_send_and_overflow_is_summarised(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)

    class Flaky(FakeTelegram):
        fail = True

        def send_message(self, chat_id, text, reply_markup=None, parse_mode="HTML"):
            if self.fail:
                self.fail = False
                raise ConnectionError("offline")
            return super().send_message(chat_id, text, reply_markup, parse_mode)
    tg = Flaky()
    w.deps.clients["telegram"] = tg
    for i in range(13):
        log_event(conn, "alert", None, message=f"समस्या {i}")
    now = ist(2026, 10, 16, 12)
    assert send_alerts(conn, w.deps, now) == 0                       # send failed
    assert send_alerts(conn, w.deps, now + timedelta(minutes=1)) == 13   # retried, not deduped away
    text = tg.sent[-1][1]
    assert "समस्या 0" in text and "समस्या 9" in text and "समस्या 12" not in text and "आणखी 3" in text
    assert send_alerts(conn, w.deps, now + timedelta(minutes=2)) == 0


def test_post_now_video_is_not_used_to_fill_a_slot(ksm_home, settings, conn):
    now = ist(2026, 10, 16, 12)
    vid = create_video(conn, VideoPlan("rabi_guide", "adv-x", None, True, False, None, {"f": 1}), now)
    conn.execute("UPDATE videos SET state = 'APPROVED' WHERE id = ?", (vid,))
    assert [r["id"] for r in _unbound_evergreen(conn, (V.APPROVED,))] == [vid]
    kv_set(conn, f"post_now:{vid}", iso(now))
    assert _unbound_evergreen(conn, (V.APPROVED,)) == []


def test_manual_tick_refuses_while_daemon_holds_lease(ksm_home, monkeypatch, capsys):
    from ksm.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setattr(cli, "_real_deps", lambda s=None: make_world(ksm_home, get_settings()).deps)
    c = open_db(ksm_home.db)
    from ksm.db import utcnow
    daemon.acquire_lease(c, utcnow(), pid=os.getppid())             # a live daemon
    assert cli.main(["tick"]) == 1
    assert "daemon is running" in capsys.readouterr().out
    daemon.release_lease(c, pid=os.getppid())
    assert cli.main(["tick"]) == 0
    assert c.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0   # the manual tick released it
    assert kv_get(c, "last_tick")
    c.close()
    get_settings.cache_clear()


def test_wake_tick_does_not_resend_a_card_it_just_sent(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    rep = tick(conn, w.deps, ist(2026, 10, 16, 21, 41), woke=True)     # the card goes out in this tick
    a = _vid(conn, "mandi")
    n = conn.execute("SELECT COUNT(*) FROM approvals a JOIN revisions r ON r.id = a.revision_id"
                     " WHERE r.video_id = ?", (a,)).fetchone()[0]
    assert n == 1 and rep.resent == 0 and len(w.approve.cards) == 1


def test_render_script_too_long_goes_back_to_writer(ksm_home, settings, conn):
    w = make_world(ksm_home, settings)

    class ScriptTooLong(ValueError):
        pass
    real_render, calls = w.deps.fns["render"], {"n": 0}

    def render(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ScriptTooLong("narration 57.0 s + end card 2.5 s > 58 s cap; shorten the script")
        return real_render(*a, **k)
    w.deps.fns["render"] = render
    for i in range(4):
        tick(conn, w.deps, ist(2026, 10, 16, 21, 40 + i))
    a = _vid(conn, "mandi")
    assert w.pipe.calls["write_script"] == 2                        # rewritten, not re-rendered 5 times
    assert conn.execute("SELECT redo_count FROM videos WHERE id = ?", (a,)).fetchone()["redo_count"] == 1
    assert video_state(conn, a) == "AWAITING_APPROVAL"


def test_failed_factcheck_spend_is_recorded(ksm_home, settings, conn):
    from ksm.ledger import video_spend

    w = make_world(ksm_home, settings)

    class ClaudeError(RuntimeError):
        def __init__(self):
            super().__init__("no usable output")
            self.usage = {"cost_inr": 4.5}

    def factcheck(*a, **k):
        raise ClaudeError()
    w.deps.fns["factcheck"] = factcheck
    vid = create_video(conn, VideoPlan("mandi", "t7", None, False, False, None, {"x": 1}), ist(2026, 10, 16, 21))
    t = ist(2026, 10, 16, 21)
    advance(conn, vid, w.deps, t)                                   # DATA_READY
    advance(conn, vid, w.deps, t)                                   # SCRIPTED (writer: 10.0)
    assert advance(conn, vid, w.deps, t) == V.SCRIPTED              # factcheck failed
    assert video_spend(conn, vid) == 14.5


def test_install_next_steps_always_reinstall_the_code(tmp_path):
    from ksm import install

    py = tmp_path / "home" / "venv" / "bin" / "python"
    res = install.InstallResult(home=tmp_path / "home", plist_path=tmp_path / "p.plist", python=py, loaded=True)
    assert "-m venv" in install.next_steps(res)[0]
    py.parent.mkdir(parents=True)
    py.write_text("")
    steps = install.next_steps(res)
    assert len(steps) == 1 and "pip install --upgrade" in steps[0] and "-m venv" not in steps[0]


def test_low_disk_and_budget_are_alerted_once_per_period(ksm_home, settings, conn):
    from ksm.guards import GuardState
    from ksm.reconcile import guard_alerts

    def alerts():
        return [json.loads(r["json"])["message"] for r in conn.execute("SELECT json FROM events WHERE kind = 'alert'")]
    now = ist(2026, 10, 16, 12)
    g = GuardState(False, False, False, ["low disk: 4.2 GB free < 5 GB"], budget="warn", free_gb=4.2)
    guard_alerts(conn, g, now)
    g.free_gb = 4.1
    guard_alerts(conn, g, now + timedelta(minutes=1))               # same conditions: no new rows
    assert len(alerts()) == 2 and any("डिस्क" in m for m in alerts())
    g.budget = "exhausted"
    guard_alerts(conn, g, now + timedelta(minutes=2))               # a new condition alerts at once
    assert len(alerts()) == 3
    guard_alerts(conn, GuardState(True, True, False, [], budget="ok"), now + timedelta(days=1))
    assert len(alerts()) == 3
