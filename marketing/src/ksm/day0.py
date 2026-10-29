"""`ksm day0 --yes`: one-time live tests before going live (plan §8).

STUB: only the low-risk checks are automated (Telegram message, one tiny call to the
configured script writer (Gemini or Anthropic, per `llm.provider`; the other is skipped),
Sarvam voice sample, Agmarknet facet listing). The checks that publish to YouTube / Facebook /
Instagram, and the scheduled-wake network test, are listed with their manual steps; they
post publicly visible content and are deliberately not run by code in this build.
Everything that runs is real (messages are sent, small API charges apply), hence --yes.
"""
from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .config import Settings
from .paths import Paths


@dataclass
class Day0Check:
    name: str
    secrets: tuple[str, ...]
    description: str
    run: Callable[["Day0Ctx"], str] | None = None     # None = manual step
    provider: str | None = None                       # set = runs only when settings.provider matches


@dataclass
class Day0Ctx:
    paths: Paths
    settings: Settings
    http: Any
    out_dir: Path


def _telegram(ctx: Day0Ctx) -> str:
    from .approve import TelegramClient, owner
    from .db import open_db
    from .secrets import get_secret

    conn = open_db(ctx.paths.db)
    try:
        _, chat = owner(conn)
    finally:
        conn.close()
    if chat is None:
        raise RuntimeError("not paired: run `ksm pair-telegram` first")
    tg = TelegramClient(get_secret("telegram_bot_token"), ctx.http)
    mid = tg.send_message(chat, "🧪 day-0 चाचणी: हा संदेश आला असेल तर बॉट काम करतो.", parse_mode=None)
    return f"message {mid} sent — confirm it arrived on your phone"


def _anthropic(ctx: Day0Ctx) -> str:
    import anthropic

    from .secrets import get_secret

    client = anthropic.Anthropic(api_key=get_secret("anthropic_api_key"))
    r = client.messages.create(model=ctx.settings.model, max_tokens=20,
                               messages=[{"role": "user", "content": "Reply with the single word OK."}])
    text = "".join(getattr(b, "text", "") for b in r.content).strip()
    return f"{ctx.settings.model} answered {text!r} ({r.usage.input_tokens}+{r.usage.output_tokens} tokens)"


GEMINI_DAY0_MAX_OUTPUT_TOKENS = 64


def _gemini(ctx: Day0Ctx) -> str:
    from .doctor import GEMINI_BASE, gemini_error, gemini_headers
    from .secrets import get_secret

    model = ctx.settings.llm_model
    if not model:
        raise RuntimeError("no model set: add llm.model to settings.yaml")
    key = get_secret("gemini_api_key")
    body = {"contents": [{"role": "user", "parts": [{"text": "Reply with the single word OK."}]}],
            "generationConfig": {"maxOutputTokens": GEMINI_DAY0_MAX_OUTPUT_TOKENS}}
    r = ctx.http.post(f"{GEMINI_BASE}/models/{model}:generateContent", headers=gemini_headers(key), json=body,
                      timeout=30)
    if r.status_code != 200:
        raise RuntimeError(gemini_error(r, key))
    data = r.json()
    cand = (data.get("candidates") or [{}])[0]
    text = "".join(p.get("text", "") for p in ((cand.get("content") or {}).get("parts") or [])
                   if not p.get("thought")).strip()
    u = data.get("usageMetadata") or {}
    tokens = f"{u.get('promptTokenCount', '?')}+{u.get('candidatesTokenCount', 0)} tokens"
    if u.get("thoughtsTokenCount"):
        tokens += f", {u['thoughtsTokenCount']} thinking"
    finish = "" if text else f", finishReason {cand.get('finishReason', '?')}"
    return f"{model} answered {text!r} ({tokens}{finish})"


def _sarvam(ctx: Day0Ctx) -> str:
    from .secrets import get_secret
    from .voice import SarvamTTS

    tts = SarvamTTS(get_secret("sarvam_api_key"), ctx.http, **dict((ctx.settings.raw or {}).get("voice") or {}))
    text = "लातूर बाजार समितीत सोयाबीनचा दर ५,७०८ रुपये प्रति क्विंटल होता. हमीभाव ५,७०८ रुपये आहे."
    out = ctx.out_dir / "sarvam_numbers.wav"
    out.write_bytes(tts.synth(text))
    return f"listen to {out} — numbers must be read correctly"


def _agmarknet(ctx: Day0Ctx) -> str:
    from .secrets import get_secret
    from .sources.agmarknet import fetch_snapshot

    rows = fetch_snapshot(ctx.http, get_secret("datagov_api_key"))
    facets = {"commodities": Counter(r.commodity for r in rows).most_common(),
              "markets": Counter(r.market for r in rows).most_common(),
              "arrival_dates": sorted({r.arrival_date.isoformat() for r in rows})}
    out = ctx.out_dir / "agmarknet_facets.json"
    out.write_text(json.dumps(facets, ensure_ascii=False, indent=1), encoding="utf-8")
    return f"{len(rows)} rows; compare {out} with crops_mr.yaml / markets_mr.yaml agmarknet names"


CHECKS: tuple[Day0Check, ...] = (
    Day0Check("telegram", ("telegram_bot_token",), "send one message to the paired owner chat", _telegram),
    Day0Check("gemini", ("gemini_api_key",), "one tiny Gemini call with the configured model", _gemini,
              provider="gemini"),
    Day0Check("anthropic", ("anthropic_api_key",), "one tiny Claude call with the configured model", _anthropic,
              provider="anthropic"),
    Day0Check("sarvam", ("sarvam_api_key",), "Marathi voice sample with numbers (₹0.01)", _sarvam),
    Day0Check("agmarknet", ("datagov_api_key",), "list Maharashtra commodity/market names (facet query)", _agmarknet),
    Day0Check("youtube-unlisted", ("youtube_client_json", "youtube_refresh_token"),
              "MANUAL: upload one Short with privacyStatus=unlisted; after processing, videos.list status must still be unlisted (an unaudited project gets it locked private). Delete it in Studio afterwards"),
    Day0Check("facebook-scheduled-reel", ("meta_system_user_token",),
              "MANUAL: schedule a Reel 15 min ahead; check it from an account with no role on the app; "
              "note whether is_ai_generated is accepted"),
    Day0Check("instagram-reel", ("meta_system_user_token",), "MANUAL: publish one Reel through the API"),
    Day0Check("pmset-wake-network", (), "MANUAL: after a scheduled pmset wake, confirm the network is up"),
)


def run(paths: Paths, settings: Settings, *, yes: bool, http: Any = None,
        has: Callable[[str], bool] | None = None) -> list[tuple[str, str, str]]:
    """-> [(check, status, detail)] with status in ran / failed / skipped / manual."""
    if not yes:
        raise PermissionError("day0 sends real messages and makes paid API calls: re-run with --yes")
    if has is None:
        from .secrets import has_secret as has
    import httpx

    own = http is None
    http = http or httpx.Client(timeout=60)
    out_dir = paths.home / "day0"
    out_dir.mkdir(parents=True, exist_ok=True)
    ctx = Day0Ctx(paths, settings, http, out_dir)
    results = []
    try:
        for c in CHECKS:
            if c.run is None:
                results.append((c.name, "manual", c.description))
                continue
            if c.provider is not None and c.provider != settings.provider:
                results.append((c.name, "skipped", f"script writer is {settings.provider!r} "
                                                   f"(settings.yaml llm.provider); this check is for {c.provider!r}"))
                continue
            missing = [s for s in c.secrets if not has(s)]
            if missing:
                results.append((c.name, "skipped", f"missing secret(s): {', '.join(missing)}"))
                continue
            try:
                results.append((c.name, "ran", c.run(ctx)))
            except Exception as e:   # noqa: BLE001
                results.append((c.name, "failed", f"{type(e).__name__}: {str(e)[:300]}"))
    finally:
        if own:
            http.close()
    return results
