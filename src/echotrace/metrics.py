"""Text normalization shared by CER-based commands.

Numbers keep their original spelling ("十八" vs "18") so transcription
differences remain visible in the CER.
"""

import unicodedata


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return "".join(c for c in text if not c.isspace() and not unicodedata.category(c).startswith("P"))
