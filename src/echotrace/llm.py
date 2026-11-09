"""文本 API（DeepSeek / Kimi，均为 OpenAI 兼容接口），只发送短文本片段，不发送音频。

密钥从项目根目录的 .env 读取，.env 不进 git：
  DEEPSEEK_API_KEY、DEEPSEEK_BASE_URL —— 模型名不以 kimi 开头时使用
  KIMI_API_KEY、KIMI_BASE_URL —— 模型名以 kimi 开头时使用（Moonshot 接口，只接受 temperature=1）
每次请求按 (模型, 参数, 消息) 的哈希缓存到 data/cache/llm/，重跑实验不重复花钱，结果也可复现。
"""

import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = ROOT / "data" / "cache" / "llm"
DEFAULT_MODEL = "deepseek-flash"

_clients: dict = {}

PROVIDERS = {
    "deepseek": ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "https://api.deepseek.com"),
    "kimi": ("KIMI_API_KEY", "KIMI_BASE_URL", "https://api.moonshot.cn/v1"),
}


def provider(model: str) -> str:
    return "kimi" if model.startswith("kimi") else "deepseek"


def _load_env():
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip("\"'"))


def _get_client(model: str):
    name = provider(model)
    if name not in _clients:
        from openai import OpenAI

        _load_env()
        key_var, url_var, default_url = PROVIDERS[name]
        key = os.environ.get(key_var)
        if not key:
            raise RuntimeError(f"缺少 {key_var}，请写进项目根目录的 .env")
        url = os.environ.get(url_var, default_url).rstrip("/")
        if name == "kimi" and not url.endswith("/v1"):
            url += "/v1"  # Moonshot 的 OpenAI 兼容接口在 /v1 下
        _clients[name] = OpenAI(api_key=key, base_url=url)
    return _clients[name]


def chat_json(system: str, user: str, model: str = DEFAULT_MODEL, temperature: float = 0.0, use_cache: bool = True, retries: int = 3) -> dict:
    """调用一次对话并要求返回 JSON 对象；返回 {"data": 解析后的对象, "usage": {...}, "cached": bool}。"""
    if provider(model) == "kimi":
        temperature = 1.0  # Kimi K3 系列只接受 1；结果有随机性，靠缓存保证重跑一致
    payload = {"model": model, "temperature": temperature, "system": system, "user": user}
    key = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:20]
    path = CACHE_DIR / f"{key}.json"
    if use_cache and path.exists():
        rec = json.loads(path.read_text(encoding="utf-8"))
        return {"data": rec["data"], "usage": rec["usage"], "cached": True}

    # 模型偶尔返回空内容或不完整的 JSON，重试几次
    for attempt in range(retries):
        resp = _get_client(model).chat.completions.create(
            model=model,
            temperature=temperature,
            response_format={"type": "json_object"},
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        )
        content = resp.choices[0].message.content or ""
        try:
            data = json.loads(content)
            break
        except json.JSONDecodeError:
            if attempt == retries - 1:
                raise RuntimeError(f"模型连续 {retries} 次没有返回合法 JSON，最后一次内容: {content[:200]!r}")
    usage = {"prompt_tokens": resp.usage.prompt_tokens, "completion_tokens": resp.usage.completion_tokens}
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"request": payload, "raw": content, "data": data, "usage": usage}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    return {"data": data, "usage": usage, "cached": False}
