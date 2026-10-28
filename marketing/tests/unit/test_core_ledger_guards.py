"""ledger (IST months, budget states), guards (disk/memory/emulator), secrets (Keychain wrapper)."""
from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest
from _core_fakes import ist, utc

from ksm import guards, ledger, secrets


def test_month_is_ist():
    assert ledger.month_of(utc(2026, 10, 31, 18, 29)) == "2026-10"
    assert ledger.month_of(utc(2026, 10, 31, 18, 31)) == "2026-11"


@pytest.mark.parametrize("spent,state", [(0, "ok"), (1199, "ok"), (1200, "degraded"), (1499, "degraded"),
                                         (1500, "exhausted"), (3000, "exhausted")])
def test_budget_thresholds(conn, settings, spent, state):
    now = ist(2026, 10, 3, 12, 0)                              # day 3: no pace projection yet
    if spent:
        ledger.record(conn, "anthropic", "writer", spent, now=now, input_tokens=1)
    assert ledger.budget_state(conn, settings, now) == state


def test_budget_warn_on_pace_and_month_reset(conn, settings):
    ledger.record(conn, "anthropic", "writer", 800, now=ist(2026, 10, 2))
    assert ledger.budget_state(conn, settings, ist(2026, 10, 10, 12)) == "warn"    # ~₹2,600 projected
    assert ledger.budget_state(conn, settings, ist(2026, 11, 1, 1)) == "ok"        # new IST month
    assert ledger.month_spend(conn, "2026-10") == 800


def test_price_helpers(settings):
    assert ledger.sarvam_cost_inr(10_000) == pytest.approx(20.0)
    assert ledger.usage_cost_inr({"cost_inr": 7.5}, settings) == 7.5
    assert ledger.usage_cost_inr({"input_tokens": 1_000_000}, settings) > 0


class Probes(guards.Probes):
    def __init__(self, disk=50.0, pressure=1, emulator=False):
        super().__init__(disk_gb=lambda: disk, pressure=lambda: pressure, emulator=lambda: emulator)


def test_guards_ok(conn, settings):
    g = guards.check(conn, settings, probes=Probes())
    assert g.production_ok and g.render_ok and not g.purge_needed and g.reasons == []


def test_disk_guard(conn, settings):
    g = guards.check(conn, settings, probes=Probes(disk=4.0))
    assert not g.production_ok and not g.render_ok and not g.purge_needed
    g = guards.check(conn, settings, probes=Probes(disk=2.0))
    assert g.purge_needed and "low disk" in g.reasons[0]


@pytest.mark.parametrize("pressure,emulator", [(2, False), (4, False), (1, True)])
def test_render_waits_for_memory_and_emulator(conn, settings, pressure, emulator):
    g = guards.check(conn, settings, probes=Probes(pressure=pressure, emulator=emulator))
    assert g.production_ok and not g.render_ok


def test_budget_exhausted_guard(conn, settings):
    ledger.record(conn, "sarvam", "tts", 1600)
    g = guards.check(conn, settings, probes=Probes())
    assert not g.production_ok and g.budget == "exhausted"


def test_system_probe_parsing(tmp_path):
    out = lambda rc=0, so="": SimpleNamespace(returncode=rc, stdout=so)  # noqa: E731
    assert guards.memory_pressure_level(lambda cmd: out(so="4\n")) == 4
    assert guards.memory_pressure_level(lambda cmd: out(so="garbage")) == 1

    def boom(cmd):
        raise subprocess.TimeoutExpired(cmd, 5)
    assert guards.memory_pressure_level(boom) == 1
    assert guards.emulator_running(lambda cmd: out(rc=0)) is True
    assert guards.emulator_running(lambda cmd: out(rc=1)) is False
    assert guards.free_disk_gb(tmp_path / "not" / "yet") > 0


@pytest.fixture
def keychain(monkeypatch):
    store: dict = {}
    monkeypatch.setattr(secrets.keyring, "get_password", lambda svc, n: store.get((svc, n)))
    monkeypatch.setattr(secrets.keyring, "set_password", lambda svc, n, v: store.__setitem__((svc, n), v))
    return store


def test_secrets_roundtrip_and_clear_error(keychain):
    with pytest.raises(secrets.SecretMissing, match="ksm secrets set telegram_bot_token"):
        secrets.get_secret("telegram_bot_token")
    assert not secrets.has_secret("telegram")
    secrets.set_secret("meta", "  tok  ")
    assert keychain[("ks-marketing", "meta_system_user_token")] == "tok"
    assert secrets.get_secret("meta_system_user_token") == "tok" and secrets.has_secret("meta")
    with pytest.raises(ValueError):
        secrets.set_secret("sarvam", " ")


def test_secrets_keyring_failure_is_reported(monkeypatch):
    from keyring.errors import KeyringLocked

    def locked(*a):
        raise KeyringLocked("locked")
    monkeypatch.setattr(secrets.keyring, "get_password", locked)
    with pytest.raises(secrets.SecretMissing, match="cannot read"):
        secrets.get_secret("anthropic_api_key")
    assert not secrets.has_secret("anthropic_api_key")
