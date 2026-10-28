"""Number grounding: every numeral the viewer hears or reads must come from the payload.

The writer is only allowed to restate numbers we fetched (prices, MSP, dates,
sourced advisory facts). Any other numeral is treated as a possible
hallucination and blocks the script.
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from ..models import CheckReport, Issue, VideoScript
from ._text import latin_digits, published_texts

KCC_HELPLINE = "1800-180-1551"
ALWAYS_ALLOWED = frozenset({"2025", "2026", "2027"})

# The helpline is one token, not three numbers; it is masked before extraction
# (rules.py separately checks that only this number is used for the KCC).
_HELPLINE_RE = re.compile(r"(?<![0-9])1800[\s\-–‐‑‒—]?180[\s\-–‐‑‒—]?1551(?![0-9])")
# Indian (1,23,456) or western (1,234,567) grouping, else a plain run; optional decimals.
# Grouped commas must be followed by 2-3 digits so "10,20" style lists are not merged.
# A dot only blocks a match when it is a decimal point (digit before it): "रु.5100"
# and "Rs.5100" abbreviations must still yield 5100, or an invented price slips through.
_NUM_RE = re.compile(
    r"(?<![0-9])(?<![0-9]\.)(?:[0-9]{1,3}(?:,[0-9]{2})*(?:,[0-9]{3})+|[0-9]+)(?:\.[0-9]+)?(?![0-9])"
)


def canonical(raw: str) -> str | None:
    """'₹4,892.00' / '४,८९२' / '04892' -> '4892'; '8.30' -> '8.3'. Sign is ignored
    because the script says 'कमी'/'जास्त' in words, not with a minus."""
    s = latin_digits(raw).replace(",", "").replace("₹", "").replace("%", "").strip()
    try:
        d = abs(Decimal(s))
    except InvalidOperation:
        return None
    if d == d.to_integral_value():
        return str(int(d))
    return format(d.normalize(), "f")


def extract_numbers(text: str) -> list[str]:
    """Raw numeral strings (Latin digits) found in text, helpline masked out."""
    t = _HELPLINE_RE.sub(" ", latin_digits(text))
    return [m.group(0) for m in _NUM_RE.finditer(t)]


def _with_roundings(value: Decimal) -> set[str]:
    """A computed value (e.g. vs_msp_pct = -8.333) may be spoken rounded."""
    out = {canonical(str(value)) or ""}
    if value != value.to_integral_value():
        for places in (0, 1, 2):
            q = abs(value).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP)
            out.add(canonical(str(q)) or "")
    out.discard("")
    return out


def payload_numbers(payload: object) -> set[str]:
    """Canonical numbers anywhere in the payload: numeric values, numerals inside
    strings (dates, sourced facts), date objects, and list lengths (a count of
    markets is a fact derived from the data)."""
    found: set[str] = set()

    def walk(v: object) -> None:
        if isinstance(v, bool) or v is None:
            return
        if isinstance(v, (int, float, Decimal)):
            try:
                found.update(_with_roundings(Decimal(str(v))))
            except InvalidOperation:
                pass
        elif isinstance(v, (date, datetime)):
            walk(v.isoformat())
        elif isinstance(v, str):
            for raw in extract_numbers(v):
                c = canonical(raw)
                if c is not None:
                    found.update(_with_roundings(Decimal(c)))
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)
        elif isinstance(v, (list, tuple, set, frozenset)):
            found.add(str(len(v)))
            for x in v:
                walk(x)

    walk(payload)
    return found


_REF_TOKEN = re.compile(r"\[(\d+)\]|([^.\[\]]+)")


def resolve_ref(payload: object, ref: str) -> bool:
    """True when a claim's data_ref ('commodities[1].markets[0].modal', 'data_date')
    names a non-empty value in the payload."""
    cur = payload
    for idx, key in _REF_TOKEN.findall(ref.strip()):
        try:
            cur = cur[int(idx)] if idx else cur[key.strip()]  # type: ignore[index]
        except (KeyError, IndexError, TypeError, ValueError):
            return False
    return cur not in (None, "", [], {}) and cur is not payload


def check_numbers(script: VideoScript, payload: dict,
                  extra_allowed: Iterable[str] = frozenset()) -> CheckReport:
    allowed = payload_numbers(payload) | set(ALWAYS_ALLOWED)
    for item in extra_allowed:
        allowed |= {c for raw in extract_numbers(str(item)) if (c := canonical(raw))}

    report = CheckReport()
    for where, text in published_texts(script):
        seen: set[str] = set()
        for raw in extract_numbers(text):
            c = canonical(raw)
            if c is None or c in allowed or c in seen:
                continue
            seen.add(c)
            report.issues.append(Issue(
                code="number_not_in_payload",
                message=f"'{raw}' does not appear in the data payload; use only numbers from the payload "
                        f"or remove it (helpline {KCC_HELPLINE} and years 2025-2027 are always allowed)",
                where=where,
            ))

    # rules.check_rules accepts a date claim sourced by data_ref instead of source_url (the
    # Agmarknet data_date); it cannot see the payload, so the ref is verified here. Otherwise
    # an instalment date with a made-up data_ref would pass as "sourced".
    for i, c in enumerate(script.claims):
        if (c.kind == "date" and c.data_ref
                and not (c.source_url or "").startswith(("https://", "http://"))
                and not resolve_ref(payload, c.data_ref)):
            report.issues.append(Issue(
                code="date_claim_bad_ref",
                message=f"date claim '{c.text_mr}' cites data_ref '{c.data_ref}', which is not in the payload; "
                        "cite the payload key or an official source_url, or cut the date",
                where=f"claims[{i}]",
            ))
    return report
