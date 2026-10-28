"""`ksm` command line."""
from __future__ import annotations

import argparse
import dataclasses
import getpass
import json
import os
import sys
import wave
from datetime import datetime
from pathlib import Path

from .paths import REPO_MARKETING_DIR, get_paths

SAMPLE_FIXTURE = REPO_MARKETING_DIR / "tests" / "fixtures" / "core_sample_video.json"


def _settings():
    from .config import get_settings
    return get_settings()


def _conn():
    from .db import open_db
    paths = get_paths().ensure()
    return open_db(paths.db)


# ── commands ──────────────────────────────────────────────────────────────────


def cmd_install(a: argparse.Namespace) -> int:
    from .install import install, next_steps

    res = install(get_paths().home, python=Path(a.python) if a.python else None, load=a.load)
    print(f"✓ installed into {res.home} ({len(res.copied)} files copied)")
    for s in res.skipped:
        print(f"! {s}")
    print(f"✓ plist written: {res.plist_path}")
    steps = next_steps(res)
    if steps:
        print("\nNext:")
        for s in steps:
            print(f"  {s}")
    return 0


def cmd_doctor(a: argparse.Namespace) -> int:
    from .doctor import format_results, run

    results = run(get_paths(), _settings(), live=a.live)
    print(format_results(results))
    return 1 if any(r.ok is False for r in results) else 0


def cmd_daemon(a: argparse.Namespace) -> int:
    from .daemon import main
    return main(get_paths().ensure(), _settings())


def _real_deps(settings=None):
    from .statemachine import Deps
    return Deps.real(settings or _settings(), get_paths().ensure())


def cmd_tick(a: argparse.Namespace, *, dry: bool = False) -> int:
    from .daemon import acquire_lease, release_lease
    from .db import utcnow
    from .reconcile import tick

    settings = _settings()
    if dry:
        settings = dataclasses.replace(settings, dry_run=True)
    conn = _conn()
    # Two concurrent ticks could both send a card or call a publisher for the same row, so a
    # manual tick takes the daemon's lease (and refuses while the daemon holds it).
    if not acquire_lease(conn, utcnow()):
        print("✗ the ksm daemon is running; stop it first "
              "(launchctl bootout gui/$(id -u)/com.krushisarva.marketing) or use `ksm report`")
        return 1
    try:
        rep = tick(conn, _real_deps(settings), utcnow(), woke=getattr(a, "woke", False))
    finally:
        release_lease(conn)
    print(json.dumps(dataclasses.asdict(rep), ensure_ascii=False, indent=1, default=str))
    return 0


def cmd_day0(a: argparse.Namespace) -> int:
    from .day0 import CHECKS, run

    if not a.yes:
        print("day0 sends real messages and makes small paid API calls. Checks:")
        for c in CHECKS:
            print(f"  - {c.name}: {c.description}")
        print("\nRe-run with --yes to run the automated ones.")
        return 2
    for name, status, detail in run(get_paths().ensure(), _settings(), yes=True):
        mark = {"ran": "✓", "failed": "✗", "skipped": "-", "manual": "☐"}[status]
        print(f"{mark} {name} [{status}] {detail}")
    return 0


def cmd_pair_telegram(a: argparse.Namespace) -> int:
    import time

    from .approve import TelegramClient, new_pair_code, owner, poll_once
    from .daemon import LEASE_NAME, _pid_alive
    from .db import parse_iso, utcnow
    from .secrets import get_secret

    conn = _conn()
    tg = TelegramClient(get_secret("telegram_bot_token"))
    me = tg.get_me()
    code = new_pair_code(conn)
    print(f"Send this from your phone to @{me.get('username')} within 15 minutes:\n\n    /start {code}\n")
    lease = conn.execute("SELECT pid, expires_at FROM leases WHERE name = ?", (LEASE_NAME,)).fetchone()
    if lease and parse_iso(lease["expires_at"]) > utcnow() and _pid_alive(lease["pid"]):
        print("The ksm daemon is running and will complete the pairing.")
        return 0
    deadline = time.monotonic() + a.wait
    while time.monotonic() < deadline:
        poll_once(conn, tg, timeout=25)
        uid, chat = owner(conn)
        if chat is not None:
            print(f"✓ paired with Telegram user {uid}")
            return 0
    print("✗ no /start received in time; run `ksm pair-telegram` again")
    return 1


def cmd_auth_youtube(a: argparse.Namespace) -> int:
    from .publish.oauth import auth_youtube

    want = ((_settings().raw or {}).get("youtube") or {}).get("channel_id")
    ch = auth_youtube(expected_channel_id=want)
    print(f"✓ YouTube authorised for {ch['title']} ({ch['id']})")
    return 0


def cmd_secrets(a: argparse.Namespace) -> int:
    from .secrets import KNOWN, has_secret, resolve_name, set_secret

    if a.action == "set":
        name = resolve_name(a.name)
        if name not in KNOWN:
            print(f"✗ unknown secret {a.name!r}; known: {', '.join(KNOWN)}")
            return 2
        if a.file:
            value = Path(a.file).expanduser().read_text(encoding="utf-8")
        else:
            value = getpass.getpass(f"{name}: ")
        set_secret(name, value)
        print(f"✓ {name} stored in the Keychain (service ks-marketing)")
        return 0
    names = [resolve_name(n) for n in a.names] or list(KNOWN)
    bad = 0
    for n in names:
        ok = has_secret(n)
        bad += not ok
        print(f"{'✓' if ok else '✗'} {n}" + ("" if ok else f"  → ksm secrets set {n}"))
    return 1 if bad else 0


def cmd_purge(a: argparse.Namespace) -> int:
    from .db import utcnow
    from .reconcile import purge

    n = purge(_conn(), get_paths(), utcnow(), aggressive=a.all)
    print(f"✓ removed {n} files/dirs")
    return 0


def cmd_report(a: argparse.Namespace) -> int:
    from .approve.cards import fmt_ist
    from .db import iso, utcnow
    from .guards import check
    from .ledger import month_of, month_spend

    settings, conn, now = _settings(), _conn(), utcnow()
    g = check(conn, settings, now=now)
    spent = month_spend(conn, month_of(now))
    print(f"Budget {month_of(now)}: ₹{spent:.0f} / ₹{settings.monthly_budget_inr:.0f} ({g.budget})"
          f" · disk {g.free_gb:.1f} GB · dry_run={settings.dry_run}")
    if g.reasons:
        print("Guards: " + "; ".join(g.reasons))
    print("\nSlots:")
    for s in conn.execute("SELECT * FROM slots WHERE late_until > ? ORDER BY publish_at LIMIT 8", (iso(now),)):
        print(f"  {s['id']:<22} {fmt_ist(s['publish_at'])}  {s['state']:<7} video={s['video_id'] or '-'}")
    print("\nVideos in flight:")
    for v in conn.execute("SELECT * FROM videos WHERE state NOT IN ('DONE','PARTIAL','BLOCKED','REJECTED','EXPIRED',"
                          "'MISSED') ORDER BY id"):
        print(f"  #{v['id']:<4} {v['series']:<11} {v['topic_key']:<28} {v['state']:<18} redo={v['redo_count']}"
              + (f"  error: {v['error'][:60]}" if v["error"] else ""))
    print("\nPending approvals:")
    for r in conn.execute("SELECT a.id, a.sent_at, r.video_id, r.rev_no FROM approvals a JOIN revisions r"
                          " ON r.id = a.revision_id WHERE a.status = 'pending' ORDER BY a.id"):
        print(f"  approval {r['id']} video #{r['video_id']} r{r['rev_no']} sent {fmt_ist(r['sent_at'])}")
    print("\nPublications not finished:")
    for p in conn.execute("SELECT * FROM publications WHERE state NOT IN ('VERIFIED','FATAL','SKIPPED','EXPIRED')"):
        print(f"  #{p['video_id']} {p['platform']} {p['state']} next={p['next_attempt_at'] or '-'}"
              + (f" err={p['last_error'][:60]}" if p["last_error"] else ""))
    print("\nRecent alerts:")
    for e in conn.execute("SELECT ts, json FROM events WHERE kind = 'alert' ORDER BY id DESC LIMIT 5"):
        print(f"  {fmt_ist(e['ts'])} {json.loads(e['json']).get('message', '')[:100]}")
    return 0


def _silent_timeline(script, out_dir: Path, rate: int = 48000):  # noqa: ANN001
    """A voice-free timeline (estimated sentence lengths) so a sample renders without Sarvam."""
    from .models import SentenceAudio, Timeline

    out_dir.mkdir(parents=True, exist_ok=True)
    parts = [(-1, script.hook.voice_mr), *[(i, s.voice_mr) for i, s in enumerate(script.segments)],
             (len(script.segments), script.cta_mr)]
    gap = 0.18
    sentences, frames = [], b""
    for n, (idx, text) in enumerate(parts):
        dur = max(1.2, len(text) / 14.0)
        pcm = b"\x00\x00" * int(dur * rate)
        p = out_dir / f"s{n:03d}.wav"
        with wave.open(str(p), "wb") as w:
            w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate), w.writeframes(pcm)
        sentences.append(SentenceAudio(text=text, wav=p, duration_s=dur, segment_index=idx))
        frames += pcm + (b"\x00\x00" * int(gap * rate) if n < len(parts) - 1 else b"")
    narration = out_dir / "narration.wav"
    with wave.open(str(narration), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate), w.writeframes(frames)
    return Timeline(sentences=sentences, gap_s=gap, narration_wav=narration)


def cmd_render_sample(a: argparse.Namespace) -> int:
    from .models import VideoPlan, VideoScript
    from .statemachine import Deps

    data = json.loads(Path(a.fixture).read_text(encoding="utf-8"))
    script = VideoScript.model_validate(data["script"])
    p = data["plan"]
    plan = VideoPlan(series=p["series"], topic_key=p["topic_key"], data_date=None, evergreen=p.get("evergreen", False),
                     time_sensitive=False, fresh_until=None, payload=p.get("payload") or {})
    paths = get_paths().ensure()
    out = Path(a.out) if a.out else paths.renders_dir / f"sample-{datetime.now():%Y%m%d-%H%M%S}"
    work = out / "work"
    deps = Deps(settings=_settings(), paths=paths)
    if a.voice:
        from .secrets import get_secret
        from .voice import SarvamTTS
        tl = deps.fn("synthesize")(script, SarvamTTS(get_secret("sarvam_api_key")), work / "voice")
    else:
        tl = _silent_timeline(script, work / "voice")
    res = deps.fn("render")(script, tl, plan, work, out, assets_dir=paths.assets_dir)
    print(f"✓ master  {res.master}\n✓ preview {res.preview}\n✓ cover   {res.cover}  ({res.duration_s:.1f} s)")
    qa = deps.fn("probe")(Path(res.master))
    print("✓ QA ok" if qa.ok else "✗ QA: " + "; ".join(qa.problems))
    return 0 if qa.ok else 1


# ── parser ────────────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="ksm", description="KrushiSarva marketing autopilot")
    ap.add_argument("--home", help="override KSM_HOME")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("install", help="copy config/assets into KSM_HOME and write the launchd plist")
    p.add_argument("--python", help="interpreter for the plist (default <KSM_HOME>/venv/bin/python)")
    p.add_argument("--load", action="store_true", help="also launchctl bootstrap the agent")
    p.set_defaults(fn=cmd_install)

    p = sub.add_parser("doctor", help="check the setup")
    p.add_argument("--live", action="store_true", help="also make one cheap call per external service")
    p.set_defaults(fn=cmd_doctor)

    sub.add_parser("daemon", help="run the agent (launchd runs this)").set_defaults(fn=cmd_daemon)

    p = sub.add_parser("tick", help="run one reconcile tick")
    p.add_argument("--woke", action="store_true", help="behave as if the Mac just woke")
    p.set_defaults(fn=cmd_tick)
    sub.add_parser("dryrun", help="one tick with publishers forced to dry-run").set_defaults(
        fn=lambda a: cmd_tick(a, dry=True))

    p = sub.add_parser("day0", help="one-time live tests (sends real messages; needs --yes)")
    p.add_argument("--yes", action="store_true")
    p.set_defaults(fn=cmd_day0)

    p = sub.add_parser("pair-telegram", help="pair your Telegram account with the bot")
    p.add_argument("--wait", type=int, default=900, help="seconds to wait for /start")
    p.set_defaults(fn=cmd_pair_telegram)

    sub.add_parser("auth-youtube", help="authorise the YouTube channel (as its owner)").set_defaults(fn=cmd_auth_youtube)

    p = sub.add_parser("secrets", help="Keychain secrets")
    ss = p.add_subparsers(dest="action", required=True)
    s = ss.add_parser("set")
    s.add_argument("name")
    s.add_argument("--file", help="read the value from a file (e.g. the Google OAuth client JSON)")
    s = ss.add_parser("check")
    s.add_argument("names", nargs="*")
    p.set_defaults(fn=cmd_secrets)

    p = sub.add_parser("purge", help="apply retention now")
    p.add_argument("--all", action="store_true", help="ignore the waiting periods (low disk)")
    p.set_defaults(fn=cmd_purge)

    sub.add_parser("report", help="print the queue and state").set_defaults(fn=cmd_report)

    p = sub.add_parser("render-sample", help="render the fixed sample video for golden review")
    p.add_argument("--fixture", default=str(SAMPLE_FIXTURE))
    p.add_argument("--voice", action="store_true", help="use Sarvam (default: silent narration)")
    p.add_argument("--out", help="output folder")
    p.set_defaults(fn=cmd_render_sample)
    return ap


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    if a.home:
        os.environ["KSM_HOME"] = str(Path(a.home).expanduser())
    try:
        return int(a.fn(a) or 0)
    except KeyboardInterrupt:
        return 130
    except Exception as e:   # noqa: BLE001 - one readable line, not a traceback, for the founder
        if os.environ.get("KSM_DEBUG"):
            raise
        print(f"✗ {type(e).__name__}: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
