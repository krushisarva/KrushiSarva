"""Agmarknet daily mandi prices via data.gov.in, snapshotted into SQLite.

Stricter than backend/src/services/mandiPrice.service.js on purpose: the backend
substitutes today's date for a bad arrival_date and accepts zero prices; a video
that shows a wrong date or price is worse than no video, so bad rows are dropped.
Market labels come only from config/markets_mr.yaml (never the backend's
DISTRICT_MANDIS); a market without a Marathi name is left out of the payload.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import re
import sqlite3
import statistics
from dataclasses import asdict, dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable

import httpx
import yaml

from ..clock import ist_date
from ..db import iso, tx, utcnow
from .msp import MspTable

RESOURCE_ID = "9ef84268-d588-465a-a308-a864a43d0070"
BASE_URL = f"https://api.data.gov.in/resource/{RESOURCE_ID}"
SOURCE = "agmarknet"
SOURCE_LABEL = "Agmarknet / data.gov.in, Government of India"
# The backend uses `filters[state]` (case-sensitive value). Some data.gov.in docs show
# `filters[state.keyword]`; verify on day 0. Rows are also filtered client-side, so a
# filter the API ignores costs pages, not correctness.
STATE_FILTER_PARAM = "filters[state]"
TIMEOUT = httpx.Timeout(20.0, connect=10.0)
OUTLIER_BAND = 0.70  # modal more than ±70 % away from the reference price is dropped
PREV_MAX_GAP_DAYS = 7  # day-over-day change only against a snapshot at most this old

log = logging.getLogger(__name__)

_DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")
_DMY = re.compile(r"(\d{1,2})[/-](\d{1,2})[/-](\d{4})")
_YMD = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?")


class AgmarknetError(RuntimeError):
    """Fetch failure. Messages never include the request URL (it carries the api-key)."""


_API_KEY_IN_URL = re.compile(r"(api-key=)[^&\s\"']+", re.IGNORECASE)


class _RedactApiKeyFilter(logging.Filter):
    """httpx logs every request URL at INFO ("HTTP Request: GET https://...?api-key=...");
    the data.gov.in key travels in the query string, so redact it before any handler sees it."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # noqa: BLE001 - never break logging
            return True
        if "api-key=" in msg.lower():
            record.msg, record.args = _API_KEY_IN_URL.sub(r"\1<redacted>", msg), ()
        return True


_REDACT = _RedactApiKeyFilter()


def _install_redaction() -> None:
    for name in ("httpx", "httpcore"):
        lg = logging.getLogger(name)
        if _REDACT not in lg.filters:
            lg.addFilter(_REDACT)


@dataclass(frozen=True)
class MandiRow:
    commodity: str
    variety: str
    market: str
    district: str
    state: str
    min_price: float
    max_price: float
    modal_price: float
    arrival_date: date
    grade: str = ""   # data.gov.in reports FAQ / Non-FAQ / Local rows separately for one market


# ── Parsing ──────────────────────────────────────────────────────────────────


def _field(raw: dict, *names: str) -> Any:
    for n in names:
        v = raw.get(n)
        if v not in (None, ""):
            return v
    return None


def _text(v: Any) -> str:
    return " ".join(str(v).split()) if v is not None else ""


def _price(v: Any) -> float | None:
    if v is None or isinstance(v, bool):
        return None
    s = str(v).translate(_DEVANAGARI_DIGITS).replace(",", "").strip()
    try:
        x = float(s)
    except ValueError:
        return None
    return x if math.isfinite(x) and x > 0 else None


def parse_arrival_date(v: Any) -> date | None:
    """DD/MM/YYYY or DD-MM-YYYY (data.gov.in) or ISO YYYY-MM-DD; None if invalid."""
    if v is None:
        return None
    s = str(v).translate(_DEVANAGARI_DIGITS).strip()
    try:
        if m := _DMY.fullmatch(s):
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        if m := _YMD.fullmatch(s):
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        pass
    return None


def parse_row(raw: dict, *, today: date | None = None) -> MandiRow | None:
    """None on bad/missing date (never substitutes today), a future date (when `today`
    is given), any price <= 0, min > max or modal outside [min, max], or missing names."""
    if not isinstance(raw, dict):
        return None
    d = parse_arrival_date(_field(raw, "arrival_date", "Arrival_Date"))
    if d is None or (today is not None and d > today):
        return None
    lo = _price(_field(raw, "min_price", "Min_Price", "MinPrice"))
    hi = _price(_field(raw, "max_price", "Max_Price", "MaxPrice"))
    modal = _price(_field(raw, "modal_price", "Modal_Price", "ModalPrice"))
    if lo is None or hi is None or modal is None or not (lo <= modal <= hi):
        return None
    commodity = _text(_field(raw, "commodity", "Commodity"))
    market = _text(_field(raw, "market", "Market"))
    state = _text(_field(raw, "state", "State"))
    if not commodity or not market or not state:
        return None
    return MandiRow(
        commodity=commodity,
        variety=_text(_field(raw, "variety", "Variety")),
        market=market,
        district=_text(_field(raw, "district", "District")),
        state=state,
        min_price=lo, max_price=hi, modal_price=modal,
        arrival_date=d,
        grade=_text(_field(raw, "grade", "Grade")),
    )


# ── Fetch ────────────────────────────────────────────────────────────────────


def fetch_snapshot(client: httpx.Client, api_key: str, state: str = "Maharashtra",
                   page_size: int = 500, max_pages: int = 20, *,
                   today: date | None = None) -> list[MandiRow]:
    """All valid rows for `state`, paginated until a short page or max_pages.

    `today` (default: today in IST) rejects rows dated in the future."""
    _install_redaction()
    today = today or ist_date(utcnow())
    out: list[MandiRow] = []
    want = state.casefold()
    for page in range(max_pages):
        params = {
            "api-key": api_key, "format": "json", "limit": page_size,
            "offset": page * page_size, STATE_FILTER_PARAM: state,
        }
        try:
            resp = client.get(BASE_URL, params=params, timeout=TIMEOUT)
            resp.raise_for_status()
            body = resp.json()
        except httpx.HTTPStatusError as e:
            raise AgmarknetError(f"data.gov.in HTTP {e.response.status_code} on page {page}") from None
        except httpx.HTTPError as e:
            raise AgmarknetError(f"data.gov.in request failed on page {page}: {type(e).__name__}") from None
        except ValueError:
            raise AgmarknetError(f"data.gov.in returned non-JSON on page {page}") from None
        records = body.get("records") if isinstance(body, dict) else None
        if not isinstance(records, list):
            raise AgmarknetError(f"data.gov.in response has no records list on page {page}")
        for raw in records:
            row = parse_row(raw, today=today)
            if row is not None and row.state.casefold() == want:
                out.append(row)
        if len(records) < page_size:
            break
    else:
        # Every page was full: the snapshot may be truncated (e.g. the API ignored the
        # state filter). store_snapshot merges, so a later fetch can still fill it in.
        log.warning("agmarknet: stopped at max_pages=%d with full pages; snapshot may be partial", max_pages)
    return out


# ── Snapshots ────────────────────────────────────────────────────────────────


def _row_key(r: MandiRow) -> tuple[str, str, str, str, str]:
    return (r.commodity.casefold(), r.variety.casefold(), r.grade.casefold(),
            r.market.casefold(), r.district.casefold())


def _row_order(r: MandiRow) -> tuple:
    """Total order used to break exact-key ties, so the stored snapshot never depends
    on the order the API happened to return rows in."""
    return (r.modal_price, r.min_price, r.max_price, r.commodity, r.variety, r.grade, r.market, r.district, r.state)


def _row_json(r: MandiRow) -> dict:
    d = asdict(r)
    d["arrival_date"] = r.arrival_date.isoformat()
    return d


def _row_from_json(d: dict) -> MandiRow:
    # Snapshots stored before `grade` existed simply lack the key (dataclass default "").
    return MandiRow(**{**d, "arrival_date": date.fromisoformat(d["arrival_date"])})


def _canonical(rows: Iterable[MandiRow]) -> str:
    items = sorted((_row_json(r) for r in rows),
                   key=lambda d: (d["commodity"], d["variety"], d["grade"], d["market"], d["district"]))
    return json.dumps(items, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def store_snapshot(conn: sqlite3.Connection, rows: Iterable[MandiRow], *, key: str = "Maharashtra",
                   now: datetime | None = None) -> list[date]:
    """Group rows by arrival_date into data_snapshots; returns the dates touched (sorted).

    Idempotent: re-storing the same rows changes nothing. data.gov.in fills a day in
    over several hours, so a later fetch is merged into the existing snapshot (newer
    values win per commodity/variety/market) instead of replacing it.
    """
    by_date: dict[date, dict[tuple, MandiRow]] = {}
    for r in rows:
        day = by_date.setdefault(r.arrival_date, {})
        k = _row_key(r)
        if k not in day or _row_order(r) < _row_order(day[k]):
            day[k] = r
    fetched = iso(now or utcnow())
    with tx(conn):
        for d, fresh in by_date.items():
            existing = conn.execute(
                "SELECT payload_json, sha256 FROM data_snapshots WHERE source=? AND key=? AND data_date=?",
                (SOURCE, key, d.isoformat()),
            ).fetchone()
            merged: dict[tuple, MandiRow] = {}
            if existing:
                for item in json.loads(existing["payload_json"]):
                    old = _row_from_json(item)
                    merged[_row_key(old)] = old
            merged.update(fresh)
            payload = _canonical(merged.values())
            sha = hashlib.sha256(payload.encode("utf-8")).hexdigest()
            if existing and existing["sha256"] == sha:
                continue
            conn.execute(
                "INSERT INTO data_snapshots(source, key, data_date, fetched_at, payload_json, sha256) "
                "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, key, data_date) DO UPDATE SET "
                "fetched_at=excluded.fetched_at, payload_json=excluded.payload_json, sha256=excluded.sha256",
                (SOURCE, key, d.isoformat(), fetched, payload, sha),
            )
    return sorted(by_date)


def load_snapshot(conn: sqlite3.Connection, data_date: date, *, key: str = "Maharashtra") -> list[MandiRow] | None:
    row = conn.execute(
        "SELECT payload_json FROM data_snapshots WHERE source=? AND key=? AND data_date=?",
        (SOURCE, key, data_date.isoformat()),
    ).fetchone()
    return [_row_from_json(d) for d in json.loads(row["payload_json"])] if row else None


def previous_snapshot_date(conn: sqlite3.Connection, data_date: date, *, key: str = "Maharashtra") -> date | None:
    row = conn.execute(
        "SELECT MAX(data_date) AS d FROM data_snapshots WHERE source=? AND key=? AND data_date < ?",
        (SOURCE, key, data_date.isoformat()),
    ).fetchone()
    return date.fromisoformat(row["d"]) if row and row["d"] else None


def _earlier_snapshot_dates(conn: sqlite3.Connection, data_date: date, *, key: str,
                            max_gap_days: int = PREV_MAX_GAP_DAYS) -> list[date]:
    """Snapshot dates before data_date, newest first, at most max_gap_days back."""
    lo = date.fromordinal(data_date.toordinal() - max_gap_days)
    rows = conn.execute(
        "SELECT data_date FROM data_snapshots WHERE source=? AND key=? AND data_date < ? AND data_date >= ? "
        "ORDER BY data_date DESC",
        (SOURCE, key, data_date.isoformat(), lo.isoformat()),
    ).fetchall()
    return [date.fromisoformat(r["data_date"]) for r in rows]


def latest_snapshot_date(conn: sqlite3.Connection, *, key: str = "Maharashtra") -> date | None:
    row = conn.execute(
        "SELECT MAX(data_date) AS d FROM data_snapshots WHERE source=? AND key=?", (SOURCE, key)
    ).fetchone()
    return date.fromisoformat(row["d"]) if row and row["d"] else None


# ── Payload ──────────────────────────────────────────────────────────────────


def load_commodities_cfg(config_dir: Path | str) -> dict:
    """{"commodities": crops_mr.yaml[commodities], "markets": markets_mr.yaml[markets]}."""
    config_dir = Path(config_dir)
    with open(config_dir / "crops_mr.yaml", encoding="utf-8") as f:
        crops = yaml.safe_load(f) or {}
    with open(config_dir / "markets_mr.yaml", encoding="utf-8") as f:
        markets = yaml.safe_load(f) or {}
    return {"commodities": crops.get("commodities", {}), "markets": markets.get("markets", {})}


def _market_index(markets: dict) -> dict[str, dict]:
    """casefolded Agmarknet market string (and aliases) -> {"key", "mr"}."""
    idx: dict[str, dict] = {}
    for name, cfg in (markets or {}).items():
        cfg = cfg if isinstance(cfg, dict) else {"mr": cfg}
        if not cfg.get("mr"):
            continue
        entry = {"key": name, "mr": cfg["mr"]}
        for alias in [name, *(cfg.get("aliases") or [])]:
            idx[" ".join(str(alias).split()).casefold()] = entry
    return idx


def _num(x: float) -> int | float:
    """Show whole rupees as ints so payload values read "5708", not "5708.0"."""
    return int(x) if float(x).is_integer() else round(x, 2)


def _per_market(rows: list[MandiRow], names: set[str], varieties: list[str],
                idx: dict[str, dict]) -> dict[str, tuple[MandiRow, dict]]:
    """One row per mapped market for a commodity; preferred variety first, then the
    lowest modal (deterministic and never flatters the price)."""
    rank = {v.casefold(): i for i, v in enumerate(varieties)}

    def pref(r: MandiRow) -> tuple:
        return (rank.get(r.variety.casefold(), len(rank)), r.modal_price, r.variety, r.grade, r.district)

    best: dict[str, tuple[MandiRow, dict]] = {}
    for r in rows:
        if r.commodity.casefold() not in names:
            continue
        m = idx.get(r.market.casefold())
        if m is None:
            continue  # unmapped market: no verified Marathi label -> not shown
        cur = best.get(m["key"])
        if cur is None or pref(r) < pref(cur[0]):
            best[m["key"]] = (r, m)
    return best


def _filter_outliers(per_market: dict[str, tuple[MandiRow, dict]], ref: float | None) -> dict:
    if ref is None:
        if not per_market:
            return per_market
        ref = statistics.median(r.modal_price for r, _ in per_market.values())
    lo, hi = ref * (1 - OUTLIER_BAND), ref * (1 + OUTLIER_BAND)
    return {k: v for k, v in per_market.items() if lo <= v[0].modal_price <= hi}


def mandi_payload(conn: sqlite3.Connection, data_date: date, *, commodities_cfg: dict, msp: MspTable,
                  min_markets: int = 3, key: str = "Maharashtra") -> dict | None:
    """Payload for the बाजारभाव video; None if no commodity has >= min_markets markets.

    commodities_cfg is load_commodities_cfg(): {"commodities": {...}, "markets": {...}}.
    A bare crops_mr.yaml mapping is accepted too; markets then load from the config dir.
    """
    rows = load_snapshot(conn, data_date, key=key)
    if not rows:
        return None
    commodities = commodities_cfg.get("commodities", commodities_cfg)
    markets = commodities_cfg.get("markets")
    if markets is None:
        from ..paths import get_paths
        markets = load_commodities_cfg(get_paths().config_dir)["markets"]
    idx = _market_index(markets)

    # Late-reporting markets can create tiny snapshots for odd dates, so walk back
    # (bounded) to the newest earlier day that shares enough markets with this one.
    prev_dates = _earlier_snapshot_dates(conn, data_date, key=key)
    prev_cache: dict[date, list[MandiRow]] = {}

    def prev_rows(d: date) -> list[MandiRow]:
        if d not in prev_cache:
            prev_cache[d] = load_snapshot(conn, d, key=key) or []
        return prev_cache[d]

    out: list[dict] = []
    for ckey, cfg in commodities.items():
        if not isinstance(cfg, dict) or cfg.get("enabled", True) is False:
            continue
        names = {n.casefold() for n in cfg.get("agmarknet", [])}
        varieties = list(cfg.get("varieties") or [])
        msp_row = (msp.lookup(cfg["msp_crop"], cfg.get("msp_variety"), on=data_date)
                   if cfg.get("msp_crop") else None)
        ref = float(msp_row.price) if msp_row else None

        kept = _filter_outliers(_per_market(rows, names, varieties, idx), ref)
        if len(kept) < min_markets:
            continue
        median = statistics.median(r.modal_price for r, _ in kept.values())
        show_msp = bool(cfg.get("show_vs_msp", True)) and msp_row is not None

        prev_median = prev_date = None
        for d in prev_dates:
            prev_kept = _filter_outliers(_per_market(prev_rows(d), names, varieties, idx), ref)
            # Compare like with like: only markets reporting on both days.
            common = [k for k in kept if k in prev_kept]
            if len(common) >= min_markets:
                prev_median = _num(round(statistics.median(prev_kept[k][0].modal_price for k in common)))
                prev_date = d
                break
        median_modal = _num(round(median))

        priority = {m: i for i, m in enumerate(cfg.get("key_markets") or [])}
        ordered = sorted(kept.items(), key=lambda kv: (priority.get(kv[0], len(priority)), -kv[1][0].modal_price, kv[0]))
        max_show = int(cfg.get("max_markets", 8))
        item = {
            "key": ckey,
            "name_mr": cfg["name_mr"],
            "msp": msp_row.price if show_msp else None,
            "msp_label": (msp_row.label_mr or f"MSP {msp_row.season_label}") if show_msp else None,
            "msp_variety": msp_row.variety if show_msp else None,
            "msp_source_url": msp_row.source_url if show_msp else None,
            "markets": [
                {"market": r.market, "market_mr": m["mr"], "district": r.district, "variety": r.variety,
                 "modal": _num(r.modal_price), "min": _num(r.min_price), "max": _num(r.max_price)}
                for _, (r, m) in ordered[:max_show]
            ],
            "n_markets": len(kept),
            "median_modal": median_modal,
            "vs_msp_pct": round((median - msp_row.price) / msp_row.price * 100, 1) if show_msp else None,
            # Signed ₹ differences, so a script saying "₹908 कमी" is grounded in the payload.
            "diff_vs_msp": median_modal - msp_row.price if show_msp else None,
            "prev_median_modal": prev_median,
            "prev_data_date": prev_date.isoformat() if prev_date is not None else None,
            "change_vs_prev": median_modal - prev_median if prev_median is not None else None,
        }
        if show_msp and cfg.get("msp_other_varieties"):
            item["msp_other"] = [
                {"variety": o.variety, "msp": o.price, "label": o.label_mr or f"MSP {o.season_label}"}
                for v in cfg["msp_other_varieties"] if (o := msp.lookup(cfg["msp_crop"], v, on=data_date))
            ]
        out.append(item)

    if not out:
        return None
    return {
        "data_date": data_date.isoformat(),
        "source": SOURCE_LABEL,
        "source_mr": "स्रोत: Agmarknet / data.gov.in, भारत सरकार",
        "state": key,
        "unit_mr": "₹ प्रति क्विंटल",
        "commodities": out,
    }
