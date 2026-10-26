"""Structured-output schemas for the fact-checker, plus the Marathi glossary.

The writer's own output schema is ``ksm.models.VideoScript``. The glossary is a
curated snapshot of the app's Marathi strings (shared/i18n/translations.js, `mr`
block) rather than a runtime parse of that file: the background agent cannot read
the repo (macOS TCC blocks ~/Desktop), and several app strings must NOT be reused
(placeholder helplines '1800-XXX-XXXX', the dead 'AI अंदाज' price-prediction feature,
and the inconsistent 'मंडी भाव' / 'मंडई भाव' — we standardise on 'बाजारभाव').
"""
from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field

# ── Fact-check structured output ──────────────────────────────────────────────


class ClaimVerdict(BaseModel):
    idx: int = Field(description="Index into script.claims")
    verdict: Literal["supported", "unsupported", "unverifiable"]
    evidence_url: str | None = Field(
        None, description="Official URL that supports the claim, or 'payload:<key>' when the payload supports it"
    )
    quote: str | None = Field(None, description="Exact supporting text or payload value, verbatim")
    note: str | None = Field(None, description="Why unsupported/unverifiable, one short sentence")


class MarathiIssue(BaseModel):
    where: str = Field(description="Field path, e.g. 'segments[2].voice_mr' or 'platform.yt.title'")
    problem: str
    fix: str = Field(description="The corrected Marathi text for that field or phrase")
    severity: Literal["low", "medium", "high"]


class PolicyFlag(BaseModel):
    where: str
    rule: Literal[
        "chemical_or_dose", "price_prediction", "unsourced_date", "politics",
        "income_or_yield_guarantee", "download_cta", "ai_disclosure_missing",
        "misleading_hook", "other",
    ]
    detail: str


class FactCheckReport(BaseModel):
    claims: list[ClaimVerdict]
    marathi_issues: list[MarathiIssue] = Field(default_factory=list)
    policy_flags: list[PolicyFlag] = Field(default_factory=list)
    overall: Literal["pass", "fix", "fail"]


# ── Glossary ──────────────────────────────────────────────────────────────────

# Terms the writer must use consistently. Keys are stable identifiers; values are
# what goes in the script. Sources: translations.js `mr` block unless noted.
GLOSSARY: dict[str, str] = {
    "brand_onscreen": "KrushiSarva",            # appName — Latin everywhere on screen
    "brand_voice": "कृषीसर्व",                  # spoken form; pending founder confirmation (plan §1.11)
    "mandi_prices": "बाजारभाव",                 # standardised (app mixes 'मंडी भाव' / 'मंडई भाव')
    "market_committee": "बाजार समिती",          # APMC
    "msp_voice": "हमीभाव",                      # spoken; on screen 'हमीभाव (MSP)'
    "msp_onscreen": "हमीभाव (MSP)",
    "msp_long": "किमान आधारभूत किंमत",           # market.mspInfo
    "per_quintal": "प्रति क्विंटल",
    "modal_price": "सरासरी भाव",                 # modal price as farmers say it
    "farmer": "शेतकरी",
    "taluka": "तालुका",
    "district": "जिल्हा",
    "village": "गाव",
    "weather": "हवामान",                        # tabWeather
    "govt_schemes": "सरकारी योजना",             # govSchemes
    "my_farm": "माझे शेत",                      # myFarm.tabLabel
    "crop_scan": "कृषी दृष्टी",                 # ai.drishti
    "kvk": "कृषी विज्ञान केंद्र (KVK)",
    "agri_officer": "तालुका कृषी अधिकारी",
    "kisan_call_centre": "किसान कॉल सेंटर: 1800-180-1551 (मोफत)",
    "crop_health_disclaimer": (                 # diagnosis.disclaimer, minus 'AI निदान' (we don't diagnose)
        "हा सल्ला फक्त माहितीसाठी आहे. महत्त्वाच्या निर्णयांसाठी स्थानिक कृषी तज्ज्ञाकडून पुष्टी करा. "
        "किसान कॉल सेंटर: 1800-180-1551 (मोफत)."
    ),
    "avoid_spraying": "फवारणी टाळा",
    "ai_voice_tag": "AI आवाज",
    "ai_voice_disclosure": "आवाज: AI (Sarvam)",
    "cta_follow": "फॉलो करा",
    "cta_share_voice": "गावाच्या व्हॉट्सॲप ग्रुपवर पाठवा",
    "cta_share_onscreen": "गावाच्या WhatsApp ग्रुपवर पाठवा",
    "cta_comment_taluka": "तुमचा तालुका कमेंट करा",
    "source_prefix": "स्रोत",
}

# Strings from the app that must never appear in marketing copy.
GLOSSARY_BLOCKLIST: tuple[str, ...] = ("1800-XXX-XXXX", "AI अंदाज", "मंडी भाव", "मंडई भाव")


def _name(v: object) -> str | None:
    if isinstance(v, str):
        return v.strip() or None
    if isinstance(v, dict):
        n = v.get("name_mr") or v.get("mr")
        return n.strip() if isinstance(n, str) and n.strip() else None
    return None


def build_glossary(config_dir: Path | None = None) -> dict[str, str]:
    """Glossary for the writer prompt: the curated terms plus crop/market names.

    crops_mr.yaml / markets_mr.yaml are optional. Entries may be ``key: "मराठी"`` or
    ``key: {name_mr|mr: "मराठी", ...}``, either at the top level or inside named sections
    (``commodities:``, ``names_mr:``, ``markets:``). Anything else is ignored, not guessed.
    """
    out = dict(GLOSSARY)
    if config_dir is None:
        return out
    for fname, prefix in (("crops_mr.yaml", "crop"), ("markets_mr.yaml", "market")):
        p = Path(config_dir) / fname
        if not p.exists():
            continue
        data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        if not isinstance(data, dict):
            continue
        flat = any(_name(v) for v in data.values())
        sections = [data] if flat else [v for v in data.values() if isinstance(v, dict)]
        for section in sections:
            for k, v in section.items():
                if (name := _name(v)) is not None:
                    out[f"{prefix}:{k}"] = name
    return out
