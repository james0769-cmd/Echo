"""ASR 对照实验：FunASR Paraformer-large（主方案） vs faster-whisper-small（对照）。

在 AliMeeting 10 个片段上比较：
  1. 中文字符错误率 CER（与 eval_cer.py 同一套归一化，数字写法不转换）
  2. CPU 耗时与 RTF（首次转写时记录，之后读缓存）
  3. 证据回溯：事实表（facts/fact_table.json，approved）每条原话在 ASR 转写里
     能否定位到、定位到的时间段是否与人工时间段重叠；以及人工时间段内 ASR 文字对原话的字覆盖率
  4. 含数字的原话逐条对照，用于展示数字转写错误

用法：.venv/bin/python scripts/compare_asr.py [clip01 ...]
输出：results/asr_compare/{cer.csv, evidence.csv, numbers.md, summary.md}
"""

import argparse
import csv
import difflib
import json
import re
import sys
from pathlib import Path

import jiwer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from echotrace import asr, asr_whisper, evidence  # noqa: E402
from eval_cer import normalize  # noqa: E402

DATA = Path("data/public/alimeeting")
ENGINES = {"paraformer": asr.transcribe, "whisper_small": asr_whisper.transcribe}
NUM_RE = re.compile(r"[0-9零一二两三四五六七八九十百千万]+[岁号点月日天周年个%块元]|[0-9]+")
TEST = {f"clip{i:02d}" for i in range(6, 11)}


_DIG = "零一二三四五六七八九"


def _int_zh(n: int) -> str:
    if n < 10:
        return _DIG[n]
    if n < 100:
        return ("" if n // 10 == 1 else _DIG[n // 10]) + "十" + (_DIG[n % 10] if n % 10 else "")
    if n < 1000:
        r = n % 100
        return _DIG[n // 100] + "百" + ("" if not r else ("零" + _DIG[r] if r < 10 else _DIG[r // 10] + "十" + (_DIG[r % 10] if r % 10 else "")))
    return "".join(_DIG[int(c)] for c in str(n))  # 年份、编号等逐位读


def num_to_zh(text: str) -> str:
    """近似把阿拉伯数字改写成汉字读法（18-45 → 十八到四十五，50% → 百分之五十），只用于补充 CER。"""
    text = re.sub(r"(\d+)%", lambda m: "百分之" + _int_zh(int(m[1])), text)
    text = re.sub(r"(?<=\d)\s*[-~～]\s*(?=\d)", "到", text)
    text = re.sub(r"(\d+)\.(\d+)", lambda m: _int_zh(int(m[1])) + "点" + "".join(_DIG[int(c)] for c in m[2]), text)
    return re.sub(r"\d+", lambda m: _int_zh(int(m[0])), text)


def char_cover(ref: str, hyp: str) -> float:
    """ref 的字有多少能在 hyp 里按顺序找到（difflib 匹配块总长 / ref 长度）。"""
    ref, hyp = normalize(ref), normalize(hyp)
    if not ref:
        return 0.0
    m = difflib.SequenceMatcher(None, ref, hyp, autojunk=False)
    return sum(b.size for b in m.get_matching_blocks()) / len(ref)


def window_text(sents, a, b, pad=0.5):
    return "".join(s["text"] for s in sents if s["end"] > a - pad and s["start"] < b + pad)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="*")
    ap.add_argument("--out", type=Path, default=Path("results/asr_compare"))
    args = ap.parse_args()
    clips = args.clips or sorted(p.stem for p in (DATA / "clips").glob("*.wav"))
    facts = [f for f in json.loads((DATA / "facts" / "fact_table.json").read_text(encoding="utf-8"))["facts"]
             if f["status"] == "approved"]
    args.out.mkdir(parents=True, exist_ok=True)

    cer_rows, ev_rows, num_md = [], [], []
    for clip in clips:
        ref_items = json.loads((DATA / "ref" / f"{clip}.json").read_text(encoding="utf-8"))
        ref = normalize("".join(r["text"] for r in ref_items))
        res = {name: fn(DATA / "clips" / f"{clip}.wav") for name, fn in ENGINES.items()}
        for name, r in res.items():
            m = jiwer.process_characters(ref, normalize(r["text"]))
            mz = jiwer.process_characters(ref, normalize(num_to_zh(r["text"])))
            cer_rows.append({"clip": clip, "engine": name, "ref_chars": m.hits + m.substitutions + m.deletions,
                             "sub": m.substitutions, "del": m.deletions, "ins": m.insertions,
                             "cer": round(m.cer, 4),
                             "err_numzh": mz.substitutions + mz.deletions + mz.insertions,
                             "cer_numzh": round(mz.cer, 4), "n_sents": len(r["sentences"]),
                             "duration": r["duration"], "elapsed": r["elapsed"], "rtf": r["rtf"]})
            print(f"{clip} {name:14s} CER {m.cer:6.2%}  S/D/I {m.substitutions}/{m.deletions}/{m.insertions}"
                  f"  耗时 {r['elapsed']:.1f}s RTF {r['rtf']:.3f}")

        for f in (f for f in facts if f["id"].startswith(clip + "-")):
            a, b = f["evidence_start"], f["evidence_end"]
            row = {"id": f["id"], "type": f["type"], "evidence_text": f["evidence_text"]}
            for name, r in res.items():
                sents = sorted(r["sentences"], key=lambda s: s["start"])
                ps = evidence.pieces(f["evidence_text"])
                spans = [evidence.locate(p, sents, near=(a, b), threshold=0.6) for p in ps]
                found = [s for s in spans if s]
                row[f"{name}_cover"] = round(char_cover(f["evidence_text"], window_text(sents, a, b)), 3)
                row[f"{name}_located"] = f"{len(found)}/{len(ps)}"
                row[f"{name}_in_span"] = int(bool(found) and all(s[1] > a - 1 and s[0] < b + 1 for s in found))
            ev_rows.append(row)
            if NUM_RE.search(f["evidence_text"]):
                num_md.append(f"### {f['id']}（{f['type']}）[{a:.2f}-{b:.2f}s]\n")
                num_md.append(f"- 人工：{f['evidence_text']}")
                for name, r in res.items():
                    num_md.append(f"- {name}：{window_text(r['sentences'], a, b)}")
                num_md.append("")

    def dump(path, rows):
        with open(path, "w", newline="", encoding="utf-8") as fp:
            w = csv.DictWriter(fp, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)

    dump(args.out / "cer.csv", cer_rows)
    dump(args.out / "evidence.csv", ev_rows)
    (args.out / "numbers.md").write_text("# 含数字的证据原话：人工 vs 两种 ASR（人工时间段 ±0.5s 内的句子）\n\n"
                                          + "\n".join(num_md), encoding="utf-8")

    # 汇总：全部 / 开发集 / 测试集
    lines = ["# ASR 对照：Paraformer-large vs faster-whisper-small\n",
             "CER 归一化同 eval_cer.py（去标点空白、NFKC、小写，数字写法不转换）。耗时为首次转写的 CPU 墙钟时间。\n",
             "「CER(数字转汉字)」先把阿拉伯数字近似改写成汉字读法再算，用来扣除纯数字写法差异。\n",
             "| 子集 | 引擎 | CER | CER(数字转汉字) | 替换 | 删除 | 插入 | 总耗时(s) | RTF | 证据字覆盖率 | 证据可定位且落在人工时间段 |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for subset, keep in [("全部", lambda c: True), ("dev", lambda c: c not in TEST), ("test", lambda c: c in TEST)]:
        for name in ENGINES:
            rs = [r for r in cer_rows if r["engine"] == name and keep(r["clip"])]
            es = [e for e in ev_rows if keep(e["id"].split("-")[0])]
            if not rs:
                continue
            n = sum(r["ref_chars"] for r in rs)
            err = {k: sum(r[k] for r in rs) for k in ("sub", "del", "ins")}
            dur, el = sum(r["duration"] for r in rs), sum(r["elapsed"] for r in rs)
            cov = sum(e[f"{name}_cover"] for e in es) / max(len(es), 1)
            ins = sum(e[f"{name}_in_span"] for e in es)
            lines.append(f"| {subset} | {name} | {sum(err.values()) / n:.2%}"
                         f" | {sum(r['err_numzh'] for r in rs) / n:.2%} | {err['sub']} | {err['del']} | {err['ins']}"
                         f" | {el:.1f} | {el / dur:.3f} | {cov:.3f} | {ins}/{len(es)} |")
    (args.out / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines[2:]))
    print(f"-> {args.out}/")


if __name__ == "__main__":
    main()
