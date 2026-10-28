"""Sourced agronomy facts for the रब्बी पेरणी मार्गदर्शक series (config/advisories.yaml).

Claude may only rephrase these facts. Entries ship as `verified: false`; the loader
hides them (and advisory_payload refuses them) until a human or a web check against
the listed official sources flips the flag. The loader also lints the file itself for
doses and chemical words, so an unsafe edit fails loudly instead of reaching a script.
"""
from __future__ import annotations

from datetime import date
from pathlib import Path
from urllib.parse import urlparse

import regex
import yaml

from .msp import allowed_domains, domain_allowed


class AdvisoryConfigError(ValueError):
    pass


# Doses, application rates and yields (a number next to a unit, or a per-acre rate),
# and chemical/fertiliser words, Latin and Devanagari. This is a config lint, not the
# script check (that is checks/chemicals.py). \d matches Devanagari digits too.
# Latin units need a word end (plurals allowed); Marathi units take case suffixes
# ("किलोने", "लिटरमध्ये"), so they are matched as prefixes.
_DOSE = regex.compile(
    r"\d[\d.,]*\s*(?:"
    r"(?:kgs?|g|gms?|grams?|ml|l|litres?|liters?|q|qtls?|quintals?|tonnes?|tons?)\b"
    r"|per\s+(?:acre|hectare|ha|plant|pump)\b|/\s*(?:acre|ha|hectare)\b"
    r"|किलो|कि\.?ग्रॅ|ग्रॅम|ग्राम|मिली(?!मी)|मि\.\s?ली|लिटर|लीटर|क्विंटल|टन"
    r")|(?:एकरी|हेक्टरी|प्रति\s*(?:एकर|हेक्टर))\s*\d",
    regex.IGNORECASE,
)
_CHEMICAL_WORDS = regex.compile(
    r"\b(?:pesticides?|insecticides?|fungicides?|herbicides?|weedicides?|fertili[sz]ers?|chemicals?|"
    r"urea|dap|npk|potash|carbendazim|thiram|mancozeb|imidacloprid|chlorpyrifos|trichoderma)\b|"
    # खत only at a word start: "खते", "खतांचा" are caught, "राखतो" (keeps) is not.
    r"कीटकनाशक|बुरशीनाशक|तणनाशक|युरिया|डीएपी|रासायनिक|औषध|(?<![\p{L}\p{M}])खत",
    regex.IGNORECASE,
)

REQUIRED = ("id", "crop", "topic", "facts", "sources")
# Every string that advisory_payload() copies into the writer's payload is linted.
_LINTED_FIELDS = ("crop", "crop_mr", "topic", "topic_mr", "source_mr")


def _lint_text(text: str, where: str) -> None:
    if _DOSE.search(text):
        raise AdvisoryConfigError(f"{where}: looks like a dose; advisories must not carry doses")
    if _CHEMICAL_WORDS.search(text):
        raise AdvisoryConfigError(f"{where}: chemical/fertiliser word; not allowed in advisories")


def _check_verification(e: dict, where: str) -> None:
    """Flipping `verified` alone is not enough: the file's own rule is that the verifier
    pins the exact source page and signs it, so enforce that here."""
    if not str(e.get("verified_by") or "").strip():
        raise AdvisoryConfigError(f"{where}: verified entry needs verified_by")
    vo = e.get("verified_on")
    if not isinstance(vo, date):
        try:
            date.fromisoformat(str(vo))
        except ValueError:
            raise AdvisoryConfigError(f"{where}: verified entry needs verified_on (YYYY-MM-DD)") from None
    for url in e["sources"]:
        if urlparse(str(url)).path.strip("/") == "":
            raise AdvisoryConfigError(f"{where}: verified entry cites a site root {url!r}; pin the exact page")


def load_advisories(config_dir: Path | str, *, include_unverified: bool = False) -> list[dict]:
    """Validated entries. By default only `verified: true` ones are returned."""
    config_dir = Path(config_dir)
    with open(config_dir / "advisories.yaml", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    allowed = allowed_domains(config_dir)
    entries = data.get("entries") or []
    seen: set[str] = set()
    out: list[dict] = []
    for i, e in enumerate(entries):
        where = f"advisories.yaml entries[{i}]"
        missing = [k for k in REQUIRED if not e.get(k)]
        if missing:
            raise AdvisoryConfigError(f"{where}: missing {missing}")
        if e["id"] in seen:
            raise AdvisoryConfigError(f"{where}: duplicate id {e['id']!r}")
        seen.add(e["id"])
        if not isinstance(e.get("verified"), bool):
            raise AdvisoryConfigError(f"{where}: 'verified' must be true or false")
        if not isinstance(e["facts"], list) or not isinstance(e["sources"], list):
            raise AdvisoryConfigError(f"{where}: facts and sources must be lists")
        for k in _LINTED_FIELDS:
            if e.get(k):
                _lint_text(str(e[k]), f"{where}.{k}")
        for j, fact in enumerate(e["facts"]):
            if not isinstance(fact, dict) or not fact.get("en") or not fact.get("mr"):
                raise AdvisoryConfigError(f"{where}.facts[{j}]: needs 'en' and 'mr'")
            _lint_text(f"{fact['en']} {fact['mr']}", f"{where}.facts[{j}]")
        for url in e["sources"]:
            if not str(url).startswith("https://"):
                raise AdvisoryConfigError(f"{where}: source {url!r} must be https")
            if allowed is not None and not domain_allowed(str(url), allowed):
                raise AdvisoryConfigError(f"{where}: source {url!r} not in sources_allowlist.yaml")
        if e["verified"]:
            _check_verification(e, where)
        if e["verified"] or include_unverified:
            out.append(e)
    return out


def advisory_payload(entry: dict) -> dict:
    """The only facts the writer may use for one advisory video."""
    if entry.get("verified") is not True:
        raise ValueError(f"advisory {entry.get('id')!r} is not verified; refusing to build a payload")
    return {
        "id": entry["id"],
        "crop": entry["crop"],
        "crop_mr": entry.get("crop_mr", entry["crop"]),
        "topic": entry["topic"],
        "topic_mr": entry.get("topic_mr", entry["topic"]),
        "facts": [{"en": f["en"], "mr": f["mr"]} for f in entry["facts"]],
        "sources": list(entry["sources"]),
        "source_mr": entry.get("source_mr", "स्रोत: कृषी विद्यापीठ / KVK मार्गदर्शन"),
        "advice_mr": "आपल्या भागासाठी कृषी सहाय्यक किंवा कृषी विज्ञान केंद्राचा सल्ला घ्या.",
        "verified_by": entry.get("verified_by"),
        "verified_on": str(entry["verified_on"]) if entry.get("verified_on") else None,
    }
