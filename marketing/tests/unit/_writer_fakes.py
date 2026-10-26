"""Shared fakes for the writer/factcheck tests: a recording Claude client and a valid script."""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace

import pytest

from ksm.config import settings_from_file
from ksm.models import VideoPlan, VideoScript
from ksm.paths import REPO_MARKETING_DIR

# ── fakes ─────────────────────────────────────────────────────────────────────


class FakeMessages:
    def __init__(self, responses: list) -> None:
        self.responses = list(responses)
        self.calls: list[tuple[str, dict]] = []

    def _next(self, kind: str, kw: dict):
        self.calls.append((kind, kw))
        r = self.responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    def parse(self, **kw):
        return self._next("parse", kw)

    def create(self, **kw):
        return self._next("create", kw)


class FakeClient:
    def __init__(self, *responses) -> None:
        self.beta = SimpleNamespace(messages=FakeMessages(list(responses)))

    @property
    def calls(self) -> list[tuple[str, dict]]:
        return self.beta.messages.calls


def usage(i=0, o=0, cr=0, cw=0, searches=0, iterations=None):
    return SimpleNamespace(
        input_tokens=i, output_tokens=o, cache_read_input_tokens=cr, cache_creation_input_tokens=cw,
        server_tool_use=SimpleNamespace(web_search_requests=searches, web_fetch_requests=0),
        iterations=iterations,
    )


def parsed_response(obj, *, stop="end_turn", u=None, text=None):
    """A structured-output response: the JSON arrives as a text block (after a thinking block)."""
    if text is None and obj is not None:
        text = obj.model_dump_json()
    content = [SimpleNamespace(type="thinking", thinking="", signature="sig")]
    if text is not None:
        content.append(SimpleNamespace(type="text", text=text))
    return SimpleNamespace(stop_reason=stop, content=content, usage=u or usage(), stop_details=None)


def refusal_response(category="bio", u=None):
    return SimpleNamespace(stop_reason="refusal", parsed_output=None, content=[],
                           usage=u or usage(100, 0),
                           stop_details=SimpleNamespace(category=category, explanation="declined"))


# ── fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def settings():
    return settings_from_file(REPO_MARKETING_DIR / "config" / "settings.yaml")


@pytest.fixture
def plan():
    return VideoPlan(
        series="mandi", topic_key="soybean-latur", data_date=date(2026, 10, 15), evergreen=False,
        time_sensitive=True, fresh_until=None,
        payload={"data_date": "2026-10-15", "source": "Agmarknet / data.gov.in, Government of India",
                 "commodities": [{"key": "soybean", "name_mr": "सोयाबीन", "msp": 5708, "median_modal": 4850,
                                  "markets": [{"market": "Latur", "market_mr": "लातूर", "modal": 4900}]}]},
    )


def make_script(**over) -> VideoScript:
    seg = {"voice_mr": "लातूरमध्ये सोयाबीनचा सरासरी भाव 4,900 रुपये होता.", "onscreen_mr": "लातूर ₹4,900",
           "visual": {"kind": "mandi_bars", "data_ref": "commodities[0]"}}
    data = {
        "hook": {"voice_mr": "सोयाबीनचा आजचा भाव.", "onscreen_mr": "सोयाबीन ₹4,900\nलातूर"},
        "segments": [seg, seg, seg],
        "cta_mr": "फॉलो करा. गावाच्या व्हॉट्सॲप ग्रुपवर पाठवा.",
        "platform": {
            "yt": {"title": "सोयाबीन बाजारभाव | Soybean rate Latur", "description": "लातूर ₹4,900",
                   "hashtags": ["#Shorts", "#सोयाबीन", "#बाजारभाव"]},
            "ig": {"caption": "लातूर ₹4,900\nस्रोत: Agmarknet · 15 ऑक्टो 2026", "hashtags": ["#सोयाबीन"]},
            "fb": {"caption": "लातूर ₹4,900\nआवाज: AI (Sarvam)\nतुमचा तालुका?", "hashtags": []},
        },
        "claims": [{"kind": "number", "text_mr": "लातूर 4,900", "value": "4,900",
                    "data_ref": "commodities[0].markets[0].modal"}],
        "chemicals_mentioned_en": [],
        "sources_onscreen_mr": "स्रोत: Agmarknet · 15 ऑक्टो 2026",
    }
    data.update(over)
    return VideoScript.model_validate(data)
