"""Filesystem layout.

Everything the running agent touches lives under KSM_HOME
(default ~/Library/Application Support/ks-marketing), never inside the repo:
macOS privacy protection (TCC) blocks background processes from reading
~/Desktop, where the repo is checked out.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_MARKETING_DIR = Path(__file__).resolve().parents[2]  # marketing/


def default_home() -> Path:
    env = os.environ.get("KSM_HOME")
    if env:
        return Path(env).expanduser()
    return Path.home() / "Library" / "Application Support" / "ks-marketing"


@dataclass(frozen=True)
class Paths:
    home: Path

    @property
    def db(self) -> Path:
        return self.home / "ksm.db"

    @property
    def config_dir(self) -> Path:
        # Installed copy of marketing/config (falls back to the repo copy in dev).
        installed = self.home / "config"
        return installed if installed.exists() else REPO_MARKETING_DIR / "config"

    @property
    def assets_dir(self) -> Path:
        installed = self.home / "assets"
        return installed if installed.exists() else REPO_MARKETING_DIR / "assets"

    @property
    def fonts_dir(self) -> Path:
        return self.assets_dir / "fonts"

    @property
    def work_dir(self) -> Path:
        """Per-video scratch space; deleted after QA."""
        return self.home / "work"

    @property
    def renders_dir(self) -> Path:
        """Masters and previews kept until retention purges them."""
        return self.home / "renders"

    @property
    def cache_dir(self) -> Path:
        return self.home / "cache"

    @property
    def logs_dir(self) -> Path:
        return self.home / "logs"

    def video_work(self, video_id: int) -> Path:
        return self.work_dir / f"v{video_id}"

    def ensure(self) -> "Paths":
        for p in (self.home, self.work_dir, self.renders_dir, self.cache_dir, self.logs_dir):
            p.mkdir(parents=True, exist_ok=True)
        return self


def get_paths() -> Paths:
    return Paths(default_home())
