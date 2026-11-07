"""在转写句子里定位一段引文，返回覆盖它的时间段。

时间段只取自转写句子本身的时间戳（ASR 或人工核对），从不让模型生成。
用于：直接摘要基线的引文回查、评测时检查"证据时间段是否包含原话"。
"""

import difflib
import re


def norm(text: str) -> str:
    return re.sub(r"[\W_]", "", text)


def pieces(quote: str, min_chars: int = 3) -> list[str]:
    """按 ；/…/... 把拼接的引文拆成片段，过短的片段丢掉。"""
    return [p for p in re.split(r"[；;]|\.\.\.|…", quote) if len(norm(p)) >= min_chars]


def _score(piece: str, text: str) -> float:
    m = difflib.SequenceMatcher(None, piece, text, autojunk=False)
    return sum(b.size for b in m.get_matching_blocks()) / max(len(piece), 1)


def _refine(p: str, run: list[dict]) -> tuple[float, float]:
    """在命中的几句里按字的位置线性插值，估计片段本身的起止时间（只用于评测）。"""
    texts = [norm(r["text"]) for r in run]
    joined = "".join(texts)
    blocks = [b for b in difflib.SequenceMatcher(None, p, joined, autojunk=False).get_matching_blocks() if b.size]
    lo, hi = blocks[0].b, blocks[-1].b + blocks[-1].size

    def at(pos: int) -> float:
        for r, t in zip(run, texts):
            if pos <= len(t):
                return r["start"] + (r["end"] - r["start"]) * pos / max(len(t), 1)
            pos -= len(t)
        return run[-1]["end"]

    return at(lo), at(hi)


def locate(piece: str, sentences: list[dict], near: tuple[float, float] | None = None,
           threshold: float = 0.85, refine: bool = False):
    """找覆盖该片段的连续 1-4 句，返回 (start, end) 或 None。

    有 near=(s, e) 时优先选落在该区间内或离它最近的；否则选最短的。
    refine=True 时返回句内按字位置插值的片段时间（评测用；纪要里的时间段始终是整句时间）。
    sentences 需按 start 排序。
    """
    p = norm(piece)
    if not p:
        return None
    cands = []
    for i in range(len(sentences)):
        for k in range(1, 5):
            run = sentences[i : i + k]
            if len(run) < k:
                break
            if _score(p, norm("".join(r["text"] for r in run))) >= threshold:
                a, b = min(r["start"] for r in run), max(r["end"] for r in run)
                dist = (max(0, near[0] - a) + max(0, b - near[1])) if near else 0
                cands.append((dist, b - a, a, b, i, k))
                break
    if not cands:
        return None
    _, _, a, b, i, k = min(cands)
    return _refine(p, sentences[i : i + k]) if refine else (a, b)


def locate_quote(quote: str, sentences: list[dict]):
    """整段引文（可含多个片段）的定位结果：(start, end, 找到的片段数, 片段总数)。"""
    ps = pieces(quote)
    spans = [s for s in (locate(p, sentences) for p in ps) if s]
    if not spans:
        return None, None, 0, len(ps)
    return min(s[0] for s in spans), max(s[1] for s in spans), len(spans), len(ps)
