from __future__ import annotations

import json
from datetime import date, datetime, timezone
from pathlib import Path

import httpx
import pytest
import respx

from ksm.db import open_db
from ksm.sources import agmarknet as ag
from ksm.sources.msp import MspRow, MspTable, load_msp

CONFIG = Path(__file__).resolve().parents[2] / "config"
D = date(2026, 10, 15)
D_PREV = date(2026, 10, 14)


def raw(market="Latur", commodity="Soyabean", modal=4800, lo=4500, hi=5000, d="15/10/2026",
        variety="Yellow", state="Maharashtra", district="Latur", grade="FAQ"):
    return {"state": state, "district": district, "market": market, "commodity": commodity,
            "variety": variety, "grade": grade, "arrival_date": d, "min_price": str(lo), "max_price": str(hi),
            "modal_price": str(modal)}


@pytest.fixture
def conn(tmp_path):
    c = open_db(tmp_path / "t.db")
    yield c
    c.close()


MSP = MspTable([
    MspRow("soybean", "KMS 2026-27", None, 5708, "https://ddnews.gov.in/x", "2026-05-13", "हमीभाव (खरीप 2026-27)"),
    MspRow("cotton", "KMS 2026-27", "medium staple", 8267, "https://ddnews.gov.in/x", "2026-05-13"),
    MspRow("cotton", "KMS 2026-27", "long staple", 8667, "https://ddnews.gov.in/x", "2026-05-13"),
])

CFG = {
    "commodities": {
        "soybean": {"name_mr": "सोयाबीन", "agmarknet": ["Soyabean"], "varieties": ["Yellow"],
                    "msp_crop": "soybean", "msp_variety": None, "show_vs_msp": True,
                    "key_markets": ["Washim"]},
        "onion": {"name_mr": "कांदा", "agmarknet": ["Onion"], "msp_crop": None, "show_vs_msp": False},
        "cotton": {"name_mr": "कापूस", "agmarknet": ["Cotton"], "msp_crop": "cotton",
                   "msp_variety": "medium staple", "msp_other_varieties": ["long staple"], "show_vs_msp": True},
    },
    "markets": {"Latur": {"mr": "लातूर"}, "Akola": {"mr": "अकोला"}, "Washim": {"mr": "वाशिम"},
                "Amravati": {"mr": "अमरावती", "aliases": ["Amarawati"]}, "Hingoli": {"mr": "हिंगोली"}},
}


# ── parse_row ────────────────────────────────────────────────────────────────


def test_parse_row_ok_ddmmyyyy():
    r = ag.parse_row(raw(d="01/06/2026"))
    assert r is not None and r.arrival_date == date(2026, 6, 1)  # 1 June, not 6 Jan
    assert (r.min_price, r.modal_price, r.max_price) == (4500, 4800, 5000)


@pytest.mark.parametrize("d", [None, "", "31/02/2026", "2026/10/15x", "15/13/2026", "tomorrow", "15/10/26"])
def test_parse_row_rejects_bad_dates_never_substitutes_today(d):
    assert ag.parse_row(raw(d=d)) is None


def test_parse_row_accepts_iso_and_dash_formats():
    assert ag.parse_row(raw(d="2026-10-15")).arrival_date == D
    assert ag.parse_row(raw(d="15-10-2026")).arrival_date == D


def test_parse_row_rejects_future_date_when_today_given():
    assert ag.parse_row(raw(d="17/10/2026"), today=date(2026, 10, 16)) is None
    assert ag.parse_row(raw(d="16/10/2026"), today=date(2026, 10, 16)) is not None


@pytest.mark.parametrize("lo,modal,hi", [(0, 4800, 5000), (4500, 0, 5000), (4500, 4800, -1),
                                        (4500, 5200, 5000), (4500, 4400, 5000), (5100, 5000, 4900),
                                        ("NR", 4800, 5000), ("nan", 4800, 5000)])
def test_parse_row_rejects_bad_prices(lo, modal, hi):
    assert ag.parse_row(raw(lo=lo, modal=modal, hi=hi)) is None


def test_parse_row_devanagari_digits_and_commas():
    r = ag.parse_row(raw(lo="४,५००", modal="४८००", hi="5,000", d="१५/१०/२०२६"))
    assert r is not None and r.modal_price == 4800 and r.arrival_date == D


def test_parse_row_requires_names():
    assert ag.parse_row(raw(market="")) is None
    assert ag.parse_row(raw(state="")) is None
    assert ag.parse_row("not a dict") is None


# ── fetch_snapshot ───────────────────────────────────────────────────────────


@respx.mock
def test_fetch_snapshot_paginates_filters_state_and_drops_bad_rows():
    page0 = [raw(market=f"M{i}") for i in range(3)] + [raw(d="bad")]
    page1 = [raw(market="X"), raw(market="Y", state="Gujarat")]
    route = respx.get(ag.BASE_URL).mock(side_effect=[
        httpx.Response(200, json={"records": page0}),
        httpx.Response(200, json={"records": page1}),
    ])
    with httpx.Client() as client:
        rows = ag.fetch_snapshot(client, "SECRET", page_size=4, max_pages=5)
    assert [r.market for r in rows] == ["M0", "M1", "M2", "X"]
    assert route.call_count == 2  # second page was short -> stop
    q = route.calls[1].request.url.params
    assert q["offset"] == "4" and q["limit"] == "4" and q[ag.STATE_FILTER_PARAM] == "Maharashtra"
    assert q["format"] == "json"


@respx.mock
def test_fetch_snapshot_error_never_leaks_api_key():
    respx.get(ag.BASE_URL).mock(return_value=httpx.Response(403, json={"message": "bad key"}))
    with httpx.Client() as client, pytest.raises(ag.AgmarknetError) as ei:
        ag.fetch_snapshot(client, "SECRET-KEY-123")
    assert "SECRET-KEY-123" not in str(ei.value) and ei.value.__cause__ is None
    assert ei.value.__suppress_context__


@respx.mock
def test_fetch_snapshot_rejects_missing_records():
    respx.get(ag.BASE_URL).mock(return_value=httpx.Response(200, json={"status": "error"}))
    with httpx.Client() as client, pytest.raises(ag.AgmarknetError):
        ag.fetch_snapshot(client, "k")


@respx.mock
def test_fetch_snapshot_stops_at_max_pages():
    route = respx.get(ag.BASE_URL).mock(return_value=httpx.Response(200, json={"records": [raw(), raw()]}))
    with httpx.Client() as client:
        rows = ag.fetch_snapshot(client, "k", page_size=2, max_pages=3)
    assert route.call_count == 3 and len(rows) == 6


# ── store_snapshot ───────────────────────────────────────────────────────────


def test_store_snapshot_groups_by_date_and_is_idempotent(conn):
    rows = [ag.parse_row(raw()), ag.parse_row(raw(market="Akola")), ag.parse_row(raw(d="14/10/2026"))]
    t1 = datetime(2026, 10, 15, 15, tzinfo=timezone.utc)
    assert ag.store_snapshot(conn, rows, now=t1) == [D_PREV, D]
    snap = conn.execute("SELECT * FROM data_snapshots WHERE data_date=?", (D.isoformat(),)).fetchone()
    assert snap["source"] == "agmarknet" and snap["key"] == "Maharashtra"
    assert len(json.loads(snap["payload_json"])) == 2

    # same rows again, in a different order: no change at all (sha and fetched_at kept)
    ag.store_snapshot(conn, list(reversed(rows)), now=datetime(2026, 10, 15, 18, tzinfo=timezone.utc))
    again = conn.execute("SELECT * FROM data_snapshots WHERE data_date=?", (D.isoformat(),)).fetchone()
    assert again["sha256"] == snap["sha256"] and again["fetched_at"] == snap["fetched_at"]
    assert conn.execute("SELECT COUNT(*) FROM data_snapshots").fetchone()[0] == 2


def test_store_snapshot_merges_later_partial_fetch(conn):
    ag.store_snapshot(conn, [ag.parse_row(raw())])
    ag.store_snapshot(conn, [ag.parse_row(raw(market="Akola")), ag.parse_row(raw(modal=4900))])
    rows = ag.load_snapshot(conn, D)
    by_market = {r.market: r.modal_price for r in rows}
    assert by_market == {"Latur": 4900, "Akola": 4800}


# ── mandi_payload ────────────────────────────────────────────────────────────


def _store(conn, rows):
    ag.store_snapshot(conn, [r for r in (ag.parse_row(x) for x in rows) if r])


def test_mandi_payload_basic_median_msp_and_unmapped_dropped(conn):
    _store(conn, [
        raw(market="Latur", modal=4800), raw(market="Akola", modal=5000, hi=5100),
        raw(market="Washim", modal=4600, lo=4400), raw(market="Unknown Yard", modal=4700),
    ])
    p = ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP)
    assert p["data_date"] == "2026-10-15" and "Agmarknet" in p["source"]
    [soy] = p["commodities"]
    assert soy["key"] == "soybean" and soy["name_mr"] == "सोयाबीन"
    assert [m["market_mr"] for m in soy["markets"]] == ["वाशिम", "अकोला", "लातूर"]  # key market first
    assert soy["median_modal"] == 4800 and soy["msp"] == 5708
    assert soy["vs_msp_pct"] == round((4800 - 5708) / 5708 * 100, 1)
    assert soy["prev_median_modal"] is None
    assert isinstance(soy["markets"][0]["modal"], int)


def test_mandi_payload_none_below_min_markets(conn):
    _store(conn, [raw(market="Latur"), raw(market="Akola")])
    assert ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP) is None
    assert ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP, min_markets=2) is not None


def test_mandi_payload_none_without_snapshot(conn):
    assert ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP) is None


def test_mandi_payload_outlier_vs_msp_dropped(conn):
    # 5708 * 1.7 = 9703.6 ; 5708 * 0.3 = 1712.4
    _store(conn, [raw(market="Latur"), raw(market="Akola"), raw(market="Washim"),
                  raw(market="Hingoli", modal=9800, lo=9000, hi=9900),
                  raw(market="Amarawati", modal=1500, lo=1400, hi=1600)])
    soy = ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP)["commodities"][0]
    assert {m["market"] for m in soy["markets"]} == {"Latur", "Akola", "Washim"}
    assert soy["n_markets"] == 3


def test_mandi_payload_onion_without_msp_uses_median_band(conn):
    _store(conn, [raw(market=m, commodity="Onion", variety="Red", modal=v, lo=v - 100, hi=v + 100)
                  for m, v in [("Latur", 2000), ("Akola", 2200), ("Washim", 2100), ("Hingoli", 9000)]])
    onion = ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP)["commodities"][0]
    assert onion["key"] == "onion" and onion["msp"] is None and onion["vs_msp_pct"] is None
    assert onion["n_markets"] == 3 and onion["median_modal"] == 2100


def test_mandi_payload_prev_median_uses_common_markets(conn):
    _store(conn, [raw(market=m, modal=v, d="14/10/2026", lo=v - 200, hi=v + 200)
                  for m, v in [("Latur", 4700), ("Akola", 4900), ("Washim", 4500), ("Hingoli", 4000)]])
    _store(conn, [raw(market=m, modal=v, lo=v - 200, hi=v + 200)
                  for m, v in [("Latur", 4800), ("Akola", 5000), ("Washim", 4600)]])
    soy = ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP)["commodities"][0]
    assert soy["prev_median_modal"] == 4700  # median of Latur/Akola/Washim on the 14th, Hingoli excluded
    assert soy["prev_data_date"] == "2026-10-14"


def test_mandi_payload_variety_preference_one_row_per_market(conn):
    _store(conn, [raw(market="Latur", variety="Other", modal=4000, lo=3900),
                  raw(market="Latur", variety="Yellow", modal=4800),
                  raw(market="Akola"), raw(market="Washim")])
    soy = ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP)["commodities"][0]
    latur = [m for m in soy["markets"] if m["market"] == "Latur"]
    assert len(latur) == 1 and latur[0]["variety"] == "Yellow" and latur[0]["modal"] == 4800


def test_mandi_payload_cotton_shows_both_staples(conn):
    _store(conn, [raw(market=m, commodity="Cotton", variety="", modal=7800, lo=7500, hi=8000)
                  for m in ("Latur", "Akola", "Washim")])
    cotton = ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP)["commodities"][0]
    assert cotton["msp"] == 8267 and cotton["msp_variety"] == "medium staple"
    assert cotton["msp_other"] == [{"variety": "long staple", "msp": 8667, "label": "MSP KMS 2026-27"}]


def test_mandi_payload_with_real_config_files(conn):
    cfg = ag.load_commodities_cfg(CONFIG)
    msp = load_msp(CONFIG)
    _store(conn, [raw(market=m, modal=5000, lo=4800, hi=5200) for m in ("Latur", "Akola", "Washim")]
           + [raw(market=m, commodity="Bengal Gram(Gram)(Whole)", variety="Desi (Whole)", modal=5600, lo=5400, hi=5800)
              for m in ("Latur", "Akola", "Jalna")])
    p = ag.mandi_payload(conn, D, commodities_cfg=cfg, msp=msp)
    by_key = {c["key"]: c for c in p["commodities"]}
    assert by_key["soybean"]["msp"] == 5708
    assert by_key["chana"]["msp"] is None  # RMS 2027-28 MSP is never compared with today's chana
    json.dumps(p, ensure_ascii=False)  # JSON-safe for videos.payload_json


# ── review fixes ─────────────────────────────────────────────────────────────


def test_parse_row_keeps_grade():
    assert ag.parse_row(raw(grade="Non-FAQ")).grade == "Non-FAQ"
    assert ag.parse_row({k: v for k, v in raw().items() if k != "grade"}).grade == ""


def test_store_snapshot_keeps_grades_apart_and_is_order_independent(conn):
    a = ag.parse_row(raw(grade="FAQ", modal=4800))
    b = ag.parse_row(raw(grade="Non-FAQ", modal=4200, lo=4000))
    dup1 = ag.parse_row(raw(market="Akola", modal=4700))
    dup2 = ag.parse_row(raw(market="Akola", modal=4900))  # same key twice in one fetch
    ag.store_snapshot(conn, [a, b, dup1, dup2])
    sha1 = conn.execute("SELECT sha256 FROM data_snapshots").fetchone()[0]
    assert len(ag.load_snapshot(conn, D)) == 3
    conn.execute("DELETE FROM data_snapshots")
    ag.store_snapshot(conn, [dup2, b, dup1, a])
    assert conn.execute("SELECT sha256 FROM data_snapshots").fetchone()[0] == sha1


def test_load_snapshot_reads_rows_stored_without_grade(conn):
    legacy = [{k: v for k, v in ag._row_json(ag.parse_row(raw())).items() if k != "grade"}]
    conn.execute("INSERT INTO data_snapshots(source, key, data_date, fetched_at, payload_json, sha256) "
                 "VALUES ('agmarknet', 'Maharashtra', ?, '2026-10-15T00:00:00+00:00', ?, 'x')",
                 (D.isoformat(), json.dumps(legacy)))
    assert ag.load_snapshot(conn, D)[0].grade == ""


@respx.mock
def test_fetch_snapshot_rejects_future_rows_by_default():
    respx.get(ag.BASE_URL).mock(return_value=httpx.Response(200, json={"records": [raw(), raw(d="01/01/2099")]}))
    with httpx.Client() as client:
        rows = ag.fetch_snapshot(client, "k")
    assert [r.arrival_date for r in rows] == [D]


@respx.mock
def test_fetch_snapshot_redacts_api_key_from_httpx_logs(caplog):
    respx.get(ag.BASE_URL).mock(return_value=httpx.Response(200, json={"records": []}))
    caplog.set_level("INFO", logger="httpx")
    with httpx.Client() as client:
        ag.fetch_snapshot(client, "SECRET-KEY-123", today=D)
    assert "HTTP Request" in caplog.text and "api-key=<redacted>" in caplog.text
    assert "SECRET-KEY-123" not in caplog.text


@respx.mock
def test_fetch_snapshot_warns_when_max_pages_exhausted(caplog):
    respx.get(ag.BASE_URL).mock(return_value=httpx.Response(200, json={"records": [raw(), raw()]}))
    with httpx.Client() as client:
        ag.fetch_snapshot(client, "k", page_size=2, max_pages=2, today=D)
    assert "may be partial" in caplog.text


def _soy(conn, d, values):
    _store(conn, [raw(market=m, modal=v, d=d, lo=v - 200, hi=v + 200) for m, v in values])


def test_mandi_payload_differences_are_grounded(conn):
    _soy(conn, "14/10/2026", [("Latur", 4700), ("Akola", 4900), ("Washim", 4500)])
    _soy(conn, "15/10/2026", [("Latur", 4800), ("Akola", 5000), ("Washim", 4600)])
    soy = ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP)["commodities"][0]
    assert soy["median_modal"] == 4800 and soy["prev_median_modal"] == 4700
    assert soy["change_vs_prev"] == 100 and soy["diff_vs_msp"] == 4800 - 5708


def test_mandi_payload_prev_skips_straggler_snapshot(conn):
    _soy(conn, "13/10/2026", [("Latur", 4600), ("Akola", 4800), ("Washim", 4400)])
    _soy(conn, "14/10/2026", [("Latur", 4700)])                 # a late-reporting straggler only
    _soy(conn, "15/10/2026", [("Latur", 4800), ("Akola", 5000), ("Washim", 4600)])
    soy = ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP)["commodities"][0]
    assert soy["prev_data_date"] == "2026-10-13" and soy["prev_median_modal"] == 4600


def test_mandi_payload_prev_ignores_stale_snapshots(conn):
    _soy(conn, "01/10/2026", [("Latur", 4600), ("Akola", 4800), ("Washim", 4400)])  # 14 days earlier
    _soy(conn, "15/10/2026", [("Latur", 4800), ("Akola", 5000), ("Washim", 4600)])
    soy = ag.mandi_payload(conn, D, commodities_cfg=CFG, msp=MSP)["commodities"][0]
    assert soy["prev_median_modal"] is None and soy["prev_data_date"] is None and soy["change_vs_prev"] is None


def test_mandi_payload_msp_only_from_season_open_on_data_date(conn):
    _soy(conn, "30/09/2026", [("Latur", 4800), ("Akola", 5000), ("Washim", 4600)])
    soy = ag.mandi_payload(conn, date(2026, 9, 30), commodities_cfg=CFG, msp=MSP)["commodities"][0]
    # 30 Sep 2026 is still KMS 2025-26: the KMS 2026-27 MSP must not be shown
    assert soy["msp"] is None and soy["vs_msp_pct"] is None and soy["diff_vs_msp"] is None
