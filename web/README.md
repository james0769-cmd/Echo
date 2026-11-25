# EchoTrace Web 工作台

在项目根目录启动：

```bash
node web/server.cjs
```

打开 `http://127.0.0.1:8124`。

## 模块化前端结构

- **HTML 入口**：`web/index.html`（档案库与双栏核对工作台）、`web/tasks.html`（会后待办看板）。
- **样式系统（`web/css/`）**：
  - `tokens.css`：设计变量与离线字体策略（现代无衬线系统字体栈为主 + EchoTrace 英文衬线品牌字标与等宽数字）。
  - `layout.css`：统一 56px 顶部导航、档案库网格、工作台双栏布局、弹性分隔条与响应式抽屉。
  - `workbench.css`：转写原文行、字符级 ASR 校对 Diff、结构化纪要卡片、行内快捷编辑与底部深色声学波形播放器。
  - `tasks.css`：三列式待办看板样式。
- **ES Modules（`web/js/`）**：
  - `state.js`：前端全局状态、时间戳/编号格式化、未知字段归一化、路由解析与 Markdown 导出构建。
  - `api.js`：统一封装会话加载、本地录音上传分析、校对持久化、Word 导出与待办看板 API。
  - `diff.js`：基于字符级 LCS 的 ASR 校对前后对比生成器。
  - `splitter.js`：支持拖拽与键盘方向键调节的双栏宽度分隔控制器（`localStorage` 持久化）。
  - `waveform.js`：`WaveformPlayer` Canvas 声学波形渲染器，基于 `AudioContext` 解码并缓存峰值，叠加全局与当前选中的琥珀色证据高亮区，支持点击/拖拽及方向键定位。
  - `app.js` / `tasks.js`：工作台主控与待办看板交互逻辑。

## 核心功能

- **会议录音档案与快速导入**：首页直接提供拖拽/选择本地 **WAV / M4A / MP3** 录音入口（通过 `web/audio.cjs` 校验或经 FFmpeg 转码为 16 kHz 单声道 PCM WAV，并在 `results/demo-live/sessions/record-<uuid>/` 按时间倒序持久化），同时自动加载本地已有 `clip01-clip05` 示例会议。
- **转写 · 纪要 · 声学波形三方联动**：
  - 左栏展示合并后整句转写，支持双击或点击「校对」行内修正错字（如数字、人名），保存后可展开字符级 Diff 对比（`查看校对对比` / `收起对比`），并同步刷新引用该句的纪要原话；
  - 右栏按议题或时间展示决定、待办与待确认条目，支持直接点击「负责人 / 截止」字段行内快速编辑，空值自动归一化为「未知」；
  - 底部深色波形控制台以琥珀色标注证据时间段，支持「证据精听」与「全场连播」模式，后端支持 HTTP `Range` `206` 精确跳播。
- **导出与合规**：顶部「导出」下拉菜单集中提供复制 Markdown、导出 `.md`、调用 `src/echotrace/word.py` 导出 `.docx` 以及「还原初始结果」；导入区域附带 `docs/录音同意书模板.docx` 下载链接。
- **工作台快捷键**：`Space` 播放/暂停、`↓ / j` 与 `↑ / k` 切换纪要、`v` 切换核对状态、`r` 重播当前证据、`[ / ]` 后退或前进 3 秒、`?` 打开快捷键说明、`Esc` 关闭弹窗/菜单或取消行内编辑。
- **会后待办看板（`/tasks.html`）**：支持将「待办」条目加入看板按「待处理 / 进行中 / 已完成」追踪，并通过 `/#session/<sessionId>/minute/<minuteId>` 精准跳回原会议及对应证据。

## 后端接口

- `GET /api/sessions`：列出可用录音会话摘要
- `GET /api/session?id=<id>`：加载指定会话的转写、纪要（含本地人工校对覆盖）及音频地址
- `GET /api/demo`：加载默认 `clip01` 会话及会话列表
- `POST /api/analyze?name=<filename>&method=<segmented|baseline>`：校验或转码上传音频并本地运行 `python -m echotrace.cli demo`
- `POST /api/session/save`：保存人工校对后的转写与纪要
- `POST /api/session/reset?id=<id>`：清除指定会话的人工校对覆盖
- `GET /api/session/word?id=<id>`：将指定会话纪要导出为 Word 文档（`.docx`）
- `GET / POST / PATCH / DELETE /api/tasks`：读取、添加、更新状态、删除会后待办看板条目
- `GET /recording-consent.docx`：下载会议录音同意书模板
- `GET /media/clip/:file`、`GET /media/session/:id.wav`、`GET /media/live.wav`、`GET /media/demo.wav`：支持 `Range` 请求的 WAV 流式传输
