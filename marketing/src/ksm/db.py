"""SQLite access: connection, migrations, and small shared helpers.

One process (the launchd agent) owns the database. The Telegram poller thread
and the reconcile loop each open their own connection; WAL mode lets them coexist.
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from importlib import resources
from pathlib import Path
from typing import Any, Iterator


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        raise ValueError("naive datetime; always use tz-aware UTC")
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds")


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    dt = datetime.fromisoformat(s)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def connect(path: Path | str) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path), timeout=30, isolation_level=None)  # autocommit; use tx() for transactions
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
    applied = {r["name"] for r in conn.execute("SELECT name FROM schema_migrations")}
    files = sorted(
        (p for p in resources.files("ksm.migrations").iterdir() if p.name.endswith(".sql")),
        key=lambda p: p.name,
    )
    for f in files:
        if f.name in applied:
            continue
        with tx(conn):
            _exec_script(conn, f.read_text(encoding="utf-8"))
            conn.execute("INSERT INTO schema_migrations(name, applied_at) VALUES (?, ?)", (f.name, iso(utcnow())))


def _exec_script(conn: sqlite3.Connection, sql: str) -> None:
    # executescript() would COMMIT the surrounding transaction; split statements instead.
    buf = ""
    for line in sql.splitlines():
        if line.strip().startswith("--"):
            continue
        buf += line + "\n"
        if sqlite3.complete_statement(buf):
            conn.execute(buf)
            buf = ""
    if buf.strip():
        conn.execute(buf)


@contextmanager
def tx(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    """BEGIN IMMEDIATE ... COMMIT; nested calls join the outer transaction."""
    if conn.in_transaction:
        yield conn
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def open_db(path: Path | str) -> sqlite3.Connection:
    conn = connect(path)
    migrate(conn)
    return conn


def log_event(conn: sqlite3.Connection, kind: str, video_id: int | None = None, **data: Any) -> None:
    conn.execute(
        "INSERT INTO events(ts, video_id, kind, json) VALUES (?, ?, ?, ?)",
        (iso(utcnow()), video_id, kind, json.dumps(data, ensure_ascii=False, default=str)),
    )


def kv_get(conn: sqlite3.Connection, key: str, default: str | None = None) -> str | None:
    row = conn.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else default


def kv_set(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
