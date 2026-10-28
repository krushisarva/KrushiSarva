"""`python -m ksm …` (what the launchd plist runs)."""
from .cli import main

raise SystemExit(main())
