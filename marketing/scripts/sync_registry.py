#!/usr/bin/env python3
"""Snapshot the CropGuard chemical registry into ksm/checks/registry_snapshot.json.

The marketing package must not import the FastAPI service (different deps, and the
daemon runs from a copy outside the repo), so we load fastapi/safety/chemicals.py
BY FILE PATH — it only imports `re` and `dataclasses` — and write a plain JSON
snapshot. A unit test compares REGISTRY_VERSION so CI fails when the registry
changes without a resync.

Usage:
    python scripts/sync_registry.py            # write the snapshot
    python scripts/sync_registry.py --check    # exit 1 if the snapshot is stale
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from types import ModuleType

MARKETING_DIR = Path(__file__).resolve().parents[1]
DEFAULT_CHEMICALS = MARKETING_DIR.parent / "fastapi" / "safety" / "chemicals.py"
DEFAULT_SNAPSHOT = MARKETING_DIR / "src" / "ksm" / "checks" / "registry_snapshot.json"


def load_chemicals(path: Path = DEFAULT_CHEMICALS) -> ModuleType:
    """Import chemicals.py from its file path without touching the fastapi package."""
    name = "_ksm_cropguard_chemicals"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load {path}")
    mod = importlib.util.module_from_spec(spec)
    # dataclasses resolves annotations through sys.modules[cls.__module__].
    sys.modules[name] = mod
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.modules.pop(name, None)
    return mod


def build_snapshot(mod: ModuleType) -> dict:
    registered = {
        name: {"aliases": sorted(a.lower() for a in entry.aliases), "type": entry.pesticide_type}
        for name, entry in sorted(mod.REGISTERED_ACTIVES.items())
    }
    return {
        "registry_version": mod.REGISTRY_VERSION,
        "source_file": "fastapi/safety/chemicals.py",
        "sources": list(getattr(mod, "REGISTRY_SOURCES", ())),
        "banned_actives": sorted(mod.BANNED_ACTIVES),
        "state_banned": {s: sorted(v) for s, v in sorted(getattr(mod, "STATE_LEVEL_BANS", {}).items())},
        "registered_actives": registered,
    }


def render(snapshot: dict) -> str:
    return json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=False) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--chemicals", type=Path, default=DEFAULT_CHEMICALS)
    ap.add_argument("--out", type=Path, default=DEFAULT_SNAPSHOT)
    ap.add_argument("--check", action="store_true", help="exit 1 if the snapshot is out of date")
    args = ap.parse_args(argv)

    text = render(build_snapshot(load_chemicals(args.chemicals)))
    if args.check:
        current = args.out.read_text(encoding="utf-8") if args.out.exists() else ""
        if current != text:
            print(f"stale: {args.out} — run scripts/sync_registry.py", file=sys.stderr)
            return 1
        print("registry snapshot up to date")
        return 0
    args.out.write_text(text, encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
