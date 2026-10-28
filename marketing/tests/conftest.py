"""Shared pytest fixtures (nothing here is autouse).

- ksm_home: a temporary KSM_HOME (env var set) holding a copy of config/, so code that
  resolves paths through ksm.paths never touches the real ~/Library folder.
- settings: the repo's config/settings.yaml, loaded fresh (not the lru-cached get_settings()).
- conn: an open, migrated SQLite database inside ksm_home.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from ksm.config import Settings, settings_from_file  # noqa: E402
from ksm.db import open_db  # noqa: E402
from ksm.paths import Paths  # noqa: E402


@pytest.fixture
def ksm_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Paths:
    home = tmp_path / "ksm-home"
    shutil.copytree(ROOT / "config", home / "config")
    monkeypatch.setenv("KSM_HOME", str(home))
    return Paths(home).ensure()


@pytest.fixture
def settings() -> Settings:
    return settings_from_file(ROOT / "config" / "settings.yaml")


@pytest.fixture
def conn(ksm_home: Paths):
    c = open_db(ksm_home.db)
    yield c
    c.close()
