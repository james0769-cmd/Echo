# ASR 对照实验：Paraformer-large vs faster-whisper-small

- 主方案：FunASR `speech_seaco_paraformer_large` + fsmn-vad + ct-punc（`src/echotrace/asr.py`）
- 对照：[Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small)，CTranslate2 int8，CPU，`language=zh`、`beam_size=5`、`vad_filter=True`、`word_timestamps=True`，提示句引导简体+标点（`src/echotrace/asr_whisper.py`）。
  权重取自 ModelScope 同名仓库，`model.bin` SHA-256 `3e305921…d671` 与 Hugging Face 官方一致。
- 数据：AliMeeting 10 段（dev clip01–05 / test clip06–10），每段约 4 分钟，共 2410 s。
- 硬件：Apple M5 CPU。耗时为首次转写墙钟时间，之后读缓存。
- 复现：`.venv/bin/python scripts/compare_asr.py`；明细见 `cer.csv`、`evidence.csv`、`numbers.md`，汇总表见 `summary.md`。

## 结果

| 子集 | 引擎 | CER | CER(数字转汉字) | 删除 | 插入 | 总耗时 | RTF | 证据字覆盖率 | 证据可定位且落在人工时间段 |
|---|---|---|---|---|---|---|---|---|---|
| 全部 | Paraformer | **22.44%** | 22.44% | 2044 | 223 | 257 s | **0.107** | **0.909** | **90/91** |
| 全部 | Whisper-small | 28.45% | 28.09% | 2873 | 97 | 597 s | 0.248 | 0.823 | 86/91 |
| test | Paraformer | **12.13%** | 12.13% | 389 | 78 | 144 s | **0.121** | **0.947** | **42/42** |
| test | Whisper-small | 16.72% | 16.57% | 672 | 36 | 307 s | 0.258 | 0.896 | 41/42 |

证据指标基于事实表 `facts/facts_all.csv` 全部 91 条（含信息类）：「字覆盖率」= 人工时间段（±0.5 s）内 ASR 文字按序覆盖原话的比例；「可定位」= 用 `evidence.locate`（阈值 0.6）在 ASR 转写里找到原话，且时间段与人工时间段重叠。

## 观察

1. **准确率**：10 段里 Paraformer 每段都更好，总体 CER 低约 6 个百分点。差距主要来自**删除**（2873 vs 2044）：Whisper 在多人交叠、语速快的地方整句漏掉，插入反而更少（不容易"编"字）。
2. **数字写法不是主要差距**：Whisper 输出阿拉伯数字（"18到5岁"），按汉字读法改写后 CER 只降 0.36 个百分点。
3. **速度**：Whisper-small 在 CPU 上慢约 2.3 倍（RTF 0.25 vs 0.11），但 4 分钟录音也只需约 1 分钟，满足离线要求。
4. **整段漏识别会直接丢掉证据**：clip07 13–29 s 的 16 秒，Whisper 完全没有输出，事实 `clip07-f02`（共识：「企业也应该像连锁经营这些连锁化和现代化……迈进」）在 Whisper 转写中字覆盖率只有 0.18，无法定位；Paraformer 为 0.87。这类错误下游大模型无从补救，只会表现为召回下降。
5. **标点不稳定**：部分片段（如 clip02 开头）Whisper 不输出标点，只能靠 1 s 停顿断句，句子变长，证据时间段会更宽。

## 数字转写错误示例（clip01-f05，待办）

人工原话 [142.72–150.87 s]：「后续再定一下这个就是**十八到五十岁**之间的色彩颜色啊，咱们到时候确认一下这个颜色好吧。」

| 来源 | 转写 |
|---|---|
| Paraformer | ……这个就是**十八到五岁**之间这个色彩颜色啊…… |
| Whisper-small | ……**18到5岁**之间的色彩**原色**…… |

两个模型都把「五十」识别成「五」（Whisper 还把「颜色」识别为「原色」），纪要里年龄区间会变成"18–5 岁"这种错误事实。处理方式：程序给出的证据时间段 142.72–150.87 s 能覆盖这句原话，人工从纪要跳转回听即可改正；用人工修正转写（`--source ref`）跑同一流程可以确认这是识别错误而不是整理错误。

同一段的 `clip01-f04`（未决，「十八到三十五岁……十八到五十岁」）中，Whisper 整句漏掉了「十八到三十五岁」，只剩「45岁之间都可以」，证据字覆盖率 0.39（Paraformer 0.95）。新事实表在这条的备注里也标了「关键数字存疑」，建议回听 01:59–02:31。

## 纪要层对照（test clip06–10，segmented 方案）

用 Whisper 转写跑同一条分段整理流程（`run_minutes.py --method segmented --source whisper --split test`），按同一事实表、同一对齐模型评测（`eval_minutes.py`），明细见 `minutes_eval_whisper_test.json`，纪要输出在 `results/minutes/segmented_whisper/`。

| 指标 | Paraformer | Whisper-small | 人工转写 |
|---|---|---|---|
| 精确率 | 0.812 | 0.824 | 0.848 |
| 召回率 | 0.857 | 0.905 | 0.905 |
| 决定+待办 精确率 | 0.818 | 0.769 | 0.875 |
| 决定+共识+待办 召回率 | **1.0** | 0.917 | 1.0 |
| 类型一致 | 0.833 | 0.789 | 0.895 |
| 虚构负责人 / 截止 | 0 / 0 | 0 / 0 | 0 / 0 |
| 原话片段覆盖率 | **0.667** | 0.608 | 0.74 |
| 对上条目含原话 | 0.944 | 1.0 | 1.0 |
| tokens | 59948 | 69322 | 58858 |

逐条差异（计分标准共 21 条，差距只有 1–2 条，需谨慎解读）：

- 只有 Paraformer 召回：`clip07-f02`（连锁化/现代化，共识）——就是 Whisper 漏掉 13–29 s 的那段，ASR 层的漏识别在这里变成纪要遗漏，也是 Whisper 重要条目召回 0.917 的原因。
- 只有 Whisper 召回：`clip08-f06`（建议公司考虑缴纳公积金）、`clip10-f09`（晚上草地活动、戴面具）。两条都是"提议"类；Paraformer 转写里原话都在，属于**大模型整理时的取舍波动**，不是识别优势（人工转写也只召回了其中 `clip10-f09`）。
- 对上条目的时间段：Paraformer 18 条里有 1 条（`clip08-f10`）没包住标准原话，Whisper 19 条全部包住；但按原话片段算，Whisper 覆盖率更低（0.608 vs 0.667），和 ASR 层"证据字覆盖率 0.896 vs 0.947"一致。

结论：纪要层召回的差别落在大模型抽取的随机波动之内（单次运行，21 条计分标准），不能说明 Whisper 更好；可以确定的是 Whisper 的整段漏识别会造成不可补救的重要条目遗漏（`clip07-f02`）。主 ASR 仍选 Paraformer。

## 结论

本项目继续用 Paraformer 作为主 ASR：准确率更高、更快、证据覆盖更完整。Whisper-small 的主要问题是漏识别，而不是数字写法。
