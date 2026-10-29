"""Secrets in the macOS Keychain (service 'ks-marketing') via `keyring`.

Secrets are written by this package's own Python (`ksm secrets set`), so the launchd agent,
running the same interpreter, can read them without a Keychain prompt. Values are never
logged or printed; errors name the secret and the command that fixes it, nothing more.
"""
from __future__ import annotations

import keyring
from keyring.errors import KeyringError

SERVICE = "ks-marketing"

KNOWN: tuple[str, ...] = (
    "gemini_api_key", "anthropic_api_key", "sarvam_api_key", "datagov_api_key", "pexels_api_key",
    "telegram_bot_token", "youtube_client_json", "youtube_refresh_token", "meta_system_user_token",
)

# Short names accepted on the command line (SETUP.md says `ksm secrets set meta`).
ALIASES: dict[str, str] = {
    "gemini": "gemini_api_key",
    "anthropic": "anthropic_api_key", "sarvam": "sarvam_api_key", "datagov": "datagov_api_key",
    "pexels": "pexels_api_key", "telegram": "telegram_bot_token", "meta": "meta_system_user_token",
    "youtube_client": "youtube_client_json",
}


class SecretMissing(RuntimeError):
    """A required secret is not in the Keychain (or the Keychain could not be read)."""


def resolve_name(name: str) -> str:
    return ALIASES.get(name, name)


def get_secret(name: str) -> str:
    name = resolve_name(name)
    try:
        value = keyring.get_password(SERVICE, name)
    except KeyringError as e:
        raise SecretMissing(f"cannot read secret {name!r} from the Keychain ({type(e).__name__}); "
                            f"run `ksm secrets set {name}` from a logged-in terminal") from None
    if not value:
        raise SecretMissing(f"secret {name!r} is not set; run `ksm secrets set {name}`")
    return value


def set_secret(name: str, value: str) -> None:
    name = resolve_name(name)
    if not value or not value.strip():
        raise ValueError(f"refusing to store an empty value for {name!r}")
    keyring.set_password(SERVICE, name, value.strip())


def has_secret(name: str) -> bool:
    try:
        get_secret(name)
    except SecretMissing:
        return False
    return True


def delete_secret(name: str) -> None:
    try:
        keyring.delete_password(SERVICE, resolve_name(name))
    except KeyringError:
        pass
