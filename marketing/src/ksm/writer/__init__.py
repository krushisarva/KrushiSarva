"""Script writer and fact-checker: Gemini or Claude per settings.yaml `llm.provider`
(see docs/ARCHITECTURE.md § writer/)."""
from .claude import ClaudeError, ClaudeRefusal, write_script
from .schemas import GLOSSARY, FactCheckReport, build_glossary


def factcheck(client, *, settings, plan, script, web, config_dir=None):  # noqa: ANN001 - contract re-export
    """Contract entry point; implemented in ksm.checks.factcheck (imported lazily to avoid a cycle)."""
    from ..checks.factcheck import factcheck as _factcheck

    return _factcheck(client, settings=settings, plan=plan, script=script, web=web, config_dir=config_dir)


__all__ = ["ClaudeError", "ClaudeRefusal", "FactCheckReport", "GLOSSARY", "build_glossary", "factcheck", "write_script"]
