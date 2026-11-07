"""用人工事实表评测生成的纪要。

条目对齐：同一片段内，由 DeepSeek 只看"内容"一句话判断预测条目和标准条目是否说的是同一件事
（一对一）。对齐结果写进 results/eval/{run}.json，供人工抽查；对齐之后的统计全部由程序计算：
  - 精确率 / 召回率（全部条目，以及只看 决定+待办）
  - 类型一致率；遗漏（未对上的标准条目）；未对上的预测条目（疑似虚构，需人工判定）
  - 错误归属：标准为"未知"而预测给出了负责人/截止日期（segmented 另报 guard 之前的原始数）
  - 证据：预测时间段能否覆盖标准原话（原话片段在 ref 句内按字位置插值定位，容差 1 秒）

用法：
  .venv/bin/python scripts/eval_minutes.py segmented_asr segmented_ref baseline_asr baseline_ref --split dev
"""

import argparse
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from echotrace import evidence, llm  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_minutes import DATA, SPLITS  # noqa: E402

FACTS = DATA / "facts" / "fact_table.json"
KEY_TYPES = ("决定", "待办")
TOL = 1.0
JUDGE_MODEL = llm.DEFAULT_MODEL

JUDGE_SYSTEM = """你在核对会议纪要。给你同一段会议的两组条目：标准条目 G 和待评条目 P，每条一句话。
判断哪些 P 和 G 说的是同一件事（同一项决定、待办或待确认事项），一对一配对：
- 只要核心事情相同就算配对，措辞、详略、类型不同都可以；
- 一个 P 只能配一个 G，一个 G 只能配一个 P；同一件事有多条时选最贴近的那条；
- 说的是不同的事就不要配对。
输出 JSON 对象：{"matches": [{"gold": "G1", "pred": "P3"}, ...]}"""


def known(v) -> bool:
    return bool(v) and str(v).strip() != "未知" and str(v).strip().lower() != "none"


def judge(gold: list[dict], pred: list[dict]) -> list[tuple[int, int]]:
    if not gold or not pred:
        return []
    user = "标准条目：\n" + "\n".join(f"G{i}. {g['content']}" for i, g in enumerate(gold, 1))
    user += "\n\n待评条目：\n" + "\n".join(f"P{i}. {p['content']}" for i, p in enumerate(pred, 1))
    data = llm.chat_json(JUDGE_SYSTEM, user, model=JUDGE_MODEL)["data"]
    pairs, used_g, used_p = [], set(), set()
    for m in data.get("matches", []):
        try:
            gi, pi = int(str(m["gold"]).lstrip("G")) - 1, int(str(m["pred"]).lstrip("P")) - 1
        except (KeyError, ValueError):
            continue
        if 0 <= gi < len(gold) and 0 <= pi < len(pred) and gi not in used_g and pi not in used_p:
            pairs.append((gi, pi))
            used_g.add(gi)
            used_p.add(pi)
    return pairs


def gold_pieces(g: dict, ref: list[dict]) -> list[tuple[float, float]]:
    """标准原话的每个片段在 ref 里的位置（优先落在标准时间段内）。"""
    near = (float(g["evidence_start"]), float(g["evidence_end"]))
    return [s for s in (evidence.locate(p, ref, near, refine=True) for p in evidence.pieces(g["evidence_text"])) if s]


def covered(span: tuple[float, float], p: dict) -> bool:
    return p["evidence_start"] is not None and p["evidence_start"] - TOL <= span[0] and span[1] <= p["evidence_end"] + TOL


def ratio(a, b):
    return round(a / b, 3) if b else None


def eval_run(run: str, clips: list[str], gold_all: list[dict], root: Path) -> dict:
    c = dict(gold=0, pred=0, match=0, key_gold=0, key_gold_hit=0, key_pred=0, key_pred_hit=0,
             type_ok=0, resp_fab=0, dl_fab=0, resp_fab_raw=0, dl_fab_raw=0, resp_known_pred=0,
             pieces=0, pieces_cov=0, items_any_cov=0, no_span=0)
    spans, detail = [], []
    elapsed, tokens = 0.0, 0
    for clip in clips:
        res = json.loads((root / run / f"{clip}.json").read_text(encoding="utf-8"))
        pred = res["items"]
        gold = [g for g in gold_all if g["id"].startswith(clip + "-")]
        ref = sorted(json.loads((DATA / "ref" / f"{clip}.json").read_text(encoding="utf-8")), key=lambda r: r["start"])
        pairs = judge(gold, pred)
        elapsed += res["elapsed"]
        tokens += res["usage"]["prompt_tokens"] + res["usage"]["completion_tokens"]

        c["gold"] += len(gold)
        c["pred"] += len(pred)
        c["match"] += len(pairs)
        c["key_gold"] += sum(g["type"] in KEY_TYPES for g in gold)
        c["key_pred"] += sum(p["type"] in KEY_TYPES for p in pred)
        c["no_span"] += sum(p["evidence_start"] is None for p in pred)
        c["resp_known_pred"] += sum(known(p["responsible"]) for p in pred)
        spans += [p["evidence_end"] - p["evidence_start"] for p in pred if p["evidence_start"] is not None]

        matched_g, matched_p, rows = set(), set(), []
        for gi, pi in pairs:
            g, p = gold[gi], pred[pi]
            matched_g.add(gi)
            matched_p.add(pi)
            c["key_gold_hit"] += g["type"] in KEY_TYPES
            c["key_pred_hit"] += p["type"] in KEY_TYPES
            c["type_ok"] += g["type"] == p["type"]
            # 错误归属：标准里没有说，预测却给了
            if not known(g["responsible"]) and known(p["responsible"]):
                c["resp_fab"] += 1
            if g["deadline"] == "未知" and known(p["deadline"]):
                c["dl_fab"] += 1
            if not known(g["responsible"]) and known(p.get("raw_responsible")):
                c["resp_fab_raw"] += 1
            if g["deadline"] == "未知" and known(p.get("raw_deadline")):
                c["dl_fab_raw"] += 1
            gp = gold_pieces(g, ref)
            cov = [covered(s, p) for s in gp]
            c["pieces"] += len(cov)
            c["pieces_cov"] += sum(cov)
            c["items_any_cov"] += any(cov)
            rows.append({
                "gold": g["id"], "pred": p["id"], "gold_type": g["type"], "pred_type": p["type"],
                "gold_content": g["content"], "pred_content": p["content"],
                "pred_span": [p["evidence_start"], p["evidence_end"]],
                "gold_pieces_covered": f"{sum(cov)}/{len(cov)}",
                "pred_responsible": p["responsible"], "pred_deadline": p["deadline"],
            })
        detail.append({
            "clip": clip,
            "matches": rows,
            "missed_gold": [{"id": gold[i]["id"], "type": gold[i]["type"], "content": gold[i]["content"]}
                            for i in range(len(gold)) if i not in matched_g],
            "unmatched_pred": [{"id": pred[i]["id"], "type": pred[i]["type"], "content": pred[i]["content"],
                                "evidence_text": pred[i]["evidence_text"]}
                               for i in range(len(pred)) if i not in matched_p],
        })

    summary = {
        "run": run,
        "clips": clips,
        "n_gold": c["gold"], "n_pred": c["pred"], "n_match": c["match"],
        "precision": ratio(c["match"], c["pred"]),
        "recall": ratio(c["match"], c["gold"]),
        "key_precision": ratio(c["key_pred_hit"], c["key_pred"]),
        "key_recall": ratio(c["key_gold_hit"], c["key_gold"]),
        "type_agreement": ratio(c["type_ok"], c["match"]),
        "missed": c["gold"] - c["match"],
        "unmatched_pred": c["pred"] - c["match"],
        "responsible_fabricated": c["resp_fab"],
        "deadline_fabricated": c["dl_fab"],
        "responsible_fabricated_before_guard": c["resp_fab_raw"],
        "deadline_fabricated_before_guard": c["dl_fab_raw"],
        "pred_without_span": c["no_span"],
        "gold_piece_coverage": ratio(c["pieces_cov"], c["pieces"]),
        "matched_items_with_evidence": ratio(c["items_any_cov"], c["match"]),
        "median_span_s": round(statistics.median(spans), 1) if spans else None,
        "llm_elapsed_s": round(elapsed, 1),
        "llm_tokens": tokens,
    }
    return {"summary": summary, "detail": detail}


COLS = [
    ("precision", "精确率"), ("recall", "召回率"), ("key_precision", "决定+待办 精确率"),
    ("key_recall", "决定+待办 召回率"), ("type_agreement", "类型一致"), ("missed", "遗漏"),
    ("unmatched_pred", "未对上的预测"), ("responsible_fabricated", "虚构负责人"),
    ("deadline_fabricated", "虚构截止"), ("deadline_fabricated_before_guard", "虚构截止(guard前)"),
    ("pred_without_span", "无时间段"), ("gold_piece_coverage", "原话片段覆盖率"),
    ("matched_items_with_evidence", "对上条目含原话"), ("median_span_s", "时间段中位长度(s)"),
    ("llm_tokens", "tokens"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runs", nargs="+", help="results/minutes 下的目录名，如 segmented_asr")
    ap.add_argument("--split", choices=list(SPLITS), default="dev")
    ap.add_argument("--root", type=Path, default=Path("results/minutes"))
    ap.add_argument("--out", type=Path, default=Path("results/eval"))
    ap.add_argument("--judge-model", default=llm.DEFAULT_MODEL, help="负责对齐条目的模型；比较不同方案时应保持一致")
    args = ap.parse_args()

    global JUDGE_MODEL
    JUDGE_MODEL = args.judge_model
    clips = SPLITS[args.split]
    gold = [f for f in json.loads(FACTS.read_text(encoding="utf-8"))["facts"] if f["status"] != "rejected"]
    args.out.mkdir(parents=True, exist_ok=True)
    summaries = []
    for run in args.runs:
        r = eval_run(run, clips, gold, args.root)
        (args.out / f"{run}_{args.split}.json").write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
        summaries.append(r["summary"])

    lines = [f"# 纪要评测（{args.split}: {', '.join(clips)}）", "",
             f"标准条目 {summaries[0]['n_gold']} 条（不含 rejected）。对齐由 DeepSeek 判断，明细见同目录 json。", "",
             "| 指标 | " + " | ".join(s["run"] for s in summaries) + " |",
             "|---|" + "---|" * len(summaries)]
    lines.append("| 预测条数 | " + " | ".join(str(s["n_pred"]) for s in summaries) + " |")
    for k, name in COLS:
        lines.append(f"| {name} | " + " | ".join("" if s[k] is None else str(s[k]) for s in summaries) + " |")
    md = "\n".join(lines) + "\n"
    (args.out / f"summary_{args.split}.md").write_text(md, encoding="utf-8")
    print(md)


if __name__ == "__main__":
    main()
