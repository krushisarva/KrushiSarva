"""PERF-013: synchronous Redis work must not run on the event loop.

Every FastAPI Redis client is the synchronous redis-py library, and the scan,
chat, soil-OCR and alert handlers are `async def`. A blocking call made inline
there freezes every request on the process for one Redis round trip, or for a
whole connect timeout when Redis is down. The routes now hand those calls to
run_in_threadpool.

These tests swap the Redis-backed helpers for fakes that record which thread they
ran on and then sleep, and check two things: the helper did not run on the
loop's thread, and a coroutine ticking on the loop kept advancing while it slept.
They also check that a 402 raised inside the threadpool still reaches the client
as a 402, and that the in-memory spend mirror stays atomic across threads.
"""
import asyncio
import hashlib
import hmac
import importlib
import json
import threading
import time

import httpx
import pytest
from fastapi import FastAPI, HTTPException

_BLOCK_SEC = 0.25


def _scan_app():
    from routes import scan
    app = FastAPI()
    app.include_router(scan.router)
    return scan, app


def _fake(state, record, name, result):
    """A stand-in for a sync Redis helper: records its thread, blocks, and
    counts how far the loop's ticker moved while it was blocking."""
    def fake(*args, **kwargs):
        start = state["ticks"]
        record[name] = {"thread": threading.get_ident()}
        time.sleep(_BLOCK_SEC)
        record[name]["ticks_during"] = state["ticks"] - start
        if isinstance(result, Exception):
            raise result
        return result
    return fake


def _drive(app, state, method, path, **kwargs):
    """Send one request in-process while a ticker runs on the same loop."""
    async def main():
        state["loop_thread"] = threading.get_ident()

        async def ticker():
            while not state["stop"]:
                await asyncio.sleep(0.01)
                state["ticks"] += 1

        task = asyncio.create_task(ticker())
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.request(method, path, **kwargs)
        state["stop"] = True
        await task
        return resp

    return asyncio.run(main())


def _assert_off_loop(record, state, names):
    for name in names:
        assert name in record, f"{name} was not called"
        assert record[name]["thread"] != state["loop_thread"], f"{name} ran on the event loop"
        assert record[name]["ticks_during"] >= 3, f"event loop stalled while {name} blocked"


def test_scan_poll_runs_redis_lookups_off_the_loop(monkeypatch):
    monkeypatch.setenv("AI_AUTH_REQUIRED", "false")
    scan, app = _scan_app()
    state = {"ticks": 0, "stop": False}
    record = {}

    monkeypatch.setattr(scan, "get_job_owner", _fake(state, record, "owner", "u1"))
    monkeypatch.setattr(scan, "get_job_status", _fake(
        state, record, "status", {"status": "done", "data": {"r": 1}, "error": None}))
    monkeypatch.setattr(scan, "get_job_idem_key",
                        _fake(state, record, "idem_key", "idem:scan:u:u1:hdr:k"))
    monkeypatch.setattr(scan.idempotency, "set", _fake(state, record, "idem_set", None))

    resp = _drive(app, state, "GET", "/ai/scan/job-1234", headers={"x-user-id": "u1"})

    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "done"
    _assert_off_loop(record, state, ("owner", "status", "idem_key", "idem_set"))


def _submit(monkeypatch, cap_result):
    """POST /ai/scan as a correctly signed request, every Redis helper faked."""
    secret = "test-secret-perf013"
    monkeypatch.setenv("AI_AUTH_REQUIRED", "true")
    monkeypatch.setenv("AI_SHARED_SECRET", secret)
    scan, app = _scan_app()
    import security.auth as auth

    state = {"ticks": 0, "stop": False}
    record = {}
    monkeypatch.setattr(auth, "_is_replay", _fake(state, record, "replay", False))
    monkeypatch.setattr(scan, "check_under_cap", _fake(state, record, "cap", cap_result))
    monkeypatch.setattr(scan.idempotency, "get", _fake(state, record, "idem_get", None))
    monkeypatch.setattr(scan, "lookup_job_for_key", _fake(state, record, "lookup", None))
    monkeypatch.setattr(scan, "enqueue_diagnosis", _fake(state, record, "enqueue", "job-xyz"))

    body = json.dumps({
        "images": [{"data": "aGVsbG8=", "mime_type": "image/jpeg", "type": "leaf"}],
        "params": {"crop_name": "tomato"},
    }).encode("utf-8")
    ts = str(int(time.time()))
    msg = f"{ts}.POST./ai/scan.{hashlib.sha256(body).hexdigest()}".encode("utf-8")
    headers = {
        "x-sig-timestamp": ts,
        "x-sig-signature": hmac.new(secret.encode(), msg, hashlib.sha256).hexdigest(),
        "x-user-id": "u1",
        "idempotency-key": "op-1",
        "content-type": "application/json",
    }
    resp = _drive(app, state, "POST", "/ai/scan", content=body, headers=headers)
    return resp, record, state


def test_scan_submit_runs_redis_work_off_the_loop(monkeypatch):
    resp, record, state = _submit(monkeypatch, cap_result=None)

    assert resp.status_code == 200, resp.text
    assert resp.json() == {"success": True, "job_id": "job-xyz", "status": "queued"}
    _assert_off_loop(record, state, ("replay", "cap", "idem_get", "lookup", "enqueue"))


def test_spend_cap_402_from_the_threadpool_is_still_a_402(monkeypatch):
    over = HTTPException(status_code=402, detail={"code": "daily_cap_reached"})
    resp, record, _ = _submit(monkeypatch, cap_result=over)

    assert resp.status_code == 402, resp.text
    assert "enqueue" not in record


def test_concurrent_in_memory_reserves_cannot_double_pass_the_cap(monkeypatch):
    """The routes now reach spend from several threads. On the in-memory path a
    reserve is a read-then-write; two threads interleaving there would both see
    the same pre-reserve total and both pass."""
    monkeypatch.setenv("DAILY_SPEND_CAP_USD", "1.00")
    monkeypatch.setenv("SPEND_CAP_ENABLED", "true")
    monkeypatch.delenv("RATE_LIMIT_STORAGE_URI", raising=False)
    monkeypatch.delenv("REDIS_URL", raising=False)
    import security.spend as spend
    importlib.reload(spend)
    spend._MEM.clear()

    n = 40
    barrier = threading.Barrier(n)
    allowed = []
    lock = threading.Lock()

    def worker():
        barrier.wait()
        try:
            spend.check_under_cap("race-user", reserve=0.30)
        except HTTPException:
            return
        with lock:
            allowed.append(1)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # 0.00, 0.30, 0.60 and 0.90 are each under the 1.00 cap; 1.20 is not.
    assert len(allowed) == 4
    assert spend.get_used("race-user") == pytest.approx(1.20)
