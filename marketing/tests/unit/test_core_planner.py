"""planner.plan_slot: mandi only with yesterday's prices, evergreen fallback, verified advisories,
topic cooldown, weights."""
from __future__ import annotations

from datetime import date, timedelta

import pytest
import yaml
from _core_fakes import ist

from ksm import planner
from ksm.clock import build_slot
from ksm.models import SlotKind
from ksm.reconcile import create_video


def _slot(settings, d: date, kind: str):
    return build_slot(d, next(w for w in settings.slots if w.kind == kind))


@pytest.fixture
def verified(ksm_home):
    """Mark two advisories verified in the tmp config copy."""
    p = ksm_home.config_dir / "advisories.yaml"
    data = yaml.safe_load(p.read_text(encoding="utf-8"))
    for e in data["entries"][:2]:
        e.update(verified=True, verified_by="test", verified_on="2026-10-15",
                 sources=[f"{u.rstrip('/')}/rabi/{e['id']}.html" for u in e["sources"]])
    p.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")
    return [e["id"] for e in data["entries"][:2]]


@pytest.fixture
def mandi_sources(monkeypatch):
    """Fake the Agmarknet store: `latest` is the newest snapshot date."""
    import ksm.sources.agmarknet as ag

    state = {"latest": None, "asked": []}
    monkeypatch.setattr(ag, "latest_snapshot_date", lambda conn, **k: state["latest"])
    monkeypatch.setattr(ag, "load_commodities_cfg", lambda d: {"commodities": {}, "markets": {}})

    def payload(conn, d, **k):
        state["asked"].append(d)
        return {"data_date": d.isoformat(), "commodities": [{"key": "soybean", "median_modal": 4950}]}
    monkeypatch.setattr(ag, "mandi_payload", payload)
    return state


def test_fresh_slot_uses_yesterdays_snapshot(conn, settings, ksm_home, mandi_sources, verified):
    mandi_sources["latest"] = date(2026, 10, 16)
    slot = _slot(settings, date(2026, 10, 17), "fresh")     # Saturday
    plan = planner.plan_slot(conn, slot, ist(2026, 10, 16, 21, 0), settings)
    assert plan.series == "mandi" and plan.data_date == date(2026, 10, 16) and not plan.evergreen
    assert plan.time_sensitive and plan.fresh_until >= slot.late_until
    assert mandi_sources["asked"] == [date(2026, 10, 16)]


def test_stale_snapshot_gets_evergreen_instead(conn, settings, ksm_home, mandi_sources, verified):
    mandi_sources["latest"] = date(2026, 10, 15)              # older than slot_date - 1
    plan = planner.plan_slot(conn, _slot(settings, date(2026, 10, 17), "fresh"), ist(2026, 10, 16, 21, 0), settings)
    assert plan.evergreen and plan.series == "rabi_guide" and plan.topic_key.startswith("adv-")
    assert mandi_sources["asked"] == []


def test_sunday_has_no_mandi_video(conn, settings, ksm_home, mandi_sources, verified):
    mandi_sources["latest"] = date(2026, 10, 17)
    plan = planner.plan_slot(conn, _slot(settings, date(2026, 10, 18), "fresh"), ist(2026, 10, 17, 21, 0), settings)
    assert plan is None or plan.evergreen


def test_unverified_advisories_produce_nothing(conn, settings, ksm_home, mandi_sources):
    plan = planner.plan_slot(conn, _slot(settings, date(2026, 10, 17), "advisory"), ist(2026, 10, 17, 9, 5), settings)
    assert plan is None


def test_advisory_slot_uses_only_verified_and_respects_cooldown(conn, settings, ksm_home, verified):
    now = ist(2026, 10, 17, 9, 5)
    slot = _slot(settings, date(2026, 10, 17), "advisory")
    p1 = planner.plan_slot(conn, slot, now, settings)
    assert p1.topic_key in {f"adv-{i}" for i in verified} and p1.payload["facts"]
    create_video(conn, p1, now)
    p2 = planner.plan_slot(conn, slot, now, settings)
    assert p2.topic_key != p1.topic_key
    create_video(conn, p2, now)
    assert planner.plan_slot(conn, slot, now, settings) is None               # both on cooldown
    conn.execute("UPDATE videos SET state = 'DONE'")
    later = now + timedelta(days=15)
    p3 = planner.plan_slot(conn, _slot(settings, date(2026, 11, 1), "advisory"), later, settings)
    assert p3 is not None and p3.topic_key in {p1.topic_key, p2.topic_key}


def test_series_weights_seeded_and_report_overrides_kept(conn, settings, ksm_home, verified):
    now = ist(2026, 10, 17, 9, 5)
    planner.plan_slot(conn, _slot(settings, date(2026, 10, 17), "advisory"), now, settings)
    w = planner.series_weights(conn)
    assert w["rabi_guide"] == 1.0 and w["yojana"] == 0.8
    conn.execute("UPDATE series_weights SET weight = 0.3, source = 'report' WHERE series = 'rabi_guide'")
    planner.seed_series_weights(conn, planner.load_series(ksm_home.config_dir), now)
    assert planner.series_weights(conn)["rabi_guide"] == 0.3
    conn.execute("UPDATE series_weights SET weight = 0 WHERE series = 'rabi_guide'")
    assert planner.plan_evergreen(conn, now, settings, seed="x", kind=SlotKind.ADVISORY) is None
