"""对照 ASR：faster-whisper-small（Systran/faster-whisper-small，CTranslate2 int8，CPU）。

接口与 echotrace.asr.transcribe 相同，返回 {audio, duration, elapsed, rtf, text, sentences, raw}，
可直接替换进纪要流程。缓存放在 data/cache/asr_whisper/，raw 保留 Whisper 的分段和逐词时间戳。

时间戳只取自 Whisper 的逐词时间戳（word_timestamps=True），句子边界由程序按标点和停顿切出。
"""

import hashlib
import json
import os
import time
import wave
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = PROJECT_ROOT / "data" / "cache" / "asr_whisper"

# 权重从 ModelScope 的 Systran/faster-whisper-small 下载到项目内 .cache/modelscope
# （HF 直连太慢；该副本 model.bin 的 SHA-256 3e305921…d671 与 Hugging Face 官方一致）
os.environ.setdefault("MODELSCOPE_CACHE", str(PROJECT_ROOT / ".cache" / "modelscope"))
os.environ.setdefault("MODELSCOPE_CREDENTIALS_PATH", str(PROJECT_ROOT / ".cache" / "modelscope_credentials"))
MODEL_SHA256 = "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671"


def _local_dir() -> str:
    """返回本地模型目录；没有时从 ModelScope 下载一次，并校验 model.bin 哈希。"""
    snap = Path(os.environ["MODELSCOPE_CACHE"]) / "models" / "Systran--faster-whisper-small" / "snapshots" / "master"
    if not (snap / "model.bin").exists():
        from modelscope import snapshot_download

        snap = Path(snapshot_download(MODEL_CONFIG["model"]))
        h = hashlib.sha256()
        with open(snap / "model.bin", "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != MODEL_SHA256:
            raise RuntimeError(f"model.bin 哈希不符：{h.hexdigest()}")
    return str(snap)

MODEL_CONFIG = {
    "model": "Systran/faster-whisper-small",
    "device": "cpu",
    "compute_type": "int8",
    "language": "zh",
    "beam_size": 5,
    "vad_filter": True,
    "word_timestamps": True,
    # Whisper 中文常输出繁体、且不加标点；用简体带标点的提示句引导输出风格
    "initial_prompt": "以下是普通话会议录音的转写，使用简体中文和标点符号。",
}

_SENT_END = set("，。？！；,.?!;")
_MAX_GAP = 1.0  # 两词间停顿超过该秒数也断句（Whisper 有时整段不加标点）

_model = None


def _get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        _model = WhisperModel(
            _local_dir(),
            device=MODEL_CONFIG["device"],
            compute_type=MODEL_CONFIG["compute_type"],
            cpu_threads=os.cpu_count() or 4,
        )
    return _model


def _cache_key(audio_path: Path) -> str:
    h = hashlib.sha256(audio_path.read_bytes())
    h.update(json.dumps(MODEL_CONFIG, sort_keys=True).encode())
    return h.hexdigest()[:16]


def _duration(audio_path: Path) -> float:
    with wave.open(str(audio_path)) as w:
        return w.getnframes() / w.getframerate()


def sentences_from_raw(raw: list[dict]) -> list[dict]:
    """按逐词时间戳切句：遇到断句标点、两词停顿超过 _MAX_GAP 或 Whisper 分段边界就收句。"""
    sentences = []
    for seg in raw:
        words = seg.get("words") or []
        if not words:  # 没有逐词时间戳时退回整段
            if seg["text"].strip():
                sentences.append({"start": seg["start"], "end": seg["end"], "text": seg["text"].strip()})
            continue
        buf, first, last = "", None, None
        for w in words:
            if first is not None and w["start"] - last > _MAX_GAP and buf.strip():
                sentences.append({"start": first, "end": last, "text": buf.strip()})
                buf, first = "", None
            if first is None:
                first = w["start"]
            buf += w["word"]
            last = w["end"]
            if w["word"].strip() and w["word"].strip()[-1] in _SENT_END:
                sentences.append({"start": first, "end": last, "text": buf.strip()})
                buf, first = "", None
        if first is not None and buf.strip():
            sentences.append({"start": first, "end": last, "text": buf.strip()})
    return [{**s, "start": round(s["start"], 3), "end": round(s["end"], 3)} for s in sentences]


def transcribe(audio_path, use_cache: bool = True) -> dict:
    audio_path = Path(audio_path)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{audio_path.stem}_{_cache_key(audio_path)}.json"
    if use_cache and cache_file.exists():
        result = json.loads(cache_file.read_text(encoding="utf-8"))
        result["sentences"] = sentences_from_raw(result["raw"])
        return result

    model = _get_model()
    cfg = {k: v for k, v in MODEL_CONFIG.items() if k not in ("model", "device", "compute_type")}
    t0 = time.perf_counter()
    segments, _info = model.transcribe(str(audio_path), **cfg)
    raw = [
        {
            "start": s.start, "end": s.end, "text": s.text,
            "avg_logprob": s.avg_logprob, "no_speech_prob": s.no_speech_prob,
            "words": [{"start": w.start, "end": w.end, "word": w.word, "prob": w.probability}
                      for w in (s.words or [])],
        }
        for s in segments  # 生成器，迭代时才真正解码，计时要包含这一步
    ]
    elapsed = time.perf_counter() - t0

    duration = _duration(audio_path)
    result = {
        "audio": str(audio_path),
        "model_config": MODEL_CONFIG,
        "duration": round(duration, 3),
        "elapsed": round(elapsed, 3),
        "rtf": round(elapsed / duration, 4),
        "text": "".join(s["text"] for s in raw).strip(),
        "sentences": sentences_from_raw(raw),
        "raw": raw,
    }
    cache_file.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    return result
