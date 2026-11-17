# 纪要输出目录

目录名格式：`{method}_{source}`，非默认模型再加 `_{model}`。

- `method`：`segmented`（分段 + 证据编号）或 `baseline`（整段直接摘要）。
- `source`：`asr`（FunASR）、`whisper`（faster-whisper-small）或 `ref`（AliMeeting 人工转写）。

## 当前主结果

- `segmented_asr/`、`segmented_ref/`、`baseline_asr/`、`baseline_ref/`：dev + test，当前流程。
- `segmented_asr/` 和 `segmented_ref/` 来自 2026-11-13 之后的“合并 ASR 碎句”版本（`merge=True`）。
- baseline 不走碎句合并，所以 early baseline 结果与当前代码一致。

## 历史快照

- `segmented_whisper/`：Whisper 转写的分段纪要，test only，合并碎句之前生成。
- `*_kimi-k3.1-pro/`：Kimi 整理模型对照，test only，合并碎句之前生成。

这些目录不参与当前主评测。当前数字见 `../eval/summary_{dev,test}.md`，完整索引见 `../README.md`。

## 相关参数

- `--no-merge`：只用于消融，输出到 `../ablation/no_merge/`。
- `--model`：切换整理模型；非默认模型会自动加后缀，避免覆盖主结果。
