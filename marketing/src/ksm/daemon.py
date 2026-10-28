"""The launchd agent: one process, a reconcile loop every 60 s, a Telegram long-poll thread.

- Single instance: a row in `leases` (name 'daemon') holds our pid and an expiry that the
  loop keeps extending; a second copy (e.g. `ksm daemon` typed while launchd runs one)
  exits instead of double-publishing.
- The poller thread has its own SQLite connection (WAL lets both write) and only records
  decisions (approve.poll_once persists them before returning); it hands them to the loop
  through a thread-safe queue and wakes the loop early so a tap is acted on within seconds.
- Sleep is detected with clock.SleepDetector; the tick after a wake re-sends cards.
- SIGTERM/SIGINT finish the current tick and exit cleanly (launchd sends SIGTERM).
"""
from __future__ import annotations

import logging
import logging.handlers
import os
import queue
import signal
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from typing import Callable

from .clock import SleepDetector
from .db import iso, open_db, parse_iso, tx, utcnow
from .paths import Paths
from .statemachine import Deps

log = logging.getLogger(__name__)

LEASE_NAME = "daemon"
# Renewed once per loop, so it must outlast the longest tick (Claude calls + one render can take
# several minutes). A crashed holder is detected by its dead pid, so a long TTL never delays restart.
LEASE_TTL = timedelta(minutes=30)
INTERVAL_S = 60.0
POLL_TIMEOUT_S = 50
POLL_ERROR_BACKOFF_S = (5, 15, 60, 300)
WOKE_MIN_S = 1800.0      # a short lid-close is not a "wake": no card re-send / welcome message


class AlreadyRunning(RuntimeError):
    pass


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def acquire_lease(conn: sqlite3.Connection, now: datetime, pid: int | None = None, name: str = LEASE_NAME,
                  alive: Callable[[int], bool] = _pid_alive) -> bool:
    """Take the lease if it is free, expired, ours, or held by a dead pid."""
    pid = pid or os.getpid()
    with tx(conn):
        row = conn.execute("SELECT pid, expires_at FROM leases WHERE name = ?", (name,)).fetchone()
        if row and row["pid"] != pid and parse_iso(row["expires_at"]) > now and alive(row["pid"]):
            return False
        conn.execute("INSERT INTO leases(name, pid, expires_at) VALUES (?,?,?) ON CONFLICT(name) DO UPDATE SET"
                     " pid = excluded.pid, expires_at = excluded.expires_at", (name, pid, iso(now + LEASE_TTL)))
    return True


def release_lease(conn: sqlite3.Connection, pid: int | None = None, name: str = LEASE_NAME) -> None:
    conn.execute("DELETE FROM leases WHERE name = ? AND pid = ?", (name, pid or os.getpid()))


def setup_logging(paths: Paths) -> None:
    paths.logs_dir.mkdir(parents=True, exist_ok=True)
    h = logging.handlers.RotatingFileHandler(paths.logs_dir / "ksm.log", maxBytes=5_000_000, backupCount=3,
                                             encoding="utf-8")
    h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.addHandler(h)
    # httpx logs every request URL at INFO; the Telegram Bot API puts the bot token in the URL path.
    for noisy in ("httpx", "httpcore", "anthropic", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


class Daemon:
    def __init__(self, paths: Paths, deps: Deps, *, interval_s: float = INTERVAL_S,
                 clock: Callable[[], datetime] = utcnow, poll: bool = True):
        self.paths = paths
        self.deps = deps
        self.interval_s = interval_s
        self.clock = clock
        self.poll = poll
        self.stop = threading.Event()
        self.wake = threading.Event()
        self.decisions: queue.Queue = queue.Queue()
        deps.decisions = self.decisions
        self.sleep = SleepDetector()
        self._poller: threading.Thread | None = None

    # ── Telegram poller thread ────────────────────────────────────────────────

    def _poll_loop(self) -> None:
        from .approve import poll_once, prune_updates  # lazy: approve module

        conn = open_db(self.paths.db)
        errors = 0
        try:
            while not self.stop.is_set():
                try:
                    tg = self.deps.client("telegram")
                    got = poll_once(conn, tg, timeout=POLL_TIMEOUT_S)
                    errors = 0
                    for d in got:
                        self.decisions.put(d)
                    if got:
                        self.wake.set()
                    prune_updates(conn)
                except Exception as e:   # noqa: BLE001 - network blips, missing token: keep trying
                    errors += 1
                    delay = POLL_ERROR_BACKOFF_S[min(errors - 1, len(POLL_ERROR_BACKOFF_S) - 1)]
                    log.warning("telegram poll failed (%s); retrying in %ss", type(e).__name__, delay)
                    self.stop.wait(delay)
        finally:
            conn.close()

    # ── main loop ─────────────────────────────────────────────────────────────

    def _handle_signal(self, signum: int, _frame: object) -> None:
        log.info("signal %s: stopping after the current tick", signum)
        self.stop.set()
        self.wake.set()

    def run(self, *, max_ticks: int | None = None) -> int:
        from .reconcile import tick

        conn = open_db(self.paths.db)
        if not acquire_lease(conn, self.clock()):
            conn.close()
            raise AlreadyRunning("another ksm daemon holds the lease")
        prev_handlers = {}
        if threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGTERM, signal.SIGINT):
                prev_handlers[sig] = signal.signal(sig, self._handle_signal)
        if self.poll:
            self._poller = threading.Thread(target=self._poll_loop, name="tg-poller", daemon=True)
            self._poller.start()
        ticks = 0
        log.info("ksm daemon started (pid %s, dry_run=%s)", os.getpid(), self.deps.settings.dry_run)
        try:
            while not self.stop.is_set():
                now = self.clock()
                if not acquire_lease(conn, now):
                    log.error("lost the daemon lease to another process; exiting")
                    return 1
                slept = self.sleep.check()
                try:
                    tick(conn, self.deps, now, woke=slept >= WOKE_MIN_S, slept_s=slept or None)
                except Exception:   # noqa: BLE001 - never die on one bad tick; launchd would restart-loop
                    log.exception("tick failed")
                ticks += 1
                if max_ticks is not None and ticks >= max_ticks:
                    break
                self.wake.wait(self.interval_s)
                self.wake.clear()
        finally:
            self.stop.set()
            for sig, h in prev_handlers.items():
                signal.signal(sig, h)
            release_lease(conn)
            conn.close()
            if self._poller is not None:
                self._poller.join(timeout=2)
            log.info("ksm daemon stopped")
        return 0


def main(paths: Paths, settings) -> int:  # noqa: ANN001 - Settings
    setup_logging(paths)
    paths.ensure()
    d = Daemon(paths, Deps.real(settings, paths))
    try:
        return d.run()
    except AlreadyRunning as e:
        log.error("%s", e)
        time.sleep(5)   # launchd ThrottleInterval also limits restarts
        return 0
