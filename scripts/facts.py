"""读取人工事实表 facts/facts_all.csv，转成评测脚本统一使用的字段。

新表有 6 类：决定 / 共识 / 待办 / 提议 / 未决 / 信息；纪要程序只输出 决定 / 待办 / 待确认。
对照口径（见 minutes.py 的类型定义）：
  决定 -> 决定
  共识 -> 决定 或 待确认 都算类型一致（"多人同意但没有正式拍板"，正好落在两类的边界上）
  待办 -> 待办
  提议、未决 -> 待确认
  信息 -> 纪要不要求提取（"纯事实问答不记录"）：不计入召回分母；但预测对上信息条目不算虚构
负责人 / 截止日期：只有明确说出的值（如 SPK8026、下周、中秋节）算已知；
"—""未指定…""未明确…""未定…"、以及"主持人指派的'你'（没有点名）"都算未知。
"""

import csv
import re
from pathlib import Path

FACTS_CSV = Path("data/public/alimeeting/facts/facts_all.csv")

TYPE_OK = {
    "决定": {"决定"},
    "共识": {"决定", "待确认"},
    "待办": {"待办"},
    "提议": {"待确认"},
    "未决": {"待确认"},
    "信息": set(),
}
SCORED = ("决定", "共识", "待办", "提议", "未决")  # 计入召回
KEY_GOLD = ("决定", "共识", "待办")                 # "重要决定和待办"
KEY_GOLD_STRICT = ("决定", "待办")
UNKNOWN_PREFIX = ("—", "-", "未指定", "未明确", "未定", "未知", "主持人指派")


def known(v) -> bool:
    s = str(v or "").strip()
    return bool(s) and s.lower() != "none" and not s.startswith(UNKNOWN_PREFIX)


def _quotes(raw: str) -> list[str]:
    """'SPK8013：“……” / SPK8015：“……”' -> 每段引号里的原话。"""
    out = []
    for part in re.split(r"\s+/\s+", raw.strip()):
        part = re.sub(r"^SPK\d+[：:]\s*", "", part.strip())
        if part.startswith("“") and part.endswith("”"):
            part = part[1:-1]
        if part:
            out.append(part)
    return out


def load(path: Path = FACTS_CSV) -> list[dict]:
    rows = list(csv.DictReader(path.open(encoding="utf-8-sig")))
    facts = []
    for r in rows:
        quotes = _quotes(r["原话"])
        facts.append({
            "id": f"{r['clip']}-f{int(r['编号']):02d}",
            "clip": r["clip"],
            "type": r["类型"],
            "content": r["内容"],
            "responsible": r["负责人"],
            "deadline": r["截止日期"],
            "evidence_text": "；".join(quotes),
            "evidence_start": float(r["start_s"]),
            "evidence_end": float(r["end_s"]),
            "speaker": ",".join(re.findall(r"SPK\d+", r["原话"])),
            "note": r["备注"],
        })
    return facts


def _core(v: str) -> str:
    """'到时候，具体日期未知' -> '到时候'；'中秋节（晚上）' -> '中秋节'。"""
    s = re.split(r"[，,（(]", str(v).strip())[0]
    return re.sub(r"[“”\"'‘’\s]", "", s)


def supported(v, g: dict) -> bool:
    """预测的负责人/截止日期是否有原话或标准字段撑腰（照抄或改写原话里的相对说法不算虚构）。"""
    core = _core(v)
    if not core:
        return False
    hay = g["evidence_text"] + g["responsible"] + g["deadline"] + g["content"]
    # 允许换序改写（"转正后三个月" vs "三个月转正后"）：核心词 80% 以上的字出现在原话/标准里
    return core in hay or sum(ch in hay for ch in core) >= 0.8 * len(core)


def spk(v) -> set[str]:
    return set(re.findall(r"SPK\d+", str(v or "")))
