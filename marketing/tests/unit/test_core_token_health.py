"""Daily token health check: runs once per IST day and turns failures into alerts."""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from ksm import doctor, reconcile
from ksm.daemon import setup_logging
from ksm.doctor import CheckResult
from ksm.statemachine import Deps


def _results(ok: bool):
    return [CheckResult("youtube channels.list", ok, "x", "ksm auth-youtube"),
            CheckResult("telegram getMe", False, "ignored", "")]


def test_runs_once_per_day_and_alerts(conn, ksm_home, settings, monkeypatch):
    calls = []
    monkeypatch.setattr(doctor, "live_checks", lambda s, http: calls.append(1) or _results(False))
    deps = Deps(settings=settings, paths=ksm_home)
    now = datetime(2026, 10, 17, 3, 0, tzinfo=timezone.utc)
    failed = reconcile.token_health(conn, deps, now)
    assert failed and "youtube" in failed[0]
    assert reconcile.token_health(conn, deps, now + timedelta(hours=2)) == []      # same IST day
    assert len(calls) == 1
    alerts = conn.execute("SELECT json FROM events WHERE kind='alert'").fetchall()
    assert len(alerts) == 1 and "telegram" not in alerts[0]["json"]
    reconcile.token_health(conn, deps, now + timedelta(days=1))
    assert len(calls) == 2


def test_httpx_logging_quiet(ksm_home):
    setup_logging(ksm_home)
    assert logging.getLogger("httpx").level == logging.WARNING
