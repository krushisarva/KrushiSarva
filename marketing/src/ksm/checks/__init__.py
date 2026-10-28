"""Deterministic script checks. They run before any paid step and block publishing.

Issue codes are stable strings (the writer's redo feedback and the Telegram card
both key on them):
  numbers:   number_not_in_payload, date_claim_bad_ref
  chemicals: chemicals_mentioned_en, chemical_banned, chemical_mentioned, chemical_mentioned_mr,
             fertiliser_mentioned, fertiliser_mentioned_mr, pesticide_class_mentioned, chemical_dose,
             chemical_alias_ambiguous (warn), dose_seed_rate (warn)
  rules:     price_prediction, prediction_word (warn), certainty_word, income_guarantee,
             political_reference, download_cta_without_url, wrong_helpline_number, date_claim_unsourced,
             sell_timing_advice
  limits:    yt_title_empty, yt_title_too_long, yt_description_too_long, yt_angle_brackets,
             yt_tags_too_long, too_many_hashtags, ig_caption_too_long, fb_caption_link,
             fb_caption_domain (warn), onscreen_too_many_lines, onscreen_line_too_long,
             source_line_too_long (warn), segment_voice_too_long, narration_too_long
"""
from __future__ import annotations

from collections.abc import Iterable

from ..models import CheckReport, VideoScript
from .chemicals import check_chemicals
from .limits import check_limits
from .numbers import check_numbers
from .rules import check_rules

__all__ = ["check_chemicals", "check_limits", "check_numbers", "check_rules", "run_deterministic"]


def run_deterministic(script: VideoScript, payload: dict, *, series: str, app_cta_url: str | None,
                      extra_allowed: Iterable[str] = frozenset()) -> CheckReport:
    """All deterministic checks in one report. `extra_allowed` (e.g. the slot date)
    is passed through to the number check."""
    report = CheckReport()
    report.extend(check_numbers(script, payload, extra_allowed))
    report.extend(check_chemicals(script))
    report.extend(check_rules(script, series=series, app_cta_url=app_cta_url))
    report.extend(check_limits(script))
    return report
