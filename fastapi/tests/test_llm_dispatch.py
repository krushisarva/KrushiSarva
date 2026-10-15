"""
Unit tests for agents/llm_dispatch.py — the flat per-feature LLM config.

KrushiSarva routes per-feature by model-id prefix (WI-11). Covers:
  - _detect_provider maps gemini-*/gpt-*/claude-*/openai/gpt-oss-*/llama-* and rejects the rest
  - get_feature_config reads AI_<FEATURE>_* env vars correctly
  - defaults (all Gemini) are used when env vars are unset
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest

from agents.llm_dispatch import (
    AI_FEATURES,
    ConfigError,
    FeatureConfig,
    _detect_provider,
    _groq_fallback,
    get_feature_config,
)


# ── Provider detection (prefix-routed, WI-11) ─────────────────────────────────────────

class TestDetectProvider:
    def test_gemini_prefix_routes_to_gemini(self):
        assert _detect_provider("gemini-2.5-flash", None) == "gemini"
        assert _detect_provider("gemini-2.5-pro", None) == "gemini"

    def test_case_insensitive(self):
        assert _detect_provider("Gemini-2.5-Flash", None) == "gemini"

    def test_supported_prefixes_route_to_their_provider(self):
        # WI-11 (docs/WI11-model-routing.md) made the dispatch multi-provider so
        # the admin "AI Models" dropdowns actually route traffic. This file was
        # written four days before that landed and still asserted every one of
        # these raised ConfigError — the commit that made them route is even
        # titled "fix stale Gemini-only docs".
        assert _detect_provider("gpt-4o", None) == "openai"
        assert _detect_provider("claude-haiku-4-5-20251001", None) == "anthropic"
        assert _detect_provider("llama-3.3-70b-versatile", None) == "groq"
        assert _detect_provider("mixtral-8x7b", None) == "groq"

    def test_gpt_oss_routes_to_groq_not_openai(self):
        # openai/gpt-oss-* are open-weight models Groq hosts (the free-plan
        # replacement for Llama 3.3 70B since 2026-08-16). They must go to Groq
        # with GROQ_API_KEY, never to OpenAI's API, which is what a bare gpt-* is.
        assert _detect_provider("openai/gpt-oss-120b", None) == "groq"
        assert _detect_provider("openai/gpt-oss-20b", None) == "groq"
        assert _detect_provider("gpt-4o-mini", None) == "openai"

    def test_unknown_prefixes_raise(self):
        # An unroutable id must fail at config time, not at call time with an
        # empty credential against an endpoint that does not exist.
        for bad in ("deepseek-chat", "grok-2", "whisper-large-v3-turbo", "", "foo-mystery",
                    "openai/gpt-4o", "qwen/qwen3.8-27b"):
            with pytest.raises(ConfigError):
                _detect_provider(bad, None)


# ── Feature-config loader ────────────────────────────────────────────────────

class TestGetFeatureConfig:
    @pytest.fixture(autouse=True)
    def _clean_env(self, monkeypatch):
        # Clear the relevant env vars so tests start from a known state.
        for feat in AI_FEATURES:
            for suffix in ("_MODEL", "_API_KEY", "_BASE_URL"):
                monkeypatch.delenv(f"AI_{feat}{suffix}", raising=False)

    def test_falls_back_to_gemini_defaults_when_env_unset(self):
        cfg = get_feature_config("TEXT_CHAT")
        assert cfg.feature == "TEXT_CHAT"
        assert cfg.model == "gemini-2.5-flash"  # baked-in default
        assert cfg.base_url is None
        assert cfg.provider == "gemini"
        # api_key defaults to GEMINI_API_KEY (may be empty in test env).
        assert isinstance(cfg.api_key, str)

    def test_env_vars_override_defaults(self, monkeypatch):
        monkeypatch.setenv("AI_TEXT_CHAT_MODEL", "gemini-2.5-pro")
        monkeypatch.setenv("AI_TEXT_CHAT_API_KEY", "test-key-12345")
        cfg = get_feature_config("TEXT_CHAT")
        assert cfg.model == "gemini-2.5-pro"
        assert cfg.api_key == "test-key-12345"
        assert cfg.provider == "gemini"

    def test_non_gemini_model_routes_to_its_own_provider(self, monkeypatch):
        # Previously asserted that a claude-* model raised on `cfg.provider`.
        # Since WI-11 it resolves to anthropic, which is the whole point of the
        # admin model dropdowns.
        monkeypatch.setenv("AI_TEXT_CHAT_MODEL", "claude-sonnet-4-6")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
        cfg = get_feature_config("TEXT_CHAT")
        assert cfg.model == "claude-sonnet-4-6"
        assert cfg.provider == "anthropic"

    def test_unroutable_model_still_fails_fast(self, monkeypatch):
        # The property the old test was reaching for, kept: a model id that maps
        # to NO provider must be a configuration error. It surfaces at LOAD time
        # (get_feature_config resolves the provider to pick the right API key),
        # which is earlier and better than at call time.
        monkeypatch.setenv("AI_TEXT_CHAT_MODEL", "foo-mystery")
        with pytest.raises(ConfigError):
            _ = get_feature_config("TEXT_CHAT").provider

    def test_unknown_feature_raises(self):
        with pytest.raises(ValueError, match="Unknown AI feature"):
            get_feature_config("FAKE_FEATURE")

    def test_all_canonical_features_resolve(self, monkeypatch):
        # Every entry in AI_FEATURES should be loadable and Gemini-routed.
        for feat in AI_FEATURES:
            monkeypatch.setenv(f"AI_{feat}_MODEL", "gemini-2.5-flash")
            monkeypatch.setenv(f"AI_{feat}_API_KEY", "test-key")
        for feat in AI_FEATURES:
            cfg = get_feature_config(feat)
            assert isinstance(cfg, FeatureConfig)
            assert cfg.feature == feat
            assert cfg.model == "gemini-2.5-flash"
            assert cfg.provider == "gemini"

    def test_empty_string_env_treated_as_unset(self, monkeypatch):
        # Common ops mistake: AI_TEXT_CHAT_MODEL=  (trailing equals, no value).
        # Should fall back to the Gemini default, not an empty model name.
        monkeypatch.setenv("AI_TEXT_CHAT_MODEL", "")
        monkeypatch.setenv("AI_TEXT_CHAT_API_KEY", "")
        cfg = get_feature_config("TEXT_CHAT")
        assert cfg.model == "gemini-2.5-flash"


# ── Cross-provider Groq chat fallback ─────────────────────────────────────────

class TestGroqFallback:
    @pytest.fixture(autouse=True)
    def _clean_env(self, monkeypatch):
        # _groq_fallback reads GROQ_API_KEY at import time (module constant) AND
        # the per-feature AI_<F>_GROQ_* overrides live. Clear them all so each
        # test starts from a known state.
        for var in ("GROQ_API_KEY",):
            monkeypatch.delenv(var, raising=False)
        for feat in AI_FEATURES:
            for suffix in ("_GROQ_FALLBACK", "_GROQ_MODEL", "_GROQ_API_KEY"):
                monkeypatch.delenv(f"AI_{feat}{suffix}", raising=False)
        # _groq_fallback closes over the GROQ_API_KEY constant captured at import.
        # Patch it on the module so the per-test key is honoured.
        import agents.llm_dispatch as d
        monkeypatch.setattr(d, "GROQ_API_KEY", "", raising=False)

    def test_disabled_without_key(self, monkeypatch):
        # No GROQ_API_KEY → fallback off even for a chat feature.
        assert _groq_fallback("CHAT_WRITER") is None

    def test_enabled_for_chat_features_when_key_set(self, monkeypatch):
        import agents.llm_dispatch as d
        monkeypatch.setattr(d, "GROQ_API_KEY", "gsk_test", raising=False)
        for feat in ("TEXT_CHAT", "CHAT_WRITER", "CHAT_ENHANCER"):
            res = _groq_fallback(feat)
            assert res is not None, feat
            model, key = res
            assert model == "openai/gpt-oss-120b"
            assert key == "gsk_test"

    def test_off_for_non_chat_features_even_with_key(self, monkeypatch):
        # Vision / diagnose / treatment / alert / pest must NOT fall over to Groq.
        import agents.llm_dispatch as d
        monkeypatch.setattr(d, "GROQ_API_KEY", "gsk_test", raising=False)
        for feat in ("CHAT_VISION", "CROP_DIAGNOSE", "CROP_TREATMENT", "ALERT", "PEST"):
            assert _groq_fallback(feat) is None, feat

    def test_per_feature_disable(self, monkeypatch):
        import agents.llm_dispatch as d
        monkeypatch.setattr(d, "GROQ_API_KEY", "gsk_test", raising=False)
        monkeypatch.setenv("AI_CHAT_WRITER_GROQ_FALLBACK", "false")
        assert _groq_fallback("CHAT_WRITER") is None

    def test_per_feature_model_override(self, monkeypatch):
        import agents.llm_dispatch as d
        monkeypatch.setattr(d, "GROQ_API_KEY", "gsk_test", raising=False)
        monkeypatch.setenv("AI_CHAT_WRITER_GROQ_MODEL", "llama-3.1-8b-instant")
        model, _ = _groq_fallback("CHAT_WRITER")
        assert model == "llama-3.1-8b-instant"

    def test_per_feature_opt_in_for_non_chat(self, monkeypatch):
        # An operator can opt a non-chat text feature into the Groq fallback.
        import agents.llm_dispatch as d
        monkeypatch.setattr(d, "GROQ_API_KEY", "gsk_test", raising=False)
        monkeypatch.setenv("AI_ALERT_GROQ_FALLBACK", "true")
        res = _groq_fallback("ALERT")
        assert res is not None and res[0] == "openai/gpt-oss-120b"


# ── Groq request fields for reasoning models ─────────────────────────────────

class TestGroqModelParams:
    def test_gpt_oss_gets_reasoning_headroom_and_hides_reasoning(self):
        from agents.llm_utils import _GPT_OSS_REASONING_HEADROOM, _groq_model_params
        p = _groq_model_params("openai/gpt-oss-120b", 512)
        # The voice path's 512-token cap must not be eaten by hidden reasoning.
        assert p["max_tokens"] == 512 + _GPT_OSS_REASONING_HEADROOM
        assert p["include_reasoning"] is False
        assert p["reasoning_effort"] == "low"

    def test_other_groq_models_send_only_the_cap(self):
        # include_reasoning / reasoning_effort are reasoning-model fields; a
        # non-reasoning model must not receive them.
        from agents.llm_utils import _groq_model_params
        assert _groq_model_params("llama-3.3-70b-versatile", 4096) == {"max_tokens": 4096}
