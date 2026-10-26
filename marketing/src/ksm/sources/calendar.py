"""Dated events (deadlines, festivals, announcements) from config/calendar.yaml.

Each event has a usable window (use_from..use_until) so the planner never builds a
countdown after a deadline has passed. An event is only quotable in a script when
`use_in_script` is true, which requires a source_url; unofficial ones are planning
hints and must be confirmed from an official source before a date goes on screen.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path

import yaml

from .msp import allowed_domains, domain_allowed


class CalendarConfigError(ValueError):
    pass


# Only a festival date may be stated from an unofficial source; deadlines, scheme,
# instalment and relief dates need an official (allow-listed) one.
UNOFFICIAL_SCRIPT_KINDS = frozenset({"festival"})


def _d(v, where: str, field: str) -> date:
    if isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v))
    except ValueError:
        raise CalendarConfigError(f"{where}: {field} must be YYYY-MM-DD") from None


def load_events(config_dir: Path | str) -> list[dict]:
    """All events, validated, with dates normalised to ISO strings (JSON-safe for payloads)."""
    config_dir = Path(config_dir)
    with open(config_dir / "calendar.yaml", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    allowed = allowed_domains(config_dir)
    out: list[dict] = []
    seen: set[str] = set()
    for i, e in enumerate(data.get("events") or []):
        where = f"calendar.yaml events[{i}]"
        for k in ("id", "date", "title_mr", "use_from", "use_until"):
            if not e.get(k):
                raise CalendarConfigError(f"{where}: missing {k}")
        if e["id"] in seen:
            raise CalendarConfigError(f"{where}: duplicate id {e['id']!r}")
        seen.add(e["id"])
        d = _d(e["date"], where, "date")
        uf, uu = _d(e["use_from"], where, "use_from"), _d(e["use_until"], where, "use_until")
        if uf > uu:
            raise CalendarConfigError(f"{where}: use_from after use_until")
        official = e.get("official")
        if not isinstance(official, bool):
            raise CalendarConfigError(f"{where}: 'official' must be true or false")
        url = e.get("source_url")
        if official and not url:
            raise CalendarConfigError(f"{where}: official event needs source_url")
        if official and allowed is not None and not domain_allowed(url, allowed):
            raise CalendarConfigError(f"{where}: official source not in sources_allowlist.yaml")
        use_in_script = bool(e.get("use_in_script", False))
        if use_in_script and not url:
            raise CalendarConfigError(f"{where}: use_in_script needs a source_url")
        if use_in_script and not official and e.get("kind") not in UNOFFICIAL_SCRIPT_KINDS:
            raise CalendarConfigError(f"{where}: only festival dates may be used in scripts without an official source")
        if e.get("kind") == "deadline" and uu > d:
            raise CalendarConfigError(f"{where}: a deadline's use_until must not be after the deadline")
        out.append({**e, "date": d.isoformat(), "use_from": uf.isoformat(), "use_until": uu.isoformat(),
                    "official": official, "use_in_script": use_in_script, "source_url": url})
    return out


def events_between(config_dir: Path | str, start: date, end: date, *, official_only: bool = False) -> list[dict]:
    """Events whose usable window overlaps [start, end], sorted by event date."""
    s, e = start.isoformat(), end.isoformat()
    hits = [ev for ev in load_events(config_dir)
            if ev["use_from"] <= e and ev["use_until"] >= s and (ev["official"] or not official_only)]
    return sorted(hits, key=lambda ev: (ev["date"], ev["id"]))
