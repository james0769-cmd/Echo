"""Repository paths shared by all commands.

Defaults use these absolute paths so the CLI works from any directory.
Paths supplied explicitly on the command line stay relative to the current
working directory, matching normal shell behaviour.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # repo root (…/Echo)
DATA = ROOT / "data"
ALIMEETING = DATA / "public" / "alimeeting"
RESULTS = ROOT / "results"
ASR_CACHE = DATA / "cache" / "asr"
LLM_CACHE = DATA / "cache" / "llm"

SPLITS = {
    "dev": [f"clip{i:02d}" for i in range(1, 6)],
    "test": [f"clip{i:02d}" for i in range(6, 11)],
}
SPLITS["all"] = SPLITS["dev"] + SPLITS["test"]
