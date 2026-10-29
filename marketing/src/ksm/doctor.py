"""`ksm doctor`: everything that must be true before (and while) the agent runs (plan §8).

Each check prints ✓ / ✗ (or ! for a warning) with a one-line fix. Offline checks never touch
the network; `--live` adds one cheap call per external service (Telegram getMe, YouTube
channels.list, Meta debug_token, data.gov.in, Sarvam, and the configured script writer:
Gemini models.get or Anthropic models.retrieve, per `llm.provider`).
"""
from __future__ import annotations

import hashlib
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import yaml

from .config import Settings
from .paths import Paths

FFMPEG_FULL = Path("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg")
NEEDED_BUILD_FLAGS = ("--enable-libass", "--enable-libharfbuzz", "--enable-libfreetype")
META_SCOPES = ("instagram_basic", "instagram_content_publish", "instagram_manage_insights", "pages_show_list",
               "pages_read_engagement", "pages_manage_posts", "read_insights", "business_management")
OPTIONAL_SECRETS = {"pexels_api_key"}

# Script-writer providers (settings.yaml `llm.provider`) and the API key each one needs.
LLM_SECRETS = {"gemini": "gemini_api_key", "anthropic": "anthropic_api_key"}
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_TIMEOUT_S = 10.0


def gemini_headers(key: str) -> dict[str, str]:
    """The key goes in a header, never in the URL (URLs end up in logs and tracebacks)."""
    return {"x-goog-api-key": key}


def gemini_error(r: Any, key: str = "") -> str:
    """One readable line for a non-200 Gemini response; the key is redacted if echoed back."""
    try:
        err = (r.json() or {}).get("error") or {}
    except ValueError:
        err = {}
    msg = f"HTTP {r.status_code}" + (f" {err['status']}" if err.get("status") else "")
    if err.get("message"):
        msg += f": {str(err['message'])[:200]}"
    return msg.replace(key, "***") if key else msg


@dataclass
class CheckResult:
    name: str
    ok: bool | None            # None = warning (does not fail doctor)
    detail: str = ""
    hint: str = ""


def _sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=20, check=False)


# ── offline checks ────────────────────────────────────────────────────────────


def check_code_path() -> CheckResult:
    import ksm

    here = Path(ksm.__file__).resolve()
    desktop = (Path.home() / "Desktop").resolve()
    if desktop in here.parents:
        return CheckResult("code outside ~/Desktop", False, str(here.parent),
                           "the launchd agent cannot read ~/Desktop (TCC): run it from <KSM_HOME>/venv "
                           "(see `ksm install`); running from the repo is fine for development only")
    return CheckResult("code outside ~/Desktop", True, str(here.parent))


def check_home(paths: Paths) -> CheckResult:
    if not paths.home.is_dir():
        return CheckResult("KSM_HOME", False, str(paths.home), "run `ksm install`")
    if not os.access(paths.home, os.W_OK):
        return CheckResult("KSM_HOME", False, f"{paths.home} not writable", "fix the folder permissions")
    return CheckResult("KSM_HOME", True, str(paths.home))


def check_db(paths: Paths) -> CheckResult:
    from .db import open_db

    try:
        conn = open_db(paths.db)
        n = conn.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]
        conn.close()
        return CheckResult("database", True, f"{paths.db} ({n} migrations)")
    except Exception as e:   # noqa: BLE001
        return CheckResult("database", False, f"{type(e).__name__}: {e}", "check KSM_HOME permissions / disk space")


def check_config(paths: Paths) -> list[CheckResult]:
    out = []
    cfg = paths.config_dir
    try:
        from .sources.msp import load_msp
        out.append(CheckResult("msp.yaml", True, f"{len(load_msp(cfg).rows)} rows, every row sourced"))
    except Exception as e:   # noqa: BLE001
        out.append(CheckResult("msp.yaml", False, str(e)[:200], "every MSP row needs a source_url (PIB)"))
    try:
        from .sources.advisories import load_advisories
        n = len(load_advisories(cfg))
        out.append(CheckResult("advisories.yaml", True if n else None, f"{n} verified entries",
                               "" if n else "रब्बी पेरणी series makes nothing until entries are verified "
                                            "(verified: true, verified_by, verified_on)"))
    except Exception as e:   # noqa: BLE001
        out.append(CheckResult("advisories.yaml", False, str(e)[:200], "fix the entry named in the message"))
    try:
        from .planner import load_series
        enabled = [s["key"] for s in load_series(cfg) if s.get("enabled")]
        out.append(CheckResult("series.yaml", bool(enabled), f"enabled: {', '.join(enabled) or 'none'}",
                               "" if enabled else "enable at least one series"))
    except Exception as e:   # noqa: BLE001
        out.append(CheckResult("series.yaml", False, str(e)[:200], "fix config/series.yaml"))
    return out


def check_settings(settings: Settings) -> list[CheckResult]:
    out = [CheckResult("platforms", bool(settings.platforms), ", ".join(settings.platforms) or "none",
                       "" if settings.platforms else "list platforms in settings.yaml")]
    out.append(CheckResult("dry run", None if settings.dry_run else True,
                           "ON: publishers only log" if settings.dry_run else "off: posts are real",
                           "turn off `dry_run` after the dry-run week" if settings.dry_run else ""))
    provider = settings.provider
    model = settings.llm_model if provider == "gemini" else settings.model
    out.append(CheckResult("script writer", provider in LLM_SECRETS, f"{provider} ({model or 'no model set'})",
                           "" if provider in LLM_SECRETS else
                           f"settings.yaml llm.provider must be one of: {', '.join(LLM_SECRETS)}"))
    if not settings.app_cta_url:
        out.append(CheckResult("app CTA", True, "no Play URL: videos never say 'download the app'"))
    return out


def check_ffmpeg(run: Callable[[list[str]], subprocess.CompletedProcess] = _run,
                 binary: Path = FFMPEG_FULL) -> CheckResult:
    if not binary.exists():
        return CheckResult("ffmpeg-full (libass)", False, f"{binary} missing",
                           "brew install ffmpeg-full (plain ffmpeg has no libass: Devanagari would break)")
    conf = run([str(binary), "-hide_banner", "-buildconf"]).stdout
    missing = [f for f in NEEDED_BUILD_FLAGS if f not in conf]
    if missing:
        return CheckResult("ffmpeg-full (libass)", False, f"built without {', '.join(missing)}",
                           "reinstall: brew reinstall ffmpeg-full")
    return CheckResult("ffmpeg-full (libass)", True, str(binary))


def check_fonts(paths: Paths) -> CheckResult:
    try:
        brand = yaml.safe_load((paths.config_dir / "brand.yaml").read_text(encoding="utf-8")) or {}
    except OSError as e:
        return CheckResult("fonts + brand files", False, str(e), "run `ksm install`")
    want = {f"fonts/{k}": v.get("sha256") for k, v in ((brand.get("fonts") or {}).get("files") or {}).items()}
    want |= {k: v.get("sha256") for k, v in (brand.get("brand_files") or {}).items()}
    bad = []
    for rel, sha in want.items():
        p = paths.assets_dir / rel
        if not p.is_file():
            bad.append(f"{rel} missing")
        elif sha and _sha256(p) != sha:
            bad.append(f"{rel} hash mismatch")
    if bad:
        return CheckResult("fonts + brand files", False, "; ".join(bad[:4]), "run `ksm install` to re-copy assets")
    return CheckResult("fonts + brand files", True, f"{len(want)} files match brand.yaml")


def needed_secrets(settings: Settings) -> list[str]:
    from .secrets import KNOWN

    out = []
    for name in KNOWN:
        if name.startswith("youtube_") and "yt" not in settings.platforms:
            continue
        if name == "meta_system_user_token" and not ({"ig", "fb"} & set(settings.platforms)):
            continue
        if name in LLM_SECRETS.values() and name != LLM_SECRETS.get(settings.provider):
            continue                       # only the configured script writer's key is needed
        out.append(name)
    return out


def check_secrets(settings: Settings, has: Callable[[str], bool] | None = None) -> list[CheckResult]:
    if has is None:
        from .secrets import has_secret as has
    out = []
    for name in needed_secrets(settings):
        ok = has(name)
        out.append(CheckResult(f"secret {name}", ok if ok or name not in OPTIONAL_SECRETS else None,
                               "readable" if ok else "missing", "" if ok else f"ksm secrets set {name}"))
    return out


def check_telegram_paired(paths: Paths) -> CheckResult:
    from .approve import owner
    from .db import open_db

    conn = open_db(paths.db)
    try:
        uid, chat = owner(conn)
    finally:
        conn.close()
    if chat is None:
        return CheckResult("telegram paired", False, "no owner chat", "ksm pair-telegram")
    return CheckResult("telegram paired", True, f"owner {uid}")


def check_resources(settings: Settings, paths: Paths) -> list[CheckResult]:
    from .guards import emulator_running, free_disk_gb, memory_pressure_level

    free = free_disk_gb(paths.home)
    ok = False if free < settings.min_free_disk_gb else (True if free >= 15 else None)
    out = [CheckResult("free disk", ok, f"{free:.1f} GB",
                       f"free space: production stops below {settings.min_free_disk_gb:g} GB (15 GB recommended)")]
    lvl = memory_pressure_level()
    out.append(CheckResult("memory pressure", True if lvl < 2 else None, {1: "normal", 2: "warn", 4: "critical"}
                           .get(lvl, str(lvl)), "" if lvl < 2 else "renders wait until pressure is normal"))
    if emulator_running():
        out.append(CheckResult("android emulator", None, "running", "renders wait while the emulator runs"))
    return out


def check_launchd(run: Callable[[list[str]], subprocess.CompletedProcess] = _run) -> CheckResult:
    from .install import LABEL

    r = run(["launchctl", "print", f"gui/{os.getuid()}/{LABEL}"])
    if r.returncode != 0:
        return CheckResult("launchd agent", False, "not loaded", "ksm install --load")
    state = next((ln.split("=", 1)[1].strip() for ln in r.stdout.splitlines() if ln.strip().startswith("state =")), "?")
    return CheckResult("launchd agent", state == "running" or None, f"state {state}",
                       "" if state == "running" else "see <KSM_HOME>/logs/launchd.err.log")


# ── live checks ───────────────────────────────────────────────────────────────


def _live(name: str, fn: Callable[[], str], hint: str) -> CheckResult:
    try:
        return CheckResult(name, True, fn())
    except Exception as e:   # noqa: BLE001 - every failure becomes a ✗ line, never a traceback
        return CheckResult(name, False, f"{type(e).__name__}: {str(e)[:200]}", hint)


def gemini_model_check(http: Any, model: str, key: str, *, base: str = GEMINI_BASE) -> str:
    """GET models/{model}: proves the key works and the configured model exists. Free; no tokens."""
    if not model:
        raise RuntimeError("no model set: add llm.model to settings.yaml")
    r = http.get(f"{base}/models/{model}", headers=gemini_headers(key), timeout=GEMINI_TIMEOUT_S)
    if r.status_code != 200:
        raise RuntimeError(gemini_error(r, key))
    data = r.json()
    return f"{data.get('displayName') or data.get('name') or model} ({model})"


def live_checks(settings: Settings, http: Any) -> list[CheckResult]:
    from .secrets import get_secret, has_secret

    out: list[CheckResult] = []

    def telegram() -> str:
        from .approve import TelegramClient
        me = TelegramClient(get_secret("telegram_bot_token"), http).get_me()
        return f"@{me.get('username')}"
    out.append(_live("telegram getMe", telegram, "check the token: ksm secrets set telegram_bot_token"))

    if "yt" in settings.platforms:
        def youtube() -> str:
            from .publish.oauth import GoogleAuth, verify_channel
            ch = verify_channel(http, GoogleAuth.from_secrets(http).access_token())
            want = ((settings.raw or {}).get("youtube") or {}).get("channel_id")
            if want and ch["id"] != want:
                raise RuntimeError(f"token is for channel {ch['id']}, expected {want}")
            return f"{ch['title']} ({ch['id']})"
        out.append(_live("youtube channels.list", youtube, "ksm auth-youtube (signed in as the channel owner)"))

    if {"ig", "fb"} & set(settings.platforms) or has_secret("meta_system_user_token"):
        def meta() -> str:
            from .publish import GRAPH_VERSION
            tok = get_secret("meta_system_user_token")
            r = http.get(f"https://graph.facebook.com/{GRAPH_VERSION}/debug_token",
                         params={"input_token": tok, "access_token": tok}, timeout=20)
            r.raise_for_status()
            data = r.json().get("data") or {}
            missing = [s for s in META_SCOPES if s not in (data.get("scopes") or [])]
            if not data.get("is_valid") or missing:
                raise RuntimeError(f"valid={data.get('is_valid')} missing scopes: {', '.join(missing) or '-'}")
            return f"valid, expires_at={data.get('expires_at')}"
        out.append(_live("meta debug_token", meta, "regenerate the system-user token: ksm secrets set meta"))

    def datagov() -> str:
        from .sources.agmarknet import RESOURCE_ID
        r = http.get(f"https://api.data.gov.in/resource/{RESOURCE_ID}",
                     params={"api-key": get_secret("datagov_api_key"), "format": "json", "limit": 1}, timeout=30)
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code}")
        return f"{r.json().get('total', '?')} records"
    out.append(_live("data.gov.in Agmarknet", datagov, "ksm secrets set datagov_api_key"))

    def sarvam() -> str:
        from .voice import SarvamTTS
        wav = SarvamTTS(get_secret("sarvam_api_key"), http, **dict((settings.raw or {}).get("voice") or {})).synth("नमस्कार")
        return f"{len(wav)} bytes of audio"
    out.append(_live("sarvam TTS", sarvam, "ksm secrets set sarvam_api_key"))

    if settings.provider == "gemini":
        def gemini() -> str:
            return gemini_model_check(http, settings.llm_model, get_secret("gemini_api_key"))
        out.append(_live("gemini", gemini, "ksm secrets set gemini_api_key"))

    if settings.provider == "anthropic":
        def anthropic_check() -> str:
            import anthropic
            m = anthropic.Anthropic(api_key=get_secret("anthropic_api_key")).models.retrieve(settings.model)
            return m.id
        out.append(_live("anthropic", anthropic_check, "ksm secrets set anthropic_api_key"))
    return out


# ── run + format ──────────────────────────────────────────────────────────────


def run(paths: Paths, settings: Settings, *, live: bool = False, http: Any = None) -> list[CheckResult]:
    results = [check_code_path(), check_home(paths), check_db(paths), *check_config(paths),
               *check_settings(settings), check_ffmpeg(), check_fonts(paths), *check_secrets(settings)]
    for name, fn, hint in (("telegram pairing", lambda: check_telegram_paired(paths), "ksm install, then ksm pair-telegram"),
                           ("launchd agent", check_launchd, "ksm install --load")):
        try:
            results.append(fn())
        except Exception as e:   # noqa: BLE001
            results.append(CheckResult(name, False, f"{type(e).__name__}: {e}", hint))
    results += check_resources(settings, paths)
    if live:
        import httpx
        own = http is None
        http = http or httpx.Client(timeout=30)
        try:
            results += live_checks(settings, http)
        finally:
            if own:
                http.close()
    return results


def format_results(results: list[CheckResult]) -> str:
    lines = []
    for r in results:
        mark = "✓" if r.ok else ("!" if r.ok is None else "✗")
        lines.append(f"{mark} {r.name}" + (f" — {r.detail}" if r.detail else ""))
        if r.hint and r.ok is not True:
            lines.append(f"    → {r.hint}")
    failed = sum(1 for r in results if r.ok is False)
    lines.append(f"\n{len(results) - failed}/{len(results)} ok" + (f", {failed} to fix" if failed else ""))
    return "\n".join(lines)

