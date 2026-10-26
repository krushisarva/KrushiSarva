"""What to make for a slot.

Fresh (morning) slots carry the mandi series, built only from the stored Agmarknet
snapshot for the day before the slot. APMCs close on Sundays and holidays, so when the
newest snapshot is older than slot_date-1 the slot gets an evergreen video instead
(a price video must never show stale prices as "today's").

Advisory (evening) slots and every evergreen fallback pick an enabled series by weight
(series_weights table, seeded from config/series.yaml), and only ever use advisories
marked `verified: true`. A topic is not repeated within TOPIC_COOLDOWN.
"""
from __future__ import annotations

import random
import sqlite3
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable

from .clock import at_ist
from .config import Settings, load_yaml
from .db import iso
from .models import TERMINAL_VIDEO_STATES, Slot, SlotKind, VideoPlan
from .paths import get_paths

TOPIC_COOLDOWN = timedelta(days=14)
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
ADVISORY_SERIES_DEFAULT = "rabi_guide"   # advisories.yaml entries without a `series:` key


def load_series(config_dir: Path | None = None) -> list[dict]:
    data = load_yaml("series.yaml", config_dir or get_paths().config_dir) or {}
    return [s for s in (data.get("series") or []) if isinstance(s, dict) and s.get("key")]


def series_cfg(series: str, config_dir: Path | None = None) -> dict:
    for s in load_series(config_dir):
        if s["key"] == series:
            return s
    raise KeyError(f"series {series!r} not in series.yaml")


def seed_series_weights(conn: sqlite3.Connection, series: Iterable[dict], now: datetime) -> None:
    """Config weights are defaults; rows the weekly report changed (source != 'config') are kept."""
    for s in series:
        conn.execute(
            "INSERT INTO series_weights(series, weight, updated_at, source) VALUES (?,?,?, 'config') "
            "ON CONFLICT(series) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at "
            "WHERE series_weights.source = 'config' AND series_weights.weight != excluded.weight",
            (s["key"], float(s.get("weight") or 0.0), iso(now)),
        )


def series_weights(conn: sqlite3.Connection) -> dict[str, float]:
    return {r["series"]: float(r["weight"]) for r in conn.execute("SELECT series, weight FROM series_weights")}


def topics_in_use(conn: sqlite3.Connection, now: datetime) -> set[str]:
    """Topic keys used within the cooldown, plus any still in flight."""
    since = iso(now - TOPIC_COOLDOWN)
    terminal = tuple(s.value for s in TERMINAL_VIDEO_STATES)
    rows = conn.execute(
        f"SELECT topic_key FROM videos WHERE created_at >= ? OR state NOT IN ({','.join('?' * len(terminal))})",
        (since, *terminal),
    )
    return {r["topic_key"] for r in rows}


def _last_used(conn: sqlite3.Connection, topic_key: str) -> str:
    row = conn.execute("SELECT MAX(created_at) AS t FROM videos WHERE topic_key = ?", (topic_key,)).fetchone()
    return row["t"] or ""


# ── mandi (fresh) ─────────────────────────────────────────────────────────────


def _mandi_plan(conn: sqlite3.Connection, slot: Slot, cfg: dict, config_dir: Path) -> VideoPlan | None:
    from .sources.agmarknet import latest_snapshot_date, load_commodities_cfg, mandi_payload  # lazy: sources module
    from .sources.msp import load_msp

    if WEEKDAYS[slot.slot_date.weekday()] not in (cfg.get("days") or WEEKDAYS):
        return None
    want = slot.slot_date - timedelta(days=1)
    latest = latest_snapshot_date(conn)
    if latest is None or latest < want:
        return None
    payload = mandi_payload(conn, want, commodities_cfg=load_commodities_cfg(config_dir), msp=load_msp(config_dir))
    if payload is None:
        return None
    hours = cfg.get("freshness_hours")
    fresh_until = (at_ist(want + timedelta(days=1), "00:00") + timedelta(hours=float(hours))) if hours else slot.late_until
    return VideoPlan(series=cfg["key"], topic_key=f"mandi-{want.isoformat()}", data_date=want, evergreen=False,
                     time_sensitive=bool(cfg.get("time_sensitive", True)),
                     fresh_until=max(fresh_until, slot.late_until), payload=payload)


# ── advisories (evergreen) ────────────────────────────────────────────────────


def _advisory_plan(conn: sqlite3.Connection, cfg: dict, config_dir: Path, used: set[str],
                   now: datetime) -> VideoPlan | None:
    from .sources.advisories import advisory_payload, load_advisories  # lazy: sources module

    entries = [e for e in load_advisories(config_dir)
               if e.get("verified") is True and e.get("series", ADVISORY_SERIES_DEFAULT) == cfg["key"]]
    fresh = [e for e in entries if f"adv-{e['id']}" not in used]
    if not fresh:
        return None
    # Least recently used first (never-used first), then file order.
    fresh.sort(key=lambda e: _last_used(conn, f"adv-{e['id']}"))
    e = fresh[0]
    ts = bool(cfg.get("time_sensitive", False))
    hours = cfg.get("freshness_hours")
    return VideoPlan(series=cfg["key"], topic_key=f"adv-{e['id']}", data_date=None,
                     evergreen=bool(cfg.get("evergreen", True)), time_sensitive=ts,
                     fresh_until=(now + timedelta(hours=float(hours))) if ts and hours else None,
                     payload=advisory_payload(e))


def plan_evergreen(conn: sqlite3.Connection, now: datetime, settings: Settings, *, seed: str,
                   kind: SlotKind | None = None, config_dir: Path | None = None) -> VideoPlan | None:
    """Weighted pick among enabled series that can produce a video right now.

    kind=None considers every enabled evergreen series (fallback / buffer); kind=ADVISORY
    considers series built for the evening slot."""
    config_dir = config_dir or get_paths().config_dir
    all_series = load_series(config_dir)
    seed_series_weights(conn, all_series, now)
    weights = series_weights(conn)
    cands = [s for s in all_series if s.get("enabled") and s["key"] != "mandi"
             and (s.get("slot_kind") == kind.value if kind else s.get("evergreen"))]
    used = topics_in_use(conn, now)
    rng = random.Random(seed)
    while cands:
        w = [max(weights.get(s["key"], float(s.get("weight") or 0.0)), 0.0) for s in cands]
        if sum(w) <= 0:
            return None
        pick = rng.choices(cands, weights=w, k=1)[0]
        plan = _advisory_plan(conn, pick, config_dir, used, now)
        if plan is not None:
            return plan
        cands.remove(pick)
    return None


def plan_slot(conn: sqlite3.Connection, slot: Slot, now: datetime, settings: Settings, *,
              config_dir: Path | None = None) -> VideoPlan | None:
    config_dir = config_dir or get_paths().config_dir
    if slot.kind == SlotKind.FRESH:
        for cfg in load_series(config_dir):
            if cfg.get("enabled") and cfg.get("slot_kind") == "fresh" and cfg["key"] == "mandi":
                plan = _mandi_plan(conn, slot, cfg, config_dir)
                if plan is not None and plan.topic_key not in topics_in_use(conn, now):
                    return plan
        return plan_evergreen(conn, now, settings, seed=slot.id, kind=None, config_dir=config_dir)
    return (plan_evergreen(conn, now, settings, seed=slot.id, kind=SlotKind.ADVISORY, config_dir=config_dir)
            or plan_evergreen(conn, now, settings, seed=slot.id, kind=None, config_dir=config_dir))


def fresh_data_ready(conn: sqlite3.Connection, slot_date: date) -> bool:
    from .sources.agmarknet import latest_snapshot_date  # lazy

    latest = latest_snapshot_date(conn)
    return latest is not None and latest >= slot_date - timedelta(days=1)


__all__ = ["TOPIC_COOLDOWN", "fresh_data_ready", "load_series", "plan_evergreen", "plan_slot",
           "series_cfg", "series_weights", "seed_series_weights", "topics_in_use"]
