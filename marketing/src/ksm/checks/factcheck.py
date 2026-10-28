"""Claude fact-check and Marathi QA (runs after the deterministic checks).

Two calls when ``web`` is True: structured outputs are documented as incompatible with
citations, which web-search results carry, so a tool-using research call collects evidence
as text first, and a tool-free ``parse`` call turns everything into a FactCheckReport.
Web tools are restricted to config/sources_allowlist.yaml, and a "supported" verdict whose
evidence URL falls outside that list is downgraded to unverifiable. Without web research a
"supported" verdict must point at the payload (an existing key, or a URL the payload carries):
anything else can only have come from the model's own memory.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from ..config import Settings, load_yaml
from ..models import CheckReport, Issue, VideoPlan, VideoScript
from ..writer.claude import (
    FACTCHECK_MAX_TOKENS, FACTCHECK_PROMPT, MAX_PAUSE_CONTINUATIONS, RESEARCH_MAX_TOKENS,
    ClaudeError, ClaudeRefusal, _common, _dumps, _g, _raise_if_refused, _system,
    add_usage, empty_usage, load_prompt, prompt_version, structured_call, usage_of,
)
from ..writer.schemas import FactCheckReport

WEB_SEARCH_MAX_USES = 3
WEB_FETCH_MAX_USES = 4
_EFFORTS = ("low", "medium", "high", "xhigh", "max")
WEB_MIN_EFFORT = "medium"   # plan §3: fact-check at low effort, medium for (web-checked) scheme videos


def factcheck_effort(settings: Settings, web: bool) -> str:
    e = settings.factcheck_effort
    if web and e in _EFFORTS and _EFFORTS.index(e) < _EFFORTS.index(WEB_MIN_EFFORT):
        return WEB_MIN_EFFORT
    return e


def load_allowlist(config_dir: Path | None = None) -> list[str]:
    """Bare domains from config/sources_allowlist.yaml.

    Accepts a flat list, ``{domains: [...]}``, or any nesting of lists/dicts of strings
    (e.g. grouped by category); URLs are reduced to their host.
    """
    data = load_yaml("sources_allowlist.yaml", config_dir)
    found: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, str):
            host = urlparse(x if "://" in x else f"https://{x}").hostname or ""
            host = host.lower().removeprefix("www.")
            if "." in host and host not in found:
                found.append(host)
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, (list, tuple)):
            for v in x:
                walk(v)

    walk(data)
    if not found:
        raise ValueError("sources_allowlist.yaml has no domains; refusing unrestricted web search")
    return found


def web_tools(allowed_domains: list[str]) -> list[dict]:
    return [
        {"type": "web_search_20260209", "name": "web_search",
         "max_uses": WEB_SEARCH_MAX_USES, "allowed_domains": list(allowed_domains)},
        {"type": "web_fetch_20260209", "name": "web_fetch",
         "max_uses": WEB_FETCH_MAX_USES, "allowed_domains": list(allowed_domains)},
    ]


def domain_allowed(url: str, allowed: list[str]) -> bool:
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    return any(host == d or host.endswith("." + d) for d in allowed)


def build_factcheck_message(*, settings: Settings, plan: VideoPlan, script: VideoScript,
                            evidence: str | None) -> str:
    parts = [
        "## Video", _dumps({"series": plan.series, "topic_key": plan.topic_key,
                            "data_date": plan.data_date.isoformat() if plan.data_date else None}),
        "## Payload", _dumps(plan.payload),
        "## Script", _dumps(script.model_dump(mode="json")),
        "## App link", (f"Allowed: {settings.app_cta_url}" if settings.app_cta_url
                        else "Not allowed: any download/install request is a policy flag."),
    ]
    if evidence is not None:
        parts += ["## Evidence notes from official-domain web research", evidence.strip() or "(no evidence found)"]
    else:
        parts += ["## Web research", "Not available for this video. A claim the payload does not support is unverifiable."]
    parts.append("Review the script now.")
    return "\n\n".join(parts)


def _research_message(plan: VideoPlan, script: VideoScript) -> str:
    claims = [{"idx": i, **c.model_dump(mode="json")} for i, c in enumerate(script.claims)]
    return "\n\n".join([
        "## Task",
        "Verify each claim below against official sources using web_search and web_fetch (only the "
        "allowed official domains are reachable). For each claim write one line: the idx, "
        "'supported', 'contradicted' or 'not found', the URL, and an exact short quote from the page. "
        "Skip claims that the payload already supports. Do not use your own knowledge as evidence. "
        "This research step has no output schema: answer in plain-text notes, not JSON.",
        "## Payload", _dumps(plan.payload),
        "## Claims", _dumps(claims),
    ])


def _research(client: Any, *, settings: Settings, plan: VideoPlan, script: VideoScript,
              system: list[dict], allowed: list[str], effort: str) -> tuple[str, dict]:
    messages: list[dict] = [{"role": "user", "content": _research_message(plan, script)}]
    usage = empty_usage()
    texts: list[str] = []
    for _ in range(MAX_PAUSE_CONTINUATIONS + 1):
        response = client.beta.messages.create(
            **_common(settings, effort), max_tokens=RESEARCH_MAX_TOKENS,
            system=system, messages=messages, tools=web_tools(allowed),
        )
        usage = add_usage(usage, usage_of(response, model=settings.model, usd_inr=settings.usd_inr))
        _raise_if_refused(response, usage)
        content = list(_g(response, "content", []) or [])
        texts += [str(_g(b, "text", "")) for b in content if _g(b, "type", None) == "text"]
        if _g(response, "stop_reason", None) != "pause_turn":
            break
        # The server-side tool loop hit its iteration limit: re-send with the paused turn to resume.
        messages = [messages[0], {"role": "assistant", "content": content}]
    return "\n".join(t for t in texts if t.strip()), usage


_PATH_TOKEN = re.compile(r"\[(\d+)\]|([^.\[\]\s]+)")


def payload_has(payload: Any, path: str) -> bool:
    """True if ``path`` (e.g. 'commodities[0].markets[1].modal') names a value in the payload."""
    tokens = _PATH_TOKEN.findall(path.strip())
    if not tokens:
        return False
    cur = payload
    for idx, name in tokens:
        key = idx or name
        if isinstance(cur, dict) and key in cur:
            cur = cur[key]
        elif isinstance(cur, list) and key.isdigit() and int(key) < len(cur):
            cur = cur[int(key)]
        else:
            return False
    return True


def payload_urls(payload: Any) -> set[str]:
    out: set[str] = set()

    def walk(x: Any) -> None:
        if isinstance(x, str) and x.startswith(("http://", "https://")):
            out.add(x.strip().rstrip("/"))
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, (list, tuple)):
            for v in x:
                walk(v)

    walk(payload)
    return out


def _evidence_problem(evidence_url: str | None, *, payload: Any, allowed: list[str] | None) -> str | None:
    """Why a 'supported' verdict's evidence does not hold up, or None if it does."""
    ev = (evidence_url or "").strip()
    if not ev:
        return "marked supported without any evidence"
    if ev.startswith("payload:"):
        key = ev.removeprefix("payload:").strip()
        return None if payload_has(payload, key) else f"evidence payload key {key!r} does not exist"
    if ev.startswith(("http://", "https://")):
        if ev.rstrip("/") in payload_urls(payload):
            return None
        if allowed is None:
            return f"evidence {ev} is not in the payload and no web research ran"
        return None if domain_allowed(ev, allowed) else f"evidence {ev} is not an allow-listed official domain"
    return f"evidence {ev!r} is neither payload:<key> nor a URL"


def report_from(fc: FactCheckReport, script: VideoScript, *, allowed: list[str] | None,
                payload: Any = None) -> CheckReport:
    """Map verdicts to pipeline issues. Unsupported/unverifiable claims and policy flags block;
    Marathi issues block only at high severity. A 'supported' verdict whose evidence is missing,
    names a payload key that does not exist, or cites a URL we cannot trust is downgraded to
    unverifiable (the LLM gate must not pass on its own say-so)."""
    rep = CheckReport()
    seen: set[int] = set()
    payload = {} if payload is None else payload
    for c in fc.claims:
        seen.add(c.idx)
        where = f"claims[{c.idx}]"
        verdict, note = c.verdict, c.note or ""
        if verdict == "supported" and (problem := _evidence_problem(c.evidence_url, payload=payload, allowed=allowed)):
            verdict, note = "unverifiable", problem
        if verdict == "unsupported":
            rep.issues.append(Issue("claim_unsupported", note or "contradicted by payload or source", True, where))
        elif verdict == "unverifiable":
            rep.issues.append(Issue("claim_unverifiable", note or "no official evidence", True, where))
    for i in range(len(script.claims)):
        if i not in seen:
            rep.issues.append(Issue("claim_unverifiable", "fact-checker returned no verdict", True, f"claims[{i}]"))
    for m in fc.marathi_issues:
        rep.issues.append(Issue("marathi_quality", f"{m.problem} → {m.fix}", m.severity == "high", m.where))
    for f in fc.policy_flags:
        rep.issues.append(Issue("policy_flag", f"[{f.rule}] {f.detail}", True, f.where))
    if fc.overall == "fail" and rep.ok:
        rep.issues.append(Issue("factcheck_fail", "fact-checker marked the script as failing", True, ""))
    return rep


def factcheck(client: Any, *, settings: Settings, plan: VideoPlan, script: VideoScript, web: bool,
              config_dir: Path | None = None) -> tuple[CheckReport, dict]:
    """Marathi QA + claim verification.

    A refusal or unusable response becomes a blocking issue rather than an exception, so a
    video can never advance on an unchecked script and the spend is still reported.
    Config errors (missing/empty allow-list with web=True) raise: they need a human.
    """
    system = _system(load_prompt(FACTCHECK_PROMPT))
    allowed = load_allowlist(config_dir) if web else None
    effort = factcheck_effort(settings, web)
    usage = empty_usage()
    try:
        evidence: str | None = None
        if allowed is not None:
            evidence, u = _research(client, settings=settings, plan=plan, script=script,
                                    system=system, allowed=allowed, effort=effort)
            usage = add_usage(usage, u)
        fc, u = structured_call(
            client, FactCheckReport, settings=settings, effort=effort, what="factcheck",
            max_tokens=FACTCHECK_MAX_TOKENS,
            system=system,
            messages=[{"role": "user", "content": build_factcheck_message(
                settings=settings, plan=plan, script=script, evidence=evidence)}],
        )
        usage = add_usage(usage, u)
        report = report_from(fc, script, allowed=allowed, payload=plan.payload)
    except ClaudeError as e:
        # A research-call failure carries only its own spend; the structured call's error
        # carries only the second call's. Either way, add it to what was already spent.
        usage = add_usage(usage, e.usage) if e.usage else usage
        code = "factcheck_refused" if isinstance(e, ClaudeRefusal) else "factcheck_error"
        report = CheckReport([Issue(code, str(e), True, "")])
    usage["prompt_version"] = prompt_version(FACTCHECK_PROMPT)
    return report, usage
