"""Minimum Support Prices from config/msp.yaml.

Every row must carry an official source URL: a wrong MSP on screen destroys
trust, and the app's own seed table was found stale (see the plan, §10). The
loader refuses the whole file rather than silently skipping a bad row.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

import yaml


class MspConfigError(ValueError):
    pass


_SEASON = re.compile(r"^(KMS|RMS) (\d{4})-(\d{2})$")


def season_window(label: str) -> tuple[date, date] | None:
    """Sales window of a marketing season: KMS Y-(Y+1) runs 1 Oct Y .. 30 Sep Y+1,
    RMS Y-(Y+1) runs 1 Apr Y .. 31 Mar Y+1. None if the label is not in that form."""
    m = _SEASON.match(" ".join(label.split()))
    if not m or int(m.group(3)) != (int(m.group(2)) + 1) % 100:
        return None
    y = int(m.group(2))
    if m.group(1) == "KMS":
        return date(y, 10, 1), date(y + 1, 9, 30)
    return date(y, 4, 1), date(y + 1, 3, 31)


@dataclass(frozen=True)
class MspRow:
    crop: str
    season_label: str            # e.g. "KMS 2026-27", "RMS 2027-28"
    variety: str | None          # e.g. "medium staple"; None when the crop has one MSP
    price: int                   # ₹ per quintal
    source_url: str
    source_date: str             # ISO date of the official announcement
    label_mr: str | None = None  # e.g. "हमीभाव (खरीप 2026-27)"


def _norm(s: str | None) -> str | None:
    return " ".join(s.casefold().split()) if s else None


@dataclass
class MspTable:
    rows: list[MspRow]

    def lookup(self, crop: str, variety: str | None = None, *, on: date | None = None) -> MspRow | None:
        """Exact crop (+ variety) match, case-insensitive.

        With variety=None only a variety-less row matches: asking for "cotton" without
        a staple returns None, so callers can never show the wrong staple's MSP.
        With `on`, only a season whose sales window contains that date matches: today's
        mandi price must never be compared with a season announced but not yet open
        (e.g. KMS 2027-28 announced in May 2027 while KMS 2026-27 still runs to Sep).
        If several seasons match, the most recently announced one wins.
        """
        c, v = _norm(crop), _norm(variety)
        hits = [r for r in self.rows if _norm(r.crop) == c and _norm(r.variety) == v]
        if on is not None:
            hits = [r for r in hits if (w := season_window(r.season_label)) and w[0] <= on <= w[1]]
        if not hits:
            return None
        return max(hits, key=lambda r: r.source_date)

    def for_crop(self, crop: str) -> list[MspRow]:
        c = _norm(crop)
        return [r for r in self.rows if _norm(r.crop) == c]


def allowed_domains(config_dir: Path) -> set[str] | None:
    p = Path(config_dir) / "sources_allowlist.yaml"
    if not p.exists():
        return None
    with open(p, encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    return {d.casefold() for d in data.get("domains", [])}


def domain_allowed(url: str, allowed: set[str]) -> bool:
    host = (urlparse(url).hostname or "").casefold()
    return any(host == d or host.endswith("." + d) for d in allowed)


def load_msp(config_dir: Path | str) -> MspTable:
    """Load and validate config/msp.yaml. Raises MspConfigError on any bad row."""
    config_dir = Path(config_dir)
    with open(config_dir / "msp.yaml", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    allowed = allowed_domains(config_dir)
    rows: list[MspRow] = []
    seen: set[tuple] = set()
    for i, raw in enumerate(data.get("rows") or []):
        where = f"msp.yaml rows[{i}]"
        url = str(raw.get("source_url") or "").strip()
        if not url:
            raise MspConfigError(f"{where}: missing source_url")
        if urlparse(url).scheme != "https":
            raise MspConfigError(f"{where}: source_url must be https")
        if allowed is not None and not domain_allowed(url, allowed):
            raise MspConfigError(f"{where}: source_url domain not in sources_allowlist.yaml")
        crop = str(raw.get("crop") or "").strip()
        season = str(raw.get("season_label") or "").strip()
        if not crop or not season:
            raise MspConfigError(f"{where}: crop and season_label are required")
        if season_window(season) is None:
            raise MspConfigError(f"{where}: season_label must look like 'KMS 2026-27' or 'RMS 2027-28'")
        price = raw.get("price")
        if not isinstance(price, int) or isinstance(price, bool) or price <= 0:
            raise MspConfigError(f"{where}: price must be a positive integer (₹/quintal)")
        sd = raw.get("source_date")
        try:
            sd_iso = sd.isoformat() if isinstance(sd, date) else date.fromisoformat(str(sd)).isoformat()
        except ValueError:
            raise MspConfigError(f"{where}: source_date must be YYYY-MM-DD") from None
        variety = (str(raw["variety"]).strip() or None) if raw.get("variety") else None
        key = (_norm(crop), _norm(variety), season)
        if key in seen:
            raise MspConfigError(f"{where}: duplicate crop/variety/season")
        seen.add(key)
        rows.append(MspRow(crop=crop, season_label=season, variety=variety, price=price,
                           source_url=url, source_date=sd_iso, label_mr=raw.get("label_mr")))
    if not rows:
        raise MspConfigError("msp.yaml has no rows")
    return MspTable(rows)
