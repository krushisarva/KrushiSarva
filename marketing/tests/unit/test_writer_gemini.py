"""Gemini as the writer/fact-checker: request shape, response parsing, retries, dispatch, settings.

All HTTP goes through respx (no real network); sleeps are injected so retries are instant.
"""
from __future__ import annotations

import dataclasses
import json

import httpx
import pytest
import respx
import yaml

from ksm.checks import factcheck as fcm
from ksm.config import _settings_from_dict
from ksm.models import CheckReport, VideoScript
from ksm.paths import REPO_MARKETING_DIR
from ksm.writer import claude as wc
from ksm.writer import gemini as gm
from ksm.writer.claude import ClaudeError, ClaudeRefusal
from ksm.writer.schemas import FactCheckReport, build_glossary

from _writer_fakes import FakeClient, make_script, parsed_response, plan, settings  # noqa: F401 - fixtures

KEY = "test-gemini-key-AIzaFAKE"
MODEL = "gemini-3.6-flash"
URL = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"


@pytest.fixture
def gsettings(settings):  # noqa: F811 - fixture from _writer_fakes
    return dataclasses.replace(settings, provider="gemini", llm_model=MODEL)


class Sleeps(list):
    def __call__(self, s: float) -> None:
        self.append(s)


def client(sleeps: Sleeps | None = None, **kw) -> gm.GeminiClient:
    return gm.GeminiClient(KEY, httpx.Client(), sleep=sleeps if sleeps is not None else Sleeps(), **kw)


def ok_body(text: str | None, *, finish: str = "STOP", usage: dict | None = None, parts: list | None = None) -> dict:
    if parts is None:
        parts = [] if text is None else [{"text": text}]
    return {
        "candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": finish}],
        "usageMetadata": usage if usage is not None else {
            "promptTokenCount": 1200, "candidatesTokenCount": 800, "thoughtsTokenCount": 300,
            "cachedContentTokenCount": 200, "totalTokenCount": 2300},
        "modelVersion": MODEL,
    }


def call_write(c, settings, plan, **kw):  # noqa: F811
    args = dict(settings=settings, series_cfg={"name_mr": "आजचा बाजारभाव"}, plan=plan,
                glossary=build_glossary(), recent_titles=["कापूस बाजारभाव | Cotton rate Akola"], feedback=None)
    args.update(kw)
    return wc.write_script(c, **args)


def assert_key_only_in_header(req: httpx.Request) -> None:
    assert req.headers["x-goog-api-key"] == KEY
    assert KEY not in str(req.url) and "key" not in req.url.params


def walk_keys(node, acc):
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "properties":
                for sub in v.values():
                    walk_keys(sub, acc)
            else:
                acc.add(k)
                walk_keys(v, acc)
    elif isinstance(node, list):
        for x in node:
            walk_keys(x, acc)
    return acc


# ── success path / request shape ──────────────────────────────────────────────


@respx.mock
def test_write_script_through_dispatcher_request_shape(gsettings, plan):  # noqa: F811
    script = make_script()
    route = respx.post(URL).mock(return_value=httpx.Response(200, json=ok_body(script.model_dump_json())))
    out, u = call_write(client(), gsettings, plan)

    assert isinstance(out, VideoScript) and out.hook == script.hook
    req = route.calls.last.request
    assert_key_only_in_header(req)
    body = json.loads(req.content)
    assert body["systemInstruction"] == {"parts": [{"text": wc.load_prompt("writer.v1.md")}]}
    (msg,) = body["contents"]
    assert msg["role"] == "user" and '"median_modal": 4850' in msg["parts"][0]["text"]
    gc = body["generationConfig"]
    assert gc["responseMimeType"] == "application/json"
    assert gc["responseJsonSchema"] == gm.gemini_schema(VideoScript.model_json_schema())
    assert gc["maxOutputTokens"] == wc.WRITER_MAX_TOKENS
    assert gc["thinkingConfig"] == {"thinkingLevel": "MEDIUM"}        # settings.writer_effort == medium
    assert "temperature" not in gc and "thinkingBudget" not in gc["thinkingConfig"]
    # usage: prompt minus cached; thinking tokens are output; free tier costs nothing
    assert set(u) == set(wc.empty_usage()) | {"prompt_version"}
    assert u["input_tokens"] == 1000 and u["cache_read_input_tokens"] == 200 and u["output_tokens"] == 1100
    assert u["cost_usd"] == 0.0 and u["cost_inr"] == 0.0
    assert u["prompt_version"] == "writer.v1+series_mandi.v1"
    # disclosures are still enforced on the Gemini path (write_script post-processing is shared)
    assert out.platform.yt.description.endswith("आवाज: AI (Sarvam)")


@respx.mock
def test_assistant_turns_become_model_and_effort_maps_to_level(gsettings):
    route = respx.post(URL).mock(return_value=httpx.Response(
        200, json=ok_body(FactCheckReport(claims=[], marathi_issues=[], policy_flags=[], overall="pass")
                          .model_dump_json())))
    gm.structured_call(client(), FactCheckReport, settings=gsettings, effort="max", what="t", max_tokens=99,
                       system="sys", messages=[{"role": "user", "content": "a"},
                                               {"role": "assistant", "content": [{"type": "text", "text": "b"}]},
                                               {"role": "user", "content": "c"}])
    body = json.loads(route.calls.last.request.content)
    assert [c["role"] for c in body["contents"]] == ["user", "model", "user"]
    assert body["contents"][1]["parts"] == [{"text": "b"}]
    assert body["systemInstruction"] == {"parts": [{"text": "sys"}]}
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "HIGH"}
    assert body["generationConfig"]["maxOutputTokens"] == 99


def test_effort_levels_and_unknown_effort():
    assert [gm.thinking_level(e) for e in ("low", "medium", "high", "xhigh", "max")] == \
        ["LOW", "MEDIUM", "HIGH", "HIGH", "HIGH"]
    with pytest.raises(ValueError):
        gm.thinking_level("turbo")


def test_schema_is_reduced_to_supported_keywords():
    allowed = gm._SCHEMA_KEYS
    for model in (VideoScript, FactCheckReport):
        s = gm.gemini_schema(model.model_json_schema())
        keys = walk_keys(s, set())
        assert keys <= allowed, keys - allowed
        assert "$ref" not in json.dumps(s) and "$defs" not in json.dumps(s)
    # $ref siblings are merged, const becomes enum, oneOf becomes anyOf
    s = gm.gemini_schema({"$defs": {"X": {"type": "object", "title": "X", "properties": {"k": {"const": "v"}}}},
                          "type": "object",
                          "properties": {"x": {"$ref": "#/$defs/X", "description": "field doc", "default": None},
                                         "y": {"oneOf": [{"type": "string"}, {"type": "null"}], "pattern": "a"}}})
    assert s["properties"]["x"] == {"type": "object", "title": "X", "description": "field doc",
                                    "properties": {"k": {"enum": ["v"]}}}
    assert s["properties"]["y"] == {"anyOf": [{"type": "string"}, {"type": "null"}]}
    with pytest.raises(ValueError):
        gm.gemini_schema({"$defs": {"N": {"type": "object", "properties": {"n": {"$ref": "#/$defs/N"}}}},
                          "$ref": "#/$defs/N"})


# ── response parsing ──────────────────────────────────────────────────────────


@respx.mock
def test_thought_parts_are_skipped(gsettings, plan):  # noqa: F811
    script = make_script()
    parts = [{"text": "thinking about prices…", "thought": True},
             {"text": script.model_dump_json(), "thoughtSignature": "c2ln"}]
    respx.post(URL).mock(return_value=httpx.Response(200, json=ok_body(None, parts=parts)))
    out, _ = call_write(client(), gsettings, plan)
    assert out.hook == script.hook


@respx.mock
def test_refusal_via_prompt_block_reason(gsettings, plan):  # noqa: F811
    respx.post(URL).mock(return_value=httpx.Response(200, json={
        "promptFeedback": {"blockReason": "PROHIBITED_CONTENT"},
        "usageMetadata": {"promptTokenCount": 500, "totalTokenCount": 500}}))
    with pytest.raises(ClaudeRefusal) as ei:
        call_write(client(), gsettings, plan)
    e = ei.value
    assert type(e).__name__ == "ClaudeRefusal"                     # what the state machine matches on
    assert e.category == "PROHIBITED_CONTENT"
    assert e.usage["input_tokens"] == 500 and e.usage["prompt_version"] == "writer.v1+series_mandi.v1"


@respx.mock
def test_refusal_via_finish_reason_safety(gsettings, plan):  # noqa: F811
    body = ok_body(None, finish="SAFETY", usage={"promptTokenCount": 700, "candidatesTokenCount": 0})
    body["candidates"][0]["safetyRatings"] = [{"category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                                               "probability": "HIGH", "blocked": True}]
    respx.post(URL).mock(return_value=httpx.Response(200, json=body))
    with pytest.raises(ClaudeRefusal) as ei:
        call_write(client(), gsettings, plan)
    assert ei.value.category == "SAFETY" and "DANGEROUS_CONTENT" in (ei.value.explanation or "")
    assert ei.value.usage["input_tokens"] == 700


@respx.mock
def test_max_tokens_is_an_error_with_usage(gsettings, plan):  # noqa: F811
    respx.post(URL).mock(return_value=httpx.Response(200, json=ok_body('{"hook": {"voice_mr": "सो', finish="MAX_TOKENS")))
    with pytest.raises(ClaudeError) as ei:
        call_write(client(), gsettings, plan)
    assert not isinstance(ei.value, ClaudeRefusal)
    assert "cut off" in str(ei.value) and ei.value.usage["output_tokens"] == 1100


@respx.mock
def test_invalid_json_is_an_error_with_usage(gsettings, plan):  # noqa: F811
    respx.post(URL).mock(return_value=httpx.Response(200, json=ok_body('{"hook": "not an object"}')))
    with pytest.raises(ClaudeError) as ei:
        call_write(client(), gsettings, plan)
    assert "schema validation" in str(ei.value) and ei.value.usage["input_tokens"] == 1000


@respx.mock
def test_no_candidates_or_empty_text_is_an_error(gsettings, plan):  # noqa: F811
    respx.post(URL).mock(side_effect=[httpx.Response(200, json={"usageMetadata": {"promptTokenCount": 3}}),
                                      httpx.Response(200, json=ok_body("   "))])
    with pytest.raises(ClaudeError, match="no candidates") as ei:
        call_write(client(), gsettings, plan)
    assert ei.value.usage["input_tokens"] == 3
    with pytest.raises(ClaudeError, match="no structured output"):
        call_write(client(), gsettings, plan)


# ── HTTP: retries and errors ──────────────────────────────────────────────────


@respx.mock
def test_429_then_success_honors_retry_info(gsettings, plan):  # noqa: F811
    err = {"error": {"code": 429, "message": "Resource has been exhausted (e.g. check quota).",
                     "status": "RESOURCE_EXHAUSTED",
                     "details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "7s"}]}}
    route = respx.post(URL).mock(side_effect=[httpx.Response(429, json=err),
                                              httpx.Response(503, headers={"retry-after": "3"}),
                                              httpx.Response(200, json=ok_body(make_script().model_dump_json()))])
    sleeps = Sleeps()
    out, _ = call_write(client(sleeps), gsettings, plan)
    assert isinstance(out, VideoScript) and route.call_count == 3
    assert sleeps == [7.0, 3.0]
    for call in route.calls:
        assert_key_only_in_header(call.request)


@respx.mock
def test_retries_exhausted_or_long_wait_raise_transient_http_error():
    route = respx.post(URL).mock(return_value=httpx.Response(500, json={"error": {"message": "internal"}}))
    sleeps = Sleeps()
    with pytest.raises(gm.GeminiHTTPError) as ei:
        client(sleeps).generate_content(MODEL, {})
    assert route.call_count == 3 and sleeps == [2.0, 4.0]
    assert ei.value.status == 500 and ei.value.transient and isinstance(ei.value, ClaudeError)

    # a daily-quota style delay beyond the cap is not waited out
    route.side_effect = [httpx.Response(429, json={"error": {"message": "quota", "details": [
        {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "3600s"}]}})]
    sleeps = Sleeps()
    with pytest.raises(gm.GeminiHTTPError) as ei:
        client(sleeps).generate_content(MODEL, {})
    assert sleeps == [] and ei.value.status == 429 and ei.value.transient


@respx.mock
def test_400_raises_with_status_and_google_message_without_key():
    respx.post(URL).mock(return_value=httpx.Response(400, json={"error": {
        "code": 400, "message": f"API key not valid ({KEY}). Please pass a valid API key.",
        "status": "INVALID_ARGUMENT",
        "details": [{"@type": "type.googleapis.com/google.rpc.ErrorInfo", "reason": "API_KEY_INVALID"}]}}))
    sleeps = Sleeps()
    with pytest.raises(ClaudeError) as ei:
        client(sleeps).generate_content(MODEL, {})
    e = ei.value
    assert isinstance(e, gm.GeminiHTTPError) and e.status == 400 and not e.transient
    assert "400" in str(e) and "API_KEY_INVALID" in str(e) and "Please pass a valid API key" in str(e)
    assert KEY not in str(e) and sleeps == []
    assert KEY not in repr(client())


@respx.mock
def test_transport_errors_are_retried_then_raised():
    route = respx.post(URL).mock(side_effect=httpx.ConnectTimeout("timed out"))
    sleeps = Sleeps()
    with pytest.raises(gm.GeminiHTTPError) as ei:
        client(sleeps).generate_content(MODEL, {})
    assert route.call_count == 3 and ei.value.status is None and ei.value.transient


def test_client_needs_a_key():
    with pytest.raises(ValueError):
        gm.GeminiClient("")


# ── dispatch ──────────────────────────────────────────────────────────────────


def test_anthropic_provider_still_uses_the_claude_client(settings, plan):  # noqa: F811
    assert settings.provider == "anthropic"
    c = FakeClient(parsed_response(make_script()))
    out, _ = call_write(c, settings, plan)
    assert isinstance(out, VideoScript) and c.calls[0][0] == "create"


@respx.mock
def test_gemini_provider_never_touches_the_claude_client(gsettings, plan):  # noqa: F811
    route = respx.post(URL).mock(return_value=httpx.Response(200, json=ok_body(make_script().model_dump_json())))

    class Both(gm.GeminiClient):
        @property
        def beta(self):
            raise AssertionError("Anthropic path used with provider gemini")

    call_write(Both(KEY, httpx.Client(), sleep=Sleeps()), gsettings, plan)
    assert route.call_count == 1


def test_unknown_provider_raises(settings, plan):  # noqa: F811
    with pytest.raises(ValueError, match="llm.provider"):
        call_write(FakeClient(), dataclasses.replace(settings, provider="openai"), plan)


@respx.mock
def test_empty_llm_model_falls_back_to_default(gsettings, plan):  # noqa: F811
    route = respx.post(URL).mock(return_value=httpx.Response(200, json=ok_body(make_script().model_dump_json())))
    call_write(client(), dataclasses.replace(gsettings, llm_model=""), plan)
    assert route.call_count == 1 and gm.DEFAULT_MODEL == MODEL


# ── factcheck on Gemini ───────────────────────────────────────────────────────


class Untouchable:
    def generate_content(self, *a, **kw):
        raise AssertionError("no API call expected")


def test_factcheck_web_on_gemini_is_a_config_error(gsettings, plan):  # noqa: F811
    with pytest.raises(ValueError, match="anthropic"):
        fcm.factcheck(Untouchable(), settings=gsettings, plan=plan, script=make_script(), web=True)


@respx.mock
def test_factcheck_without_web_on_gemini(gsettings, plan):  # noqa: F811
    fc = {"claims": [{"idx": 0, "verdict": "supported", "evidence_url": "payload:commodities[0].markets[0].modal"}],
          "marathi_issues": [], "policy_flags": [], "overall": "pass"}
    route = respx.post(URL).mock(return_value=httpx.Response(200, json=ok_body(json.dumps(fc))))
    rep, u = fcm.factcheck(client(), settings=gsettings, plan=plan, script=make_script(), web=False)
    assert isinstance(rep, CheckReport) and rep.ok, rep.issues
    body = json.loads(route.calls.last.request.content)
    assert body["systemInstruction"]["parts"][0]["text"] == wc.load_prompt("factcheck.v1.md")
    assert body["generationConfig"]["thinkingConfig"] == {"thinkingLevel": "LOW"}
    assert body["generationConfig"]["maxOutputTokens"] == wc.FACTCHECK_MAX_TOKENS
    assert u["cost_inr"] == 0.0 and u["prompt_version"] == "factcheck.v1"


@respx.mock
def test_factcheck_content_failure_blocks_but_http_failure_propagates(gsettings, plan):  # noqa: F811
    respx.post(URL).mock(side_effect=[httpx.Response(200, json=ok_body("{}", finish="SAFETY")),
                                      httpx.Response(403, json={"error": {"message": "denied"}})])
    rep, _ = fcm.factcheck(client(), settings=gsettings, plan=plan, script=make_script(), web=False)
    assert not rep.ok and rep.issues[0].code == "factcheck_refused"
    # an HTTP failure says nothing about the script: re-raised so the step is retried, not redone
    with pytest.raises(gm.GeminiHTTPError):
        fcm.factcheck(client(), settings=gsettings, plan=plan, script=make_script(), web=False)


# ── settings ──────────────────────────────────────────────────────────────────


def _settings_yaml() -> dict:
    return yaml.safe_load((REPO_MARKETING_DIR / "config" / "settings.yaml").read_text(encoding="utf-8"))


def test_settings_parse_llm_block():
    d = _settings_yaml()
    s = _settings_from_dict(d)
    assert s.provider == "gemini" and s.llm_model == "gemini-3.6-flash"
    assert s.model == "claude-opus-5-5" and s.writer_effort == "medium"      # claude block kept

    d["llm"] = {"provider": " Anthropic "}
    s = _settings_from_dict(d)
    assert s.provider == "anthropic" and s.llm_model == ""


def test_settings_without_llm_block_default_to_anthropic():
    d = _settings_yaml()
    del d["llm"]
    s = _settings_from_dict(d)
    assert s.provider == "anthropic" and s.llm_model == ""


# ── wiring ────────────────────────────────────────────────────────────────────


def test_deps_real_builds_the_configured_client(monkeypatch, ksm_home, gsettings):
    from ksm import secrets as ksecrets
    from ksm.statemachine import Deps

    asked = []

    def get_secret(name):
        asked.append(name)
        return KEY

    monkeypatch.setattr(ksecrets, "get_secret", get_secret)
    c = Deps.real(gsettings, ksm_home).client("claude")
    assert isinstance(c, gm.GeminiClient) and asked == ["gemini_api_key"]

    with pytest.raises(ValueError, match="llm.provider"):
        Deps.real(dataclasses.replace(gsettings, provider="openai"), ksm_home).client("claude")


def test_ledger_rows_name_the_configured_provider(ksm_home, conn, gsettings):
    from _core_fakes import ist, make_world

    from ksm.reconcile import tick

    w = make_world(ksm_home, gsettings)
    tick(conn, w.deps, ist(2026, 10, 16, 21, 40))
    rows = {(r["provider"], r["op"]) for r in conn.execute("SELECT provider, op FROM cost_ledger")}
    assert ("gemini", "writer") in rows and ("gemini", "factcheck") in rows
    assert not any(p == "anthropic" for p, _ in rows)
