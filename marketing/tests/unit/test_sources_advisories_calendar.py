from __future__ import annotations

import shutil
from datetime import date
from pathlib import Path

import pytest
import yaml

from ksm.sources.advisories import AdvisoryConfigError, advisory_payload, load_advisories
from ksm.sources.calendar import CalendarConfigError, events_between, load_events

CONFIG = Path(__file__).resolve().parents[2] / "config"


# ── advisories ───────────────────────────────────────────────────────────────


def test_real_advisories_are_all_unverified_and_hidden_by_default():
    assert load_advisories(CONFIG) == []
    entries = load_advisories(CONFIG, include_unverified=True)
    assert 8 <= len(entries) <= 12
    assert all(e["verified"] is False for e in entries)
    crops = {e["crop"] for e in entries}
    assert {"chana", "rabi_jowar", "wheat", "safflower", "onion", "general"} <= crops
    seed = next(e for e in entries if e["id"] == "seed-treatment-advice")
    assert any("कृषी सहाय्यक/KVK च्या सल्ल्याने" in f["mr"] for f in seed["facts"])


def test_advisory_payload_refuses_unverified():
    e = load_advisories(CONFIG, include_unverified=True)[0]
    with pytest.raises(ValueError, match="not verified"):
        advisory_payload(e)


def test_advisory_payload_for_verified_entry():
    e = {**load_advisories(CONFIG, include_unverified=True)[0], "verified": True,
         "verified_by": "founder", "verified_on": date(2026, 10, 17)}
    p = advisory_payload(e)
    assert p["id"] == e["id"] and p["facts"] and p["sources"]
    assert p["verified_on"] == "2026-10-17"


def _adv(tmp_path: Path, entry: dict) -> Path:
    shutil.copy(CONFIG / "sources_allowlist.yaml", tmp_path / "sources_allowlist.yaml")
    (tmp_path / "advisories.yaml").write_text(yaml.safe_dump({"entries": [entry]}, allow_unicode=True),
                                              encoding="utf-8")
    return tmp_path


BASE = {"id": "x", "crop": "chana", "topic": "t", "verified": True, "verified_by": "founder",
        "verified_on": "2026-10-17",
        "facts": [{"en": "Sow on moisture.", "mr": "ओलाव्यावर पेरा."}],
        "sources": ["https://mpkv.ac.in/research/rabi-pop.pdf"]}


@pytest.mark.parametrize("fact", [
    {"en": "Apply 20 kg per acre.", "mr": "एकरी खत द्या."},
    {"en": "Use 2 ml per litre.", "mr": "ठीक"},
    {"en": "Spray a fungicide.", "mr": "ठीक"},
    {"en": "ok", "mr": "बुरशीनाशकाची फवारणी करा"},
    {"en": "ok", "mr": "युरिया द्या"},
    {"en": "Treat seed with Thiram.", "mr": "ठीक"},
])
def test_lint_rejects_doses_and_chemicals(tmp_path, fact):
    with pytest.raises(AdvisoryConfigError):
        load_advisories(_adv(tmp_path, {**BASE, "facts": [fact]}))


def test_lint_rejects_non_official_source_and_missing_flag(tmp_path):
    with pytest.raises(AdvisoryConfigError):
        load_advisories(_adv(tmp_path, {**BASE, "sources": ["https://randomblog.example/"]}))
    no_flag = {k: v for k, v in BASE.items() if k != "verified"}
    with pytest.raises(AdvisoryConfigError):
        load_advisories(_adv(tmp_path, no_flag))


def test_verified_entry_is_returned(tmp_path):
    assert [e["id"] for e in load_advisories(_adv(tmp_path, BASE))] == ["x"]


@pytest.mark.parametrize("fact", [
    {"en": "Apply 20 kgs.", "mr": "ठीक"},
    {"en": "Mix 2 litres.", "mr": "ठीक"},
    {"en": "Use 5 grams.", "mr": "ठीक"},
    {"en": "Avoid pesticides.", "mr": "ठीक"},
    {"en": "Use chemical fertilisers sparingly.", "mr": "ठीक"},
    {"en": "Expect 10 quintal per hectare.", "mr": "ठीक"},
    {"en": "ok", "mr": "५ किलोग्रॅम बियाणे"},
    {"en": "ok", "mr": "२ लिटरमध्ये मिसळा"},
    {"en": "ok", "mr": "एकरी २० द्या"},
    {"en": "ok", "mr": "खते वेळेवर द्या"},
    {"en": "ok", "mr": "औषध फवारा"},
])
def test_lint_catches_plurals_suffixes_rates_and_yields(tmp_path, fact):
    with pytest.raises(AdvisoryConfigError):
        load_advisories(_adv(tmp_path, {**BASE, "facts": [fact]}))


def test_lint_no_false_positive_on_common_marathi_words(tmp_path):
    fact = {"en": "Mulch keeps moisture; 50 mm of rain helps.", "mr": "आच्छादन ओलावा राखते; ५० मिलीमीटर पाऊस उपयोगी."}
    assert load_advisories(_adv(tmp_path, {**BASE, "facts": [fact]}))


def test_lint_covers_payload_fields_not_only_facts(tmp_path):
    with pytest.raises(AdvisoryConfigError, match="topic_mr"):
        load_advisories(_adv(tmp_path, {**BASE, "topic_mr": "बुरशीनाशक निवड"}))


@pytest.mark.parametrize("change", [
    {"verified_by": None}, {"verified_by": "  "}, {"verified_on": None}, {"verified_on": "17/10/2026"},
    {"sources": ["https://mpkv.ac.in/"]}, {"sources": ["https://mpkv.ac.in"]},
])
def test_verified_entry_must_be_signed_and_pin_exact_pages(tmp_path, change):
    with pytest.raises(AdvisoryConfigError):
        load_advisories(_adv(tmp_path, {**BASE, **change}))
    # the same entry is fine while still unverified (it is simply hidden)
    assert load_advisories(_adv(tmp_path, {**BASE, **change, "verified": False})) == []


# ── calendar ─────────────────────────────────────────────────────────────────


def test_real_calendar_loads_and_is_json_safe():
    events = load_events(CONFIG)
    ids = {e["id"] for e in events}
    assert {"kapas-kisan-registration-close", "diwali-2026", "rms-2027-28-msp",
            "diwali-week-apmc-closures"} <= ids
    for e in events:
        assert isinstance(e["date"], str) and isinstance(e["use_from"], str)
        if e["use_in_script"]:
            assert e["source_url"]
    kapas = next(e for e in events if e["id"] == "kapas-kisan-registration-close")
    assert kapas["date"] == "2026-10-31" and kapas["official"] is False and kapas["use_in_script"] is False
    assert "8,267" in kapas["msp_note"] and "8,667" in kapas["msp_note"]


def test_events_between_window_overlap():
    ids = [e["id"] for e in events_between(CONFIG, date(2026, 11, 1), date(2026, 11, 2))]
    assert "kapas-kisan-registration-close" not in ids  # deadline passed
    assert "diwali-2026" in ids
    early = [e["id"] for e in events_between(CONFIG, date(2026, 10, 16), date(2026, 10, 16))]
    assert "kapas-kisan-registration-close" in early and "diwali-2026" not in early
    official = events_between(CONFIG, date(2026, 10, 16), date(2026, 11, 30), official_only=True)
    assert [e["id"] for e in official] == ["rms-2027-28-msp"]


def _cal(tmp_path: Path, event: dict) -> Path:
    shutil.copy(CONFIG / "sources_allowlist.yaml", tmp_path / "sources_allowlist.yaml")
    (tmp_path / "calendar.yaml").write_text(yaml.safe_dump({"events": [event]}, allow_unicode=True),
                                            encoding="utf-8")
    return tmp_path


EV = {"id": "e", "date": "2026-10-31", "title_mr": "x", "use_from": "2026-10-16",
      "use_until": "2026-10-31", "official": True, "source_url": "https://pib.gov.in/x"}


@pytest.mark.parametrize("bad", [
    {"official": True, "source_url": None},
    {"official": True, "source_url": "https://news.example.com/x"},
    {"official": False, "source_url": None, "use_in_script": True},
    {"use_from": "2026-11-01"},
    {"official": "yes"},
    {"date": "31/10/2026"},
])
def test_calendar_validation(tmp_path, bad):
    with pytest.raises(CalendarConfigError):
        load_events(_cal(tmp_path, {**EV, **bad}))


def test_calendar_unofficial_dates_only_for_festivals(tmp_path):
    unofficial = {**EV, "official": False, "source_url": "https://news.example.com/x", "use_in_script": True}
    with pytest.raises(CalendarConfigError, match="festival"):
        load_events(_cal(tmp_path, {**unofficial, "kind": "deadline"}))
    with pytest.raises(CalendarConfigError, match="festival"):
        load_events(_cal(tmp_path, unofficial))  # no kind: treated as not a festival
    assert load_events(_cal(tmp_path, {**unofficial, "kind": "festival"}))[0]["use_in_script"] is True
    # an unofficial deadline as a planning hint is fine
    assert load_events(_cal(tmp_path, {**unofficial, "kind": "deadline", "use_in_script": False}))


def test_calendar_deadline_window_cannot_outlive_deadline(tmp_path):
    with pytest.raises(CalendarConfigError, match="deadline"):
        load_events(_cal(tmp_path, {**EV, "kind": "deadline", "use_until": "2026-11-02"}))
