"""daemon lease + loop, keep_awake, install/plist, cli commands, doctor and day0 (all hermetic)."""
from __future__ import annotations

import os
import plistlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from _core_fakes import ist, make_world

from ksm import cli, daemon, doctor, install, statemachine
from ksm.db import open_db


def test_lease_single_instance(conn):
    now = ist(2026, 10, 16, 12)
    assert daemon.acquire_lease(conn, now, pid=111, alive=lambda p: True)
    assert not daemon.acquire_lease(conn, now, pid=222, alive=lambda p: True)        # held + alive
    assert daemon.acquire_lease(conn, now, pid=222, alive=lambda p: False)           # holder died
    assert not daemon.acquire_lease(conn, now, pid=111, alive=lambda p: True)
    later = now + daemon.LEASE_TTL + daemon.LEASE_TTL
    assert daemon.acquire_lease(conn, later, pid=111, alive=lambda p: True)          # expired lease
    daemon.release_lease(conn, pid=111)
    assert conn.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0


def test_daemon_runs_ticks_and_releases_lease(ksm_home, settings):
    w = make_world(ksm_home, settings)
    times = iter([ist(2026, 10, 16, 21, 40), ist(2026, 10, 16, 21, 41), ist(2026, 10, 16, 21, 42)])
    d = daemon.Daemon(ksm_home, w.deps, interval_s=0, clock=lambda: next(times), poll=False)
    assert d.run(max_ticks=2) == 0
    c = open_db(ksm_home.db)
    assert c.execute("SELECT state FROM videos").fetchone()["state"] == "AWAITING_APPROVAL"
    assert c.execute("SELECT COUNT(*) FROM leases").fetchone()[0] == 0
    c.close()


def test_daemon_refuses_second_instance(ksm_home, settings):
    w = make_world(ksm_home, settings)
    c = open_db(ksm_home.db)
    daemon.acquire_lease(c, ist(2026, 10, 16, 12), pid=os.getppid())     # a live process holds it
    d = daemon.Daemon(ksm_home, w.deps, interval_s=0, clock=lambda: ist(2026, 10, 16, 12), poll=False)
    with pytest.raises(daemon.AlreadyRunning):
        d.run(max_ticks=1)
    c.close()


def test_daemon_poller_feeds_decisions_queue(ksm_home, settings, monkeypatch):
    import ksm.approve as approve
    from ksm.models import Decision

    w = make_world(ksm_home, settings)
    d = daemon.Daemon(ksm_home, w.deps, interval_s=0, poll=False)
    calls = {"n": 0}

    def poll_once(conn, tg, timeout=50):
        calls["n"] += 1
        d.stop.set()
        return [Decision(7, "approve", ("yt",))]
    monkeypatch.setattr(approve, "poll_once", poll_once)
    monkeypatch.setattr(approve, "prune_updates", lambda conn: None)
    d._poll_loop()
    assert calls["n"] == 1 and d.wake.is_set()
    assert w.deps.decisions.get_nowait() == Decision(7, "approve", ("yt",))


def test_keep_awake_spawns_caffeinate_for_our_pid(monkeypatch):
    spawned = []

    class P:
        def __init__(self, args, **k):
            spawned.append(args)
            self.terminated = False

        def terminate(self):
            spawned.append("terminated")

        def wait(self, timeout=None):
            return 0
    monkeypatch.setattr(statemachine.shutil, "which", lambda n: "/usr/bin/caffeinate")
    monkeypatch.setattr(statemachine.subprocess, "Popen", P)
    with statemachine.keep_awake():
        assert spawned[0] == ["/usr/bin/caffeinate", "-i", "-w", str(os.getpid())]
    assert spawned[-1] == "terminated"


def test_render_plist(tmp_path):
    xml = install.render_plist(tmp_path / "home & co", tmp_path / "home & co" / "venv" / "bin" / "python")
    pl = plistlib.loads(xml.encode())
    assert pl["Label"] == "com.krushisarva.marketing"
    assert pl["ProgramArguments"][1:] == ["-m", "ksm", "daemon"]
    assert pl["ProgramArguments"][0].endswith("venv/bin/python")
    assert pl["KeepAlive"] is True and pl["RunAtLoad"] is True and pl["ThrottleInterval"] == 30
    assert pl["LimitLoadToSessionType"] == "Aqua" and pl["ProcessType"] == "Background"
    assert pl["WorkingDirectory"] == str(tmp_path / "home & co")
    assert pl["EnvironmentVariables"]["PATH"].startswith("/opt/homebrew/opt/ffmpeg-full/bin:")
    assert pl["EnvironmentVariables"]["KSM_HOME"] == str(tmp_path / "home & co")
    assert pl["StandardErrorPath"].startswith(str(tmp_path / "home & co" / "logs"))


def test_illustration_allow_list():
    brand = {"illustrations": {"allowed_prefixes": ["CROP-", "ACT-"], "forbidden_tokens": ["SYMPTOM", "SEV"],
                               "denied_ids": ["ACT-SPRAY"],
                               "candidates": ["CROP-Soybean", "ACT-SPRAY", "ACT-SOWING", "CROP-SYMPTOM-x",
                                              "PEST-aphid", "CROP-sev-high"]}}
    assert install.illustration_ids(brand) == ["CROP-Soybean", "ACT-SOWING"]


def test_install_copies_assets_and_writes_plist(tmp_path):
    masters = tmp_path / "masters"
    masters.mkdir()
    (masters / "CROP-Soybean.png").write_bytes(b"png")
    (masters / "ACT-SPRAY.png").write_bytes(b"png")
    calls = []
    res = install.install(tmp_path / "home", masters_dir=masters, launch_agents=tmp_path / "LA",
                          load=True, run=lambda cmd, **k: calls.append(cmd) or SimpleNamespace(returncode=0))
    home = res.home
    assert (home / "config" / "settings.yaml").is_file() and (home / "assets" / "brand" / "splash-mark.png").is_file()
    assert (home / "assets" / "illustrations" / "CROP-Soybean.png").is_file()
    assert not (home / "assets" / "illustrations" / "ACT-SPRAY.png").exists()
    assert res.plist_path.is_file() and res.loaded and calls[1][:2] == ["launchctl", "bootstrap"]
    again = install.install(tmp_path / "home", masters_dir=masters, launch_agents=tmp_path / "LA", load=False)
    assert any("previous config" in s for s in again.skipped)
    assert any("venv" in s for s in install.next_steps(again))


def test_cli_secrets_check_and_set(monkeypatch, capsys):
    import ksm.secrets as s

    store = {}
    monkeypatch.setattr(s.keyring, "get_password", lambda svc, n: store.get(n))
    monkeypatch.setattr(s.keyring, "set_password", lambda svc, n, v: store.__setitem__(n, v))
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt: "secret-value")
    assert cli.main(["secrets", "set", "telegram"]) == 0
    assert store == {"telegram_bot_token": "secret-value"}
    assert cli.main(["secrets", "check", "telegram"]) == 0
    assert cli.main(["secrets", "check", "sarvam"]) == 1
    out = capsys.readouterr().out
    assert "secret-value" not in out and "ksm secrets set sarvam_api_key" in out
    assert cli.main(["secrets", "set", "nope"]) == 2


def test_cli_day0_requires_yes(capsys):
    assert cli.main(["day0"]) == 2
    assert "--yes" in capsys.readouterr().out


def test_day0_runs_only_checks_with_secrets(ksm_home, settings):
    from ksm import day0

    with pytest.raises(PermissionError):
        day0.run(ksm_home, settings, yes=False)
    res = day0.run(ksm_home, settings, yes=True, http=object(), has=lambda n: False)
    status = {n: s for n, s, _ in res}
    assert status["telegram"] == "skipped" and status["youtube-unlisted"] == "manual"
    assert "ran" not in status.values()


def test_cli_report_and_tick(ksm_home, monkeypatch, capsys):
    from ksm.config import get_settings

    get_settings.cache_clear()
    monkeypatch.setattr(cli, "_real_deps", lambda s=None: make_world(ksm_home, get_settings()).deps)
    assert cli.main(["tick"]) == 0
    assert cli.main(["report"]) == 0
    out = capsys.readouterr().out
    assert "Budget" in out and "Slots:" in out
    get_settings.cache_clear()


def test_doctor_offline_checks(ksm_home, settings, monkeypatch):
    conf = "configuration: --enable-libass --enable-libharfbuzz --enable-libfreetype"
    fake_bin = ksm_home.home / "ffmpeg"
    fake_bin.write_text("")
    ok = doctor.check_ffmpeg(lambda cmd: SimpleNamespace(stdout=conf, returncode=0), binary=fake_bin)
    assert ok.ok
    bad = doctor.check_ffmpeg(lambda cmd: SimpleNamespace(stdout="--enable-libx264", returncode=0), binary=fake_bin)
    assert bad.ok is False and "libass" in bad.detail
    assert doctor.check_ffmpeg(binary=Path("/nonexistent/ffmpeg")).ok is False
    sec = doctor.check_secrets(settings, has=lambda n: n != "sarvam_api_key")
    assert [r.name for r in sec if r.ok is False] == ["secret sarvam_api_key"]
    assert all("meta" not in r.name for r in sec)          # M1: YouTube only
    launch = doctor.check_launchd(lambda cmd: SimpleNamespace(returncode=113, stdout=""))
    assert launch.ok is False and "install --load" in launch.hint
    text = doctor.format_results([doctor.CheckResult("a", True, "x"), doctor.CheckResult("b", False, "y", "fix b"),
                                  doctor.CheckResult("c", None, "z", "maybe")])
    assert "✓ a" in text and "✗ b" in text and "→ fix b" in text and "! c" in text and "1 to fix" in text


def test_doctor_config_and_fonts(ksm_home):
    names = {r.name: r for r in doctor.check_config(ksm_home)}
    assert names["msp.yaml"].ok and names["advisories.yaml"].ok is None     # none verified yet
    fonts = doctor.check_fonts(ksm_home)
    assert fonts.name == "fonts + brand files"
