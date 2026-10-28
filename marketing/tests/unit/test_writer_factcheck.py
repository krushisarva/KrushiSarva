"""Fact-check: verdict mapping, web-tool restriction, two-call flow, refusal handling."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from ksm.checks import factcheck as fcm
from ksm.writer.schemas import FactCheckReport

from _writer_fakes import (  # noqa: F401 - fixtures used by name
    FakeClient, make_script, parsed_response, plan, refusal_response, settings, usage,
)


@pytest.fixture
def config_dir(tmp_path):
    (tmp_path / "sources_allowlist.yaml").write_text(
        "official:\n  - pib.gov.in\n  - https://www.pmkisan.gov.in/\nuniversities: [mpkv.ac.in]\n",
        encoding="utf-8")
    return tmp_path


def report(**over) -> FactCheckReport:
    data = {"claims": [{"idx": 0, "verdict": "supported", "evidence_url": "payload:commodities[0].markets[0].modal",
                        "quote": "4900"}],
            "marathi_issues": [], "policy_flags": [], "overall": "pass"}
    data.update(over)
    return FactCheckReport.model_validate(data)


def text_response(text, *, stop="end_turn", u=None):
    return SimpleNamespace(stop_reason=stop, content=[SimpleNamespace(type="server_tool_use"),
                                                      SimpleNamespace(type="text", text=text)],
                           usage=u or usage(), stop_details=None)


def run(client, settings, plan, *, web, config_dir=None, script=None):
    return fcm.factcheck(client, settings=settings, plan=plan, script=script or make_script(), web=web,
                         config_dir=config_dir)


# ── no web ────────────────────────────────────────────────────────────────────


def test_no_web_single_parse_call_without_tools(settings, plan):
    client = FakeClient(parsed_response(report()))
    rep, u = run(client, settings, plan, web=False)
    (kind, kw), = client.calls
    assert kind == "create" and "tools" not in kw and "tool_choice" not in kw and "thinking" not in kw
    assert kw["model"] == "claude-opus-5-5"
    assert kw["output_config"]["effort"] == settings.factcheck_effort == "low"
    assert kw["output_config"]["format"]["type"] == "json_schema" and "output_format" not in kw
    assert kw["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert "Not available for this video" in kw["messages"][0]["content"]
    assert rep.ok and rep.issues == []
    assert u["prompt_version"] == "factcheck.v1"


def test_verdict_mapping(settings, plan):
    script = make_script(claims=[{"kind": "number", "text_mr": f"c{i}", "value": str(i)} for i in range(4)])
    fc = report(
        claims=[{"idx": 0, "verdict": "supported", "evidence_url": "payload:commodities[0].msp"},
                {"idx": 1, "verdict": "unsupported", "note": "payload says 4,850"},
                {"idx": 2, "verdict": "unverifiable"}],   # idx 3 missing -> unverifiable
        marathi_issues=[{"where": "hook.voice_mr", "problem": "Hindi word", "fix": "भाव", "severity": "high"},
                        {"where": "cta_mr", "problem": "style", "fix": "फॉलो करा", "severity": "low"}],
        policy_flags=[{"where": "segments[1].voice_mr", "rule": "price_prediction", "detail": "says prices will rise"}],
        overall="fix")
    rep, _ = run(FakeClient(parsed_response(fc)), settings, plan, web=False, script=script)
    by = [(i.code, i.where, i.blocking) for i in rep.issues]
    assert ("claim_unsupported", "claims[1]", True) in by
    assert ("claim_unverifiable", "claims[2]", True) in by
    assert ("claim_unverifiable", "claims[3]", True) in by
    assert ("marathi_quality", "hook.voice_mr", True) in by
    assert ("marathi_quality", "cta_mr", False) in by
    assert ("policy_flag", "segments[1].voice_mr", True) in by
    assert not any(w == "claims[0]" for _, w, _ in by)
    assert not rep.ok
    assert "[price_prediction]" in rep.feedback()


def test_low_severity_marathi_only_is_not_blocking(settings, plan):
    fc = report(marathi_issues=[{"where": "cta_mr", "problem": "style", "fix": "x", "severity": "medium"}], overall="fix")
    rep, _ = run(FakeClient(parsed_response(fc)), settings, plan, web=False)
    assert rep.ok and rep.issues[0].code == "marathi_quality"


def test_overall_fail_without_issues_still_blocks(settings, plan):
    rep, _ = run(FakeClient(parsed_response(report(overall="fail"))), settings, plan, web=False)
    assert not rep.ok and rep.issues[0].code == "factcheck_fail"


def test_refusal_becomes_blocking_issue_with_usage(settings, plan):
    rep, u = run(FakeClient(refusal_response(u=usage(1_000_000, 0))), settings, plan, web=False)
    assert not rep.ok and rep.issues[0].code == "factcheck_refused"
    assert u["cost_usd"] == pytest.approx(4.0)


def test_max_tokens_becomes_blocking_issue(settings, plan):
    rep, _ = run(FakeClient(parsed_response(None, stop="max_tokens")), settings, plan, web=False)
    assert not rep.ok and rep.issues[0].code == "factcheck_error"


# ── web ───────────────────────────────────────────────────────────────────────


def test_web_research_then_parse(settings, plan, config_dir):
    client = FakeClient(
        text_response("0 supported https://pib.gov.in/x 'MSP 5,708'", u=usage(500, 200, searches=2)),
        parsed_response(report(claims=[{"idx": 0, "verdict": "supported", "evidence_url": "https://pib.gov.in/x",
                                        "quote": "5,708"}]), u=usage(800, 300)),
    )
    rep, u = run(client, settings, plan, web=True, config_dir=config_dir)
    (k1, research), (k2, parse) = client.calls
    assert (k1, k2) == ("create", "create")
    domains = ["pib.gov.in", "pmkisan.gov.in", "mpkv.ac.in"]
    assert research["tools"] == [
        {"type": "web_search_20260209", "name": "web_search", "max_uses": 3, "allowed_domains": domains},
        {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 4, "allowed_domains": domains},
    ]
    assert "tool_choice" not in research and "thinking" not in research
    assert "format" not in research["output_config"]   # structured output kept off the citation-bearing call
    assert research["output_config"] == {"effort": "medium"}   # plan: medium for web-checked scheme videos
    assert parse["output_config"]["effort"] == "medium" and parse["output_config"]["format"]["type"] == "json_schema"
    assert "plain-text notes" in research["messages"][0]["content"]
    assert research["system"] == parse["system"]
    assert "tools" not in parse
    assert "https://pib.gov.in/x" in parse["messages"][0]["content"]
    assert rep.ok
    assert u["web_search_requests"] == 2
    assert u["input_tokens"] == 1300 and u["output_tokens"] == 500
    usd = (1300 * 4 + 500 * 20) / 1e6 + 2 * 0.01
    assert u["cost_usd"] == pytest.approx(usd)
    assert u["cost_inr"] == pytest.approx(usd * settings.usd_inr, abs=1e-4)


def test_web_pause_turn_is_resumed(settings, plan, config_dir):
    paused = text_response("searching", stop="pause_turn")
    client = FakeClient(paused, text_response("0 supported"), parsed_response(report()))
    run(client, settings, plan, web=True, config_dir=config_dir)
    (_, first), (_, second), _ = client.calls
    assert len(first["messages"]) == 1
    assert second["messages"][1] == {"role": "assistant", "content": paused.content}


def test_evidence_outside_allowlist_is_downgraded(settings, plan, config_dir):
    client = FakeClient(text_response("notes"), parsed_response(report(
        claims=[{"idx": 0, "verdict": "supported", "evidence_url": "https://www.agrowon.com/news"}])))
    rep, _ = run(client, settings, plan, web=True, config_dir=config_dir)
    assert [i.code for i in rep.issues] == ["claim_unverifiable"]
    assert "allow-listed" in rep.issues[0].message


def test_subdomain_of_allowed_domain_is_accepted():
    assert fcm.domain_allowed("https://static.pib.gov.in/a", ["pib.gov.in"])
    assert not fcm.domain_allowed("https://pib.gov.in.evil.com/a", ["pib.gov.in"])


def test_research_refusal_blocks(settings, plan, config_dir):
    rep, _ = run(FakeClient(refusal_response()), settings, plan, web=True, config_dir=config_dir)
    assert rep.issues[0].code == "factcheck_refused"


def test_web_without_allowlist_raises(settings, plan, tmp_path):
    (tmp_path / "sources_allowlist.yaml").write_text("[]\n", encoding="utf-8")
    with pytest.raises(ValueError):
        run(FakeClient(), settings, plan, web=True, config_dir=tmp_path)
    with pytest.raises(FileNotFoundError):
        run(FakeClient(), settings, plan, web=True, config_dir=tmp_path / "missing")


# ── evidence grounding (review fixes) ─────────────────────────────────────────


@pytest.mark.parametrize("evidence,why", [
    (None, "without any evidence"),
    ("payload:commodities[0].markets[5].modal", "does not exist"),
    ("payload:commodities[0].price", "does not exist"),
    ("https://pib.gov.in/remembered", "no web research ran"),
    ("msp.yaml", "neither payload"),
])
def test_ungrounded_supported_verdict_is_downgraded_without_web(settings, plan, evidence, why):
    fc = report(claims=[{"idx": 0, "verdict": "supported", "evidence_url": evidence}])
    rep, _ = run(FakeClient(parsed_response(fc)), settings, plan, web=False)
    assert [i.code for i in rep.issues] == ["claim_unverifiable"] and why in rep.issues[0].message


def test_payload_url_and_payload_key_are_accepted_without_web(settings, plan):
    import dataclasses
    p = dataclasses.replace(plan, payload={**plan.payload, "sources": [{"url": "https://mpkv.ac.in/advice/1"}]})
    script = make_script(claims=[{"kind": "fact", "text_mr": "a"}, {"kind": "number", "text_mr": "b", "value": "4,900"}])
    fc = report(claims=[{"idx": 0, "verdict": "supported", "evidence_url": "https://mpkv.ac.in/advice/1/"},
                        {"idx": 1, "verdict": "supported", "evidence_url": "payload: commodities[0].markets[0].modal"}])
    rep, _ = run(FakeClient(parsed_response(fc)), settings, p, web=False, script=script)
    assert rep.ok and rep.issues == []


def test_payload_has():
    pl = {"commodities": [{"markets": [{"modal": 4900}]}], "facts": ["x"]}
    assert fcm.payload_has(pl, "commodities[0].markets[0].modal")
    assert fcm.payload_has(pl, "commodities.0.markets.0")
    assert fcm.payload_has(pl, "facts[0]")
    assert not fcm.payload_has(pl, "facts[1]") and not fcm.payload_has(pl, "") and not fcm.payload_has(pl, "x")


def test_parse_call_error_after_research_keeps_both_spends(settings, plan, config_dir):
    client = FakeClient(text_response("notes", u=usage(1_000_000, 0, searches=1)),
                        parsed_response(None, stop="max_tokens", text="{", u=usage(1_000_000, 0)))
    rep, u = run(client, settings, plan, web=True, config_dir=config_dir)
    assert rep.issues[0].code == "factcheck_error" and "max_tokens" in rep.issues[0].message
    assert u["input_tokens"] == 2_000_000 and u["web_search_requests"] == 1
    assert u["cost_usd"] == pytest.approx(8.0 + 0.01)


def test_invalid_report_json_is_blocking_with_spend(settings, plan):
    rep, u = run(FakeClient(parsed_response(None, text='{"claims": "nope"}', u=usage(10, 20))), settings, plan, web=False)
    assert rep.issues[0].code == "factcheck_error" and not rep.ok
    assert u["output_tokens"] == 20


def test_effort_escalation_only_for_web(settings):
    import dataclasses
    assert fcm.factcheck_effort(settings, web=False) == "low"
    assert fcm.factcheck_effort(settings, web=True) == "medium"
    assert fcm.factcheck_effort(dataclasses.replace(settings, factcheck_effort="high"), web=True) == "high"
