import base64
import json

import httpx
import pytest
import respx

from _media_fixtures import make_wav
from ksm.voice.sarvam import SarvamError, SarvamTTS, split_sentences

URL = "https://api.sarvam.ai/text-to-speech"


# ── split_sentences ──────────────────────────────────────────────────────────

def test_split_on_danda_and_full_stop():
    text = "आज सोयाबीनचे भाव वाढले आहेत। कापसाचे भाव स्थिर आहेत. पुढील माहिती पाहूया!"
    assert split_sentences(text) == ["आज सोयाबीनचे भाव वाढले आहेत।", "कापसाचे भाव स्थिर आहेत.",
                                     "पुढील माहिती पाहूया!"]


@pytest.mark.parametrize("num", ["2.5", "२.५", "4,350.50"])
def test_never_splits_inside_numbers(num):
    text = f"पावसाचे प्रमाण {num} मिमी होते. उद्या हवामान कोरडे राहील."
    out = split_sentences(text)
    assert out[0] == f"पावसाचे प्रमाण {num} मिमी होते."
    assert all(num not in s or s.count(num) == 1 for s in out)


def test_abbreviation_without_space_is_not_a_boundary():
    assert split_sentences("दर Rs.500 वाढला आहे आज बाजारात.") == ["दर Rs.500 वाढला आहे आज बाजारात."]


def test_short_sentence_merges_forward():
    out = split_sentences("होय. आज भाव चांगला आहे बाजारात.")
    assert out == ["होय. आज भाव चांगला आहे बाजारात."]


def test_short_tail_joins_previous():
    out = split_sentences("आज बाजारात सोयाबीनचे भाव चांगले आहेत. धन्यवाद.")
    assert out == ["आज बाजारात सोयाबीनचे भाव चांगले आहेत. धन्यवाद."]


def test_long_text_force_cut_at_space_within_bounds():
    text = " ".join(["शेतकरी"] * 80)          # no boundary at all, 559 chars
    out = split_sentences(text)
    assert len(out) > 1
    assert all(12 <= len(s) <= 180 for s in out)
    assert " ".join(out) == text


def test_newline_is_boundary_and_empty_input():
    assert split_sentences("पहिली ओळ इथे आहे\nदुसरी ओळ इथे आहे") == ["पहिली ओळ इथे आहे", "दुसरी ओळ इथे आहे"]
    assert split_sentences("   ") == []


# ── SarvamTTS ────────────────────────────────────────────────────────────────

def _ok(wav: bytes) -> httpx.Response:
    return httpx.Response(200, json={"request_id": "r1", "audios": [base64.b64encode(wav).decode()]})


@respx.mock
def test_synth_request_shape_and_decode():
    wav = make_wav(0.2)
    route = respx.post(URL).mock(return_value=_ok(wav))
    tts = SarvamTTS("k-123", httpx.Client(), dict_id="d1")
    assert tts.synth(" नमस्कार शेतकरी मित्रांनो ") == wav
    req = route.calls.last.request
    assert req.headers["api-subscription-key"] == "k-123"
    body = json.loads(req.content)
    assert body == {"text": "नमस्कार शेतकरी मित्रांनो", "target_language_code": "mr-IN",
                    "speaker": "mrunal_mr_narration", "model": "bulbul:v4-flash",
                    "speech_sample_rate": 48000, "pace": 1.0, "dict_id": "d1"}
    assert tts.chars_billed == len("नमस्कार शेतकरी मित्रांनो")


@respx.mock
def test_retries_429_and_5xx_then_succeeds():
    wav = make_wav(0.1)
    route = respx.post(URL).mock(side_effect=[httpx.Response(429, headers={"retry-after": "3"}),
                                              httpx.Response(503), _ok(wav)])
    sleeps: list[float] = []
    tts = SarvamTTS("k", httpx.Client(), sleep=sleeps.append)
    assert tts.synth("नमस्कार शेतकरी") == wav
    assert route.call_count == 3
    assert sleeps == [3.0, 2.0]


@respx.mock
def test_transport_error_retried_then_gives_up():
    respx.post(URL).mock(side_effect=httpx.ConnectTimeout("t"))
    tts = SarvamTTS("k", httpx.Client(), sleep=lambda s: None, max_attempts=3)
    with pytest.raises(SarvamError, match="after 3 attempts"):
        tts.synth("नमस्कार शेतकरी")


@respx.mock
def test_4xx_is_not_retried():
    route = respx.post(URL).mock(return_value=httpx.Response(400, json={"error": "bad speaker"}))
    with pytest.raises(SarvamError, match="400"):
        SarvamTTS("k", httpx.Client(), sleep=lambda s: None).synth("नमस्कार शेतकरी")
    assert route.call_count == 1


@respx.mock
def test_bad_audio_rejected():
    respx.post(URL).mock(return_value=httpx.Response(200, json={"audios": [base64.b64encode(b"nope").decode()]}))
    with pytest.raises(SarvamError, match="not a WAV"):
        SarvamTTS("k", httpx.Client()).synth("नमस्कार शेतकरी")


@respx.mock
def test_multiple_audios_are_joined():
    a, b = make_wav(0.1), make_wav(0.2)
    respx.post(URL).mock(return_value=httpx.Response(200, json={"audios": [base64.b64encode(a).decode(),
                                                                          base64.b64encode(b).decode()]}))
    out = SarvamTTS("k", httpx.Client()).synth("नमस्कार शेतकरी")
    import io, wave
    with wave.open(io.BytesIO(out)) as w:
        assert w.getnframes() == int(0.3 * 48000)


def test_limits_and_v3_speaker_rejected():
    tts = SarvamTTS("k", httpx.Client())
    with pytest.raises(ValueError):
        tts.synth("क" * 2501)
    with pytest.raises(ValueError):
        tts.synth("  ")
    with pytest.raises(ValueError, match="persona"):
        SarvamTTS("k", httpx.Client(), speaker="priya")


# ── Review fixes ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("abbr", ["रु.", "Rs.", "डॉ."])
def test_abbreviation_dot_before_space_is_not_a_boundary(abbr):
    out = split_sentences(f"सोयाबीनचा सरासरी दर {abbr} ४,३५० आहे. उद्या हवामान कोरडे राहील.")
    assert out == [f"सोयाबीनचा सरासरी दर {abbr} ४,३५० आहे.", "उद्या हवामान कोरडे राहील."]


@respx.mock
def test_language_field_switches_once_when_rejected():
    wav = make_wav(0.1)
    def reply(request):
        if "target_language_code" in json.loads(request.content):
            return httpx.Response(422, json={"detail": "target_language_code: extra fields not permitted"})
        return _ok(wav)
    route = respx.post(URL).mock(side_effect=reply)
    tts = SarvamTTS("k", httpx.Client(), sleep=lambda s: None)
    assert tts.synth("नमस्कार शेतकरी") == wav
    first, second = (json.loads(c.request.content) for c in route.calls)
    assert "target_language_code" in first and "language_code" not in first
    assert second["language_code"] == "mr-IN" and "target_language_code" not in second
    tts.synth("नमस्कार शेतकरी")                       # sticky: no second rejection round-trip
    assert route.call_count == 3


@respx.mock
def test_unrelated_400_still_not_retried():
    route = respx.post(URL).mock(return_value=httpx.Response(400, json={"error": "speaker invalid"}))
    with pytest.raises(SarvamError, match="400"):
        SarvamTTS("k", httpx.Client(), sleep=lambda s: None).synth("नमस्कार शेतकरी")
    assert route.call_count == 1


@respx.mock
def test_non_json_200_is_sarvam_error_and_still_billed():
    respx.post(URL).mock(return_value=httpx.Response(200, text="<html>gateway</html>"))
    tts = SarvamTTS("k", httpx.Client())
    with pytest.raises(SarvamError, match="non-JSON"):
        tts.synth("नमस्कार शेतकरी")
    assert tts.chars_billed == len("नमस्कार शेतकरी")


def _wav(sampwidth: int, frames: bytes) -> bytes:
    import io, wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(sampwidth)
        w.setframerate(48000)
        w.writeframes(frames)
    return buf.getvalue()


@pytest.mark.parametrize("wav", [_wav(1, b"\x80" * 100), _wav(2, b""),
                                 b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x03\x00" + b"\x00" * 30])
@respx.mock
def test_non_pcm16_or_empty_audio_rejected(wav):
    respx.post(URL).mock(return_value=_ok(wav))
    with pytest.raises(SarvamError):
        SarvamTTS("k", httpx.Client()).synth("नमस्कार शेतकरी")
