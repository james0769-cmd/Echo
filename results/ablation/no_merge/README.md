# 消融：不合并 ASR 碎句（dev）

这项消融比较 `merge_fragments` 的影响：同一分段方案、同一 guard，只切换是否先把 ASR 切碎的半句并回整句。

- 数据：dev clip01–05。
- 目录 `minutes/segmented_asr/` 是 `--no-merge` 的纪要；内部 JSON 的 `"run": "segmented_asr"` 是历史字段，目录名才是消融标识。
- 目录 `eval/` 是用当前事实表和评测流程重算的结果。

复现：

```bash
uv run echotrace minutes --method segmented --source asr --split dev \
  --no-merge --out results/ablation/no_merge/minutes

uv run echotrace evaluate segmented_asr --split dev \
  --root results/ablation/no_merge/minutes \
  --out results/ablation/no_merge/eval
```

## 与合并版本的对比（dev）

| 指标 | 不合并（本消融） | 合并（当前主结果） |
|---|---|---|
| 预测条数 | 46 | 45 |
| 精确率 | 0.804 | 0.733 |
| 召回率 | 0.822 | 0.733 |
| 原话片段覆盖率 | 0.564 | 0.644 |
| 对上条目含原话 | 0.784 | 0.848 |

解读：在 dev 上，合并不提高条目级精确率/召回率，但证据质量更好——预测条目的时间段更容易覆盖标准原话。合并的动机是把模型切碎的半句还原成完整语义单元，减少“半句证据”；这不是一个在全部指标上单调变好的改动，因此保留为消融记录，而不是主结论。

注意：这项消融只覆盖 dev，且计分条目只有 45 条；单条变化就会造成约 0.02 的波动，不要过度解读。
