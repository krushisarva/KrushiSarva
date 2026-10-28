import json
import struct
import subprocess
from pathlib import Path

from ksm.render import qa

EBUR = """[Parsed_ebur128_0 @ 0x1] t: 0.5 TARGET:-23 LUFS M: -30.0 S:-120.7 I: -70.0 LUFS LRA: 0.0 LU
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -14.3 LUFS
    Threshold: -24.6 LUFS

  Loudness range:
    LRA:         2.9 LU

  True peak:
    Peak:       -1.7 dBFS
"""
BLACK = "[blackdetect @ 0x2] black_start:3.2 black_end:3.9 black_duration:0.7\n"
SILENCE = ("[silencedetect @ 0x3] silence_start: 10.5\n"
           "[silencedetect @ 0x3] silence_end: 12.1 | silence_duration: 1.6\n"
           "[silencedetect @ 0x3] silence_start: 30.0\n")


def _box(kind: bytes, payload: bytes = b"") -> bytes:
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def _good_info(**over):
    v = {"codec_type": "video", "codec_name": "h264", "profile": "High", "width": 1080, "height": 1920,
         "pix_fmt": "yuv420p", "avg_frame_rate": "30/1", "r_frame_rate": "30/1"}
    a = {"codec_type": "audio", "codec_name": "aac", "sample_rate": "48000"}
    info = {"streams": [v, a], "format": {"duration": "35.2", "size": "24000000"}}
    for k, val in over.items():
        (v if k in v else a if k in a else info["format"])[k] = val
    return info


def test_parsers():
    assert qa.parse_ebur128(EBUR) == (-14.3, -1.7)
    assert qa.parse_ebur128("nothing") == (None, None)
    assert qa.parse_blackdetect(BLACK) == [(3.2, 3.9, 0.7)]
    assert qa.parse_silencedetect(SILENCE, total_s=31.0) == [(10.5, 1.6), (30.0, 1.0)]


def test_atom_order(tmp_path):
    fast, slow = tmp_path / "fast.mp4", tmp_path / "slow.mp4"
    fast.write_bytes(_box(b"ftyp", b"isom") + _box(b"moov", b"\0" * 20) + _box(b"mdat", b"\0" * 100))
    slow.write_bytes(_box(b"ftyp", b"isom") + _box(b"mdat", b"\0" * 100) + _box(b"moov", b"\0" * 20))
    assert qa.atom_order(fast) == ["ftyp", "moov", "mdat"]
    assert qa.moov_before_mdat(fast) and not qa.moov_before_mdat(slow)


def test_check_streams():
    assert qa.check_streams(_good_info()) == []
    probs = qa.check_streams(_good_info(width=720, profile="Main", avg_frame_rate="25/1", sample_rate="44100",
                                        duration="61.0", size=str(120 * 1024 * 1024)))
    joined = " | ".join(probs)
    for frag in ("1080x1920", "h264 High", "fps", "48000", "duration", "100 MB"):
        assert frag in joined
    assert "no audio stream" in qa.check_streams({"streams": [_good_info()["streams"][0]], "format": {"duration": "20"}})


def _runner(info, stderr):
    def run(cmd, **kw):
        if "ffprobe" in cmd[0]:
            return subprocess.CompletedProcess(cmd, 0, json.dumps(info), "")
        return subprocess.CompletedProcess(cmd, 0, "", stderr)
    return run


def test_probe_pass_and_fail(tmp_path):
    m = tmp_path / "m.mp4"
    m.write_bytes(_box(b"ftyp") + _box(b"moov") + _box(b"mdat"))
    ok = qa.probe(m, runner=_runner(_good_info(), EBUR), ffmpeg="/x/ffmpeg", ffprobe="/x/ffprobe")
    assert ok.ok, ok.problems
    assert ok.probe["qa"]["lufs"] == -14.3

    loud = EBUR.replace("-14.3 LUFS", "-9.0 LUFS").replace("-1.7 dBFS", "-0.2 dBFS")
    bad = qa.probe(m, runner=_runner(_good_info(), loud + BLACK + SILENCE), ffmpeg="/x/ffmpeg", ffprobe="/x/ffprobe")
    assert not bad.ok
    joined = " | ".join(bad.problems)
    for frag in ("integrated loudness -9.0", "true peak -0.2", "black frames 0.70", "silence 1.60"):
        assert frag in joined
    assert "silence 1.00" not in joined          # open trailing silence of 1.0 s is under the limit


def test_analysis_command():
    cmd = qa.analysis_command(Path("/m.mp4"), ffmpeg="/x/ffmpeg")
    g = cmd[cmd.index("-filter_complex") + 1]
    assert "blackdetect=d=0.5" in g and "ebur128=peak=true" in g and "silencedetect=noise=-50dB:d=1.2" in g


def test_probe_reports_timeouts_and_bad_json(tmp_path):
    m = tmp_path / "m.mp4"
    m.write_bytes(_box(b"ftyp") + _box(b"moov") + _box(b"mdat"))

    def hang(cmd, **kw):
        raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
    rep = qa.probe(m, runner=hang, ffmpeg="/x/ffmpeg", ffprobe="/x/ffprobe")
    assert not rep.ok and "ffprobe failed" in rep.problems[0]

    def garbage(cmd, **kw):
        return subprocess.CompletedProcess(cmd, 0, "not json", "")
    rep = qa.probe(m, runner=garbage, ffmpeg="/x/ffmpeg", ffprobe="/x/ffprobe")
    assert not rep.ok and "JSON" in rep.problems[0]

    def analysis_hangs(cmd, **kw):
        if "ffprobe" in cmd[0]:
            return subprocess.CompletedProcess(cmd, 0, json.dumps(_good_info()), "")
        raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
    rep = qa.probe(m, runner=analysis_hangs, ffmpeg="/x/ffmpeg", ffprobe="/x/ffprobe")
    assert not rep.ok and any("analysis failed" in p for p in rep.problems)
