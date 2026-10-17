"""从 AliMeeting Eval 近场数据切出若干段 3-5 分钟的短片段，作为公开参考集。

每场会议的多路耳麦音频混成一路 16kHz 单声道，片段边界只落在没人说话的间隙，
保证人工转写的每一句都完整落在片段内。输出：
  clips/clipNN.wav     片段音频
  ref/clipNN.json      人工转写（时间相对片段起点，单位秒）
  ref/clipNN.txt       同上，便于人读
  manifest.csv         片段来源与起止时间

用法：python3 scripts/make_alimeeting_clips.py --src ~/Eval_Ali/Eval_Ali_near
"""

import argparse
import csv
import json
import re
import subprocess
from collections import defaultdict
from pathlib import Path


def parse_textgrid(path):
    """解析 Praat 长格式 TextGrid，返回 [(tier名, xmin, xmax, text)]，跳过空文本。"""
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "utf-16", "gbk"):
        try:
            content = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    items = []
    tier = None
    xmin = xmax = None
    for line in content.splitlines():
        line = line.strip()
        if m := re.match(r'name = "(.*)"', line):
            tier = m.group(1)
        elif m := re.match(r"xmin = ([\d.]+)", line):
            xmin = float(m.group(1))
        elif m := re.match(r"xmax = ([\d.]+)", line):
            xmax = float(m.group(1))
        elif m := re.match(r'text = "(.*)"', line):
            text = m.group(1).strip()
            if text:
                items.append((tier, xmin, xmax, text))
    return items


def pick_windows(segs, n, min_len, max_len, target_len, skip_head):
    """在会议内挑 n 个互不重叠的窗口，边界只落在所有说话段之间的间隙。"""
    segs = sorted(segs, key=lambda s: s["start"])
    # 合法切点：此刻没有任何说话段跨过
    cuts = []
    covered_until = 0.0
    for s in segs:
        if s["start"] >= covered_until:
            cuts.append(s["start"])
        covered_until = max(covered_until, s["end"])
    cuts.append(covered_until)

    meeting_end = covered_until
    span = (meeting_end - skip_head) / n
    windows = []
    for i in range(n):
        lo = skip_head + i * span
        start = next((c for c in cuts if c >= lo), None)
        if start is None:
            break
        ends = [c for c in cuts if min_len <= c - start <= max_len]
        if not ends:
            continue
        end = min(ends, key=lambda c: abs(c - start - target_len))
        if windows and start < windows[-1][1]:
            continue
        windows.append((start, end))
    return windows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, type=Path, help="Eval_Ali_near 目录")
    ap.add_argument("--out", type=Path, default=Path("data/public/alimeeting"))
    ap.add_argument("--n", type=int, default=10)
    ap.add_argument("--min-len", type=float, default=180)
    ap.add_argument("--max-len", type=float, default=300)
    ap.add_argument("--target-len", type=float, default=240)
    ap.add_argument("--skip-head", type=float, default=60, help="跳过会议开头的寒暄")
    args = ap.parse_args()

    src = args.src.expanduser()
    wavs = sorted((src / "audio_dir").glob("*.wav"))
    grids = sorted((src / "textgrid_dir").glob("*.TextGrid"))

    # 按会议分组：文件名前两段（如 R8001_M8004）是会议 ID
    def meeting_id(p):
        return "_".join(p.stem.split("_")[:2])

    meeting_wavs = defaultdict(list)
    for w in wavs:
        meeting_wavs[meeting_id(w)].append(w)
    meeting_segs = defaultdict(list)
    for g in grids:
        mid = meeting_id(g)
        for tier, s, e, text in parse_textgrid(g):
            spk = tier if tier and tier.startswith("SPK") else g.stem.split("_")[-1]
            meeting_segs[mid].append({"start": s, "end": e, "speaker": spk, "text": text})

    meetings = sorted(m for m in meeting_wavs if meeting_segs[m])
    if not meetings:
        raise SystemExit(f"在 {src} 下没找到音频和 TextGrid 对得上的会议")

    # 片段尽量平均分到各场会议
    quota = {m: args.n // len(meetings) for m in meetings}
    for m in meetings[: args.n % len(meetings)]:
        quota[m] += 1

    out = args.out
    (out / "clips").mkdir(parents=True, exist_ok=True)
    (out / "ref").mkdir(parents=True, exist_ok=True)
    mix_dir = out / "_mixed"
    mix_dir.mkdir(exist_ok=True)

    rows = []
    idx = 0
    for m in meetings:
        if quota[m] == 0:
            continue
        # 多路耳麦混成一路
        mixed = mix_dir / f"{m}.wav"
        if not mixed.exists():
            ins = meeting_wavs[m]
            cmd = ["ffmpeg", "-y", "-loglevel", "error"]
            for w in ins:
                cmd += ["-i", str(w)]
            cmd += [
                "-filter_complex",
                f"amix=inputs={len(ins)}:normalize=0,alimiter=limit=0.95",
                "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(mixed),
            ]
            subprocess.run(cmd, check=True)

        segs = meeting_segs[m]
        for start, end in pick_windows(segs, quota[m], args.min_len, args.max_len,
                                       args.target_len, args.skip_head):
            idx += 1
            name = f"clip{idx:02d}"
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-ss", f"{start:.3f}", "-to", f"{end:.3f}",
                 "-i", str(mixed), "-c:a", "pcm_s16le", str(out / "clips" / f"{name}.wav")],
                check=True,
            )
            ref = [
                {"start": round(s["start"] - start, 3), "end": round(s["end"] - start, 3),
                 "speaker": s["speaker"], "text": s["text"]}
                for s in sorted(segs, key=lambda s: s["start"])
                if s["start"] >= start and s["end"] <= end
            ]
            (out / "ref" / f"{name}.json").write_text(
                json.dumps(ref, ensure_ascii=False, indent=1), encoding="utf-8")
            (out / "ref" / f"{name}.txt").write_text(
                "\n".join(f"[{r['start']:7.2f}-{r['end']:7.2f}] {r['speaker']}: {r['text']}" for r in ref)
                + "\n", encoding="utf-8")
            rows.append({"clip": name, "meeting": m, "src_start": round(start, 3),
                         "src_end": round(end, 3), "duration": round(end - start, 1),
                         "n_utts": len(ref), "n_chars": sum(len(r["text"]) for r in ref),
                         "n_speakers": len({r["speaker"] for r in ref})})
            print(f"{name}: {m} {start:.1f}-{end:.1f}s ({end - start:.0f}s, {len(ref)} 句)")

    with open(out / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"共 {len(rows)} 段 -> {out}")


if __name__ == "__main__":
    main()
