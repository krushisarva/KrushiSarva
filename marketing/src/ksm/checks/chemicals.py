"""Chemical screen: no pesticide/fertiliser names, classes or doses in any script text.

The CropGuard validator (fastapi/safety) only sees Latin script, and our scripts
are Marathi, so this screen adds a Devanagari lexicon and a dose regex on top of
a JSON snapshot of the Latin registry (scripts/sync_registry.py keeps it current).
Matching is deliberately broad: a false positive costs one redo, a false negative
can put a spray recommendation in front of farmers.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from pathlib import Path

from ..models import CheckReport, Issue, VideoScript
from ._text import NOT_DEV_AFTER, NOT_DEV_BEFORE, all_texts, latin_digits, norm_mr

_LAT_BEFORE = r"(?<![A-Za-z0-9])"
_LAT_AFTER = r"(?![A-Za-z0-9])"


def _read_json(name: str, path: Path | None) -> dict:
    if path is not None:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    return json.loads(resources.files("ksm.checks").joinpath(name).read_text(encoding="utf-8"))


@lru_cache(maxsize=4)
def load_registry(path: Path | None = None) -> dict:
    return _read_json("registry_snapshot.json", path)


@lru_cache(maxsize=4)
def load_lexicon(path: Path | None = None) -> dict:
    return _read_json("lexicon_mr.json", path)


def _flex(term: str) -> str:
    """Escaped term whose internal spaces/hyphens match any run of spaces/hyphens."""
    return r"[\s\-]*".join(re.escape(p) for p in re.split(r"[\s\-]+", term.strip()) if p)


@dataclass(frozen=True)
class _Matcher:
    pattern: re.Pattern[str]
    kinds: dict[str, str]            # lower-cased term -> category

    def find(self, text: str) -> list[tuple[str, str]]:
        out = []
        for m in self.pattern.finditer(text):
            key = re.sub(r"[\s\-]+", " ", m.group(0).lower()).strip()
            out.append((m.group(0), self.kinds.get(key, "")))
        return out


def _compile(terms: dict[str, str], before: str, after: str, flags: int = 0) -> _Matcher:
    ordered = sorted(terms, key=len, reverse=True)   # longest first: "copper oxychloride" before "copper"
    body = "|".join(_flex(t) for t in ordered)
    kinds = {re.sub(r"[\s\-]+", " ", t.lower()).strip(): k for t, k in terms.items()}
    return _Matcher(re.compile(f"{before}(?:{body}){after}", flags), kinds)


@lru_cache(maxsize=1)
def _matchers() -> tuple[_Matcher, _Matcher, list[str]]:
    reg, lex = load_registry(), load_lexicon()
    latin: dict[str, str] = {}
    for name, entry in reg["registered_actives"].items():
        latin[name] = "registered"
        for alias in entry.get("aliases", []):
            latin[alias] = "registered"
    for t in lex["latin_extra_actives"]:
        latin.setdefault(t.lower(), "active")
    for state, names in reg.get("state_banned", {}).items():
        for n in names:
            latin[n] = f"banned in {state.title()}"
    for n in reg["banned_actives"]:
        latin[n] = "banned"
    for t in lex["fertilisers_latin"]:
        latin[t.lower()] = "fertiliser"
    for t in lex["class_nouns_latin"]:
        latin[t.lower()] = "class"
    for t in lex["ambiguous_latin"]:
        if latin.get(t.lower(), "") not in ("banned",):
            latin[t.lower()] = "ambiguous"

    dev: dict[str, str] = {}
    for key, kind in (("class_nouns_mr", "class"), ("actives_mr", "active"),
                      ("brands_mr", "brand"), ("fertilisers_mr", "fertiliser")):
        for t in lex[key]:
            dev[norm_mr(latin_digits(t))] = kind

    allowed = sorted((norm_mr(p) for p in lex["allowed_phrases"]), key=len, reverse=True)
    # Devanagari terms may carry suffixes (इमिडाक्लोप्रिडची), so only the start is anchored.
    return (_compile(latin, _LAT_BEFORE, _LAT_AFTER, re.IGNORECASE),
            _compile(dev, NOT_DEV_BEFORE, ""), allowed)


# ── Dose patterns ─────────────────────────────────────────────────────────────
_NUM = r"[0-9]+(?:[.,][0-9]+)?"
_UNIT = (r"(?:मिली|मि\.?\s?ली\.?|मिलि|एमएल|ml|ग्रॅम|ग्राम|ग्रा\.?|gm|grams?|g|किलो|कि\.?\s?ग्रॅ\.?|कि\.?\s?ग्रा\.?|"
         r"किग्रॅ|kg|लिटर|लीटर|litres?|liters?|l)(?![A-Za-z])")
_SMALL_UNIT = r"(?:मिली|मि\.?\s?ली\.?|मिलि|एमएल|ml|ग्रॅम|ग्राम|ग्रा\.?|gm|grams?|g)(?![A-Za-z])"
_PER = r"(?:\s*/\s*|\s*प्रति\s*|\s*प्रती\s*|\s+per\s+)"
_TARGET = (rf"(?:लिटर|लीटर|ली\.?|लि(?:\.|{NOT_DEV_AFTER})|एकर|हेक्टर|पंप|टाकी|litres?|liters?|acres?|hectares?|ha|pump|l)"
           r"(?![A-Za-z])")
_AREA_WORD = r"(?:एकरी|हेक्टरी|प्रति\s*(?:लिटर|लीटर|एकर|हेक्टर|पंप)\S*)"
_CONTAINER = r"(?:पाण्या|पंपा|टाकी)"
_DOSE_PATTERNS = [
    # 2 मिली/लिटर, 50 kg per acre, and "20 मिली प्रति 10 लिटर" / "2 ml per 10 litres"
    re.compile(rf"{_NUM}\s*{_UNIT}{_PER}(?:{_NUM}\s*)?{_TARGET}", re.IGNORECASE),
    re.compile(rf"{_NUM}\s*{_SMALL_UNIT}{_PER}(?:किलो|kg)", re.IGNORECASE),     # 4 ग्रॅम प्रति किलो बियाणे
    re.compile(rf"{_NUM}\s*(?:किलो|kg)\s*(?:एकरी|हेक्टरी)", re.IGNORECASE),     # 30 किलो एकरी
    re.compile(rf"{_AREA_WORD}\s+(?:{_CONTAINER}\S*\s+)?{_NUM}\s*{_UNIT}",
               re.IGNORECASE),                                                  # प्रति लिटर पाण्यात 2 मिली, एकरी 50 किलो
    re.compile(rf"{_NUM}\s*{_SMALL_UNIT}[^.।!?\n]{{0,30}}{_CONTAINER}", re.IGNORECASE),  # 20 मिली ... पाण्यात
    re.compile(rf"{_CONTAINER}\S*\s+{_NUM}\s*{_SMALL_UNIT}", re.IGNORECASE),   # पंपाला 30 मिली
    re.compile(rf"{_NUM}\s*(?:%|टक्के)\s*(?:EC|WP|SC|WG|WDG|SL|GR|CS|DP|EW|ZC|OD|FS|CG|ईसी|डब्ल्यूपी|डब्लूपी|एससी)"
               r"(?![A-Za-z])", re.IGNORECASE),                                 # 25% EC, 25 टक्के ईसी
    re.compile(r"(?<![0-9])[0-9]{1,2}\s*:\s*[0-9]{1,2}\s*:\s*[0-9]{1,2}(?![0-9])"),  # 19:19:19 grade
]
_SEED_WORDS = re.compile(r"बियाण|बियाणे|बीज|seed", re.IGNORECASE)
_KG = re.compile(r"किलो|कि\.?\s?ग्र|kg", re.IGNORECASE)
_AREA = re.compile(r"एकर|हेक्टर|acre|hectare|ha", re.IGNORECASE)


def _is_seed_rate(match: str, sentence: str) -> bool:
    """'30 किलो प्रति एकर' / 'एकरी 30 किलो' in a sentence about seed is a sowing rate,
    not an input dose (either word order)."""
    return bool(_KG.search(match) and _AREA.search(match) and _SEED_WORDS.search(sentence))


def _sentence_at(text: str, start: int, end: int) -> str:
    left = max(text.rfind(c, 0, start) for c in ".।!?\n")
    rights = [i for i in (text.find(c, end) for c in ".।!?\n") if i != -1]
    return text[left + 1: min(rights) if rights else len(text)]


def _mask(text: str, phrases: list[str]) -> str:
    for p in phrases:
        text = text.replace(p, " " * len(p))
    return text


_LATIN_CODES = {
    "registered": ("chemical_mentioned", "registered pesticide active/brand"),
    "active": ("chemical_mentioned", "pesticide active/brand"),
    "fertiliser": ("fertiliser_mentioned", "fertiliser name"),
    "class": ("pesticide_class_mentioned", "pesticide/fertiliser class word"),
}
_DEV_CODES = {
    "class": ("pesticide_class_mentioned", "pesticide/chemical class word"),
    "active": ("chemical_mentioned_mr", "pesticide active (Devanagari)"),
    "brand": ("chemical_mentioned_mr", "pesticide brand (Devanagari)"),
    "fertiliser": ("fertiliser_mentioned_mr", "fertiliser name (Devanagari)"),
}


def check_chemicals(script: VideoScript) -> CheckReport:
    latin_m, dev_m, allowed = _matchers()
    report = CheckReport()

    def add(code: str, msg: str, where: str, blocking: bool = True) -> None:
        if not any(i.code == code and i.where == where and i.message == msg for i in report.issues):
            report.issues.append(Issue(code=code, message=msg, blocking=blocking, where=where))

    if script.chemicals_mentioned_en:
        add("chemicals_mentioned_en",
            f"chemicals_mentioned_en must be empty, got {script.chemicals_mentioned_en!r}; "
            "remove every pesticide/fertiliser from the script", "chemicals_mentioned_en")

    for where, raw in all_texts(script):
        text = _mask(latin_digits(norm_mr(raw)), allowed)
        for found, kind in latin_m.find(text):
            if kind == "ambiguous":
                add("chemical_alias_ambiguous",
                    f"'{found}' is also a pesticide brand/active name; check it is not a product reference",
                    where, blocking=False)
            elif kind.startswith("banned"):
                add("chemical_banned", f"'{found}' is a {kind} pesticide; never name it", where)
            else:
                code, label = _LATIN_CODES.get(kind, _LATIN_CODES["active"])
                add(code, f"'{found}' is a {label}; remove it (refer farmers to KVK / कृषी अधिकारी)", where)
        for found, kind in dev_m.find(text):
            code, label = _DEV_CODES.get(kind, _DEV_CODES["active"])
            add(code, f"'{found}' is a {label}; remove it (refer farmers to KVK / कृषी अधिकारी)", where)
        for pat in _DOSE_PATTERNS:
            for m in pat.finditer(text):
                sentence = _sentence_at(text, m.start(), m.end())
                if _is_seed_rate(m.group(0), sentence):
                    add("dose_seed_rate", f"'{m.group(0).strip()}' looks like a seed rate; confirm it is "
                        "sourced and not an input dose", where, blocking=False)
                else:
                    add("chemical_dose", f"'{m.group(0).strip()}' looks like an application dose or "
                        "formulation; doses are never allowed", where)
    return report
