"""对 AliMeeting 片段生成纪要，输出到 results/minutes/{方案}_{转写来源}/。

转写来源：
  asr  FunASR 原始转写（data/cache/asr，需要 clips/*.wav 才能定位缓存）
  whisper  faster-whisper-small 转写（data/cache/asr_whisper），ASR 对照实验用
  ref  AliMeeting 人工转写（data/public/alimeeting/ref），用来区分识别错误与整理错误

用法：
  echotrace minutes --method segmented --source asr --split dev
  echotrace minutes --method baseline --source ref clip01 clip02
"""

import argparse
import json
from pathlib import Path

from .. import minutes as core_minutes
from ..asr import transcribe
from ..paths import ALIMEETING, RESULTS, SPLITS


def load_sentences(clip: str, source: str) -> list[dict]:
    if source == "ref":
        return json.loads((ALIMEETING / "ref" / f"{clip}.json").read_text(encoding="utf-8"))
    if source == "whisper":
        from .. import asr_whisper
        return asr_whisper.transcribe(ALIMEETING / "clips" / f"{clip}.wav")["sentences"]
    return transcribe(ALIMEETING / "clips" / f"{clip}.wav")["sentences"]


def register(subparsers):
    ap = subparsers.add_parser("minutes", help="生成带时间戳证据的会议纪要")
    ap.add_argument("clips", nargs="*")
    ap.add_argument("--method", choices=["segmented", "baseline"], required=True)
    ap.add_argument("--source", choices=["asr", "whisper", "ref"], required=True)
    ap.add_argument("--split", choices=list(SPLITS), default=None)
    ap.add_argument("--out", type=Path, default=RESULTS / "minutes")
    ap.add_argument("--no-merge", action="store_true", help="segmented 不合并 ASR 碎句（消融对照）")
    ap.add_argument("--model", default=None, help="整理用的模型，默认 DeepSeek；非默认模型输出目录加 _模型名 后缀")
    ap.set_defaults(func=run)


def run(args):
    clips = args.clips or SPLITS[args.split or "dev"]

    model = args.model or core_minutes.llm.DEFAULT_MODEL
    suffix = "" if model == core_minutes.llm.DEFAULT_MODEL else f"_{model}"
    out = args.out / f"{args.method}_{args.source}{suffix}"
    out.mkdir(parents=True, exist_ok=True)
    for clip in clips:
        sents = load_sentences(clip, args.source)
        if args.method == "segmented":
            res = core_minutes.extract_segmented(sents, model=model, merge=not args.no_merge)
        else:
            res = core_minutes.extract_baseline(sents, model=model)
        res["clip"], res["source"] = clip, args.source
        (out / f"{clip}.json").write_text(core_minutes.dumps(res), encoding="utf-8")
        (out / f"{clip}.md").write_text(core_minutes.to_markdown(res, clip), encoding="utf-8")
        n_flag = sum(bool(it["flags"]) for it in res["items"])
        print(f"{clip}: {len(res['items'])} 条（{n_flag} 条带提示，丢弃 {len(res['dropped'])}），"
              f"{res['llm_calls']} 次调用，{res['usage']['prompt_tokens']}+{res['usage']['completion_tokens']} tokens，{res['elapsed']}s")
