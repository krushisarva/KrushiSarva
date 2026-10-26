"""Platform and on-screen size limits.

These are hard API/rendering limits (a YouTube title over 100 characters is
rejected; an on-screen line over 22 graphemes overflows the safe area), so they
block. Graphemes are counted with the `regex` module's \\X because a Marathi
conjunct like 'क्ष' is several code points but one visible cluster.
"""
from __future__ import annotations

import regex

from ..models import CheckReport, Issue, VideoScript

YT_TITLE_MAX = 100              # characters
YT_DESCRIPTION_MAX_BYTES = 5000
YT_TAGS_TOTAL_MAX = 500         # YouTube counts quotes around multi-word tags and the separating commas
HASHTAGS_MAX = 5                # Instagram hard limit; Meta advises the same on Facebook
IG_CAPTION_MAX = 2200
ONSCREEN_LINE_MAX = 22          # graphemes
HOOK_ONSCREEN_LINES_MAX = 2
SEGMENT_VOICE_MAX = 220         # characters, see Segment.voice_mr
NARRATION_MAX = 750             # characters, all spoken text (~58 s at narration pace)
SOURCE_LINE_MAX = 70            # graphemes; small-type source line

_HASHTAG = regex.compile(r"#[\p{L}\p{M}\p{N}_]+")
_URL = regex.compile(r"https?://\S+|www\.\S+", regex.IGNORECASE)
_DOMAIN = regex.compile(r"\b[\w-]+(?:\.[\w-]+)*\.(?:com|in|org|net|gov|io|co|info|me|ly|be)\b(?:/\S*)?",
                        regex.IGNORECASE)


def graphemes(s: str) -> int:
    return len(regex.findall(r"\X", s))


def yt_tags_length(tags: list[str]) -> int:
    return sum(len(t) + (2 if " " in t else 0) for t in tags) + max(len(tags) - 1, 0)


def _hashtags(caption: str, listed: list[str]) -> set[str]:
    tags = {h.lower() for h in _HASHTAG.findall(caption)}
    tags |= {("#" + h.lstrip("#")).lower() for h in listed if h.strip("# ")}
    return tags


# Mirrors ksm.publish.common.AI_DISCLOSURE / with_hashtags / with_ai_disclosure (not imported:
# checks must not depend on the publisher). The limits apply to the text the API receives.
AI_DISCLOSURE = "निवेदन: AI आवाज"


def published_body(body: str, listed: list[str]) -> str:
    """Description/caption as the publisher sends it: missing listed hashtags appended
    after a blank line, then the AI disclosure if the body does not already carry it."""
    tags = [h if h.startswith("#") else f"#{h}" for h in listed]
    missing = [h for h in tags if h not in body]
    out = f"{body.rstrip()}\n\n{' '.join(missing)}".strip() if missing else body.strip()
    return out if "AI आवाज" in out else f"{out.rstrip()}\n\n{AI_DISCLOSURE}".strip()


def check_limits(script: VideoScript) -> CheckReport:
    report = CheckReport()

    def add(code: str, msg: str, where: str, blocking: bool = True) -> None:
        report.issues.append(Issue(code=code, message=msg, blocking=blocking, where=where))

    yt = script.platform.yt
    if not yt.title.strip():
        add("yt_title_empty", "YouTube title is required", "platform.yt.title")
    if len(yt.title) > YT_TITLE_MAX:
        add("yt_title_too_long", f"{len(yt.title)} chars > {YT_TITLE_MAX}", "platform.yt.title")
    yt_desc = published_body(yt.description, yt.hashtags)
    if (n := len(yt_desc.encode("utf-8"))) > YT_DESCRIPTION_MAX_BYTES:
        add("yt_description_too_long", f"{n} UTF-8 bytes (with hashtags and AI disclosure) > "
            f"{YT_DESCRIPTION_MAX_BYTES} (Devanagari is 3 bytes per code point)", "platform.yt.description")
    for field, value in (("title", yt.title), ("description", yt_desc)):
        if regex.search(r"[<>]", value):
            add("yt_angle_brackets", "YouTube rejects '<' and '>' in titles and descriptions",
                f"platform.yt.{field}")
    if (n := yt_tags_length(yt.tags)) > YT_TAGS_TOTAL_MAX:
        add("yt_tags_too_long", f"tags total {n} chars > {YT_TAGS_TOTAL_MAX}", "platform.yt.tags")

    for plat in ("ig", "fb"):
        pt = getattr(script.platform, plat)
        if (n := len(_hashtags(pt.caption, pt.hashtags))) > HASHTAGS_MAX:
            add("too_many_hashtags", f"{n} hashtags > {HASHTAGS_MAX}", f"platform.{plat}")
    ig = script.platform.ig
    if (n := len(published_body(ig.caption, ig.hashtags))) > IG_CAPTION_MAX:
        add("ig_caption_too_long", f"{n} chars (with hashtags and AI disclosure) > {IG_CAPTION_MAX}",
            "platform.ig.caption")
    fb = script.platform.fb
    if m := _URL.search(fb.caption):
        add("fb_caption_link", f"'{m.group(0)}': no links in the Facebook caption (reach penalty)",
            "platform.fb.caption")
    elif m := _DOMAIN.search(fb.caption):
        add("fb_caption_domain", f"'{m.group(0)}' may be auto-linked by Facebook; prefer the source name only",
            "platform.fb.caption", blocking=False)

    hook_lines = script.hook.onscreen_mr.split("\n")
    if len(hook_lines) > HOOK_ONSCREEN_LINES_MAX:
        add("onscreen_too_many_lines", f"{len(hook_lines)} lines > {HOOK_ONSCREEN_LINES_MAX}", "hook.onscreen_mr")
    onscreen = [("hook.onscreen_mr", script.hook.onscreen_mr),
                *((f"segments[{i}].onscreen_mr", s.onscreen_mr) for i, s in enumerate(script.segments))]
    for where, text in onscreen:
        for line in text.split("\n"):
            if (n := graphemes(line.strip())) > ONSCREEN_LINE_MAX:
                add("onscreen_line_too_long", f"'{line.strip()}' is {n} graphemes > {ONSCREEN_LINE_MAX}", where)
    if (n := graphemes(script.sources_onscreen_mr)) > SOURCE_LINE_MAX:
        add("source_line_too_long", f"{n} graphemes > {SOURCE_LINE_MAX}", "sources_onscreen_mr", blocking=False)

    for i, s in enumerate(script.segments):
        if len(s.voice_mr) > SEGMENT_VOICE_MAX:
            add("segment_voice_too_long", f"{len(s.voice_mr)} chars > {SEGMENT_VOICE_MAX}",
                f"segments[{i}].voice_mr")
    if (n := len(" ".join(script.narration()))) > NARRATION_MAX:
        add("narration_too_long", f"spoken text {n} chars > {NARRATION_MAX}", "narration")
    return report
