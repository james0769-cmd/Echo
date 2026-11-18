# EchoTrace Web 工作台

在项目根目录启动：

```bash
node web/server.cjs
```

打开 `http://127.0.0.1:8124`。

## 核心功能

- **主页与多录音会话管理**：主页提供产品核心流程概览、快速拖拽导入入口与会议录音卡片库；自动加载本地已有 `clip01–clip05` 示例会议的最新分段纪要（`results/minutes/segmented_asr`）与 FunASR 转写结果（不加载独立测试集），同时支持在页面内导入本地 16 kHz WAV 录音调用 `echotrace demo` 生成实时会话。
- **转写 ↔ 纪要 ↔ 音频三方联动**：
  - 左侧展示的是与纪要抽取同一套的「合并后整句」（ASR 碎句按 `merge_fragments` 规则并回整句，原始转写仍保留在 `data/cache/asr/`），证据时间段与转写句一一对齐；
  - 点击任意纪要条目，左侧转写原文自动高亮对应时间段的原话并定位滚动；
  - 点击纪要上的证据时间段芯片或底部播放器，支持「证据精听模式」逐段跳播与「全场连播模式」实时字幕跟随（后端支持 HTTP `Range` `206` 精确跳播）；
  - 点击左侧任意转写句的时间戳即可直接从该句开始播放。
- **人工校对与防幻觉核对闭环**：
  - 支持在左栏行内校对 ASR 错字（如数字、人名识别误差），自动同步更新相关证据引文；
  - 支持对每条纪要标记「已核对」、编辑/新增/删除纪要条目，本地持久化保存于 `results/demo-live/edits/`（不入库，可随时还原初始自动生成结果）；
  - 未明确说明的负责人与截止日期显式标注为「未知（原话未指明）」，防幻觉校验拦截提示直接在卡片展示；
  - 支持一键复制或导出当前核对后的规范 Markdown 纪要（`.md`）。

## 后端接口

- `GET /api/sessions`：列出可用录音会话摘要
- `GET /api/session?id=<id>`：加载指定会话的转写、纪要（含本地人工校对覆盖）及音频地址
- `GET /api/demo`：加载默认 `clip01` 会话及会话列表
- `POST /api/analyze?name=<filename>&method=<segmented|baseline>`：本地运行 `python -m echotrace.cli demo`
- `POST /api/session/save`：保存人工校对后的转写与纪要
- `POST /api/session/reset?id=<id>`：清除指定会话的人工校对覆盖
- `GET /media/clip/:file`、`GET /media/live.wav`、`GET /media/demo.wav`：支持 `Range` 请求的 WAV 流式传输
