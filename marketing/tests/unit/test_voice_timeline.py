import wave

import pytest

from _media_fixtures import FakeTTS, make_wav, sample_script
from ksm.voice.timeline import (chunk_captions, glen, sentence_starts, synthesize, timeline_from_dict,
                                timeline_to_dict, wav_duration)


def test_synthesize_one_clip_per_sentence_and_narration_length(tmp_path):
    script = sample_script()
    tts = FakeTTS()
    tl = synthesize(script, tts, tmp_path)
    # segment 0 has two sentences; everything else one
    assert [s.segment_index for s in tl.sentences] == [-1, 0, 0, 1, 2, 3]
    assert len(tts.calls) == 6
    for s in tl.sentences:
        assert s.duration_s == pytest.approx(round(len(s.text) * 0.06 * 48000) / 48000)
    with wave.open(str(tl.narration_wav)) as w:
        assert w.getframerate() == 48000 and w.getnchannels() == 1
        frames = w.getnframes()
    expected = sum(round(len(s.text) * 0.06 * 48000) for s in tl.sentences) + 5 * round(0.18 * 48000)
    assert frames == expected
    assert wav_duration(tl.narration_wav) == pytest.approx(tl.total_s, abs=1e-6)
    starts = sentence_starts(tl)
    assert starts[0] == 0 and starts[1] == pytest.approx(tl.sentences[0].duration_s + 0.18)


def test_synthesize_reuses_cached_clips(tmp_path):
    script = sample_script()
    synthesize(script, FakeTTS(), tmp_path)
    again = FakeTTS()
    tl = synthesize(script, again, tmp_path)
    assert again.calls == []
    assert len(tl.sentences) == 6


def test_synthesize_rejects_wrong_rate_and_mixes_channels(tmp_path):
    with pytest.raises(ValueError, match="expected 48000"):
        class Wrong(FakeTTS):
            def synth(self, text):
                return make_wav(0.3, rate=22050)
        synthesize(sample_script(), Wrong(), tmp_path / "a")

    class Alternating(FakeTTS):
        n = 0

        def synth(self, text):
            Alternating.n += 1
            return make_wav(0.3, channels=1 + Alternating.n % 2)
    tl = synthesize(sample_script(), Alternating(), tmp_path / "b")
    with wave.open(str(tl.narration_wav)) as w:
        first_channels = w.getnchannels()
        assert w.getnframes() == 6 * round(0.3 * 48000) + 5 * round(0.18 * 48000)
    assert first_channels in (1, 2)


def test_timeline_roundtrip(tmp_path):
    tl = synthesize(sample_script(), FakeTTS(), tmp_path)
    back = timeline_from_dict(timeline_to_dict(tl))
    assert back == tl


# ── captions ────────────────────────────────────────────────────────────────

SENT = "महाराष्ट्रातील प्रमुख बाजारांतील सोयाबीनचे भाव पाहूया आज लातूर सर्वात पुढे आहे आणि भाव ₹४,३५० आहे."


def test_chunks_tile_the_sentence_exactly():
    chunks = chunk_captions(SENT, 6.3, 2.0)
    assert chunks[0][0] == 2.0
    assert chunks[-1][1] == pytest.approx(8.3)
    for (a0, a1, _), (b0, _, _) in zip(chunks, chunks[1:]):
        assert a1 == pytest.approx(b0)
    assert " ".join(c[2] for c in chunks) == " ".join(SENT.split())


def test_chunk_limits_words_and_graphemes():
    for c0, c1, text in chunk_captions(SENT, 6.3, 0.0):
        assert 1 <= len(text.split()) <= 5
        assert glen(text) <= 22
        assert c1 - c0 >= 0.6 - 1e-9


def test_chunk_time_proportional_to_graphemes():
    chunks = chunk_captions("अ आ इ ई उ ऊ ए ऐ ओ औ क ख ग घ ङ च छ ज झ ञ", 10.0, 0.0, max_graphemes=10)
    durs = [c1 - c0 for c0, c1, _ in chunks]
    assert sum(durs) == pytest.approx(10.0)
    # every chunk has 5 one-grapheme words -> equal shares
    assert max(durs) - min(durs) < 1e-9


def test_short_chunks_merge_to_minimum():
    chunks = chunk_captions("एक दोन तीन चार पाच सहा सात आठ नऊ दहा", 1.4, 0.0)
    assert all(c1 - c0 >= 0.6 - 1e-9 for c0, c1, _ in chunks)
    assert chunks[-1][1] == pytest.approx(1.4)


def test_grapheme_count_treats_conjuncts_as_clusters():
    assert glen("क्षेत्र") < len("क्षेत्र")
    assert chunk_captions("", 1.0, 0.0) == []


# ── Review fixes ─────────────────────────────────────────────────────────────

def test_short_chunk_merge_respects_word_limit():
    out = chunk_captions("हे व या ते की न हे", 1.5, 0.0)
    assert all(len(t.split()) <= 5 for _, _, t in out)
    assert " ".join(t for _, _, t in out) == "हे व या ते की न हे"
    assert all(b - a >= 0.6 - 1e-9 for a, b, _ in out)
    assert out[0][0] == 0.0 and out[-1][1] == pytest.approx(1.5)


def test_clip_cache_is_keyed_by_pace(tmp_path):
    script = sample_script()
    slow = FakeTTS()
    slow.pace = 0.9
    synthesize(script, slow, tmp_path)
    fast = FakeTTS()
    fast.pace = 1.1
    synthesize(script, fast, tmp_path)
    assert len(fast.calls) == len(slow.calls)             # a pace change must not reuse old clips


def test_wrong_rate_clip_is_not_cached(tmp_path):
    class WrongRate(FakeTTS):
        def synth(self, text):
            self.calls.append(text)
            return make_wav(0.2, rate=22050)

    tts = WrongRate()
    with pytest.raises(ValueError, match="22050"):
        synthesize(sample_script(), tts, tmp_path)
    assert not list(tmp_path.glob("s*.wav"))
