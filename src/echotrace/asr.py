"""本地 FunASR 转写，结果按音频内容缓存。

同一段音频 + 同一套模型配置只转写一次，缓存里保留 FunASR 的原始输出，
另外整理出以秒为单位的句子列表，供后续切句编号和证据绑定使用。
"""

import hashlib
import json
import os
import re
import time
import wave
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = PROJECT_ROOT / "data" / "cache" / "asr"

# 模型和 ModelScope 配置都放在项目内，不写用户主目录
os.environ.setdefault("MODELSCOPE_CACHE", str(PROJECT_ROOT / ".cache" / "modelscope"))
os.environ.setdefault("MODELSCOPE_CREDENTIALS_PATH", str(PROJECT_ROOT / ".cache" / "modelscope_credentials"))

# 即 FunASR 别名 paraformer-zh / fsmn-vad / ct-punc 对应的 ModelScope 模型
MODEL_CONFIG = {
    "model": "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "vad_model": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "punc_model": "iic/punc_ct-transformer_cn-en-common-vocab471067-large",
}

_model = None


def _local_dir(model_id: str) -> str:
    """返回模型本地目录；本地没有完整模型时才联网下载一次。"""
    org, name = model_id.split("/")
    root = Path(os.environ["MODELSCOPE_CACHE"]) / "models" / f"{org}--{name}" / "snapshots"
    for snap in sorted(root.glob("*")):
        if (snap / "model.pt").exists():
            return str(snap)
    from modelscope import snapshot_download

    return snapshot_download(model_id)


def _get_model():
    global _model
    if _model is None:
        from funasr import AutoModel

        paths = {k: _local_dir(v) for k, v in MODEL_CONFIG.items()}
        _model = AutoModel(**paths, disable_update=True)
    return _model


def _cache_key(audio_path: Path) -> str:
    h = hashlib.sha256(audio_path.read_bytes())
    h.update(json.dumps(MODEL_CONFIG, sort_keys=True).encode())
    return h.hexdigest()[:16]


def _duration(audio_path: Path) -> float:
    with wave.open(str(audio_path)) as w:
        return w.getnframes() / w.getframerate()


# 一个时间戳对应一个 token：汉字逐字，连续的英文字母/数字算一个
_TOKEN_RE = re.compile(r"[A-Za-z0-9']+|[^\W\d_A-Za-z]")
_SENT_END = set("，。？！；,.?!;")


def sentences_from_raw(raw: dict) -> list[dict]:
    """用 FunASR 的全文 text 和逐 token 时间戳自己切句，时间单位秒。

    不用 FunASR 的 sentence_info：实测它在长音频里会把文字和时间戳错位
    （clip03 中"老师呢这一天"逐字时间戳是 172.5s，sentence_info 却标成 164.9s 且吞掉了"老"字，
    越往后偏得越多，最多约 12 秒）。逐字时间戳本身与人工转写对得上。
    """
    text, ts = raw.get("text", ""), raw.get("timestamp") or []
    tokens = list(_TOKEN_RE.finditer(text))
    if len(tokens) != len(ts):
        raise ValueError(f"token 数 {len(tokens)} 与时间戳数 {len(ts)} 不一致，无法对齐")
    sentences, buf, first, last, k = [], "", None, None, 0
    pos = 0
    for m in tokens:
        buf += text[pos : m.end()]
        pos = m.end()
        if first is None:
            first = ts[k][0]
        last = ts[k][1]
        k += 1
        # 把紧跟在 token 后的标点并进当前句，遇到断句标点就收句
        j = pos
        while j < len(text) and not _TOKEN_RE.match(text, j) and text[j] not in " \t\n":
            j += 1
        tail = text[pos:j]
        if tail and any(c in _SENT_END for c in tail):
            buf += tail
            pos = j
            sentences.append({"start": first / 1000, "end": last / 1000, "text": buf.strip()})
            buf, first = "", None
    buf += text[pos:]
    if first is not None and buf.strip():
        sentences.append({"start": first / 1000, "end": last / 1000, "text": buf.strip()})
    return sentences


def transcribe(audio_path, use_cache: bool = True) -> dict:
    """返回 {audio, duration, elapsed, rtf, text, sentences, raw}，时间单位秒。

    sentences 每次都由缓存里的原始输出（raw）重新切出，见 sentences_from_raw。
    """
    audio_path = Path(audio_path)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_file = CACHE_DIR / f"{audio_path.stem}_{_cache_key(audio_path)}.json"
    if use_cache and cache_file.exists():
        result = json.loads(cache_file.read_text(encoding="utf-8"))
        result["sentences"] = sentences_from_raw(result["raw"])
        return result

    model = _get_model()
    t0 = time.perf_counter()
    raw = model.generate(input=str(audio_path), sentence_timestamp=True)[0]
    elapsed = time.perf_counter() - t0

    duration = _duration(audio_path)
    sentences = sentences_from_raw(raw)
    result = {
        "audio": str(audio_path),
        "model_config": MODEL_CONFIG,
        "duration": round(duration, 3),
        "elapsed": round(elapsed, 3),
        "rtf": round(elapsed / duration, 4),
        "text": raw.get("text", ""),
        "sentences": sentences,
        "raw": raw,
    }
    cache_file.write_text(json.dumps(result, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    return result
