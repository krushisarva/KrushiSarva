"""Publishers: YouTube Shorts, Facebook Page Reels, Instagram Reels.

Contract (adapted): `Publisher.ensure(conn, pub_row, revision_row, *, now, slot) -> PubState str`.
`slot` is the ksm.models.Slot being published (publish_at drives scheduling, late_until
the Instagram cut-off); for "post now" pass `dataclasses.replace(slot, publish_at=now)`.
ensure() is idempotent and safe to call every reconcile tick: it returns immediately
while `next_attempt_at` is in the future or the row is in a final state.
"""
from __future__ import annotations

import httpx

from ..config import Settings
from .common import (GRAPH_VERSION, TIMEOUT, BasePublisher, DryRunPublisher, MetaSession, Publisher,
                     PublishError, meta_settings, record_intent, record_result)
from .meta_fb import FacebookPublisher
from .meta_ig import InstagramPublisher
from .oauth import GoogleAuth
from .youtube import YouTubePublisher

__all__ = [
    "GRAPH_VERSION", "Publisher", "PublishError", "BasePublisher", "DryRunPublisher", "MetaSession",
    "YouTubePublisher", "FacebookPublisher", "InstagramPublisher", "build_publishers",
    "record_intent", "record_result",
]


def build_publishers(settings: Settings, http: httpx.Client | None = None, *,
                     dry_run: bool | None = None) -> dict[str, Publisher]:
    """Publishers for settings.platforms, wrapped in DryRunPublisher when dry-run is on.
    Secrets are read lazily on first real API call, never at construction."""
    http = http or httpx.Client(timeout=TIMEOUT)
    m = meta_settings(settings)

    def meta_token() -> str:
        from ..secrets import get_secret  # lazy: core module, Keychain access
        return get_secret("meta_system_user_token")

    meta = MetaSession(http, meta_token, page_id=m.get("page_id"), ig_user_id=m.get("ig_user_id"))
    all_pubs: dict[str, BasePublisher] = {
        "yt": YouTubePublisher(http, GoogleAuth.from_secrets(http), settings),
        "fb": FacebookPublisher(http, meta, settings),
        "ig": InstagramPublisher(http, meta, settings),
    }
    dry = settings.dry_run if dry_run is None else dry_run
    return {p: (DryRunPublisher(all_pubs[p]) if dry else all_pubs[p]) for p in settings.platforms if p in all_pubs}
