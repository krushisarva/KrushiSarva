"""Gemini as the script writer: secrets alias, doctor (secret list + live check) and day0 (all hermetic).

No real API is called: Gemini HTTP goes through respx, `anthropic` is a fake module, and
get_secret is replaced so the real Keychain is never read. Nothing here touches os.getuid
(check_launchd), which does not exist on Windows.
"""
from __future__ import annotations

import dataclasses
import json
import sys
from types import SimpleNamespace

import httpx
import pytest
import respx

from ksm import cli, day0, doctor
from ksm import secrets as ksecrets

MODEL = "gemini-3.6-flash"
BASE = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_KEY = "test-gemini-key-AIzaFAKE"
ANTHROPIC_KEY = "test-anthropic-key"


def _with(settings, provider: str, llm_model: str = MODEL):
    # platforms=() keeps the YouTube live check (which reads the real Keychain) out of these tests.
    return dataclasses.replace(settings, provider=provider, llm_model=llm_model, platforms=())


@pytest.fixture
def fake_secrets(monkeypatch):
    """Only the two LLM keys exist; every other get_secret fails before any HTTP call is made."""
    store = {"gemini_api_key": GEMINI_KEY, "anthropic_api_key": ANTHROPIC_KEY}

    def get_secret(name):
        name = ksecrets.resolve_name(name)
        if name not in store:
            raise ksecrets.SecretMissing(f"secret {name!r} is not set")
        return store[name]

    monkeypatch.setattr(ksecrets, "get_secret", get_secret)
    monkeypatch.setattr(ksecrets, "has_secret", lambda n: ksecrets.resolve_name(n) in store)
    return store


@pytest.fixture
def fake_anthropic(monkeypatch):
    calls = []

    class Anthropic:
        def __init__(self, api_key):
            calls.append(api_key)
            self.models = SimpleNamespace(retrieve=lambda m: SimpleNamespace(id=m))
            self.messages = SimpleNamespace(create=lambda **kw: SimpleNamespace(
                content=[SimpleNamespace(text="OK")], usage=SimpleNamespace(input_tokens=9, output_tokens=1)))

    monkeypatch.setitem(sys.modules, "anthropic", SimpleNamespace(Anthropic=Anthropic))
    return calls


def _assert_key_in_header_only(request: httpx.Request) -> None:
    assert request.headers["x-goog-api-key"] == GEMINI_KEY
    assert "key" not in request.url.params
    assert GEMINI_KEY not in str(request.url)


# ── secrets ───────────────────────────────────────────────────────────────────


def test_gemini_secret_name_and_alias():
    assert "gemini_api_key" in ksecrets.KNOWN
    assert ksecrets.resolve_name("gemini") == "gemini_api_key"
    assert ksecrets.resolve_name("gemini_api_key") == "gemini_api_key"
    assert ksecrets.resolve_name("anthropic") == "anthropic_api_key"     # Claude stays available


def test_cli_secrets_set_gemini_alias(monkeypatch, capsys):
    store = {}
    monkeypatch.setattr(ksecrets.keyring, "get_password", lambda svc, n: store.get(n))
    monkeypatch.setattr(ksecrets.keyring, "set_password", lambda svc, n, v: store.__setitem__(n, v))
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt: GEMINI_KEY)
    assert cli.main(["secrets", "set", "gemini"]) == 0
    assert store == {"gemini_api_key": GEMINI_KEY}
    assert cli.main(["secrets", "check", "gemini"]) == 0
    out = capsys.readouterr().out
    assert "gemini_api_key" in out and GEMINI_KEY not in out


# ── doctor: offline ───────────────────────────────────────────────────────────


def test_needed_secrets_follow_the_provider(settings):
    gem = doctor.needed_secrets(_with(settings, "gemini"))
    assert "gemini_api_key" in gem and "anthropic_api_key" not in gem
    ant = doctor.needed_secrets(_with(settings, "anthropic"))
    assert "anthropic_api_key" in ant and "gemini_api_key" not in ant
    # the rest of the list is unchanged by the provider
    assert [n for n in gem if n != "gemini_api_key"] == [n for n in ant if n != "anthropic_api_key"]
    assert "sarvam_api_key" in gem and "telegram_bot_token" in gem


def test_check_secrets_reports_missing_gemini_key(settings):
    sec = doctor.check_secrets(_with(settings, "gemini"), has=lambda n: n != "gemini_api_key")
    bad = [r for r in sec if r.ok is False]
    assert [r.name for r in bad] == ["secret gemini_api_key"]
    assert bad[0].hint == "ksm secrets set gemini_api_key"
    # with Claude configured, a missing Gemini key is not even asked about
    sec = doctor.check_secrets(_with(settings, "anthropic"), has=lambda n: n != "gemini_api_key")
    assert all(r.ok is not False for r in sec)


def test_check_settings_names_the_script_writer(settings):
    rows = {r.name: r for r in doctor.check_settings(_with(settings, "gemini"))}
    assert rows["script writer"].ok is True and MODEL in rows["script writer"].detail
    rows = {r.name: r for r in doctor.check_settings(_with(settings, "anthropic"))}
    assert rows["script writer"].ok is True and settings.model in rows["script writer"].detail
    rows = {r.name: r for r in doctor.check_settings(_with(settings, "openai"))}
    assert rows["script writer"].ok is False and "gemini" in rows["script writer"].hint


# ── doctor: live ──────────────────────────────────────────────────────────────


def test_gemini_model_check_request_shape():
    with respx.mock(assert_all_called=True) as router:
        route = router.get(f"{BASE}/models/{MODEL}").mock(return_value=httpx.Response(
            200, json={"name": f"models/{MODEL}", "displayName": "Gemini 3.6 Flash"}))
        with httpx.Client() as http:
            detail = doctor.gemini_model_check(http, MODEL, GEMINI_KEY)
    req = route.calls.last.request
    assert req.method == "GET" and req.url.path == f"/v1beta/models/{MODEL}"
    _assert_key_in_header_only(req)
    assert "Gemini 3.6 Flash" in detail and GEMINI_KEY not in detail


def test_gemini_model_check_needs_a_model():
    with respx.mock(assert_all_called=False) as router:
        route = router.get(url__startswith=BASE).mock(return_value=httpx.Response(200, json={}))
        with httpx.Client() as http, pytest.raises(RuntimeError, match="llm.model"):
            doctor.gemini_model_check(http, "", GEMINI_KEY)
    assert not route.called


def test_live_checks_gemini_ok(settings, fake_secrets, fake_anthropic):
    with respx.mock(assert_all_called=True) as router:
        router.get(f"{BASE}/models/{MODEL}").mock(return_value=httpx.Response(
            200, json={"name": f"models/{MODEL}", "displayName": "Gemini 3.6 Flash"}))
        with httpx.Client() as http:
            res = {r.name: r for r in doctor.live_checks(_with(settings, "gemini"), http)}
    assert res["gemini"].ok is True and "Gemini 3.6 Flash" in res["gemini"].detail
    assert "anthropic" not in res and fake_anthropic == []


def test_live_checks_gemini_failure_is_a_cross_with_hint(settings, fake_secrets, fake_anthropic):
    err = {"error": {"code": 400, "status": "INVALID_ARGUMENT",
                     "message": f"API key not valid. Please pass a valid API key. ({GEMINI_KEY})"}}
    with respx.mock(assert_all_called=True) as router:
        route = router.get(f"{BASE}/models/{MODEL}").mock(return_value=httpx.Response(400, json=err))
        with httpx.Client() as http:
            res = {r.name: r for r in doctor.live_checks(_with(settings, "gemini"), http)}
    g = res["gemini"]
    assert g.ok is False and g.hint == "ksm secrets set gemini_api_key"
    assert "HTTP 400 INVALID_ARGUMENT" in g.detail and "API key not valid" in g.detail
    assert GEMINI_KEY not in g.detail and GEMINI_KEY not in doctor.format_results(list(res.values()))
    _assert_key_in_header_only(route.calls.last.request)


def test_live_checks_anthropic_provider_skips_gemini(settings, fake_secrets, fake_anthropic):
    with respx.mock(assert_all_called=False) as router:
        route = router.get(url__startswith=BASE).mock(return_value=httpx.Response(200, json={}))
        with httpx.Client() as http:
            res = {r.name: r for r in doctor.live_checks(_with(settings, "anthropic"), http)}
    assert res["anthropic"].ok is True and res["anthropic"].detail == settings.model
    assert fake_anthropic == [ANTHROPIC_KEY]
    assert "gemini" not in res and not route.called


# ── day0 ──────────────────────────────────────────────────────────────────────


def _gemini_reply(text: str = "OK") -> dict:
    return {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 8, "candidatesTokenCount": 1, "totalTokenCount": 9}}


def test_day0_gemini_request_shape(ksm_home, settings, fake_secrets, tmp_path):
    with respx.mock(assert_all_called=True) as router:
        route = router.post(f"{BASE}/models/{MODEL}:generateContent").mock(
            return_value=httpx.Response(200, json=_gemini_reply()))
        with httpx.Client() as http:
            detail = day0._gemini(day0.Day0Ctx(ksm_home, _with(settings, "gemini"), http, tmp_path))
    req = route.calls.last.request
    assert req.method == "POST" and req.url.path == f"/v1beta/models/{MODEL}:generateContent"
    _assert_key_in_header_only(req)
    body = json.loads(req.content)
    assert "OK" in body["contents"][0]["parts"][0]["text"]
    assert 0 < body["generationConfig"]["maxOutputTokens"] <= 64
    assert MODEL in detail and "'OK'" in detail and "8+1 tokens" in detail and GEMINI_KEY not in detail


def test_day0_gemini_ignores_thought_parts_and_reports_empty_answers(ksm_home, settings, fake_secrets, tmp_path):
    thought = {"candidates": [{"content": {"parts": [{"text": "thinking...", "thought": True}]},
                               "finishReason": "MAX_TOKENS"}],
               "usageMetadata": {"promptTokenCount": 8, "thoughtsTokenCount": 64}}
    with respx.mock() as router:
        router.post(f"{BASE}/models/{MODEL}:generateContent").mock(return_value=httpx.Response(200, json=thought))
        with httpx.Client() as http:
            detail = day0._gemini(day0.Day0Ctx(ksm_home, _with(settings, "gemini"), http, tmp_path))
    assert "answered ''" in detail and "MAX_TOKENS" in detail and "64 thinking" in detail


def test_day0_gemini_failure_is_reported(ksm_home, settings, fake_secrets):
    err = {"error": {"code": 403, "status": "PERMISSION_DENIED", "message": "Method doesn't allow unregistered callers."}}
    with respx.mock() as router:
        router.post(f"{BASE}/models/{MODEL}:generateContent").mock(return_value=httpx.Response(403, json=err))
        with httpx.Client() as http:
            res = day0.run(ksm_home, _with(settings, "gemini"), yes=True, http=http,
                           has=lambda n: n == "gemini_api_key")
    status = {n: (s, d) for n, s, d in res}
    assert status["gemini"][0] == "failed" and "HTTP 403 PERMISSION_DENIED" in status["gemini"][1]
    assert GEMINI_KEY not in status["gemini"][1]


def test_day0_runs_only_the_configured_writer(ksm_home, settings, fake_secrets, fake_anthropic):
    has = lambda n: n in ("gemini_api_key", "anthropic_api_key")    # noqa: E731
    with respx.mock(assert_all_called=False) as router:
        route = router.post(f"{BASE}/models/{MODEL}:generateContent").mock(
            return_value=httpx.Response(200, json=_gemini_reply()))
        with httpx.Client() as http:
            gem = {n: (s, d) for n, s, d in day0.run(ksm_home, _with(settings, "gemini"), yes=True, http=http, has=has)}
            assert route.call_count == 1 and fake_anthropic == []
            ant = {n: (s, d) for n, s, d in day0.run(ksm_home, _with(settings, "anthropic"), yes=True, http=http,
                                                     has=has)}
    assert gem["gemini"][0] == "ran" and "'OK'" in gem["gemini"][1]
    assert gem["anthropic"][0] == "skipped" and "llm.provider" in gem["anthropic"][1]
    assert ant["anthropic"][0] == "ran" and "'OK'" in ant["anthropic"][1]
    assert ant["gemini"][0] == "skipped" and "llm.provider" in ant["gemini"][1]
    assert route.call_count == 1 and fake_anthropic == [ANTHROPIC_KEY]      # no Gemini call the second time
    # checks without secrets are still skipped for the usual reason
    assert gem["telegram"] == ("skipped", "missing secret(s): telegram_bot_token")
