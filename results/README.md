# results 索引

本目录只保留一套当前主结果，历史实验单独标注，避免 v1/v2 混用。

## 当前主结果

| 路径 | 内容 |
|---|---|
| `minutes/segmented_asr/` | 分段 + 证据绑定，ASR 转写，dev + test；当前流程（合并 ASR 碎句） |
| `minutes/segmented_ref/` | 同一方案，人工转写；dev + test |
| `minutes/baseline_asr/` | 直接摘要对照组，ASR 转写；dev + test |
| `minutes/baseline_ref/` | 直接摘要对照组，人工转写；dev + test |
| `eval/summary_{dev,test}.md` | 上面四组的主评测；明细在同目录 `{run}_{split}.json` |
| `error_attribution/` | 由当前 `eval/` 重新生成的误差归因（`summary_all.md`、`summary_test.md`） |
| `alimeeting_cer.csv` | Paraformer 在 10 段上的 CER 与 CPU 耗时 |
| `asr_compare/` | Paraformer vs faster-whisper-small 的 CER、耗时、证据覆盖（ASR 层，不受碎句合并影响） |
| `demo/` | 网页默认加载的 clip01 示例（当前 segmented ASR 输出） |

## 消融

| 路径 | 内容 |
|---|---|
| `ablation/no_merge/` | dev clip01–05 的“不合并 ASR 碎句”消融，见该目录 README |

## 历史快照（不要和当前主结果混用）

- `minutes/segmented_whisper/`：Whisper 转写的分段纪要，合并碎句之前生成。
- `minutes/*_kimi-k3.1-pro/`：Kimi 整理模型对照，合并碎句之前生成。
- `asr_compare/README.md` 的“纪要层对照”表：合并前的 Paraformer/Whisper/人工转写对比。
- `llm_compare/`：DeepSeek vs Kimi 的完整对照，合并前的历史快照。

这些历史目录保留原始数字用于记录实验过程；当前主评测以 `eval/summary_{dev,test}.md` 为准。旧的分段 v1 结果已在 2026-11-17 被 v2（合并碎句）替换，需要时可以从 git 历史找回。

## 复现

```bash
# 生成四组主结果（需要 DeepSeek API；已有缓存时不会重复调用）
uv run echotrace minutes --method segmented --source asr --split dev
uv run echotrace minutes --method segmented --source ref --split dev
uv run echotrace minutes --method baseline  --source asr --split dev
uv run echotrace minutes --method baseline  --source ref --split dev

# 评测与归因
uv run echotrace evaluate segmented_asr segmented_ref baseline_asr baseline_ref --split dev
uv run echotrace attribute --split all
```

测试集把 `--split dev` 换成 `--split test`。
