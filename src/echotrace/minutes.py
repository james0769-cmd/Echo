"""从带时间戳的转写生成纪要：决定、待办、待确认事项，每条绑定原句和时间段。

两种方案（对照实验）：
- segmented（本项目方案）：转写按时长切成短块，句子编号后交给模型；模型只返回句子编号，
  时间段由程序按编号从转写里取。负责人、截止日期在原话里找不到的，程序强制改回"未知"。
- baseline（对照组）：整段转写不带编号直接交给模型摘要，模型自己写"原话"；
  程序再到转写里模糊查找这句原话，找不到就没有时间段。
"""

import json
import math
import time

from . import evidence, llm

TYPES = ("决定", "待办", "待确认")

RULES = """\
标注规则：
1. 只记录原话明确表达、或相邻原话可以直接确认的内容；不要推测、不要补充原话里没有的信息。
2. 类型：
   - 决定：有人明确拍板（"定了""敲定""就这样"），或其他参会者明确同意且无人反对。
   - 待办：明确要有人去做的具体事情。
   - 待确认：多人附和但无人收口、只有一人提议、或明说还要再定的事项。
   - 纯事实问答、闲聊不记录。
3. 负责人：原话里明确点名谁去做才填，照抄原话里的称呼；说话人说"我来/我去做"时填"说话人自述"；
   否则一律填"未知"。不要根据上下文猜人。
4. 截止日期：原话里有相对说法（如"下周""教师节前"）时照抄原话并加"，具体日期未知"；
   完全没提时填"未知"。不要换算成具体日期。
5. 转写来自语音识别，可能有错别字；按读音和上下文理解，但不要把错字改成你猜的人名或数字。
"""

SEGMENTED_SYSTEM = f"""你在整理会议纪要。输入是一段会议转写，每句以 [S编号] 开头。
{RULES}
输出 JSON 对象：{{"items": [{{"topic": "议题（简短名词短语）", "type": "决定|待办|待确认",
"content": "一句话概括", "responsible": "…", "deadline": "…",
"evidence_ids": ["支撑这一条的原句编号，按顺序，通常 1 到 4 句"]}}]}}
- evidence_ids 只能用输入里出现的编号，不要编造编号，不要输出时间。
- "上文"部分只帮助理解，条目的主要依据必须在"本段"里。
- 没有可记录的内容时输出 {{"items": []}}。"""

BASELINE_SYSTEM = f"""你在整理会议纪要。输入是一场会议的完整转写。
{RULES}
输出 JSON 对象：{{"items": [{{"topic": "议题（简短名词短语）", "type": "决定|待办|待确认",
"content": "一句话概括", "responsible": "…", "deadline": "…",
"quote": "支撑这一条的原话，从转写中摘抄"}}]}}
没有可记录的内容时输出 {{"items": []}}。"""

TOPIC_SYSTEM = """你在整理会议纪要的议题。输入是若干条目的编号、议题名和内容。
把说的是同一件事的议题合并成同一个名字（尽量沿用已有名字，简短的名词短语），不要改动内容。
输出 JSON 对象：{"topics": {"条目编号": "统一后的议题名", ...}}，每个编号都要出现。"""


# ---------- 输入 ----------


def number_sentences(sentences: list[dict]) -> list[dict]:
    """按开始时间排序并编号 S001…；保留 speaker（只有人工转写有）。"""
    out = []
    for i, s in enumerate(sorted(sentences, key=lambda s: (s["start"], s["end"])), 1):
        out.append({"id": f"S{i:03d}", **s})
    return out


def chunk(sentences: list[dict], seconds: float = 90.0, context: int = 4) -> list[dict]:
    """按时长切块，每块附带前面 context 句作为上文。"""
    chunks, cur = [], []
    for s in sentences:
        if cur and s["start"] - cur[0]["start"] >= seconds:
            chunks.append(cur)
            cur = []
        cur.append(s)
    if cur:
        chunks.append(cur)
    result, seen = [], 0
    for c in chunks:
        result.append({"context": sentences[max(0, seen - context) : seen], "body": c})
        seen += len(c)
    return result


def _render(lines: list[dict]) -> str:
    return "\n".join(f"[{s['id']}] {s['text']}" for s in lines)


# ---------- 后处理：时间段和"未知"保护 ----------


def _core(value: str) -> str:
    for sep in ("，", ",", "（", "("):
        value = value.split(sep)[0]
    return evidence.norm(value)


def guard_unknown(item: dict, evidence_text: str) -> list[str]:
    """负责人/截止日期在证据原话里找不到就改回"未知"，返回触发的提示。"""
    flags = []
    ev = evidence.norm(evidence_text)
    resp = (item.get("responsible") or "未知").strip()
    if resp != "未知":
        if "自述" in resp:
            ok = "我" in evidence_text
            resp = "说话人自述（身份未识别）"
        else:
            ok = bool(_core(resp)) and _core(resp) in ev
        if not ok:
            flags.append(f"负责人“{item.get('responsible')}”在原话中找不到，已改为未知")
            resp = "未知"
    dl = (item.get("deadline") or "未知").strip()
    if dl != "未知":
        if not (_core(dl) and _core(dl) in ev):
            flags.append(f"截止日期“{item.get('deadline')}”在原话中找不到，已改为未知")
            dl = "未知"
        elif "未知" not in dl:
            dl += "，具体日期未知"
    item["responsible"], item["deadline"] = resp, dl
    return flags


def _speakers(lines: list[dict]) -> str:
    spk = []
    for s in lines:
        if s.get("speaker") and s["speaker"] not in spk:
            spk.append(s["speaker"])
    return "/".join(spk)


def _evidence_spans(lines: list[dict]) -> list[dict]:
    """保留每条证据句的独立时间段，避免不连续证据被合并成一大段。"""
    return [
        {"id": s["id"], "start": s["start"], "end": s["end"]}
        for s in sorted(lines, key=lambda s: (s["start"], s["end"]))
    ]


def _normalize_type(t: str) -> str:
    t = (t or "").strip()
    return t if t in TYPES else "待确认"


# ---------- 方案一：分段 + 证据编号 ----------


def extract_segmented(sentences: list[dict], model: str = llm.DEFAULT_MODEL, seconds: float = 90.0) -> dict:
    sents = number_sentences(sentences)
    by_id = {s["id"]: s for s in sents}
    items, dropped, usage, calls = [], [], [], 0
    t0 = time.time()
    for ck in chunk(sents, seconds=seconds):
        user = ""
        if ck["context"]:
            user += "【上文】\n" + _render(ck["context"]) + "\n\n"
        user += "【本段】\n" + _render(ck["body"])
        resp = llm.chat_json(SEGMENTED_SYSTEM, user, model=model)
        calls += 1
        usage.append(resp["usage"])
        allowed = {s["id"] for s in ck["context"] + ck["body"]}
        body_ids = {s["id"] for s in ck["body"]}
        for raw in resp["data"].get("items", []):
            ids = [i for i in raw.get("evidence_ids", []) if i in allowed]
            if not ids or not set(ids) & body_ids:
                dropped.append({**raw, "reason": "证据编号无效或不在本段"})
                continue
            ids = sorted(set(ids))
            lines = [by_id[i] for i in ids]
            text = "；".join(s["text"] for s in lines)
            item = {
                "topic": (raw.get("topic") or "其他").strip(),
                "type": _normalize_type(raw.get("type")),
                "content": (raw.get("content") or "").strip(),
                "responsible": raw.get("responsible"),
                "deadline": raw.get("deadline"),
                "raw_responsible": raw.get("responsible"),
                "raw_deadline": raw.get("deadline"),
                "evidence_ids": ids,
                "evidence_start": min(s["start"] for s in lines),
                "evidence_end": max(s["end"] for s in lines),
                "evidence_spans": _evidence_spans(lines),
                "evidence_text": text,
                "speaker": _speakers(lines),
            }
            item["flags"] = guard_unknown(item, text)
            items.append(item)
    items = _dedupe(items)
    usage += unify_topics(items, model=model)
    calls += 1 if items else 0
    return _finish(items, dropped, usage, calls, time.time() - t0, "segmented", model, seconds=seconds)


def _dedupe(items: list[dict]) -> list[dict]:
    """相邻块可能抽到同一条：同类型且证据句重叠过半的只留证据更多的那条。"""
    kept = []
    for it in sorted(items, key=lambda x: -len(x["evidence_ids"])):
        a = set(it["evidence_ids"])
        if any(k["type"] == it["type"] and len(a & set(k["evidence_ids"])) * 2 >= min(len(a), len(k["evidence_ids"])) for k in kept):
            continue
        kept.append(it)
    return sorted(kept, key=lambda x: x["evidence_start"])


def unify_topics(items: list[dict], model: str = llm.DEFAULT_MODEL) -> list[dict]:
    """分块抽取的议题名各自为政，用一次短调用统一议题名（只改 topic，不改内容和证据）。"""
    if not items:
        return []
    listing = "\n".join(f"{i}. [{it['topic']}] {it['content']}" for i, it in enumerate(items, 1))
    resp = llm.chat_json(TOPIC_SYSTEM, listing, model=model)
    mapping = resp["data"].get("topics", {})
    for i, it in enumerate(items, 1):
        new = mapping.get(str(i))
        if isinstance(new, str) and new.strip():
            it["topic"] = new.strip()
    return [resp["usage"]]


# ---------- 方案二：整段直接摘要（对照组） ----------


def extract_baseline(sentences: list[dict], model: str = llm.DEFAULT_MODEL) -> dict:
    sents = number_sentences(sentences)
    t0 = time.time()
    resp = llm.chat_json(BASELINE_SYSTEM, "\n".join(s["text"] for s in sents), model=model)
    items = []
    for raw in resp["data"].get("items", []):
        quote = (raw.get("quote") or "").strip()
        spans = evidence.locate_quote_spans(quote, sents)
        start = min((span[0] for span in spans), default=None)
        end = max((span[1] for span in spans), default=None)
        found, total = len(spans), len(evidence.pieces(quote))
        hit = [s for s in sents if any(s["start"] < span_end and s["end"] > span_start for span_start, span_end in spans)]
        item = {
            "topic": (raw.get("topic") or "其他").strip(),
            "type": _normalize_type(raw.get("type")),
            "content": (raw.get("content") or "").strip(),
            "responsible": (raw.get("responsible") or "未知").strip(),
            "deadline": (raw.get("deadline") or "未知").strip(),
            "raw_responsible": raw.get("responsible"),
            "raw_deadline": raw.get("deadline"),
            "evidence_ids": [s["id"] for s in hit],
            "evidence_start": start,
            "evidence_end": end,
            "evidence_spans": [{"start": span_start, "end": span_end} for span_start, span_end in spans],
            "evidence_text": quote,
            "speaker": _speakers(hit),
            "flags": [] if found == total and total else [f"原话只在转写中找到 {found}/{total} 段"],
        }
        items.append(item)
    items.sort(key=lambda x: (x["evidence_start"] is None, x["evidence_start"] or 0))
    return _finish(items, [], [resp["usage"]], 1, time.time() - t0, "baseline", model)


# ---------- 输出 ----------


def _finish(items, dropped, usage, calls, elapsed, method, model, **params) -> dict:
    for i, it in enumerate(items, 1):
        it["id"] = f"m{i:02d}"
    return {
        "method": method,
        "model": model,
        "params": params,
        "items": items,
        "dropped": dropped,
        "llm_calls": calls,
        "usage": {
            "prompt_tokens": sum(u["prompt_tokens"] for u in usage),
            "completion_tokens": sum(u["completion_tokens"] for u in usage),
        },
        "elapsed": round(elapsed, 2),
    }


def _ts(sec, round_up: bool = False):
    """格式化为 mm:ss。结束时间向上取整，保证显示的整秒区间仍包含原话。"""
    if sec is None:
        return "无"
    total = max(0, math.ceil(sec) if round_up else math.floor(sec))
    m, s = divmod(total, 60)
    return f"{m:02d}:{s:02d}"


def to_markdown(result: dict, title: str = "") -> str:
    lines = [f"# 会议纪要 {title}".rstrip(), "", f"方案：{result['method']}　模型：{result['model']}", ""]
    topics = []
    for it in result["items"]:
        if it["topic"] not in topics:
            topics.append(it["topic"])
    for tp in topics:
        lines.append(f"## {tp}")
        lines.append("")
        for t in TYPES:
            group = [it for it in result["items"] if it["topic"] == tp and it["type"] == t]
            if not group:
                continue
            lines.append(f"**{t}**")
            lines.append("")
            for it in group:
                lines.append(f"- {it['content']}（负责人：{it['responsible']}；截止：{it['deadline']}）")
                lines.append(f"  - 证据 [{_ts(it['evidence_start'])}-{_ts(it['evidence_end'], round_up=True)}] {it['evidence_text']}")
                for f in it["flags"]:
                    lines.append(f"  - ⚠ {f}")
            lines.append("")
    return "\n".join(lines) + "\n"


def dumps(result: dict) -> str:
    return json.dumps(result, ensure_ascii=False, indent=1)
