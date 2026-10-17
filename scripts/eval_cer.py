"""对 data/public/alimeeting 的片段跑 FunASR 转写，并与人工转写对比计算 CER。

CER 计算前统一去掉标点和空白、全角转半角、英文转小写；
数字写法（"十八" vs "18"）不做转换，保留为可观察的误差来源。

用法：.venv/bin/python scripts/eval_cer.py [--data data/public/alimeeting]
"""

import argparse
import csv
import json
import sys
import unicodedata
from pathlib import Path

import jiwer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from echotrace.asr import transcribe  # noqa: E402


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    return "".join(c for c in text if not c.isspace() and not unicodedata.category(c).startswith("P"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=Path("data/public/alimeeting"))
    ap.add_argument("--out", type=Path, default=Path("results/alimeeting_cer.csv"))
    args = ap.parse_args()

    rows = []
    total = {"ref_chars": 0, "sub": 0, "del": 0, "ins": 0}
    for wav in sorted((args.data / "clips").glob("*.wav")):
        ref_items = json.loads((args.data / "ref" / f"{wav.stem}.json").read_text(encoding="utf-8"))
        ref = normalize("".join(r["text"] for r in ref_items))
        asr = transcribe(wav)
        hyp = normalize(asr["text"])

        m = jiwer.process_characters(ref, hyp)
        n = m.substitutions + m.deletions + m.hits
        row = {
            "clip": wav.stem, "ref_chars": n, "hyp_chars": len(hyp),
            "sub": m.substitutions, "del": m.deletions, "ins": m.insertions,
            "cer": round(m.cer, 4), "duration": asr["duration"],
            "elapsed": asr["elapsed"], "rtf": asr["rtf"],
        }
        rows.append(row)
        for k in total:
            total[k] += row[k]
        print(f"{wav.stem}: CER {m.cer:.2%}  (替换 {m.substitutions} / 删除 {m.deletions} / 插入 {m.insertions})"
              f"  耗时 {asr['elapsed']:.1f}s  RTF {asr['rtf']:.3f}")

    overall = (total["sub"] + total["del"] + total["ins"]) / total["ref_chars"]
    dur = sum(r["duration"] for r in rows)
    el = sum(r["elapsed"] for r in rows)
    print(f"\n总体 CER {overall:.2%}  替换 {total['sub']} / 删除 {total['del']} / 插入 {total['ins']}"
          f" / 参考字数 {total['ref_chars']}")
    print(f"总音频 {dur:.0f}s，总耗时 {el:.1f}s，平均 RTF {el / dur:.3f}（耗时为首次转写时记录）")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
        w.writerow({"clip": "TOTAL", "ref_chars": total["ref_chars"], "sub": total["sub"],
                    "del": total["del"], "ins": total["ins"], "cer": round(overall, 4),
                    "duration": round(dur, 1), "elapsed": round(el, 1), "rtf": round(el / dur, 4)})
    print(f"-> {args.out}")


if __name__ == "__main__":
    main()
