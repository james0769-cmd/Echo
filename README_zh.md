# EchoTrace

带时间戳证据的录音纪要助手

[English](README.md) · 中文

## 环境

需要 Python 3.11+、[uv](https://docs.astral.sh/uv/) 和 ffmpeg。

```bash
uv sync
```

FunASR 模型（约 2.8 GB）在第一次转写时自动从 ModelScope 下载到 `.cache/modelscope/`，之后完全离线加载。

## 使用

**1. 准备公开参考集**（可选）

下载 [AliMeeting](https://www.openslr.org/119/) 的 `Eval_Ali.tar.gz`，解压出近场数据后：

```bash
uv run python scripts/make_alimeeting_clips.py --src ~/Eval_Ali/Eval_Ali_near
```

输出到 `data/public/alimeeting/`：`clips/` 音频、`ref/` 人工转写、`manifest.csv` 片段来源。

`facts/` 是小组按 `ref/` 人工整理的事实表（决定、待办、待确认，附原话和时间段），作为纪要评测的标准答案；判定规则写在 `fact_table.json` 的 `rules` 里，`review_queue.md` 列出仍需回听的条目。

**2. 转写并计算 CER**

```bash
uv run python scripts/eval_cer.py
```

结果写入 `results/alimeeting_cer.csv`。转写缓存在 `data/cache/asr/`。

**3. 导出校对稿**

```bash
uv run python scripts/export_transcript.py data/private/audio
```

把 ASR 初稿导出为每行一句、带时间段的文本（默认写到 `data/private/corrected/`），人工边听边改文字，改完即为人工修正版。原始转写仍保留在缓存里不动；已存在的校对稿默认跳过，不会被覆盖。

## 目录

```
src/echotrace/asr.py              本地转写 + 缓存
src/echotrace/transcript.py       校对稿格式读写
scripts/make_alimeeting_clips.py  从 AliMeeting 切片段
scripts/eval_cer.py               CER 评测
scripts/export_transcript.py      导出校对稿
data/public/                      公开数据集（音频不入库）
data/public/alimeeting/facts/     人工事实表（评测标准答案）
data/private/                     私有录音及其转写、标注（整个目录不入库）
data/cache/                       ASR 缓存（不入库）
results/                          评测结果
```

## 数据与隐私

- 私有录音须事先取得参与者同意，仅在本地处理，不上传、不公开。
- 录音只在本地离线转写；调用文本 API 时只发送短片段文字。
- 时间戳全部来自转写或人工核对，不由大模型生成。

AliMeeting 数据集使用 CC BY-SA 4.0 许可，引用见 [OpenSLR 119](https://www.openslr.org/119/)。
