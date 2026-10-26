"""Claude calls: the script writer, plus request/usage plumbing shared with ksm.checks.factcheck.

Request shape (claude-opus-5-5, anthropic SDK 1.x):
- thinking is always on for this model and cannot be disabled, so ``thinking`` is omitted;
  depth is controlled by ``output_config.effort``, set explicitly on every call.
- structured output via ``client.beta.messages.create`` with ``output_config.format`` (the
  documented API-level parameter; the schema is ``anthropic.transform_schema(Model)``, exactly
  what ``.parse()`` sends). We validate the text ourselves instead of using ``.parse()``
  because ``.parse()`` validates eagerly inside the call: a max_tokens cut-off or an invalid
  output raises before the response (and so its usage/spend) is visible to us.
- forced ``tool_choice`` is a 400 on this model, so it is never sent.
- the beta namespace is used for the server-side refusal fallback
  (``fallbacks="default"`` + beta ``server-side-fallback-2026-07-01``).
- ``stop_reason == "refusal"`` is checked before any content is read.
- The system prompt is a single stable block with ``cache_control``; everything that varies
  per video (series spec, payload, settings-dependent rules) goes in the user message.
- Structured outputs are documented as incompatible with citations, which web search
  results carry, so a web fact-check is two calls: a tool-using research call that returns
  evidence notes as text, then a tool-free parse call.
"""
from __future__ import annotations

import json
import re
from datetime import date
from importlib import resources
from typing import Any

from anthropic import transform_schema
from pydantic import BaseModel, ValidationError

from ..config import Settings
from ..models import VideoPlan, VideoScript

WRITER_PROMPT = "writer.v1.md"
FACTCHECK_PROMPT = "factcheck.v1.md"

FALLBACK_BETA = "server-side-fallback-2026-07-01"   # pairs with fallbacks="default" (scalar form)
WRITER_MAX_TOKENS = 16000                           # thinking counts toward max_tokens
FACTCHECK_MAX_TOKENS = 12000
RESEARCH_MAX_TOKENS = 16000
MAX_PAUSE_CONTINUATIONS = 3

AI_VOICE_LINE = "आवाज: AI (Sarvam)"

# USD per million tokens. Opus 5.5 from the Claude API docs; 5-minute cache writes are 1.25x
# input. Fallback models (when the server-side fallback serves a request) are priced at their
# own rates when known; an unknown model is priced at the most expensive known rates so the
# budget guard over-counts rather than under-counts. Fallback credit repricing is ignored.
PRICES_USD_PER_MTOK: dict[str, dict[str, float]] = {
    "claude-opus-5-5": {"input": 4.0, "output": 20.0, "cache_read": 0.20, "cache_write": 5.0},
    "claude-opus-5": {"input": 5.0, "output": 25.0, "cache_read": 0.50, "cache_write": 6.25},
    "claude-opus-4-8": {"input": 5.0, "output": 25.0, "cache_read": 0.50, "cache_write": 6.25},
}
_PRICE_UNKNOWN = max(PRICES_USD_PER_MTOK.values(), key=lambda p: p["output"])
# Web search at $10 per 1,000 searches (the list rate quoted in the Claude API docs'
# managed-agents cost notes; not restated on the Messages API pages we have).
# Web fetch has no per-request fee; its content is billed as input tokens.
WEB_SEARCH_USD_PER_REQUEST = 10.0 / 1000

_MONTHS_MR = ("जाने", "फेब्रु", "मार्च", "एप्रि", "मे", "जून", "जुलै", "ऑग", "सप्टें", "ऑक्टो", "नोव्हें", "डिसें")


class ClaudeError(RuntimeError):
    """A Claude call finished without usable output. ``usage`` still carries the spend."""

    def __init__(self, message: str, usage: dict | None = None) -> None:
        super().__init__(message)
        self.usage = usage or {}


class ClaudeRefusal(ClaudeError):
    """stop_reason == 'refusal' (after any server-side fallback also declined)."""

    def __init__(self, category: str | None, explanation: str | None, usage: dict | None = None) -> None:
        super().__init__(f"Claude declined (category={category}): {explanation or ''}".strip(), usage)
        self.category = category
        self.explanation = explanation


# ── Prompts ───────────────────────────────────────────────────────────────────


def load_prompt(name: str) -> str:
    return resources.files("ksm.writer").joinpath("prompts", name).read_text(encoding="utf-8")


def prompt_version(name: str) -> str:
    return name.removesuffix(".md")


def _series_prompt_name(series: str, series_cfg: dict) -> str | None:
    """series.yaml's ``prompt`` must exist (a typo there is a config bug, so it raises);
    without one, ``series_<key>.v1.md`` is used if present, else the series config alone."""
    explicit = series_cfg.get("prompt")
    name = explicit or f"series_{series}.v1.md"
    if resources.files("ksm.writer").joinpath("prompts", name).is_file():
        return name
    if explicit:
        raise FileNotFoundError(f"series prompt {name!r} (series.yaml key {series!r}) is not in writer/prompts/")
    return None


# ── Usage and cost ────────────────────────────────────────────────────────────


def empty_usage() -> dict[str, Any]:
    return {
        "input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 0,
        "cache_creation_input_tokens": 0, "web_search_requests": 0, "cost_usd": 0.0, "cost_inr": 0.0,
    }


def _g(obj: Any, name: str, default: Any = 0) -> Any:
    if obj is None:
        return default
    if isinstance(obj, dict):
        v = obj.get(name, default)
    else:
        v = getattr(obj, name, default)
    return default if v is None else v


def cost_usd(model: str, *, input_tokens: int = 0, output_tokens: int = 0, cache_read: int = 0,
             cache_write: int = 0, web_searches: int = 0) -> float:
    p = PRICES_USD_PER_MTOK.get(model) or _PRICE_UNKNOWN
    tokens = (input_tokens * p["input"] + output_tokens * p["output"]
              + cache_read * p["cache_read"] + cache_write * p["cache_write"]) / 1_000_000
    return tokens + web_searches * WEB_SEARCH_USD_PER_REQUEST


def usage_of(response: Any, *, model: str, usd_inr: float) -> dict[str, Any]:
    """Token counts and cost for one response.

    When a server-side fallback ran, top-level usage covers only the serving attempt;
    ``usage.iterations`` is the per-attempt source of truth, so it is summed instead.
    """
    u = _g(response, "usage", None)
    stu = _g(u, "server_tool_use", None)
    searches = int(_g(stu, "web_search_requests", 0))
    iterations = _g(u, "iterations", None) or []
    out = empty_usage()
    usd = 0.0
    rows = iterations if iterations else [u]
    for it in rows:
        i, o = int(_g(it, "input_tokens")), int(_g(it, "output_tokens"))
        cr, cw = int(_g(it, "cache_read_input_tokens")), int(_g(it, "cache_creation_input_tokens"))
        out["input_tokens"] += i
        out["output_tokens"] += o
        out["cache_read_input_tokens"] += cr
        out["cache_creation_input_tokens"] += cw
        usd += cost_usd(str(_g(it, "model", model) or model), input_tokens=i, output_tokens=o,
                        cache_read=cr, cache_write=cw)
    out["web_search_requests"] = searches
    usd += searches * WEB_SEARCH_USD_PER_REQUEST
    out["cost_usd"] = round(usd, 6)
    out["cost_inr"] = round(usd * usd_inr, 4)
    return out


def add_usage(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    out = dict(a)
    for k in ("input_tokens", "output_tokens", "cache_read_input_tokens",
              "cache_creation_input_tokens", "web_search_requests"):
        out[k] = int(a.get(k, 0)) + int(b.get(k, 0))
    out["cost_usd"] = round(float(a.get("cost_usd", 0)) + float(b.get("cost_usd", 0)), 6)
    out["cost_inr"] = round(float(a.get("cost_inr", 0)) + float(b.get("cost_inr", 0)), 4)
    return out


# ── Shared request plumbing ───────────────────────────────────────────────────


def _system(text: str) -> list[dict]:
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


def _common(settings: Settings, effort: str) -> dict[str, Any]:
    return {
        "model": settings.model,
        "output_config": {"effort": effort},
        "betas": [FALLBACK_BETA],
        "fallbacks": "default",
    }


def _raise_if_refused(response: Any, usage: dict) -> None:
    if _g(response, "stop_reason", None) == "refusal":
        details = _g(response, "stop_details", None)
        raise ClaudeRefusal(_g(details, "category", None), _g(details, "explanation", None), usage)


def _text_of(response: Any) -> str:
    return "".join(str(_g(b, "text", "")) for b in (_g(response, "content", []) or [])
                   if _g(b, "type", None) == "text")


def structured_call(client: Any, out_type: type[BaseModel], *, settings: Settings, effort: str,
                    what: str, **kw: Any) -> tuple[Any, dict]:
    """One structured-output request. Returns (validated object, usage).

    Order matters: usage first (so every failure carries the spend), then refusal, then
    max_tokens, then validation. Raises ClaudeRefusal / ClaudeError.
    """
    req = _common(settings, effort)
    req["output_config"] = {**req["output_config"],
                            "format": {"type": "json_schema", "schema": transform_schema(out_type)}}
    response = client.beta.messages.create(**req, **kw)
    usage = usage_of(response, model=settings.model, usd_inr=settings.usd_inr)
    _raise_if_refused(response, usage)
    stop = _g(response, "stop_reason", None)
    if stop == "max_tokens":
        raise ClaudeError(f"{what}: output cut off at max_tokens", usage)
    text = _text_of(response)
    if not text.strip():
        raise ClaudeError(f"{what}: no structured output (stop_reason={stop})", usage)
    try:
        return out_type.model_validate_json(text), usage
    except ValidationError as e:
        # Constraints the API cannot enforce (e.g. 3-7 segments) are only checked here.
        raise ClaudeError(f"{what}: output failed schema validation: {e.error_count()} errors", usage) from e


def _dumps(obj: Any) -> str:
    # sort_keys keeps the user message deterministic across redos (cache-friendly, diffable).
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=1, default=str)


def date_mr(d: date) -> str:
    return f"{d.day} {_MONTHS_MR[d.month - 1]} {d.year}"


# ── write_script ──────────────────────────────────────────────────────────────


def build_writer_message(*, settings: Settings, series_cfg: dict, plan: VideoPlan, glossary: dict,
                         recent_titles: list[str], feedback: str | None) -> tuple[str, str | None]:
    """Returns (user message, series prompt file name or None)."""
    series_name = _series_prompt_name(plan.series, series_cfg)
    parts: list[str] = ["## Series spec"]
    if series_name:
        parts.append(load_prompt(series_name).strip())
    cfg = {k: v for k, v in series_cfg.items() if k != "prompt"}
    if cfg:
        parts.append("Series config:\n" + _dumps(cfg))
    meta = {
        "series": plan.series, "topic_key": plan.topic_key, "evergreen": plan.evergreen,
        "time_sensitive": plan.time_sensitive,
        "data_date": plan.data_date.isoformat() if plan.data_date else None,
        "data_date_onscreen": date_mr(plan.data_date) if plan.data_date else None,
    }
    parts += ["## Video", _dumps(meta)]
    parts += ["## Payload (the only allowed source of numbers, dates and facts)", _dumps(plan.payload)]
    parts += ["## Glossary (use these terms exactly)", _dumps(glossary)]
    if settings.app_cta_url:
        parts += ["## App link", f"An app link is allowed: {settings.app_cta_url} — one line in the YouTube "
                  "description and Instagram caption only; never spoken, never in the Facebook caption."]
    else:
        parts += ["## App link", "No app link is allowed. Do not ask anyone to download or install the app."]
    if recent_titles:
        parts += ["## Recent titles (do not repeat these titles or their hooks)",
                  "\n".join(f"- {t}" for t in recent_titles)]
    if feedback:
        parts += ["## Feedback on the previous attempt (fix every item)", feedback.strip()]
    parts.append("Write the script now.")
    return "\n\n".join(parts), series_name


_FOOTERISH = re.compile(r"^\s*(?:स्रोत|आवाज)\s*:")


def _with_footer(text: str, source_line: str) -> str:
    """Ensure the text ends with the source line and then the AI-voice disclosure.

    Any source/voice line the model wrote itself is dropped first: its wording may differ
    from the canonical line (a duplicate source line, or one that still carries a domain
    in the Facebook caption)."""
    footer = [ln for ln in (source_line.strip(), AI_VOICE_LINE) if ln]
    lines = [ln for ln in text.rstrip().split("\n") if ln.strip() not in footer and not _FOOTERISH.match(ln)]
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join([*lines, *footer]) if lines else "\n".join(footer)


_TLD = r"(?:com|in|org|net|gov|io|co|info)"
_DOMAIN = rf"(?:https?://)?(?:[\w-]+\.)+{_TLD}\b(?:/\S*)?"


def fb_safe(line: str) -> str:
    """Drop domain names from a source line for Facebook, which auto-links them (links cost reach):
    'स्रोत: Agmarknet / data.gov.in · 15 ऑक्टो' -> 'स्रोत: Agmarknet · 15 ऑक्टो'."""
    s = re.sub(rf"\s*\([^)]*{_DOMAIN}[^)]*\)", "", line, flags=re.I)      # '(pib.gov.in/...)'
    s = re.sub(rf"\s+/\s+{_DOMAIN}|{_DOMAIN}\s+/\s+", "", s, flags=re.I)  # 'X / domain', 'domain / X'
    s = re.sub(_DOMAIN, "", s, flags=re.I)
    s = re.sub(r":\s*[·,]\s*", ": ", s)                                   # 'स्रोत: · date'
    return re.sub(r"\s{2,}", " ", s).strip(" /·,")


def ensure_disclosures(script: VideoScript) -> VideoScript:
    """Deterministically enforce plan §2 'AI disclosure': every description/caption ends with
    the source line and the AI-voice line."""
    src = script.sources_onscreen_mr
    p = script.platform
    p.yt.description = _with_footer(p.yt.description, src)
    p.ig.caption = _with_footer(p.ig.caption, src)
    p.fb.caption = _with_footer(p.fb.caption, fb_safe(src))
    return script


def write_script(client: Any, *, settings: Settings, series_cfg: dict, plan: VideoPlan,
                 glossary: dict, recent_titles: list[str], feedback: str | None) -> tuple[VideoScript, dict]:
    """One structured writer call. Raises ClaudeRefusal / ClaudeError (with ``.usage``) on failure."""
    user, series_name = build_writer_message(settings=settings, series_cfg=series_cfg, plan=plan,
                                             glossary=glossary, recent_titles=recent_titles, feedback=feedback)
    version = "+".join(prompt_version(n) for n in (WRITER_PROMPT, series_name) if n)
    try:
        script, usage = structured_call(
            client, VideoScript, settings=settings, effort=settings.writer_effort, what="write_script",
            max_tokens=WRITER_MAX_TOKENS,
            system=_system(load_prompt(WRITER_PROMPT)),
            messages=[{"role": "user", "content": user}],
        )
    except ClaudeError as e:
        e.usage["prompt_version"] = version
        raise
    usage["prompt_version"] = version
    return ensure_disclosures(script), usage


__all__ = [
    "AI_VOICE_LINE", "ClaudeError", "ClaudeRefusal", "FALLBACK_BETA", "PRICES_USD_PER_MTOK",
    "WEB_SEARCH_USD_PER_REQUEST", "add_usage", "build_writer_message", "cost_usd", "date_mr",
    "empty_usage", "ensure_disclosures", "load_prompt", "prompt_version", "structured_call", "usage_of",
    "write_script",
]
