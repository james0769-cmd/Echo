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

**4. 生成纪要**

文本处理用 DeepSeek API，在项目根目录的 `.env` 里写 `DEEPSEEK_API_KEY=...`（`.env` 不入库）。

```bash
uv run python scripts/run_minutes.py --method segmented --source asr --split dev
```

- `--method segmented`：转写切成约 90 秒的块，句子编号后交给模型，模型只返回句子编号，时间段由程序按编号取；负责人、截止日期在原话里找不到的，程序改回"未知"并在纪要里提示。
- `--method baseline`：对照组，整段转写直接交给模型摘要，模型自己摘抄原话，程序再回转写里查找。
- `--source asr|ref`：用 ASR 转写或人工转写跑同一流程，用来区分识别错误和整理错误。
- `--split dev|test|all`：开发集 clip01–05，测试集 clip06–10；调提示词只看开发集。

输出 `results/minutes/{方案}_{来源}/clipNN.{json,md}`。API 返回按请求内容缓存在 `data/cache/llm/`，重跑不重复调用。

**5. 现场演示**

使用一段本地 WAV 录音跑完整链路：语音识别、带时间戳转写、证据分段、结构化纪要和原话回溯。

```bash
uv run python scripts/run_demo.py
```

默认使用 `data/public/alimeeting/clips/clip01.wav`，推荐的分段方案会把结果写入 `results/demo/`：
`transcript.json`、`minutes.json`、`minutes.md` 和适合现场打开的 `demo_report.md`。
也可以指定其他本地 WAV：

```bash
uv run python scripts/run_demo.py --audio path/to/meeting.wav
```

**6. 评测纪要**

```bash
uv run python scripts/eval_minutes.py segmented_asr segmented_ref baseline_asr baseline_ref --split dev
```

对照 `facts/fact_table.json` 统计精确率、召回率、类型一致、遗漏、虚构负责人/截止日期、证据时间段是否覆盖原话。条目对齐由 DeepSeek 判断，对齐明细在 `results/eval/{run}_{split}.json`，需要人工抽查；汇总表 `results/eval/summary_{split}.md`。

## 目录

```
src/echotrace/asr.py              本地转写 + 缓存
src/echotrace/transcript.py       校对稿格式读写
src/echotrace/llm.py              DeepSeek 调用 + 缓存
src/echotrace/minutes.py          纪要生成（分段证据方案 / 直接摘要基线）
src/echotrace/evidence.py         在转写里定位原话的时间段
scripts/make_alimeeting_clips.py  从 AliMeeting 切片段
scripts/eval_cer.py               CER 评测
scripts/export_transcript.py      导出校对稿
scripts/run_minutes.py            生成纪要
scripts/eval_minutes.py           纪要评测
data/public/                      公开数据集（音频不入库）
data/public/alimeeting/facts/     人工事实表（评测标准答案）
data/private/                     私有录音及其转写、标注（整个目录不入库）
data/cache/                       ASR 与 LLM 缓存（不入库）
results/                          评测结果
```

## 数据与隐私

- 私有录音须事先取得参与者同意，仅在本地处理，不上传、不公开。
- 录音只在本地离线转写；调用文本 API 时只发送短片段文字。
- 时间戳全部来自转写或人工核对，不由大模型生成。

AliMeeting 数据集使用 CC BY-SA 4.0 许可，引用见 [OpenSLR 119](https://www.openslr.org/119/)。
