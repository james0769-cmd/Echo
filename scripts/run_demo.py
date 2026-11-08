"""Run one local audio file through the Echo end-to-end demo.

Pipeline: WAV -> FunASR transcript with timestamps -> segmented minutes -> evidence.

Examples:
  uv run python scripts/run_demo.py
  uv run python scripts/run_demo.py --audio data/public/alimeeting/clips/clip10.wav
  uv run python scripts/run_demo.py --audio path/to/meeting.wav --method baseline
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from echotrace import minutes  # noqa: E402
from echotrace.asr import transcribe  # noqa: E402


ts = minutes._ts  # 与纪要 Markdown 共用：开始向下取整，结束向上取整


def make_report(audio: Path, asr: dict, result: dict) -> str:
    lines = [
        "# Echo 端到端现场演示",
        "",
        f"- 音频：`{audio.name}`",
        f"- ASR：FunASR Paraformer-zh + VAD + 标点",
        f"- 纪要方法：`{result['method']}`",
        f"- 音频时长：{ts(asr['duration'])}",
        f"- ASR 用时：{asr['elapsed']:.2f}s，RTF {asr['rtf']:.4f}",
        f"- 转写句数：{len(asr['sentences'])}",
        f"- 纪要条数：{len(result['items'])}",
        "",
        "## 转写预览",
        "",
        asr.get("text", "")[:1200],
        "",
        "## 结构化纪要",
        "",
    ]
    if not result["items"]:
        lines.append("本段没有抽取到可记录的决定、待办或待确认事项。")
        return "\n".join(lines) + "\n"

    for item in result["items"]:
        lines.extend(
            [
                f"### {item['id']} · {item['topic']} · {item['type']}",
                "",
                f"- 内容：{item['content']}",
                f"- 负责人：{item['responsible']}",
                f"- 截止：{item['deadline']}",
                f"- 时间：{ts(item['evidence_start'])}-{ts(item['evidence_end'], round_up=True)}",
                f"- 证据：{item['evidence_text']}",
            ]
        )
        for flag in item.get("flags", []):
            lines.append(f"- 提示：{flag}")
        lines.append("")
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Echo local end-to-end demo")
    parser.add_argument(
        "--audio",
        type=Path,
        default=Path("data/public/alimeeting/clips/clip01.wav"),
        help="local WAV file; defaults to the included clip01",
    )
    parser.add_argument(
        "--method",
        choices=["segmented", "baseline"],
        default="segmented",
        help="minutes method; segmented is the recommended demo",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("results/demo-live"),
        help="output directory (git-ignored); results/demo/ holds the committed sample",
    )
    args = parser.parse_args()

    audio = args.audio if args.audio.is_absolute() else ROOT / args.audio
    audio = audio.resolve()
    if not audio.exists():
        raise SystemExit(f"音频不存在：{audio}")
    if audio.suffix.lower() != ".wav":
        raise SystemExit("当前现场演示入口要求 16 kHz WAV 音频。")

    out = args.out if args.out.is_absolute() else ROOT / args.out
    out.mkdir(parents=True, exist_ok=True)

    print("[1/4] 读取音频并运行 FunASR...")
    asr = transcribe(audio)
    print(
        f"      {asr['duration']:.2f}s 音频 -> {len(asr['sentences'])} 句，"
        f"用时 {asr['elapsed']:.2f}s，RTF {asr['rtf']:.4f}"
    )

    print("[2/4] 按时间段切分并绑定证据...")
    chunks = minutes.chunk(minutes.number_sentences(asr["sentences"]))
    print(f"      切成 {len(chunks)} 个证据块")

    print(f"[3/4] 使用 {args.method} 方法生成结构化纪要...")
    if args.method == "segmented":
        result = minutes.extract_segmented(asr["sentences"])
    else:
        result = minutes.extract_baseline(asr["sentences"])
    result["audio"] = audio.name
    result["source"] = "asr"
    print(
        f"      输出 {len(result['items'])} 条，调用 {result['llm_calls']} 次，"
        f"用时 {result['elapsed']:.2f}s"
    )

    print("[4/4] 保存转写、纪要和现场摘要...")
    (out / "transcript.json").write_text(
        json.dumps(asr, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    (out / "minutes.json").write_text(
        minutes.dumps(result), encoding="utf-8"
    )
    (out / "minutes.md").write_text(
        minutes.to_markdown(result, audio.stem), encoding="utf-8"
    )
    (out / "demo_report.md").write_text(
        make_report(audio, asr, result), encoding="utf-8"
    )

    print(f"      结果目录：{out}")
    print("      可打开 demo_report.md 查看现场展示结果。")


if __name__ == "__main__":
    main()
