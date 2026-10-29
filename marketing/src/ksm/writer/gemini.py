"""Gemini (Google AI, free tier) as the script writer and fact-checker.

Selected by ``llm.provider: gemini`` in settings.yaml; ``ksm.writer.claude.structured_call``
delegates here, so ``write_script`` and ``factcheck`` run unchanged. Errors reuse
``ClaudeError`` / ``ClaudeRefusal`` (generic "LLM call failed / declined" in this codebase).

Request shape (REST ``models.generateContent``, checked against https://ai.google.dev/api/generate-content
on 2026-10-28):
- the API key goes in the ``x-goog-api-key`` header, never in the URL (URLs reach logs);
- structured output: ``generationConfig.responseMimeType = "application/json"`` plus
  ``responseJsonSchema`` (JSON Schema). Only a subset of keywords is supported, so the pydantic
  schema is reduced first (``gemini_schema``): ``$defs``/``$ref`` are inlined (a ``$ref`` may carry
  no siblings) and keywords outside the documented list (e.g. ``default``) are dropped.
  Constraints the API does not enforce are still checked by ``model_validate_json``;
- thinking depth: ``generationConfig.thinkingConfig.thinkingLevel`` (MINIMAL/LOW/MEDIUM/HIGH; the
  recommended control for Gemini 3, never combined with ``thinkingBudget``). Thinking tokens
  count toward ``maxOutputTokens`` and are reported as ``usageMetadata.thoughtsTokenCount``;
- ``temperature`` is not sent (ignored on Gemini 3.6 Flash and newer).

HTTP failures raise ``GeminiHTTPError`` (a ``ClaudeError``). Like the Anthropic SDK's own API
errors, these are not a verdict on the script, so ``factcheck`` re-raises them and the state
machine retries the step with backoff instead of sending the script back for a rewrite.
"""
from __future__ import annotations

import re
import time
from typing import Any, Callable

import httpx
from pydantic import BaseModel, ValidationError

from ..config import Settings
from .claude import ClaudeError, ClaudeRefusal, empty_usage

DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_MODEL = "gemini-3.6-flash"

RETRY_STATUSES = frozenset({429, 500, 502, 503, 504})
MAX_ATTEMPTS = 3
MAX_RETRY_WAIT_S = 60.0          # a longer server-requested wait (e.g. daily quota) is not waited out
BACKOFF_BASE_S = 2.0

# Our effort strings (shared with Claude: low/medium/high/xhigh/max) -> Gemini thinkingLevel.
THINKING_LEVELS = {"minimal": "MINIMAL", "low": "LOW", "medium": "MEDIUM", "high": "HIGH",
                   "xhigh": "HIGH", "max": "HIGH"}

# promptFeedback.blockReason is always a refusal; these candidate finishReasons are too.
REFUSAL_FINISH = frozenset({"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION",
                            "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "ESCALATION"})
CUTOFF_FINISH = frozenset({"MAX_TOKENS", "CONTINUATION"})

# JSON Schema keywords responseJsonSchema documents as supported ($defs/$ref are inlined first).
_SCHEMA_KEYS = frozenset({"type", "format", "title", "description", "enum", "items", "prefixItems",
                          "minItems", "maxItems", "minimum", "maximum", "anyOf", "properties",
                          "additionalProperties", "required", "propertyOrdering"})
_MAX_REF_DEPTH = 32


class GeminiHTTPError(ClaudeError):
    """A non-2xx response (after retries) or a transport failure. ``status`` is None for the latter;
    ``transient`` is True when a later retry may succeed (429/5xx, network)."""

    def __init__(self, message: str, *, status: int | None, transient: bool, reason: str | None = None) -> None:
        super().__init__(message, empty_usage())
        self.status = status
        self.transient = transient
        self.reason = reason


# ── HTTP client ───────────────────────────────────────────────────────────────


def _duration_s(v: Any) -> float | None:
    """'33s' / '1.5s' (protobuf Duration JSON) or a number -> seconds."""
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str) and (m := re.fullmatch(r"\s*(\d+(?:\.\d+)?)s?\s*", v)):
        return float(m.group(1))
    return None


def _error_info(r: httpx.Response) -> tuple[str, str | None, float | None]:
    """(message, reason, retry delay seconds) from a Google error body."""
    try:
        err = (r.json() or {}).get("error") or {}
    except (ValueError, AttributeError):
        err = {}
    if not isinstance(err, dict):
        err = {}
    msg = str(err.get("message") or r.reason_phrase or "").strip()
    status = err.get("status")
    reason, delay = None, None
    for d in err.get("details") or []:
        if not isinstance(d, dict):
            continue
        t = str(d.get("@type", ""))
        if t.endswith("google.rpc.RetryInfo"):
            delay = _duration_s(d.get("retryDelay"))
        elif t.endswith("google.rpc.ErrorInfo") and d.get("reason"):
            reason = str(d["reason"])
    if reason is None and status:
        reason = str(status)
    return msg, reason, delay


class GeminiClient:
    """Minimal sync REST client for ``models.generateContent``. No network until called."""

    def __init__(self, api_key: str, http: httpx.Client | None = None, *, base_url: str = DEFAULT_BASE_URL,
                 timeout: float = 120.0, max_attempts: int = MAX_ATTEMPTS, max_wait: float = MAX_RETRY_WAIT_S,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        if not api_key:
            raise ValueError("Gemini API key is empty")
        self._key = api_key
        self._http = http or httpx.Client(timeout=httpx.Timeout(timeout, connect=10.0))
        self._timeout = httpx.Timeout(timeout, connect=10.0)
        self.base_url = base_url.rstrip("/")
        self.max_attempts = max(1, int(max_attempts))
        self.max_wait = float(max_wait)
        self._sleep = sleep

    def __repr__(self) -> str:   # never show the key
        return f"GeminiClient(base_url={self.base_url!r})"

    def _redact(self, s: str) -> str:
        return s.replace(self._key, "***") if self._key else s

    def generate_content(self, model: str, body: dict) -> dict:
        url = f"{self.base_url}/models/{model}:generateContent"
        headers = {"x-goog-api-key": self._key, "content-type": "application/json"}
        for attempt in range(1, self.max_attempts + 1):
            last = attempt == self.max_attempts
            try:
                r = self._http.post(url, headers=headers, json=body, timeout=self._timeout)
            except httpx.TransportError as e:
                if last:
                    raise GeminiHTTPError(self._redact(f"Gemini request failed: {type(e).__name__}: {e}"),
                                          status=None, transient=True) from None
                self._sleep(BACKOFF_BASE_S * 2 ** (attempt - 1))
                continue
            if r.status_code == 200:
                try:
                    data = r.json()
                except ValueError:
                    raise GeminiHTTPError("Gemini returned HTTP 200 with a non-JSON body",
                                          status=200, transient=True) from None
                if not isinstance(data, dict):
                    raise GeminiHTTPError("Gemini returned HTTP 200 with an unexpected body",
                                          status=200, transient=True)
                return data
            msg, reason, delay = _error_info(r)
            text = self._redact(f"Gemini HTTP {r.status_code}" + (f" {reason}" if reason else "")
                                + (f": {msg}" if msg else ""))
            if r.status_code not in RETRY_STATUSES:
                raise GeminiHTTPError(text, status=r.status_code, transient=False, reason=reason)
            if delay is None:
                delay = _duration_s(r.headers.get("retry-after"))
            if delay is None:
                delay = BACKOFF_BASE_S * 2 ** (attempt - 1)
            if last or delay > self.max_wait:
                # Out of attempts, or told to wait longer than we block a tick for (e.g. the free
                # tier's daily quota): give up now; the state machine retries the step later.
                raise GeminiHTTPError(text, status=r.status_code, transient=True, reason=reason)
            self._sleep(max(0.0, delay))
        raise AssertionError("unreachable")  # pragma: no cover


# ── schema ────────────────────────────────────────────────────────────────────


def gemini_schema(schema: dict) -> dict:
    """A pydantic ``model_json_schema()`` reduced to what responseJsonSchema supports."""
    defs = dict(schema.get("$defs") or {})

    def resolve(ref: str) -> dict:
        prefix = "#/$defs/"
        if not ref.startswith(prefix) or ref[len(prefix):] not in defs:
            raise ValueError(f"unsupported $ref {ref!r} in output schema")
        return defs[ref[len(prefix):]]

    def walk(node: Any, depth: int) -> Any:
        if isinstance(node, list):
            return [walk(x, depth) for x in node]
        if not isinstance(node, dict):
            return node
        if depth > _MAX_REF_DEPTH:
            raise ValueError("output schema is recursive; Gemini cannot take it")
        if "$ref" in node:
            target = walk(resolve(node["$ref"]), depth + 1)
            # Siblings of $ref (pydantic puts a field's description/default there) are merged in;
            # the field-level description is more specific than the class's, so it wins.
            extra = walk({k: v for k, v in node.items() if k != "$ref"}, depth)
            return {**target, **extra} if isinstance(target, dict) else target
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k == "properties" and isinstance(v, dict):
                out[k] = {name: walk(sub, depth) for name, sub in v.items()}
            elif k == "oneOf":
                out["anyOf"] = walk(v, depth)     # documented as interpreted the same as anyOf
            elif k == "const":
                out["enum"] = [v]
            elif k in ("items", "additionalProperties", "anyOf", "prefixItems"):
                out[k] = walk(v, depth)
            elif k in _SCHEMA_KEYS:
                out[k] = v
        return out

    return walk({k: v for k, v in schema.items() if k != "$defs"}, 0)


# ── request / response ────────────────────────────────────────────────────────


def thinking_level(effort: str) -> str:
    try:
        return THINKING_LEVELS[str(effort).strip().lower()]
    except KeyError:
        raise ValueError(f"unknown effort {effort!r}; expected one of {sorted(THINKING_LEVELS)}") from None


def _parts(content: Any) -> list[dict]:
    if isinstance(content, str):
        return [{"text": content}]
    parts = []
    for b in content or []:
        if isinstance(b, dict) and b.get("type", "text") == "text" and isinstance(b.get("text"), str):
            parts.append({"text": b["text"]})
        else:
            raise ValueError(f"Gemini path supports text content only, got {b!r:.80}")
    return parts


def build_request(out_type: type[BaseModel], *, effort: str, max_tokens: int, system: Any,
                  messages: list[dict]) -> dict:
    if isinstance(system, str):
        sys_parts = [{"text": system}]
    else:
        sys_parts = [{"text": b["text"]} for b in (system or []) if isinstance(b, dict) and b.get("text")]
    contents = [{"role": "model" if m.get("role") == "assistant" else "user", "parts": _parts(m.get("content"))}
                for m in messages]
    body: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseJsonSchema": gemini_schema(out_type.model_json_schema()),
            "maxOutputTokens": int(max_tokens),
            "thinkingConfig": {"thinkingLevel": thinking_level(effort)},
        },
    }
    if sys_parts:
        body["systemInstruction"] = {"parts": sys_parts}
    return body


def usage_of(data: dict) -> dict[str, Any]:
    """usageMetadata -> our usage dict. promptTokenCount includes cached tokens (Anthropic's
    input_tokens does not), so the cached share is moved to cache_read_input_tokens. Thinking
    tokens are output tokens. Free tier: cost 0."""
    u = data.get("usageMetadata") or {}
    out = empty_usage()
    cached = int(u.get("cachedContentTokenCount") or 0)
    out["input_tokens"] = max(0, int(u.get("promptTokenCount") or 0) - cached)
    out["output_tokens"] = int(u.get("candidatesTokenCount") or 0) + int(u.get("thoughtsTokenCount") or 0)
    out["cache_read_input_tokens"] = cached
    return out


def _safety_summary(ratings: Any) -> str:
    bad = [str(r.get("category", "?")) for r in ratings or []
           if isinstance(r, dict) and (r.get("blocked") or r.get("probability") in ("HIGH", "MEDIUM"))]
    return ", ".join(bad)


def structured_call(client: Any, out_type: type[BaseModel], *, settings: Settings, effort: str, what: str,
                    max_tokens: int, system: Any, messages: list[dict]) -> tuple[Any, dict]:
    """Same contract as ``claude.structured_call``: (validated object, usage); usage first, then
    refusal, then cut-off, then empty output, then validation. Raises ClaudeRefusal / ClaudeError."""
    model = settings.llm_model or DEFAULT_MODEL
    body = build_request(out_type, effort=effort, max_tokens=max_tokens, system=system, messages=messages)
    data = client.generate_content(model, body)
    usage = usage_of(data)

    fb = data.get("promptFeedback") or {}
    if fb.get("blockReason"):
        expl = fb.get("blockReasonMessage") or _safety_summary(fb.get("safetyRatings")) or "prompt blocked"
        raise ClaudeRefusal(str(fb["blockReason"]), str(expl), usage)
    cands = data.get("candidates") or []
    if not cands:
        raise ClaudeError(f"{what}: Gemini returned no candidates", usage)
    cand = cands[0] or {}
    finish = str(cand.get("finishReason") or "")
    if finish in REFUSAL_FINISH:
        expl = cand.get("finishMessage") or _safety_summary(cand.get("safetyRatings")) or "response blocked"
        raise ClaudeRefusal(finish, str(expl), usage)
    if finish in CUTOFF_FINISH:
        raise ClaudeError(f"{what}: output cut off at max_tokens (finishReason={finish})", usage)
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(str(p.get("text", "")) for p in parts if isinstance(p, dict) and not p.get("thought"))
    if not text.strip():
        raise ClaudeError(f"{what}: no structured output (finishReason={finish or 'none'})", usage)
    try:
        return out_type.model_validate_json(text), usage
    except ValidationError as e:
        raise ClaudeError(f"{what}: output failed schema validation: {e.error_count()} errors", usage) from e


__all__ = ["DEFAULT_BASE_URL", "DEFAULT_MODEL", "GeminiClient", "GeminiHTTPError", "build_request",
           "gemini_schema", "structured_call", "thinking_level", "usage_of"]
