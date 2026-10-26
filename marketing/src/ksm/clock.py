"""Time handling: IST slot maths, YouTube's Pacific quota day, and sleep detection.

Rules: the DB stores UTC; slots are defined in IST (no DST); YouTube's daily
quota resets at midnight America/Los_Angeles (which has DST).
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import date, datetime, time as dtime, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import Settings, SlotWindow
from .models import Slot, SlotKind

IST = ZoneInfo("Asia/Kolkata")
PACIFIC = ZoneInfo("America/Los_Angeles")

_REL = re.compile(r"^\s*([+-]?\d+)d\s+(\d{1,2}):(\d{2})\s*$")


def to_ist(dt: datetime) -> datetime:
    return dt.astimezone(IST)


def ist_date(dt: datetime) -> date:
    return to_ist(dt).date()


def at_ist(d: date, hhmm: str) -> datetime:
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime.combine(d, dtime(h, m), tzinfo=IST).astimezone(timezone.utc)


def relative_ist(d: date, rel: str) -> datetime:
    """'-1d 20:30' relative to slot date d -> UTC datetime."""
    m = _REL.match(rel)
    if not m:
        raise ValueError(f"bad relative time {rel!r}; expected like '-1d 20:30'")
    days, hh, mm = int(m.group(1)), int(m.group(2)), int(m.group(3))
    return at_ist(d + timedelta(days=days), f"{hh}:{mm:02d}")


def slot_id(d: date, kind: SlotKind | str) -> str:
    return f"{d.isoformat()}@{SlotKind(kind).value}"


def build_slot(d: date, w: SlotWindow) -> Slot:
    kind = SlotKind(w.kind)
    return Slot(
        id=slot_id(d, kind),
        slot_date=d,
        kind=kind,
        publish_at=at_ist(d, w.publish_time),
        produce_from=relative_ist(d, w.produce_from),
        approve_by=relative_ist(d, w.approve_by),
        late_until=relative_ist(d, w.late_until),
    )


def upcoming_slots(now: datetime, settings: Settings, horizon: timedelta = timedelta(hours=48)) -> list[Slot]:
    """Slots whose late_until is still ahead and whose publish time is within the horizon."""
    out: list[Slot] = []
    start = ist_date(now) - timedelta(days=1)
    for offset in range(0, 4):
        d = start + timedelta(days=offset)
        for w in settings.slots:
            s = build_slot(d, w)
            if s.late_until > now and s.publish_at <= now + horizon:
                out.append(s)
    return sorted(out, key=lambda s: s.publish_at)


def in_quiet_hours(now: datetime, quiet: tuple[str, str]) -> bool:
    """quiet=('22:30','05:30') wraps midnight."""
    t = to_ist(now).time()
    start = dtime(*(int(x) for x in quiet[0].split(":")))
    end = dtime(*(int(x) for x in quiet[1].split(":")))
    if start <= end:
        return start <= t < end
    return t >= start or t < end


def next_youtube_quota_reset(now: datetime) -> datetime:
    """Next midnight America/Los_Angeles, returned in UTC (DST-aware)."""
    local = now.astimezone(PACIFIC)
    nxt = datetime.combine(local.date() + timedelta(days=1), dtime(0, 0), tzinfo=PACIFIC)
    return nxt.astimezone(timezone.utc)


@dataclass
class SleepDetector:
    """Detects that the Mac slept: on macOS time.monotonic() does not advance during sleep,
    so a jump in wall-clock time that monotonic time does not share means we were asleep."""

    threshold_s: float = 120.0
    _wall: float | None = None
    _mono: float | None = None

    def check(self, wall: float | None = None, mono: float | None = None) -> float:
        """Returns seconds slept since the previous check (0 if none)."""
        wall = time.time() if wall is None else wall
        mono = time.monotonic() if mono is None else mono
        slept = 0.0
        if self._wall is not None and self._mono is not None:
            gap = (wall - self._wall) - (mono - self._mono)
            if gap > self.threshold_s:
                slept = gap
        self._wall, self._mono = wall, mono
        return slept
