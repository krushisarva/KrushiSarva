"""Script/payload builders shared by the test_checks_* files."""
from __future__ import annotations

from datetime import date

from ksm.models import (Claim, Hook, PlatformBundle, PlatformText, Segment, VideoScript, Visual)


def mandi_payload() -> dict:
    return {
        "data_date": "2026-10-15",
        "source": "Agmarknet / data.gov.in, Government of India",
        "commodities": [{
            "key": "soybean", "name_mr": "सोयाबीन", "msp": 5328, "msp_label": "MSP 2026-27",
            "markets": [
                {"market": "Latur", "market_mr": "लातूर", "district": "Latur", "modal": 4892.0, "min": 4600, "max": 5011},
                {"market": "Akola", "market_mr": "अकोला", "district": "Akola", "modal": 4750, "min": 4500, "max": 4900},
                {"market": "Washim", "market_mr": "वाशिम", "district": "Washim", "modal": 4810, "min": 4550, "max": 4950},
            ],
            "median_modal": 4810, "vs_msp_pct": -9.722222, "prev_median_modal": None,
        }],
        "as_of": date(2026, 10, 15),
    }


def make_script(**over) -> VideoScript:
    """A clean, passing mandi script. Override any top-level field with kwargs."""
    segs = [
        Segment(voice_mr="लातूर बाजारात सोयाबीनचा सरासरी भाव ४,८९२ रुपये प्रति क्विंटल होता.",
                onscreen_mr="लातूर ₹४,८९२", visual=Visual(kind="mandi_bars", data_ref="commodities[0]")),
        Segment(voice_mr="अकोला येथे ₹4,750 आणि वाशिम येथे 4810 रुपये.",
                onscreen_mr="अकोला · वाशिम", visual=Visual(kind="mandi_bars")),
        Segment(voice_mr="हमीभाव ५,३२८ रुपये आहे, म्हणजे बाजारभाव सुमारे ९.७% कमी आहे.",
                onscreen_mr="हमीभावापेक्षा ९.७% कमी", visual=Visual(kind="msp_compare")),
    ]
    base = dict(
        hook=Hook(voice_mr="आज सोयाबीनचा भाव किती?", onscreen_mr="सोयाबीन भाव\n१५ ऑक्टोबर"),
        segments=segs,
        cta_mr="पीक सल्ल्यासाठी कृषी विज्ञान केंद्र किंवा किसान कॉल सेंटर 1800-180-1551 वर संपर्क करा. नक्की शेअर करा.",
        platform=PlatformBundle(
            yt=PlatformText(title="सोयाबीन बाजारभाव 15 ऑक्टोबर 2026 | Soybean rate Latur",
                            description="Agmarknet / data.gov.in आकडेवारी. AI आवाज.",
                            hashtags=["#Shorts", "#शेतकरी"], tags=["soybean", "मंडी भाव", "latur"]),
            ig=PlatformText(caption="सोयाबीन भाव #शेतकरी", hashtags=["#शेती", "#बाजारभाव"]),
            fb=PlatformText(caption="सोयाबीन भाव, स्रोत Agmarknet"),
        ),
        claims=[Claim(kind="number", text_mr="लातूर भाव", value="4892", data_ref="commodities[0].markets[0].modal")],
        sources_onscreen_mr="स्रोत: Agmarknet / data.gov.in · 15 ऑक्टो 2026",
    )
    base.update(over)
    return VideoScript(**base)


def with_segment_voice(text: str, index: int = 0, **over) -> VideoScript:
    s = make_script(**over)
    s.segments[index].voice_mr = text
    return s


def codes(report) -> list[str]:
    return [i.code for i in report.issues]


def blocking_codes(report) -> list[str]:
    return [i.code for i in report.issues if i.blocking]
