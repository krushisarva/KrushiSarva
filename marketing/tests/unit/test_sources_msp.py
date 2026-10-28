from __future__ import annotations

import shutil
from pathlib import Path

import pytest
import yaml

from ksm.sources.msp import MspConfigError, load_msp

CONFIG = Path(__file__).resolve().parents[2] / "config"


def test_real_msp_file_loads_with_verified_figures():
    t = load_msp(CONFIG)
    assert t.lookup("soybean").price == 5708
    assert t.lookup("tur").price == 8450
    assert t.lookup("cotton", "medium staple").price == 8267
    assert t.lookup("cotton", "Long Staple").price == 8667
    assert t.lookup("paddy", "common").price == 2441
    expected_rabi = {"wheat": 2610, "gram": 5958, "rapeseed-mustard": 6613, "safflower": 7215,
                     "lentil": 7390, "barley": 2286}
    for crop, price in expected_rabi.items():
        row = t.lookup(crop)
        assert row.price == price and row.season_label == "RMS 2027-28" and row.source_date == "2026-09-30"
    assert all(r.source_url.startswith("https://") for r in t.rows)


def test_cotton_without_staple_is_ambiguous():
    assert load_msp(CONFIG).lookup("cotton") is None


def test_unknown_crop():
    assert load_msp(CONFIG).lookup("dragonfruit") is None


def _write(tmp_path: Path, rows: list[dict]) -> Path:
    shutil.copy(CONFIG / "sources_allowlist.yaml", tmp_path / "sources_allowlist.yaml")
    (tmp_path / "msp.yaml").write_text(yaml.safe_dump({"rows": rows}, allow_unicode=True), encoding="utf-8")
    return tmp_path


GOOD = {"crop": "wheat", "season_label": "RMS 2027-28", "variety": None, "price": 2610,
        "source_url": "https://www.pib.gov.in/PressReleasepage.aspx?PRID=2316941", "source_date": "2026-09-30"}


@pytest.mark.parametrize("bad", [
    {"source_url": ""}, {"source_url": None}, {"source_url": "http://pib.gov.in/x"},
    {"source_url": "https://example.com/msp"}, {"price": 0}, {"price": "2610"}, {"price": 2610.5},
    {"source_date": "30/09/2026"}, {"crop": ""},
])
def test_load_msp_rejects_bad_rows(tmp_path, bad):
    with pytest.raises(MspConfigError):
        load_msp(_write(tmp_path, [{**GOOD, **bad}]))


def test_load_msp_rejects_missing_source_url_key(tmp_path):
    row = dict(GOOD)
    del row["source_url"]
    with pytest.raises(MspConfigError, match="source_url"):
        load_msp(_write(tmp_path, [row]))


def test_load_msp_rejects_duplicates_and_empty(tmp_path):
    with pytest.raises(MspConfigError):
        load_msp(_write(tmp_path, [GOOD, GOOD]))
    with pytest.raises(MspConfigError):
        load_msp(_write(tmp_path, []))


def test_lookup_prefers_latest_season(tmp_path):
    newer = {**GOOD, "season_label": "RMS 2028-29", "price": 2700, "source_date": "2027-09-30"}
    t = load_msp(_write(tmp_path, [GOOD, newer]))
    assert t.lookup("Wheat").price == 2700


def test_season_window():
    from datetime import date

    from ksm.sources.msp import season_window
    assert season_window("KMS 2026-27") == (date(2026, 10, 1), date(2027, 9, 30))
    assert season_window("RMS 2027-28") == (date(2027, 4, 1), date(2028, 3, 31))
    assert season_window("KMS 2026-28") is None and season_window("Kharif 2026") is None


@pytest.mark.parametrize("label", ["Kharif 2026-27", "RMS 2027-29", "RMS 2027"])
def test_load_msp_rejects_unparseable_season(tmp_path, label):
    with pytest.raises(MspConfigError, match="season_label"):
        load_msp(_write(tmp_path, [{**GOOD, "season_label": label}]))


def test_lookup_on_date_uses_the_season_open_on_that_date(tmp_path):
    from datetime import date
    kms26 = {**GOOD, "crop": "soybean", "season_label": "KMS 2026-27", "price": 5708, "source_date": "2026-05-13"}
    kms27 = {**kms26, "season_label": "KMS 2027-28", "price": 6000, "source_date": "2027-05-20"}
    t = load_msp(_write(tmp_path, [kms26, kms27]))
    # KMS 2027-28 is announced in May 2027 but sales until 30 Sep 2027 are still KMS 2026-27
    assert t.lookup("soybean", on=date(2027, 6, 1)).price == 5708
    assert t.lookup("soybean", on=date(2027, 10, 1)).price == 6000
    assert t.lookup("soybean", on=date(2026, 9, 30)) is None   # KMS 2025-26 not in the table
    assert t.lookup("soybean").price == 6000                    # no date: latest announced


def test_real_table_gram_not_active_for_todays_sales():
    from datetime import date
    t = load_msp(CONFIG)
    assert t.lookup("gram", on=date(2026, 10, 16)) is None       # RMS 2027-28 opens Apr 2027
    assert t.lookup("soybean", on=date(2026, 10, 16)).price == 5708
