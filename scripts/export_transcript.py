"""把 ASR 初稿导出成每行一句、带时间段的文本，供人工边听边校对。

原始转写仍留在 data/cache/asr/ 不动；人工只改导出的文本，改完即为人工修正版。
已存在的文件默认跳过，避免覆盖人工改过的内容。

用法：
  .venv/bin/python scripts/export_transcript.py data/private/audio
  .venv/bin/python scripts/export_transcript.py data/public/alimeeting/clips/clip01.wav --out data/public/alimeeting/draft
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from echotrace import transcript  # noqa: E402
from echotrace.asr import transcribe  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+", type=Path, help="wav 文件或包含 wav 的目录")
    ap.add_argument("--out", type=Path, default=Path("data/private/corrected"))
    ap.add_argument("--force", action="store_true", help="覆盖已存在的文件（会丢掉人工修改）")
    args = ap.parse_args()

    wavs = []
    for p in args.inputs:
        if not p.exists():
            sys.exit(f"路径不存在: {p}")
        wavs += sorted(p.glob("*.wav")) if p.is_dir() else [p]
    if not wavs:
        sys.exit("没有找到 wav 文件")

    args.out.mkdir(parents=True, exist_ok=True)
    for wav in wavs:
        out = args.out / f"{wav.stem}.txt"
        if out.exists() and not args.force:
            print(f"{wav.stem}: 已存在，跳过 {out}")
            continue
        asr = transcribe(wav)
        text = transcript.dumps(asr["sentences"], source=str(wav))
        assert len(transcript.loads(text)) == len(asr["sentences"])
        out.write_text(text, encoding="utf-8")
        print(f"{wav.stem}: {len(asr['sentences'])} 句 -> {out}")


if __name__ == "__main__":
    main()
