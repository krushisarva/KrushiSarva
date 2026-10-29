"""Configuration loading.

Non-secret settings live in YAML under config/ (see config/settings.yaml).
Secrets live in the macOS Keychain (see ksm.secrets) and are never read from files.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

import yaml

from .paths import get_paths


def load_yaml(name: str, config_dir: Path | None = None) -> Any:
    d = config_dir or get_paths().config_dir
    with open(d / name, encoding="utf-8") as f:
        return yaml.safe_load(f)


@dataclass(frozen=True)
class SlotWindow:
    kind: str                 # 'fresh' | 'advisory'
    publish_time: str         # "07:00" IST
    produce_from: str         # e.g. "-1d 20:30" = previous day 20:30 IST; "0d 09:00" = same day
    approve_by: str           # "0d 06:45"
    late_until: str           # "0d 10:00" — after this the slot is missed / IG post expires


@dataclass(frozen=True)
class Settings:
    timezone: str
    slots: tuple[SlotWindow, ...]
    quiet_hours: tuple[str, str]            # ("22:30", "05:30") IST — nothing is published
    evergreen_min_approved: int
    approval_resend_after_hours: float
    max_redos: int
    monthly_budget_inr: float
    usd_inr: float
    model: str
    writer_effort: str
    factcheck_effort: str
    vision_effort: str
    max_video_seconds: float
    min_free_disk_gb: float
    purge_disk_gb: float
    platforms: tuple[str, ...]              # enabled platforms, e.g. ("yt",) in M1
    dry_run: bool                           # publishers log instead of calling APIs
    app_cta_url: str | None                 # Play listing URL; None = no download CTA
    provider: str = "anthropic"             # llm.provider: 'gemini' | 'anthropic' (default without an llm block)
    llm_model: str = ""                     # llm.model: the Gemini model (claude.model is used for anthropic)
    raw: dict = field(default_factory=dict, repr=False)


def _settings_from_dict(d: dict) -> Settings:
    llm = d.get("llm") or {}
    return Settings(
        timezone=d["timezone"],
        slots=tuple(SlotWindow(**s) for s in d["slots"]),
        quiet_hours=tuple(d["quiet_hours"]),
        evergreen_min_approved=int(d["evergreen_min_approved"]),
        approval_resend_after_hours=float(d["approval_resend_after_hours"]),
        max_redos=int(d["max_redos"]),
        monthly_budget_inr=float(d["budget"]["monthly_inr"]),
        usd_inr=float(d["budget"]["usd_inr"]),
        model=d["claude"]["model"],
        writer_effort=d["claude"]["writer_effort"],
        factcheck_effort=d["claude"]["factcheck_effort"],
        vision_effort=d["claude"]["vision_effort"],
        max_video_seconds=float(d["video"]["max_seconds"]),
        min_free_disk_gb=float(d["guards"]["min_free_disk_gb"]),
        purge_disk_gb=float(d["guards"]["purge_disk_gb"]),
        platforms=tuple(d["platforms"]),
        dry_run=bool(d.get("dry_run", True)),
        app_cta_url=d.get("app_cta_url") or None,
        provider=str(llm.get("provider") or "anthropic").strip().lower(),
        llm_model=str(llm.get("model") or "").strip(),
        raw=d,
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return _settings_from_dict(load_yaml("settings.yaml"))


def settings_from_file(path: Path) -> Settings:
    with open(path, encoding="utf-8") as f:
        return _settings_from_dict(yaml.safe_load(f))
