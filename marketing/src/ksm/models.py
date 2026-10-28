"""Shared data types passed between pipeline stages.

The script schema (VideoScript) is a pydantic model so the Claude writer can
request it as structured output and every later stage can rely on its shape.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from enum import StrEnum
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

# ── Enumerations ──────────────────────────────────────────────────────────────


class SlotKind(StrEnum):
    FRESH = "fresh"
    ADVISORY = "advisory"


class SlotState(StrEnum):
    OPEN = "open"
    FILLED = "filled"
    MISSED = "missed"
    SKIPPED = "skipped"


class VideoState(StrEnum):
    PLANNED = "PLANNED"
    DATA_READY = "DATA_READY"
    SCRIPTED = "SCRIPTED"
    CHECKED = "CHECKED"
    VOICED = "VOICED"
    RENDERED = "RENDERED"
    QA_PASSED = "QA_PASSED"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    APPROVED = "APPROVED"
    PUBLISHING = "PUBLISHING"
    DONE = "DONE"
    PARTIAL = "PARTIAL"            # some platforms published, others FATAL/EXPIRED
    NEEDS_REDO = "NEEDS_REDO"
    BLOCKED = "BLOCKED"            # a check failed after max redos; founder notified
    REJECTED = "REJECTED"          # founder tapped skip
    EXPIRED = "EXPIRED"            # stale before approval / publish
    MISSED = "MISSED"


TERMINAL_VIDEO_STATES = frozenset(
    {VideoState.DONE, VideoState.PARTIAL, VideoState.BLOCKED, VideoState.REJECTED,
     VideoState.EXPIRED, VideoState.MISSED}
)


class Platform(StrEnum):
    YOUTUBE = "yt"
    INSTAGRAM = "ig"
    FACEBOOK = "fb"


class PubState(StrEnum):
    PENDING = "PENDING"
    UPLOADING = "UPLOADING"
    UPLOADED = "UPLOADED"          # bytes delivered; remote id known
    SCHEDULED = "SCHEDULED"        # platform will publish at scheduled_for (yt/fb)
    PUBLISH_DUE = "PUBLISH_DUE"    # ig container FINISHED, waiting for the slot
    PUBLISHED = "PUBLISHED"
    VERIFIED = "VERIFIED"          # read back as public after the slot
    RETRY = "RETRY"
    FATAL = "FATAL"
    SKIPPED = "SKIPPED"
    EXPIRED = "EXPIRED"


class ApprovalStatus(StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    SUPERSEDED = "superseded"


# ── Planning ──────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Slot:
    id: str                    # e.g. "2026-10-17@fresh"
    slot_date: date            # IST calendar date of publication
    kind: SlotKind
    publish_at: datetime       # tz-aware UTC
    produce_from: datetime     # tz-aware UTC
    approve_by: datetime       # tz-aware UTC
    late_until: datetime       # tz-aware UTC


@dataclass
class VideoPlan:
    series: str                # key in config/series.yaml
    topic_key: str             # dedupe key within the series, e.g. "soybean-msp-gap"
    data_date: date | None     # the date the data describes (None for evergreen)
    evergreen: bool
    time_sensitive: bool
    fresh_until: datetime | None   # UTC; after this the video must not be published
    payload: dict = field(default_factory=dict)  # every number/fact the script may use


# ── Script (Claude structured output) ─────────────────────────────────────────

VisualKind = Literal["title", "mandi_bars", "msp_compare", "illustration", "step_card", "checklist", "broll", "end_card"]


class Visual(BaseModel):
    kind: VisualKind
    asset_id: str | None = Field(None, description="Brand illustration id from the allow-list, or Pexels clip id for broll")
    data_ref: str | None = Field(None, description="Key into the payload for data cards, e.g. 'commodities[0]'")


class Hook(BaseModel):
    voice_mr: str = Field(description="Spoken Marathi hook, one short sentence, Devanagari only")
    onscreen_mr: str = Field(description="Big on-screen hook text, max ~22 graphemes per line, max 2 lines")


class Segment(BaseModel):
    voice_mr: str = Field(description="Spoken Marathi for this segment, <= 220 characters, Devanagari, numbers with commas")
    onscreen_mr: str = Field(description="Short on-screen label/headline for the segment (not the caption)")
    visual: Visual


class PlatformText(BaseModel):
    title: str = ""
    description: str = ""
    caption: str = ""
    hashtags: list[str] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)


class Claim(BaseModel):
    kind: Literal["number", "date", "fact", "advice"]
    text_mr: str
    value: str | None = Field(None, description="The literal number/date as written, if any")
    unit: str | None = None
    data_ref: str | None = Field(None, description="Payload key the number comes from")
    source_url: str | None = Field(None, description="Official source URL for facts/dates not in the payload")


class PlatformBundle(BaseModel):
    yt: PlatformText
    ig: PlatformText
    fb: PlatformText


class VideoScript(BaseModel):
    hook: Hook
    segments: list[Segment] = Field(min_length=3, max_length=7)
    cta_mr: str
    platform: PlatformBundle
    claims: list[Claim]
    chemicals_mentioned_en: list[str] = Field(default_factory=list, description="Must be empty: no pesticide/fertiliser names")
    sources_onscreen_mr: str = Field(description="Short on-screen source line, e.g. 'स्रोत: Agmarknet / data.gov.in · 16 ऑक्टो 2026'")

    def narration(self) -> list[str]:
        """All spoken text in order (hook first)."""
        return [self.hook.voice_mr, *[s.voice_mr for s in self.segments], self.cta_mr]


# ── Checks ────────────────────────────────────────────────────────────────────


@dataclass
class Issue:
    code: str                  # e.g. "number_not_in_payload", "chemical_mentioned"
    message: str
    blocking: bool = True
    where: str = ""            # e.g. "segments[2].voice_mr"


@dataclass
class CheckReport:
    issues: list[Issue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(i.blocking for i in self.issues)

    def extend(self, other: "CheckReport") -> "CheckReport":
        self.issues.extend(other.issues)
        return self

    def feedback(self) -> str:
        """Plain-text feedback to hand back to the writer on a redo."""
        return "\n".join(f"- [{i.code}] {i.where}: {i.message}" for i in self.issues if i.blocking)


# ── Voice / render ────────────────────────────────────────────────────────────


@dataclass
class SentenceAudio:
    text: str
    wav: Path
    duration_s: float
    segment_index: int         # -1 = hook, len(segments) = CTA


@dataclass
class Timeline:
    sentences: list[SentenceAudio]
    gap_s: float
    narration_wav: Path        # all sentences concatenated with gaps, 48 kHz

    @property
    def total_s(self) -> float:
        if not self.sentences:
            return 0.0
        return sum(s.duration_s for s in self.sentences) + self.gap_s * (len(self.sentences) - 1)


@dataclass
class RenderOutputs:
    master: Path
    preview: Path
    cover: Path
    ass: Path
    duration_s: float


@dataclass
class QAReport:
    ok: bool
    problems: list[str] = field(default_factory=list)
    probe: dict = field(default_factory=dict)


# ── Approval decisions ────────────────────────────────────────────────────────


@dataclass
class Decision:
    approval_id: int
    action: Literal["approve", "post_now", "skip", "redo", "toggle_platform", "edit"]
    platforms: tuple[str, ...] = ()
    reason: str = ""
    edit_field: str | None = None
    edit_value: str | None = None
