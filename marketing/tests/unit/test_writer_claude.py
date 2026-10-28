"""Writer: request shape, prompt caching, refusal handling, disclosure enforcement, cost math."""
from __future__ import annotations

import dataclasses
import json
from datetime import date
from types import SimpleNamespace

import pytest
from anthropic import transform_schema

from ksm.models import VideoScript
from ksm.writer import claude as wc
from ksm.writer.schemas import GLOSSARY, build_glossary

from _writer_fakes import (  # noqa: F401 - fixtures used by name
    FakeClient, make_script, parsed_response, plan, refusal_response, settings, usage,
)


def call_write(client, settings, plan, **kw):
    args = dict(settings=settings, series_cfg={"name_mr": "आजचा बाजारभाव"}, plan=plan,
                glossary=build_glossary(), recent_titles=["कापूस बाजारभाव | Cotton rate Akola"], feedback=None)
    args.update(kw)
    return wc.write_script(client, **args)


# ── request shape ─────────────────────────────────────────────────────────────


def test_write_script_request_shape(settings, plan):
    client = FakeClient(parsed_response(make_script(), u=usage(1000, 2000, 3000, 400)))
    script, u = call_write(client, settings, plan)

    (kind, kw), = client.calls
    assert kind == "create"
    assert kw["model"] == "claude-opus-5-5" == settings.model
    assert kw["output_config"] == {"effort": settings.writer_effort,
                                   "format": {"type": "json_schema", "schema": transform_schema(VideoScript)}}
    assert "output_format" not in kw
    assert "thinking" not in kw                     # always on for Opus 5.5; never sent
    assert "tool_choice" not in kw                  # forced tool_choice is a 400
    assert kw["betas"] == ["server-side-fallback-2026-07-01"] and kw["fallbacks"] == "default"
    sys_blocks = kw["system"]
    assert len(sys_blocks) == 1 and sys_blocks[0]["cache_control"] == {"type": "ephemeral"}
    assert sys_blocks[0]["text"] == wc.load_prompt("writer.v1.md")
    user = kw["messages"][0]["content"]
    assert kw["messages"][0]["role"] == "user"
    assert '"median_modal": 4850' in user           # payload JSON present
    assert "आजचा बाजारभाव" in user                 # series spec / config
    assert "Cotton rate Akola" in user              # recent titles
    assert "No app link is allowed" in user
    assert "15 ऑक्टो 2026" in user                  # on-screen date supplied, not invented
    assert u["prompt_version"] == "writer.v1+series_mandi.v1"
    assert isinstance(script, VideoScript)


def test_system_prompt_is_stable_across_videos_and_redos(settings, plan):
    """The cached prefix must be byte-identical; per-video data lives in the user message."""
    client = FakeClient(parsed_response(make_script()), parsed_response(make_script()))
    call_write(client, settings, plan)
    other = dataclasses.replace(plan, series="rabi", payload={"facts": ["x"]})
    call_write(client, dataclasses.replace(settings, app_cta_url="https://play.google.com/x"), other,
               feedback="- [number_not_in_payload] segments[1].voice_mr: 4,950")
    (_, a), (_, b) = client.calls
    assert a["system"] == b["system"]
    assert "- [number_not_in_payload] segments[1].voice_mr: 4,950" in b["messages"][0]["content"]
    assert "https://play.google.com/x" in b["messages"][0]["content"]


def test_user_message_is_deterministic(settings, plan):
    m1, _ = wc.build_writer_message(settings=settings, series_cfg={"b": 1, "a": 2}, plan=plan,
                                    glossary=GLOSSARY, recent_titles=[], feedback=None)
    m2, _ = wc.build_writer_message(settings=settings, series_cfg={"a": 2, "b": 1}, plan=plan,
                                    glossary=dict(reversed(list(GLOSSARY.items()))), recent_titles=[], feedback=None)
    assert m1 == m2


def test_unknown_series_has_no_prompt_file_but_still_works(settings, plan):
    client = FakeClient(parsed_response(make_script()))
    _, u = call_write(client, settings, dataclasses.replace(plan, series="nonexistent"))
    assert u["prompt_version"] == "writer.v1"


def test_series_yaml_prompt_key_is_used_and_must_exist(settings, plan):
    client = FakeClient(parsed_response(make_script()))
    _, u = call_write(client, settings, dataclasses.replace(plan, series="rabi_guide"),
                      series_cfg={"prompt": "series_rabi_guide.v1.md", "name_mr": "रब्बी"})
    assert u["prompt_version"] == "writer.v1+series_rabi_guide.v1"
    assert "series_rabi_guide.v1.md" not in client.calls[0][1]["messages"][0]["content"].split("Series config")[-1]
    with pytest.raises(FileNotFoundError):
        call_write(FakeClient(), settings, plan, series_cfg={"prompt": "series_typo.v1.md"})


# ── output handling ───────────────────────────────────────────────────────────


def test_disclosure_and_source_line_enforced(settings, plan):
    client = FakeClient(parsed_response(make_script()))
    script, _ = call_write(client, settings, plan)
    src = script.sources_onscreen_mr
    for text in (script.platform.yt.description, script.platform.ig.caption, script.platform.fb.caption):
        lines = text.split("\n")
        assert lines[-2:] == [src, "आवाज: AI (Sarvam)"]
        assert lines.count("आवाज: AI (Sarvam)") == 1 and lines.count(src) == 1
    assert script.platform.fb.caption.startswith("लातूर ₹4,900\nतुमचा तालुका?")


def test_fb_caption_source_line_has_no_domain(settings, plan):
    script = make_script(sources_onscreen_mr="स्रोत: Agmarknet / data.gov.in · 15 ऑक्टो 2026")
    out, _ = call_write(FakeClient(parsed_response(script)), settings, plan)
    assert out.platform.fb.caption.split("\n")[-2:] == ["स्रोत: Agmarknet · 15 ऑक्टो 2026", "आवाज: AI (Sarvam)"]
    assert out.platform.yt.description.split("\n")[-2] == "स्रोत: Agmarknet / data.gov.in · 15 ऑक्टो 2026"


@pytest.mark.parametrize("line,expected", [
    ("स्रोत: PIB (pib.gov.in/PressRelease?id=1), 30 सप्टें 2026", "स्रोत: PIB, 30 सप्टें 2026"),
    ("स्रोत: data.gov.in / Agmarknet", "स्रोत: Agmarknet"),
    ("स्रोत: MPKV राहुरी", "स्रोत: MPKV राहुरी"),
])
def test_fb_safe(line, expected):
    assert wc.fb_safe(line) == expected


def test_refusal_raises_with_usage_before_reading_content(settings, plan):
    client = FakeClient(refusal_response(u=usage(1_000_000, 0)))
    with pytest.raises(wc.ClaudeRefusal) as ei:
        call_write(client, settings, plan)
    assert ei.value.category == "bio"
    assert ei.value.usage["cost_usd"] == pytest.approx(4.0)


def test_max_tokens_and_missing_output_raise(settings, plan):
    with pytest.raises(wc.ClaudeError, match="max_tokens"):
        call_write(FakeClient(parsed_response(None, stop="max_tokens")), settings, plan)
    with pytest.raises(wc.ClaudeError, match="no structured output"):
        call_write(FakeClient(parsed_response(None)), settings, plan)


def test_client_side_validation_error_keeps_spend(settings, plan):
    """Only 2 segments: the API cannot enforce min_length=3, we can; the spend must survive."""
    bad = make_script().model_dump(mode="json")
    bad["segments"] = bad["segments"][:2]
    client = FakeClient(parsed_response(None, text=json.dumps(bad, ensure_ascii=False), u=usage(1000, 10_000)))
    with pytest.raises(wc.ClaudeError, match="schema validation") as ei:
        call_write(client, settings, plan)
    assert ei.value.usage["output_tokens"] == 10_000
    assert ei.value.usage["cost_usd"] == pytest.approx((1000 * 4 + 10_000 * 20) / 1e6)
    assert ei.value.usage["prompt_version"] == "writer.v1+series_mandi.v1"


def test_max_tokens_truncated_json_is_max_tokens_with_spend(settings, plan):
    """The truncated JSON must be reported as max_tokens (not a schema error) with its spend."""
    cut = make_script().model_dump_json()[:150]
    client = FakeClient(parsed_response(None, stop="max_tokens", text=cut, u=usage(2000, 16_000)))
    with pytest.raises(wc.ClaudeError, match="max_tokens") as ei:
        call_write(client, settings, plan)
    assert ei.value.usage["output_tokens"] == 16_000


def test_model_written_footer_lines_are_replaced(settings, plan):
    """A model-written source line (with a domain) must not survive next to the canonical one."""
    script = make_script(sources_onscreen_mr="स्रोत: Agmarknet / data.gov.in · 15 ऑक्टो 2026")
    script.platform.fb.caption = "लातूर ₹4,900\nस्रोत: data.gov.in, 15 ऑक्टो\nआवाज : AI\nतुमचा तालुका?"
    out, _ = call_write(FakeClient(parsed_response(script)), settings, plan)
    fb = out.platform.fb.caption
    assert fb == "लातूर ₹4,900\nतुमचा तालुका?\nस्रोत: Agmarknet · 15 ऑक्टो 2026\nआवाज: AI (Sarvam)"
    assert "gov.in" not in fb


# ── cost ──────────────────────────────────────────────────────────────────────


def test_cost_math(settings, plan):
    u = usage(i=10_000, o=5_000, cr=20_000, cw=8_000, searches=2)
    client = FakeClient(parsed_response(make_script(), u=u))
    _, got = call_write(client, settings, plan)
    usd = (10_000 * 4 + 5_000 * 20 + 20_000 * 0.20 + 8_000 * 5.0) / 1e6 + 2 * 0.01
    assert got["cost_usd"] == pytest.approx(usd)
    assert got["cost_inr"] == pytest.approx(usd * settings.usd_inr, abs=1e-4)
    assert {k: got[k] for k in ("input_tokens", "output_tokens", "cache_read_input_tokens",
                                "cache_creation_input_tokens", "web_search_requests")} == {
        "input_tokens": 10_000, "output_tokens": 5_000, "cache_read_input_tokens": 20_000,
        "cache_creation_input_tokens": 8_000, "web_search_requests": 2}


def test_cache_write_is_125x_input():
    p = wc.PRICES_USD_PER_MTOK["claude-opus-5-5"]
    assert p["cache_write"] == pytest.approx(1.25 * p["input"])
    assert p["cache_read"] == pytest.approx(0.20)


def test_fallback_iterations_are_summed_at_each_models_price():
    it = [SimpleNamespace(type="message", model="claude-opus-5-5", input_tokens=1_000_000, output_tokens=0,
                          cache_read_input_tokens=0, cache_creation_input_tokens=0),
          SimpleNamespace(type="fallback_message", model="claude-opus-5", input_tokens=1_000_000,
                          output_tokens=0, cache_read_input_tokens=0, cache_creation_input_tokens=0)]
    resp = SimpleNamespace(usage=usage(1_000_000, 0, iterations=it))
    got = wc.usage_of(resp, model="claude-opus-5-5", usd_inr=88)
    assert got["input_tokens"] == 2_000_000
    assert got["cost_usd"] == pytest.approx(4.0 + 5.0)


def test_fallback_to_opus_4_8_and_unknown_models_are_not_underpriced():
    assert wc.cost_usd("claude-opus-4-8", input_tokens=1_000_000) == pytest.approx(5.0)
    assert wc.cost_usd("claude-some-future-model", output_tokens=1_000_000) >= wc.cost_usd(
        "claude-opus-5-5", output_tokens=1_000_000)


def test_add_usage_sums():
    a = {**wc.empty_usage(), "input_tokens": 3, "cost_inr": 1.5, "cost_usd": 0.1}
    b = {**wc.empty_usage(), "input_tokens": 4, "cost_inr": 2.0, "cost_usd": 0.2, "web_search_requests": 1}
    s = wc.add_usage(a, b)
    assert (s["input_tokens"], s["web_search_requests"]) == (7, 1)
    assert s["cost_inr"] == pytest.approx(3.5)


def test_date_mr():
    assert wc.date_mr(date(2026, 10, 16)) == "16 ऑक्टो 2026"
    assert json.dumps(wc.date_mr(date(2027, 1, 1)), ensure_ascii=False) == '"1 जाने 2027"'
