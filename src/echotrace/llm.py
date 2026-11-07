"""DeepSeek 文本 API（OpenAI 兼容接口），只发送短文本片段，不发送音频。

密钥从项目根目录的 .env 读取（DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL），.env 不进 git。
每次请求按 (模型, 参数, 消息) 的哈希缓存到 data/cache/llm/，重跑实验不重复花钱，结果也可复现。
"""

import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = ROOT / "data" / "cache" / "llm"
DEFAULT_MODEL = "deepseek-flash"

_client = None


def _load_env():
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


def _get_client():
    global _client
    if _client is None:
        from openai import OpenAI

        _load_env()
        key = os.environ.get("DEEPSEEK_API_KEY")
        if not key:
            raise RuntimeError("缺少 DEEPSEEK_API_KEY，请写进项目根目录的 .env")
        _client = OpenAI(api_key=key, base_url=os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com"))
    return _client


def chat_json(system: str, user: str, model: str = DEFAULT_MODEL, temperature: float = 0.0, use_cache: bool = True) -> dict:
    """调用一次对话并要求返回 JSON 对象；返回 {"data": 解析后的对象, "usage": {...}, "cached": bool}。"""
    payload = {"model": model, "temperature": temperature, "system": system, "user": user}
    key = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:20]
    path = CACHE_DIR / f"{key}.json"
    if use_cache and path.exists():
        rec = json.loads(path.read_text(encoding="utf-8"))
        return {"data": rec["data"], "usage": rec["usage"], "cached": True}

    resp = _get_client().chat.completions.create(
        model=model,
        temperature=temperature,
        response_format={"type": "json_object"},
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
    )
    content = resp.choices[0].message.content
    data = json.loads(content)
    usage = {"prompt_tokens": resp.usage.prompt_tokens, "completion_tokens": resp.usage.completion_tokens}
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"request": payload, "raw": content, "data": data, "usage": usage}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    return {"data": data, "usage": usage, "cached": False}
