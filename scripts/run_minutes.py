"""对 AliMeeting 片段生成纪要，输出到 results/minutes/{方案}_{转写来源}/。

转写来源：
  asr  FunASR 原始转写（data/cache/asr，需要 clips/*.wav 才能定位缓存）
  whisper  faster-whisper-small 转写（data/cache/asr_whisper），ASR 对照实验用
  ref  AliMeeting 人工转写（data/public/alimeeting/ref），用来区分识别错误与整理错误

用法：
  .venv/bin/python scripts/run_minutes.py --method segmented --source asr --split dev
  .venv/bin/python scripts/run_minutes.py --method baseline --source ref clip01 clip02
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from echotrace import minutes  # noqa: E402
from echotrace.asr import transcribe  # noqa: E402

DATA = Path("data/public/alimeeting")
SPLITS = {
    "dev": [f"clip{i:02d}" for i in range(1, 6)],
    "test": [f"clip{i:02d}" for i in range(6, 11)],
}
SPLITS["all"] = SPLITS["dev"] + SPLITS["test"]


def load_sentences(clip: str, source: str) -> list[dict]:
    if source == "ref":
        return json.loads((DATA / "ref" / f"{clip}.json").read_text(encoding="utf-8"))
    if source == "whisper":
        from echotrace import asr_whisper
        return asr_whisper.transcribe(DATA / "clips" / f"{clip}.wav")["sentences"]
    return transcribe(DATA / "clips" / f"{clip}.wav")["sentences"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clips", nargs="*")
    ap.add_argument("--method", choices=["segmented", "baseline"], required=True)
    ap.add_argument("--source", choices=["asr", "whisper", "ref"], required=True)
    ap.add_argument("--split", choices=list(SPLITS), default=None)
    ap.add_argument("--out", type=Path, default=Path("results/minutes"))
    ap.add_argument("--no-merge", action="store_true", help="segmented 不合并 ASR 碎句（消融对照）")
    ap.add_argument("--model", default=None, help="整理用的模型，默认 DeepSeek；非默认模型输出目录加 _模型名 后缀")
    args = ap.parse_args()
    clips = args.clips or SPLITS[args.split or "dev"]

    model = args.model or minutes.llm.DEFAULT_MODEL
    suffix = "" if model == minutes.llm.DEFAULT_MODEL else f"_{model}"
    out = args.out / f"{args.method}_{args.source}{suffix}"
    out.mkdir(parents=True, exist_ok=True)
    for clip in clips:
        sents = load_sentences(clip, args.source)
        if args.method == "segmented":
            res = minutes.extract_segmented(sents, model=model, merge=not args.no_merge)
        else:
            res = minutes.extract_baseline(sents, model=model)
        res["clip"], res["source"] = clip, args.source
        (out / f"{clip}.json").write_text(minutes.dumps(res), encoding="utf-8")
        (out / f"{clip}.md").write_text(minutes.to_markdown(res, clip), encoding="utf-8")
        n_flag = sum(bool(it["flags"]) for it in res["items"])
        print(f"{clip}: {len(res['items'])} 条（{n_flag} 条带提示，丢弃 {len(res['dropped'])}），"
              f"{res['llm_calls']} 次调用，{res['usage']['prompt_tokens']}+{res['usage']['completion_tokens']} tokens，{res['elapsed']}s")


if __name__ == "__main__":
    main()
