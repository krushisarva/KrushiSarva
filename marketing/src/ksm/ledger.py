"""Cost ledger and the monthly budget state.

Months are IST calendar months: the founder's budget is an Indian-month budget, and a
UTC month would shift 5.5 h of spend across the boundary.

Budget states (fraction of settings.monthly_budget_inr spent this month):
  ok         < 80 % and on pace
  warn       < 80 % but the month-to-date pace projects >= 100 % by month end (alert only)
  degraded   >= 80 %: writer effort low, vision QA off
  exhausted  >= 100 %: no new production; only already-approved videos are published
"""
from __future__ import annotations

import calendar
import json
import sqlite3
from datetime import datetime
from typing import Any, Literal

from .clock import to_ist
from .config import Settings
from .db import iso, utcnow

BudgetState = Literal["ok", "warn", "degraded", "exhausted"]

DEGRADE_AT = 0.80
EXHAUST_AT = 1.00
PACE_MIN_DAY = 7                      # too noisy to project before a week of data

SARVAM_INR_PER_10K_CHARS = 20.0       # bulbul v4-flash list price (plan §6)


def month_of(dt: datetime) -> str:
    return to_ist(dt).strftime("%Y-%m")


def record(conn: sqlite3.Connection, provider: str, op: str, cost_inr: float, video_id: int | None = None,
           *, now: datetime | None = None, **units: Any) -> None:
    now = now or utcnow()
    conn.execute(
        "INSERT INTO cost_ledger(ts, month, provider, op, video_id, units_json, cost_inr) VALUES (?,?,?,?,?,?,?)",
        (iso(now), month_of(now), provider, op, video_id,
         json.dumps(units, ensure_ascii=False, default=str), round(float(cost_inr), 4)),
    )


def month_spend(conn: sqlite3.Connection, month: str) -> float:
    row = conn.execute("SELECT COALESCE(SUM(cost_inr), 0) AS s FROM cost_ledger WHERE month = ?", (month,)).fetchone()
    return float(row["s"])


def video_spend(conn: sqlite3.Connection, video_id: int) -> float:
    row = conn.execute("SELECT COALESCE(SUM(cost_inr), 0) AS s FROM cost_ledger WHERE video_id = ?",
                       (video_id,)).fetchone()
    return float(row["s"])


def budget_state(conn: sqlite3.Connection, settings: Settings, now: datetime | None = None) -> BudgetState:
    now = now or utcnow()
    cap = settings.monthly_budget_inr
    if cap <= 0:
        return "exhausted"
    spent = month_spend(conn, month_of(now))
    frac = spent / cap
    if frac >= EXHAUST_AT:
        return "exhausted"
    if frac >= DEGRADE_AT:
        return "degraded"
    local = to_ist(now)
    if local.day >= PACE_MIN_DAY:
        days = calendar.monthrange(local.year, local.month)[1]
        elapsed = local.day - 1 + (local.hour * 60 + local.minute) / 1440
        if elapsed > 0 and spent / elapsed * days >= cap:
            return "warn"
    return "ok"


# ── price helpers ─────────────────────────────────────────────────────────────


def sarvam_cost_inr(chars: int) -> float:
    return chars * SARVAM_INR_PER_10K_CHARS / 10_000


def claude_cost_inr(settings: Settings, *, input_tokens: int = 0, output_tokens: int = 0, cache_read: int = 0,
                    cache_write: int = 0, web_searches: int = 0) -> float:
    """Token prices live with the writer (one table); this converts to INR at settings.usd_inr."""
    from .writer.claude import cost_usd  # lazy: built by the writer module

    return cost_usd(settings.model, input_tokens=input_tokens, output_tokens=output_tokens, cache_read=cache_read,
                    cache_write=cache_write, web_searches=web_searches) * settings.usd_inr


def usage_cost_inr(usage: dict, settings: Settings) -> float:
    """Cost of a writer/factcheck usage dict: its own cost_inr when present, else priced from tokens."""
    if isinstance(usage.get("cost_inr"), (int, float)):
        return float(usage["cost_inr"])
    return claude_cost_inr(
        settings, input_tokens=int(usage.get("input_tokens") or 0), output_tokens=int(usage.get("output_tokens") or 0),
        cache_read=int(usage.get("cache_read_input_tokens") or 0),
        cache_write=int(usage.get("cache_creation_input_tokens") or 0),
        web_searches=int(usage.get("web_search_requests") or 0),
    )
