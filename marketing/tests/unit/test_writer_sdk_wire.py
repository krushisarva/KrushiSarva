"""The real anthropic SDK (no network): checks the wire body our kwargs produce and that
structured output parses back into VideoScript. Guards against SDK-shape drift that the
recording fakes in the other writer tests cannot see."""
from __future__ import annotations

import json

import anthropic
import httpx2
import pytest

from ksm.models import VideoScript
from ksm.writer import claude as wc
from ksm.writer.schemas import build_glossary

from _writer_fakes import make_script, plan, settings  # noqa: F401 - fixtures used by name


def _client(captured: list, body: dict) -> anthropic.Anthropic:
    def handler(request: httpx2.Request) -> httpx2.Response:
        captured.append(request)
        return httpx2.Response(200, json=body)

    return anthropic.Anthropic(api_key="test-key", base_url="http://anthropic.test", max_retries=0,
                               http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(handler)))


def _message(content: list, stop_reason: str = "end_turn", **extra) -> dict:
    return {"id": "msg_test", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
            "content": content, "stop_reason": stop_reason, "stop_sequence": None,
            "usage": {"input_tokens": 1200, "output_tokens": 900, "cache_read_input_tokens": 3000,
                      "cache_creation_input_tokens": 0}, **extra}


def test_write_script_wire_body_and_parse(settings, plan):
    script = make_script()
    captured: list = []
    client = _client(captured, _message([{"type": "thinking", "thinking": "", "signature": "sig"},
                                         {"type": "text", "text": script.model_dump_json()}]))
    out, usage = wc.write_script(client, settings=settings, series_cfg={"prompt": "series_mandi.v1.md"},
                                 plan=plan, glossary=build_glossary(), recent_titles=[], feedback=None)

    req, = captured
    body = json.loads(req.content)
    assert req.url.path == "/v1/messages"
    assert "server-side-fallback-2026-07-01" in req.headers["anthropic-beta"]
    assert body["model"] == "claude-opus-5-5"
    assert body["fallbacks"] == "default"
    assert body["output_config"]["effort"] == settings.writer_effort
    assert body["output_config"]["format"]["type"] == "json_schema"
    assert "thinking" not in body and "tool_choice" not in body and "output_format" not in body
    assert body["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert isinstance(out, VideoScript) and out.hook == script.hook
    assert usage["cache_read_input_tokens"] == 3000
    assert usage["cost_usd"] == pytest.approx((1200 * 4 + 900 * 20 + 3000 * 0.2) / 1e6)


def test_refusal_on_the_wire(settings, plan):
    client = _client([], _message([], stop_reason="refusal",
                                  stop_details={"type": "refusal", "category": "bio", "explanation": "no"}))
    with pytest.raises(wc.ClaudeRefusal):
        wc.write_script(client, settings=settings, series_cfg={}, plan=plan, glossary={},
                        recent_titles=[], feedback=None)


def test_factcheck_web_tools_on_the_wire(settings, plan, tmp_path):
    from ksm.checks.factcheck import factcheck

    (tmp_path / "sources_allowlist.yaml").write_text("domains: [pib.gov.in]\n", encoding="utf-8")
    captured: list = []
    report_json = json.dumps({"claims": [{"idx": 0, "verdict": "supported", "evidence_url": "https://pib.gov.in/a",
                                          "quote": "4,900", "note": None}],
                              "marathi_issues": [], "policy_flags": [], "overall": "pass"})

    def handler(request: httpx2.Request) -> httpx2.Response:
        captured.append(request)
        body = json.loads(request.content)
        if "tools" in body:
            return httpx2.Response(200, json=_message([{"type": "text", "text": "0 supported https://pib.gov.in/a"}]))
        return httpx2.Response(200, json=_message([{"type": "text", "text": report_json}]))

    client = anthropic.Anthropic(api_key="k", base_url="http://anthropic.test", max_retries=0,
                                 http_client=anthropic.DefaultHttpxClient(transport=httpx2.MockTransport(handler)))
    rep, _ = factcheck(client, settings=settings, plan=plan, script=make_script(), web=True, config_dir=tmp_path)
    research, final = (json.loads(r.content) for r in captured)
    assert [t["type"] for t in research["tools"]] == ["web_search_20260209", "web_fetch_20260209"]
    assert all(t["allowed_domains"] == ["pib.gov.in"] for t in research["tools"])
    assert [t["max_uses"] for t in research["tools"]] == [3, 4]
    assert "format" not in research["output_config"]
    assert final["output_config"]["format"]["type"] == "json_schema" and "tools" not in final
    assert rep.ok


def test_max_tokens_truncation_on_the_wire_keeps_spend(settings, plan):
    """Regression: through .parse() the SDK validated the cut-off JSON eagerly, so this surfaced
    as a schema error with an empty usage dict (spend lost from the ledger)."""
    cut = make_script().model_dump_json()[:200]
    body = _message([{"type": "text", "text": cut}], stop_reason="max_tokens")
    with pytest.raises(wc.ClaudeError, match="max_tokens") as ei:
        wc.write_script(_client([], body), settings=settings, series_cfg={}, plan=plan, glossary={},
                        recent_titles=[], feedback=None)
    assert ei.value.usage["output_tokens"] == 900 and ei.value.usage["cost_usd"] > 0


def test_wire_schema_matches_what_parse_would_send(settings, plan):
    from anthropic import transform_schema

    captured: list = []
    client = _client(captured, _message([{"type": "text", "text": make_script().model_dump_json()}]))
    wc.write_script(client, settings=settings, series_cfg={}, plan=plan, glossary={}, recent_titles=[], feedback=None)
    body = json.loads(captured[0].content)
    assert body["output_config"]["format"] == {"type": "json_schema", "schema": transform_schema(VideoScript)}
