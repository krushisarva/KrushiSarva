"""Shared fixtures for the voice/render tests (not collected: no test_ prefix)."""
from __future__ import annotations

import io
import math
import struct
import wave
from datetime import date
from pathlib import Path

from ksm.models import Hook, PlatformBundle, PlatformText, Segment, VideoPlan, VideoScript, Visual
from ksm.voice.timeline import synthesize

REPO_MARKETING = Path(__file__).resolve().parents[2]


def make_wav(duration_s: float, rate: int = 48000, channels: int = 1, freq: float = 220.0, amp: float = 0.3) -> bytes:
    n = int(round(duration_s * rate))
    frames = bytearray()
    for i in range(n):
        v = int(amp * 32767 * math.sin(2 * math.pi * freq * i / rate))
        frames += struct.pack("<h", v) * channels
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(frames))
    return buf.getvalue()


class FakeTTS:
    """Deterministic stand-in for SarvamTTS: duration = 0.06 s per character."""

    model, speaker, dict_id = "fake", "fake_mr_narration", None

    def __init__(self, sample_rate: int = 48000, per_char: float = 0.06, channels: int = 1) -> None:
        self.sample_rate = sample_rate
        self.per_char = per_char
        self.channels = channels
        self.calls: list[str] = []

    def synth(self, text: str) -> bytes:
        self.calls.append(text)
        return make_wav(len(text) * self.per_char, self.sample_rate, self.channels)


def sample_payload() -> dict:
    return {
        "data_date": "2026-10-15",
        "source": "Agmarknet / data.gov.in, Government of India",
        "commodities": [{
            "key": "soybean", "name_mr": "सोयाबीन", "msp": 5328, "msp_label": "हमीभाव",
            "markets": [
                {"market": "Latur", "market_mr": "लातूर", "district": "Latur", "modal": 4350, "min": 4100, "max": 4500},
                {"market": "Akola", "market_mr": "अकोला", "district": "Akola", "modal": 4280, "min": 4000, "max": 4400},
                {"market": "Washim", "market_mr": "वाशिम", "district": "Washim", "modal": 4210, "min": 4050, "max": 4300},
                {"market": "Hingoli", "market_mr": "हिंगोली", "district": "Hingoli", "modal": 4190, "min": 4000, "max": 4250},
                {"market": "Jalna", "market_mr": "जालना", "district": "Jalna", "modal": 4100, "min": 3900, "max": 4200},
            ],
            "median_modal": 4210, "vs_msp_pct": -21.0, "prev_median_modal": None,
        }],
    }


def sample_plan() -> VideoPlan:
    return VideoPlan(series="mandi", topic_key="soybean-msp-gap", data_date=date(2026, 10, 15), evergreen=False,
                     time_sensitive=True, fresh_until=None, payload=sample_payload())


def sample_script(**over) -> VideoScript:
    pt = PlatformText(title="सोयाबीन बाजारभाव", description="AI आवाज", caption="", hashtags=[], tags=[])
    data = dict(
        hook=Hook(voice_mr="लातूरमध्ये सोयाबीनला आज ₹४,३५० भाव मिळाला.", onscreen_mr="सोयाबीन ₹४,३५० लातूर"),
        segments=[
            Segment(voice_mr="महाराष्ट्रातील प्रमुख बाजारांतील सोयाबीनचे भाव पाहूया. लातूर सर्वात पुढे आहे.",
                    onscreen_mr="आजचे बाजारभाव", visual=Visual(kind="mandi_bars", data_ref="commodities[0]")),
            Segment(voice_mr="सरासरी भाव ₹४,२१० आहे, तर हमीभाव ₹५,३२८ आहे.",
                    onscreen_mr="बाजारभाव विरुद्ध हमीभाव", visual=Visual(kind="msp_compare", data_ref="commodities[0]")),
            Segment(voice_mr="माल विकण्यापूर्वी जवळच्या दोन बाजारांचे भाव तपासा.",
                    onscreen_mr="विकण्यापूर्वी भाव तपासा", visual=Visual(kind="illustration", asset_id="CROP-Soybean")),
        ],
        cta_mr="हा व्हिडिओ गावाच्या WhatsApp ग्रुपवर पाठवा.",
        platform=PlatformBundle(yt=pt, ig=pt, fb=pt),
        claims=[],
        sources_onscreen_mr="स्रोत: Agmarknet / data.gov.in · १५ ऑक्टो २०२६",
    )
    data.update(over)
    return VideoScript(**data)


def sample_timeline(tmp: Path, script: VideoScript | None = None, per_char: float = 0.06):
    return synthesize(script or sample_script(), FakeTTS(per_char=per_char), tmp / "voice")


def sample_brand() -> dict:
    import yaml
    return yaml.safe_load((REPO_MARKETING / "config" / "brand.yaml").read_text(encoding="utf-8"))
