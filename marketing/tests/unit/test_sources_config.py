"""Shape checks for the config YAML files owned by the sources area."""
from __future__ import annotations

from pathlib import Path

import yaml

from ksm.sources.msp import domain_allowed

CONFIG = Path(__file__).resolve().parents[2] / "config"
VISUAL_KINDS = {"title", "mandi_bars", "msp_compare", "illustration", "step_card", "checklist", "broll", "end_card"}


def _y(name: str):
    return yaml.safe_load((CONFIG / name).read_text(encoding="utf-8"))


def test_series_yaml():
    series = _y("series.yaml")["series"]
    keys = [s["key"] for s in series]
    assert len(series) == 6 and len(set(keys)) == 6
    assert {s["key"] for s in series if s["enabled"]} == {"mandi", "rabi_guide"}
    required = {"key", "name_mr", "slot_kind", "status", "enabled", "weight", "length_s", "evergreen",
                "time_sensitive", "freshness_hours", "web_factcheck", "visuals", "disclaimer", "prompt"}
    for s in series:
        assert required <= s.keys(), s["key"]
        assert s["slot_kind"] in {"fresh", "advisory"}
        assert s["status"] in {"v1", "m3", "m4", "later"}
        lo, hi = s["length_s"]
        assert 0 < lo < hi <= 58
        assert set(s["visuals"]) <= VISUAL_KINDS
        assert s["prompt"].startswith("series_") and s["prompt"].endswith(".v1.md")
        if s["time_sensitive"]:
            assert s["freshness_hours"]
    assert next(s for s in series if s["key"] == "yojana")["web_factcheck"] is True
    assert "broll" not in next(s for s in series if s["key"] == "pik_doctor")["visuals"]


def test_hashtags_within_platform_limit():
    h = _y("hashtags.yaml")
    series_keys = {s["key"] for s in _y("series.yaml")["series"]}
    assert set(h["series"]) == series_keys
    for tags in h["series"].values():
        assert 3 <= len(tags) <= 5 and len(tags) + 1 <= h["max_per_post"]  # room for one crop tag
        assert all(t.startswith("#") and " " not in t for t in tags)
    assert all(t.startswith("#") for t in h["crops"].values())


def test_pronunciation_entries():
    entries = {e["written"]: e for e in _y("pronunciation.yaml")["entries"]}
    assert entries["KrushiSarva"]["spoken"] == "कृषीसर्व" and entries["KrushiSarva"]["confirmed"] is False
    assert entries["APMC"]["spoken"] == "बाजार समिती"
    assert entries["KVK"]["spoken"] == "कृषी विज्ञान केंद्र"


def test_allowlist_has_official_domains_only():
    domains = _y("sources_allowlist.yaml")["domains"]
    assert len(domains) == len(set(domains))
    for d in ("pib.gov.in", "ddnews.gov.in", "mpkv.ac.in", "data.gov.in", "cotcorp.org.in"):
        assert d in domains
    assert domain_allowed("https://www.pib.gov.in/x", set(domains))
    assert not domain_allowed("https://pib.gov.in.evil.com/x", set(domains))
    assert not domain_allowed("https://notpib.gov.in/x", set(domains))


def test_markets_and_crops_are_marathi_and_consistent():
    markets = _y("markets_mr.yaml")["markets"]
    crops = _y("crops_mr.yaml")["commodities"]
    assert set(crops) == {"soybean", "cotton", "onion", "tur", "chana", "maize"}
    for name, m in markets.items():
        assert any("ऀ" <= ch <= "ॿ" for ch in m["mr"]), name
    for key, c in crops.items():
        assert c["agmarknet"] and c["name_mr"]
        assert set(c.get("key_markets", [])) <= set(markets), key


def test_market_aliases_are_not_sub_yards():
    # markets_mr.yaml rule: a sub-yard like "Lasalgaon(Vinchur)" is a different market.
    for name, m in _y("markets_mr.yaml")["markets"].items():
        assert all("(" not in a for a in m.get("aliases", [])), name
