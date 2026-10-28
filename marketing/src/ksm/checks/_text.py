"""Shared text helpers for the deterministic checks.

Every check walks the same script fields and reports the same `where` labels
(e.g. "segments[2].voice_mr"), so the writer's redo feedback points at one place.
"""
from __future__ import annotations

import unicodedata
from collections.abc import Iterator

from ..models import VideoScript

_DEV_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")
DEV = "ऀ-ॿ꣠-ꣿ"           # Devanagari + Devanagari Extended
NOT_DEV_BEFORE = rf"(?<![{DEV}])"             # word start for Devanagari terms
NOT_DEV_AFTER = rf"(?![{DEV}])"               # word end for Devanagari terms


def latin_digits(s: str) -> str:
    """Devanagari digits -> ASCII; one code point each, so offsets are preserved."""
    return s.translate(_DEV_DIGITS)


def norm_mr(s: str) -> str:
    """NFC, drop ZWJ/ZWNJ and fold the two spellings of the Marathi 'ॲ' vowel,
    so lexicon terms match however the model typed them."""
    s = unicodedata.normalize("NFC", s).replace("‍", "").replace("‌", "")
    return s.replace("अॅ", "ॲ").replace("आॅ", "ऑ")


def published_texts(script: VideoScript) -> Iterator[tuple[str, str]]:
    """(where, text) for everything a viewer can hear or read."""
    yield "hook.voice_mr", script.hook.voice_mr
    yield "hook.onscreen_mr", script.hook.onscreen_mr
    for i, seg in enumerate(script.segments):
        yield f"segments[{i}].voice_mr", seg.voice_mr
        yield f"segments[{i}].onscreen_mr", seg.onscreen_mr
    yield "cta_mr", script.cta_mr
    yield "sources_onscreen_mr", script.sources_onscreen_mr
    for plat in ("yt", "ig", "fb"):
        pt = getattr(script.platform, plat)
        for field in ("title", "description", "caption"):
            text = getattr(pt, field)
            if text:
                yield f"platform.{plat}.{field}", text
        for j, h in enumerate(pt.hashtags):
            yield f"platform.{plat}.hashtags[{j}]", h
        for j, t in enumerate(pt.tags):
            yield f"platform.{plat}.tags[{j}]", t


def all_texts(script: VideoScript) -> Iterator[tuple[str, str]]:
    """Published text plus the writer's claim notes (not shown, but a chemical
    named in a claim is still a chemical the script is built around)."""
    yield from published_texts(script)
    for i, c in enumerate(script.claims):
        yield f"claims[{i}].text_mr", c.text_mr
        if c.value:
            yield f"claims[{i}].value", c.value
