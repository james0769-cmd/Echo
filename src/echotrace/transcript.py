"""可人工校对的转写文本：每行一句，行首带时间段。

    [01:23.45-01:27.80] 小王你周五前把报价单弄一下。

导出时时间段来自 ASR 句级时间戳；人工只改文字，时间段由人工回听核对后才改。
以 # 开头的行和空行是注释，读取时忽略。
"""

import re
from pathlib import Path

LINE_RE = re.compile(r"^\[(\d+):(\d{2}\.\d{2})-(\d+):(\d{2}\.\d{2})\] ?(.*)$")

HEADER = """\
# 校对说明
# - 每行一句：[开始-结束] 文字，时间格式 分:秒.百分秒
# - 只改文字，不改时间段；错字、漏字、多字都直接在文字里改
# - 整句是幻觉：把文字清空，保留时间段
# - ASR 漏掉整句：新起一行，回听确认后手填时间段
# - 以 # 开头的行是注释
"""


def format_ts(sec: float) -> str:
    m, s = divmod(round(sec * 100) / 100, 60)
    return f"{int(m):02d}:{s:05.2f}"


def _parse_ts(m: str, s: str) -> float:
    return int(m) * 60 + float(s)


def dumps(sentences: list[dict], source: str = "") -> str:
    lines = [HEADER.rstrip("\n")]
    if source:
        lines.append(f"# 来源: {source}")
    lines.append("")
    for s in sentences:
        lines.append(f"[{format_ts(s['start'])}-{format_ts(s['end'])}] {s['text']}")
    return "\n".join(lines) + "\n"


def loads(text: str) -> list[dict]:
    """解析校对文本，返回 [{start, end, text}]；格式不对的行直接报错并给出行号。"""
    sentences = []
    for i, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = LINE_RE.match(line)
        if not m:
            raise ValueError(f"第 {i} 行格式不对: {line!r}")
        start, end = _parse_ts(m[1], m[2]), _parse_ts(m[3], m[4])
        if end < start:
            raise ValueError(f"第 {i} 行结束时间早于开始时间: {line!r}")
        sentences.append({"start": start, "end": end, "text": m[5].strip()})
    return sentences


def load(path) -> list[dict]:
    return loads(Path(path).read_text(encoding="utf-8"))
