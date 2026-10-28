"""`ksm install`: put everything the background agent needs under KSM_HOME and render its plist.

The agent cannot read the repo (macOS TCC blocks ~/Desktop for background processes), so
config, fonts, brand files and the allow-listed illustrations are copied out. The Python
environment is NOT created here: the plist points at <KSM_HOME>/venv/bin/python and the
printed next steps say how to create it.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable
from xml.sax.saxutils import escape

import yaml

from .paths import REPO_MARKETING_DIR

LABEL = "com.krushisarva.marketing"
TEMPLATE = REPO_MARKETING_DIR / "launchd" / f"{LABEL}.plist.tmpl"
MASTERS_DIR = REPO_MARKETING_DIR.parent / "docs" / "branding" / "masters"
FFMPEG_BIN = "/opt/homebrew/opt/ffmpeg-full/bin"
BASE_PATH = ("/opt/homebrew/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin")


@dataclass
class InstallResult:
    home: Path
    plist_path: Path
    python: Path
    copied: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    commands: list[list[str]] = field(default_factory=list)
    loaded: bool = False


def agent_path() -> str:
    return ":".join((FFMPEG_BIN, *BASE_PATH))


def venv_python(home: Path) -> Path:
    return home / "venv" / "bin" / "python"


def render_plist(home: Path, python: Path, template: str | None = None) -> str:
    text = template if template is not None else TEMPLATE.read_text(encoding="utf-8")
    for key, val in (("{{PYTHON}}", str(python)), ("{{KSM_HOME}}", str(home)), ("{{PATH}}", agent_path())):
        text = text.replace(key, escape(val))
    if "{{" in text:
        raise ValueError("unrendered placeholder left in plist template")
    return text


def illustration_ids(brand: dict) -> list[str]:
    """Candidates that pass the prefix allow-list and the forbidden-token / deny checks."""
    cfg = brand.get("illustrations") or {}
    prefixes = tuple(cfg.get("allowed_prefixes") or ())
    forbidden = [t.upper() for t in cfg.get("forbidden_tokens") or ()]
    denied = set(cfg.get("denied_ids") or ())
    return [i for i in cfg.get("candidates") or ()
            if i.startswith(prefixes) and i not in denied and not any(t in i.upper() for t in forbidden)]


def _copy_tree(src: Path, dst: Path, res: InstallResult) -> None:
    for p in sorted(src.rglob("*")):
        if p.is_dir() or p.name.startswith(".") or "__pycache__" in p.parts:
            continue
        target = dst / p.relative_to(src)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, target)
        res.copied.append(str(target.relative_to(res.home)))


def install(home: Path, *, python: Path | None = None, load: bool = False, repo_dir: Path = REPO_MARKETING_DIR,
            masters_dir: Path = MASTERS_DIR, launch_agents: Path | None = None,
            run: Callable[..., subprocess.CompletedProcess] = subprocess.run) -> InstallResult:
    home = home.expanduser().resolve()
    python = python or venv_python(home)
    launch_agents = launch_agents or Path.home() / "Library" / "LaunchAgents"
    res = InstallResult(home=home, plist_path=launch_agents / f"{LABEL}.plist", python=python)
    for d in ("logs", "work", "renders", "cache"):
        (home / d).mkdir(parents=True, exist_ok=True)

    # config/: keep the previous copy (the founder may have verified advisories there).
    cfg_dst = home / "config"
    if cfg_dst.exists():
        backup = home / f"config.prev-{datetime.now():%Y%m%d-%H%M%S}"
        shutil.copytree(cfg_dst, backup)
        res.skipped.append(f"previous config kept at {backup.name}")
    _copy_tree(repo_dir / "config", cfg_dst, res)
    for sub in ("fonts", "brand"):
        if (repo_dir / "assets" / sub).is_dir():
            _copy_tree(repo_dir / "assets" / sub, home / "assets" / sub, res)

    brand = yaml.safe_load((repo_dir / "config" / "brand.yaml").read_text(encoding="utf-8")) or {}
    ill_dst = home / "assets" / "illustrations"
    ill_dst.mkdir(parents=True, exist_ok=True)
    for i in illustration_ids(brand):
        src = masters_dir / f"{i}.png"
        if src.is_file():
            shutil.copy2(src, ill_dst / src.name)
            res.copied.append(f"assets/illustrations/{src.name}")
        else:
            res.skipped.append(f"illustration {i}: not found in {masters_dir}")

    launch_agents.mkdir(parents=True, exist_ok=True)
    res.plist_path.write_text(render_plist(home, python), encoding="utf-8")
    domain = f"gui/{os.getuid()}"
    res.commands = [["launchctl", "bootout", domain, str(res.plist_path)],
                    ["launchctl", "bootstrap", domain, str(res.plist_path)]]
    if load:
        run(res.commands[0], check=False, capture_output=True)   # not loaded yet is fine
        run(res.commands[1], check=True, capture_output=True)
        res.loaded = True
    return res


def next_steps(res: InstallResult) -> list[str]:
    steps = []
    # The agent runs a non-editable copy of the package (it cannot read the repo), so the
    # code must be (re)installed into the venv after every update, not only the first time.
    pip = f"'{res.python}' -m pip install --upgrade '{REPO_MARKETING_DIR}'"
    if not res.python.exists():
        steps.append(f"/opt/homebrew/bin/python3.12 -m venv '{res.python.parent.parent}' && {pip}")
    else:
        steps.append(pip)
    if not res.loaded:
        steps += [" ".join(c if " " not in c else f"'{c}'" for c in cmd) for cmd in res.commands]
    return steps
