"""Guards for the repo plumbing around ksm: lock files, the CI job and the privacy notice.

These catch the drift that nobody notices until it bites: a dependency added to pyproject.toml
but not pinned (CI installs with --no-deps, so it would fail at import), a CI edit that starts
running render/live tests on a runner without ffmpeg or secrets, or a privacy page missing a
link that YouTube/Meta review requires.
"""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

import pytest
import yaml

packaging = pytest.importorskip("packaging")
from packaging.requirements import Requirement  # noqa: E402
from packaging.utils import canonicalize_name  # noqa: E402

MARKETING = Path(__file__).resolve().parents[2]
REPO = MARKETING.parent


def _pins(path: Path) -> dict[str, str]:
    pins: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        name, sep, version = line.partition("==")
        assert sep, f"{path.name}: not an exact pin: {line!r}"
        pins[canonicalize_name(name)] = version
    return pins


def _pyproject() -> dict:
    return tomllib.loads((MARKETING / "pyproject.toml").read_text(encoding="utf-8"))


def test_runtime_lock_pins_every_dependency_within_its_range():
    runtime = _pins(MARKETING / "requirements.lock")
    for spec in _pyproject()["project"]["dependencies"]:
        req = Requirement(spec)
        key = canonicalize_name(req.name)
        assert key in runtime, f"{req.name} is in pyproject.toml but not pinned in requirements.lock"
        assert req.specifier.contains(runtime[key], prereleases=True), (
            f"{req.name}=={runtime[key]} does not satisfy {req.specifier}")


def test_dev_lock_is_a_superset_with_identical_runtime_pins():
    runtime = _pins(MARKETING / "requirements.lock")
    dev = _pins(MARKETING / "requirements-dev.lock")
    assert {k: dev.get(k) for k in runtime} == runtime
    for spec in _pyproject()["project"]["optional-dependencies"]["dev"]:
        req = Requirement(spec)
        key = canonicalize_name(req.name)
        assert key in dev, f"{req.name} missing from requirements-dev.lock"
        assert req.specifier.contains(dev[key], prereleases=True)


def test_ci_marketing_job_is_hermetic():
    ci_path = REPO / ".github" / "workflows" / "ci.yml"
    if not ci_path.exists():  # marketing/ checked out on its own
        pytest.skip("repo-root CI file not present")
    job = yaml.safe_load(ci_path.read_text(encoding="utf-8"))["jobs"]["marketing"]
    assert job["defaults"]["run"]["working-directory"] == "marketing"
    py = next(s for s in job["steps"] if str(s.get("uses", "")).startswith("actions/setup-python"))
    assert str(py["with"]["python-version"]) == "3.12"
    assert py["with"]["cache-dependency-path"] == "marketing/requirements-dev.lock"
    runs = "\n".join(s.get("run", "") for s in job["steps"])
    assert "pip install -r requirements-dev.lock" in runs
    assert "pip install -e . --no-deps" in runs
    assert 'pytest -m "not render and not live"' in runs
    # Hermetic means no repository secrets and no service containers (DB, Redis) in this job.
    assert "secrets." not in yaml.safe_dump(job), "marketing CI job must not read repository secrets"
    assert "services" not in job


@pytest.mark.parametrize("doc", ["PRIVACY.md", "SETUP.md"])
def test_privacy_text_has_required_links(doc):
    text = (MARKETING / doc).read_text(encoding="utf-8")
    for needle in (
        "https://policies.google.com/privacy",
        "https://security.google.com/settings/security/permissions",
        "https://www.youtube.com/t/terms",
        "krushisarva@gmail.com",
        "Data deletion request",
    ):
        assert needle in text, f"{doc} is missing {needle}"


@pytest.mark.parametrize("doc", ["SETUP.md", "README.md"])
def test_docs_use_contract_secret_names(doc):
    """The docs must only tell the founder to set secrets that ksm.secrets knows about."""
    from ksm.secrets import ALIASES, KNOWN

    text = (MARKETING / doc).read_text(encoding="utf-8")
    names = set(re.findall(r"ksm secrets set ([a-z_]+)", text))
    # README's command table lists the accepted names in backticks on the `secrets set <name>` row.
    row = next((ln for ln in text.splitlines() if "`ksm secrets set <name>`" in ln and ln.startswith("|")), "")
    names |= {n for n in re.findall(r"`([a-z_]+)`", row)}
    assert names, f"{doc} no longer mentions `ksm secrets set`"
    unknown = {n for n in names if n not in KNOWN and n not in ALIASES}
    assert not unknown, f"{doc} uses unknown secret names: {sorted(unknown)}"


def test_setup_pairing_example_matches_bot(monkeypatch):
    """SETUP.md's `/start <code>` example must look like what `ksm pair-telegram` really prints."""
    cb = pytest.importorskip("ksm.approve.callbacks")
    text = (MARKETING / "SETUP.md").read_text(encoding="utf-8")
    example = re.search(r"`(/start [^`]+)`", text)
    assert example, "SETUP.md lost the /start pairing example"
    m = cb._START.match(example.group(1))
    assert m, f"{example.group(1)!r} would not be recognised by the bot"
    code = m.group(1)
    assert set(code) <= set(cb._PAIR_ALPHABET), f"{code!r} uses characters a real code never has"
    monkeypatch.setattr(cb, "kv_set", lambda *a, **k: None)   # no DB: we only want a sample code
    assert len(code) == len(cb.new_pair_code(None)), "example code length differs from real codes"
    ttl_min = int(cb.PAIR_TTL.total_seconds() // 60)
    assert f"{ttl_min} minutes" in text, "SETUP.md must state how long a pairing code lasts"


def test_launchd_label_in_readme_matches_template():
    plist = (MARKETING / "launchd" / "com.krushisarva.marketing.plist.tmpl")
    if not plist.exists():
        pytest.skip("launchd template not written yet")
    label = re.search(r"<key>Label</key>\s*<string>([^<]+)</string>", plist.read_text(encoding="utf-8"))
    assert label, "plist template has no Label"
    readme = (MARKETING / "README.md").read_text(encoding="utf-8")
    used = set(re.findall(r"gui/\$\(id -u\)/([\w.]+)", readme))
    assert used == {label.group(1)}, f"README launchctl commands use {used}, plist Label is {label.group(1)}"


def test_privacy_covers_cookies_in_every_language():
    """YouTube Developer Policies III.A: the privacy policy must say whether the client uses
    cookies or similar technology on users' devices. The Sites paste text has two languages."""
    assert "cookies" in (MARKETING / "PRIVACY.md").read_text(encoding="utf-8")
    setup = (MARKETING / "SETUP.md").read_text(encoding="utf-8")
    mr, _, en = setup.partition("━ English ━")
    assert "कुकीज" in mr and "cookies" in en


def test_setup_warns_against_time_limited_google_access():
    """Time-based Google access silently kills the refresh token when it lapses."""
    assert "no end date" in (MARKETING / "SETUP.md").read_text(encoding="utf-8")
