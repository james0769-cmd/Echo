"""识别误差传播分析：逐条比较同一方案在 ASR 转写和人工转写（ref）上的评测结果，判断错误来源。

只读取 results/eval/{method}_{asr|ref}_{split}.json（eval_minutes.py 的输出）、事实表、ref 与 ASR 缓存，
不调用任何 API。归因规则（针对每条标准条目）：
  asr 漏 / ref 中  -> ASR 导致（识别错误传给了大模型）
  asr 漏 / ref 漏  -> 大模型导致（输入正确也没整理出来；也可能是标注口径问题，需人工复核）
  asr 中 / ref 漏  -> 大模型不稳定（输入更差反而对上，说明差异来自模型波动而非识别）
  都中            -> 正确
另外给出每条证据时间段内的局部 CER（ref 句 vs ASR 句，同一时间窗），用来核对"ASR 导致"是否真的伴随识别错误。

用法：
  .venv/bin/python scripts/error_attribution.py --split all
输出：results/error_attribution/{split}.csv 和 summary_{split}.md
"""

import argparse
import csv
import json
import re
import sys
import unicodedata
from collections import Counter
from pathlib import Path

import jiwer

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_minutes import DATA, SPLITS  # noqa: E402

EVAL = Path("results/eval")
ASR_CACHE = Path("data/cache/asr")
OUT = Path("results/error_attribution")
METHODS = ("segmented", "baseline")
PAD = 0.5
NUM = re.compile(r"[0-9]|[一二三四五六七八九两][十百千万]|[十百千万][一二三四五六七八九]")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return "".join(c for c in text if not c.isspace() and not unicodedata.category(c).startswith("P"))


def window_text(sents: list[dict], start: float, end: float) -> str:
    return "".join(s["text"] for s in sents if s["end"] >= start - PAD and s["start"] <= end + PAD)


def load_asr(clip: str) -> list[dict]:
    files = sorted(ASR_CACHE.glob(f"{clip}_*.json"))
    if not files:
        raise FileNotFoundError(f"没有 {clip} 的 ASR 缓存")
    return json.loads(files[0].read_text(encoding="utf-8"))["sentences"]


def load_eval(run: str, split: str) -> dict:
    """返回 {gold_id: {'hit': bool, 'type_ok': bool, 'pred_content': str, 'pieces': str}}"""
    clips = SPLITS[split]
    parts = ["dev", "test"] if split == "all" else [split]
    out = {}
    for p in parts:
        d = json.loads((EVAL / f"{run}_{p}.json").read_text(encoding="utf-8"))
        for c in d["detail"]:
            if c["clip"] not in clips:
                continue
            for m in c["matches"]:
                out[m["gold"]] = dict(hit=True, type_ok=m["gold_type"] == m["pred_type"],
                                      pred_type=m["pred_type"], pred_content=m["pred_content"],
                                      pieces=m["gold_pieces_covered"])
            for g in c["missed_gold"]:
                out[g["id"]] = dict(hit=False, type_ok=False, pred_type="", pred_content="", pieces="")
    return out


def attribute(a: dict, r: dict) -> str:
    if a["hit"] and r["hit"]:
        return "正确"
    if not a["hit"] and r["hit"]:
        return "ASR导致"
    if not a["hit"] and not r["hit"]:
        return "大模型导致"
    return "大模型不稳定"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", choices=list(SPLITS), default="all")
    args = ap.parse_args()
    clips = SPLITS[args.split]

    facts = json.loads((DATA / "facts" / "fact_table.json").read_text(encoding="utf-8"))["facts"]
    facts = [f for f in facts if f["id"].split("-")[0] in clips and f.get("status") != "rejected"]
    ref = {c: json.loads((DATA / "ref" / f"{c}.json").read_text(encoding="utf-8")) for c in clips}
    asr = {c: load_asr(c) for c in clips}
    evals = {(m, s): load_eval(f"{m}_{s}", args.split) for m in METHODS for s in ("asr", "ref")}

    rows = []
    for f in facts:
        clip = f["id"].split("-")[0]
        st, en = float(f["evidence_start"]), float(f["evidence_end"])
        ref_w, asr_w = normalize(window_text(ref[clip], st, en)), normalize(window_text(asr[clip], st, en))
        local_cer = round(jiwer.cer(ref_w, asr_w), 3) if ref_w else None
        row = dict(id=f["id"], type=f["type"], content=f["content"], span=f"{st:.2f}-{en:.2f}",
                   local_cer=local_cer, has_digit=bool(NUM.search(f["evidence_text"])))
        for m in METHODS:
            a, r = evals[(m, "asr")].get(f["id"]), evals[(m, "ref")].get(f["id"])
            if a is None or r is None:
                row[f"{m}_attr"] = "无评测"
                continue
            row[f"{m}_attr"] = attribute(a, r)
            row[f"{m}_asr_type"] = a["pred_type"] or "-"
            row[f"{m}_ref_type"] = r["pred_type"] or "-"
            row[f"{m}_asr_pred"] = a["pred_content"]
            row[f"{m}_ref_pred"] = r["pred_content"]
        rows.append(row)

    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / f"{args.split}.csv").open("w", encoding="utf-8-sig", newline="") as fp:
        w = csv.DictWriter(fp, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    lines = [f"# 错误归因（{args.split}: {', '.join(clips)}）", "",
             f"标准条目 {len(rows)} 条（不含 rejected）。规则见 scripts/error_attribution.py 文件头。", "",
             "| 归因 | " + " | ".join(METHODS) + " | 平均局部 CER（segmented） |", "|---|---|---|---|"]
    cats = ["正确", "ASR导致", "大模型导致", "大模型不稳定"]
    for cat in cats:
        cnt = [sum(r[f"{m}_attr"] == cat for r in rows) for m in METHODS]
        cers = [r["local_cer"] for r in rows if r["segmented_attr"] == cat and r["local_cer"] is not None]
        avg = f"{sum(cers) / len(cers):.3f}" if cers else "-"
        lines.append(f"| {cat} | " + " | ".join(map(str, cnt)) + f" | {avg} |")
    lines += ["", "## 非“正确”条目明细", ""]
    for m in METHODS:
        lines += [f"### {m}", "", "| 条目 | 类型 | 归因 | 局部CER | 含数字 | 标准内容 |", "|---|---|---|---|---|---|"]
        for r in rows:
            if r[f"{m}_attr"] != "正确":
                lines.append(f"| {r['id']} | {r['type']} | {r[f'{m}_attr']} | {r['local_cer']} | "
                             f"{'是' if r['has_digit'] else ''} | {r['content']} |")
        lines.append("")
    # 类型判断：两边都对上时，类型是否一致
    lines += ["## 两边都对上时的类型判断", ""]
    for m in METHODS:
        both = [r for r in rows if r[f"{m}_attr"] == "正确"]
        c = Counter((r[f"{m}_asr_type"] == r["type"], r[f"{m}_ref_type"] == r["type"]) for r in both)
        lines.append(f"- {m}：共 {len(both)} 条；类型 asr对/ref对 {c[(True, True)]}，asr错/ref对 {c[(False, True)]}，"
                     f"asr对/ref错 {c[(True, False)]}，都错 {c[(False, False)]}")
    (OUT / f"summary_{args.split}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[:10]))


if __name__ == "__main__":
    main()
