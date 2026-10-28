"""Resource guards: disk, memory pressure, the Android emulator, and the budget.

The Mac has 8 GB RAM and a nearly full disk, and the founder runs the Android emulator
on it. Production (paid steps) stops on low disk or an exhausted budget; rendering
additionally waits while macOS reports memory pressure or the emulator is running.
"""
from __future__ import annotations

import shutil
import sqlite3
import subprocess
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

from .config import Settings
from .ledger import budget_state
from .paths import get_paths

PRESSURE_NORMAL, PRESSURE_WARN, PRESSURE_CRITICAL = 1, 2, 4


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=5, check=False)


def free_disk_gb(path: Path | None = None) -> float:
    p = Path(path) if path else get_paths().home
    while not p.exists() and p != p.parent:   # KSM_HOME may not exist before install
        p = p.parent
    return shutil.disk_usage(p).free / 1024**3


def memory_pressure_level(run: Callable[[list[str]], subprocess.CompletedProcess] = _run) -> int:
    """1 normal, 2 warn, 4 critical (kern.memorystatus_vm_pressure_level). Unknown -> 1."""
    try:
        out = run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"])
        return int(out.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return PRESSURE_NORMAL


def emulator_running(run: Callable[[list[str]], subprocess.CompletedProcess] = _run) -> bool:
    try:
        return run(["pgrep", "-x", "qemu-system-aarch64"]).returncode == 0
    except (OSError, subprocess.SubprocessError):
        try:
            return "qemu-system-aarch64" in run(["ps", "-axco", "comm"]).stdout
        except (OSError, subprocess.SubprocessError):
            return False


@dataclass
class GuardState:
    production_ok: bool            # paid steps (writer, checks, TTS) may run
    render_ok: bool                # heavy CPU/RAM steps (TTS assembly, ffmpeg) may run now
    purge_needed: bool             # free disk below settings.purge_disk_gb
    reasons: list[str] = field(default_factory=list)
    budget: str = "ok"
    free_gb: float = 0.0


@dataclass
class Probes:
    """Injectable system probes so tests never shell out."""

    disk_gb: Callable[[], float] = free_disk_gb
    pressure: Callable[[], int] = memory_pressure_level
    emulator: Callable[[], bool] = emulator_running


def check(conn: sqlite3.Connection, settings: Settings, *, now: datetime | None = None,
          probes: Probes | None = None) -> GuardState:
    probes = probes or Probes()
    reasons: list[str] = []
    free = probes.disk_gb()
    budget = budget_state(conn, settings, now)
    production_ok = True
    if free < settings.min_free_disk_gb:
        production_ok = False
        reasons.append(f"low disk: {free:.1f} GB free < {settings.min_free_disk_gb:g} GB")
    if budget == "exhausted":
        production_ok = False
        reasons.append("monthly budget exhausted")
    render_ok = production_ok
    level = probes.pressure()
    if level >= PRESSURE_WARN:
        render_ok = False
        reasons.append(f"memory pressure level {level}")
    if probes.emulator():
        render_ok = False
        reasons.append("Android emulator running")
    return GuardState(production_ok=production_ok, render_ok=render_ok,
                      purge_needed=free < settings.purge_disk_gb, reasons=reasons, budget=budget, free_gb=free)
