"""
Google Play "Misleading Claims" policy, government information: the chat must
say KrushiSarva is a private app, may name ONLY the official sources the store
listing names, and must never tell a farmer they are eligible for a scheme.

The rules live in agents/prompts/chat_rules.v2.md, which every chat system
prompt (writer, enhancer, vision, voice) interpolates. The source list there
must match docs/play-store/farmer-app.md "SOURCES OF GOVERNMENT INFORMATION";
test_sources_match_store_listing fails when the two drift.
"""
import os
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import services.chat_service as cs

# Links the chat may give. Every one opens from outside India too (several
# government sites do not), and each is also in the store listing.
ALLOWED_URLS = {
    "https://www.myscheme.gov.in/schemes/pm-kisan",
    "https://www.myscheme.gov.in/schemes/pmfby",
    "https://www.myscheme.gov.in/schemes/kcc",
    "https://www.myscheme.gov.in/schemes/rkvyshfshc",
    "https://www.myscheme.gov.in/schemes/pkvy",
    "https://mausam.imd.gov.in",
    "https://icar.org.in/en/krishi-vigyan-kendras",
}
ALLOWED_PHONES = {"1800-180-1551"}   # Kisan Call Centre
# Sources the chat may name but must not link.
NAME_ONLY = ("Agmarknet", "data.gov.in", "CACP")
# Old or invented links that must not come back.
NEVER = ("pmkisan.gov.in", "155261", "pmfby.gov.in", "soilhealth.dac.gov.in",
         "agmarknet.gov.in", "cacp.da.gov.in", "agriwelfare.gov.in")

_URL_RE = re.compile(r"https?://[^\s;,)]+")
_PHONE_RE = re.compile(r"\b\d[\d -]{4,}\d\b")
_DOCS = Path(__file__).resolve().parents[2] / "docs" / "play-store" / "farmer-app.md"


def _urls(text: str) -> set[str]:
    return {u.rstrip(".") for u in _URL_RE.findall(text)}


def _assembled():
    """Every chat system prompt, exactly as chat_service builds it."""
    return {
        "writer":   cs._writer_system({}, "short", "text", with_followups=True)[0],
        "voice":    cs._writer_system({}, "short", "voice")[0],
        "enhancer": cs._enhancer_system({}, "long", "text", turn_token="abc123")[0],
        "vision":   cs._vision_system({}, "short", "text", turn_token="abc123")[0],
    }


@pytest.mark.parametrize("surface", ["writer", "voice", "enhancer", "vision"])
def test_chat_prompt_says_private_app_not_government(surface):
    text = _assembled()[surface]
    assert "KrushiSarva is a private app, not a government app" in text
    assert "can apply on behalf of any government body" in text


@pytest.mark.parametrize("surface", ["writer", "voice", "enhancer", "vision"])
def test_chat_prompt_names_only_the_allowed_sources(surface):
    text = _assembled()[surface]
    assert _urls(text) == ALLOWED_URLS
    assert set(_PHONE_RE.findall(text)) == ALLOWED_PHONES
    assert "name ONLY these" in text
    assert "Name, but never link: mandi prices from Agmarknet / data.gov.in" in text
    assert "nearest agriculture office or Common Service Centre" in text
    for bad in NEVER:
        assert bad not in text, f"{surface} prompt still carries {bad!r}"


@pytest.mark.parametrize("surface", ["writer", "voice", "enhancer", "vision"])
def test_chat_prompt_never_decides_eligibility(surface):
    text = _assembled()[surface]
    assert "you cannot know whether this farmer is eligible" in text
    assert "confirm on the official site before applying" in text


def test_chat_rules_v2_is_the_version_served():
    _, metas = cs._writer_system({}, "short", "text")
    rules = next(m for m in metas if m["name"] == "chat_rules")
    assert rules["version"] == "v2"


def test_sources_match_store_listing():
    """Everything the chat may link or name is listed in the Play store
    description. The listing names more sources than the chat links (some
    government sites open only from inside India), so this is a subset check."""
    if not _DOCS.exists():   # the AI Docker image ships fastapi/ only
        pytest.skip("docs/play-store/farmer-app.md not present")
    doc = _DOCS.read_text(encoding="utf-8")
    start = doc.index("SOURCES OF GOVERNMENT INFORMATION")
    section = doc[start:doc.index("```", start)]
    assert ALLOWED_URLS <= _urls(section)
    assert ALLOWED_PHONES <= set(_PHONE_RE.findall(section))
    assert "Agmarknet" in section and "https://data.gov.in" in section
    assert "Commission for Agricultural Costs and Prices" in section
