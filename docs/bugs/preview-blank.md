# Bug: 生成大型 deck 后 Preview 黑屏、HTML 标签也空白

> ⚠ 这是一个 **macOS Electron 桌面 app**，不是网页/CLI。复现和调试方式见
> [`HOW-TO-RUN-AND-DEBUG.md`](./HOW-TO-RUN-AND-DEBUG.md)（如何 npm start、看哪个 console、
> 以及如何不开 GUI 直接跑引擎模块快速复现）。先读那份。

## 项目背景（自包含）
Electron 桌面 app（coding-agent 风格的 PPT 生成器），目录：
`/Users/macalan/Documents/real-ppt-agent/app`
- 聊天输入需求 → 调用自定义 LLM provider 生成「一份自包含 HTML」
- 右侧 webview 预览这份 HTML；HTML 既是预览，也是后续编译成 .pptx 的蓝本
- 运行：`cd app && npm install && npm start`

关键文件：
- `app/main.js` — Electron 主进程。IPC：
  - `agent:generate`（流式调用 LLM，边生成边通过 `agent:delta`/`agent:thinking` 推 token）
  - `agent:previewDoc`（把生成的 HTML 注入预览 runtime + 导航脚本，**写到临时文件，返回 file:// URL**）
- `app/engine/providers.js` — LLM 客户端，支持 openai(/chat/completions) 和 anthropic(/v1/messages) 两种格式，含 SSE 流式解析（`readSSE`，anthropic 取 `content_block_delta` 的 `text_delta`；忽略 `thinking_delta`，仅用于状态显示）
- `app/engine/llm.js` — `generate()` + `systemPrompt()`（约束 HTML 子集的系统提示）
- `app/renderer/renderer.js` — `generate()`（流式累积，完成后 `renderPreview()`）、`renderPreview(html)`（`$("preview").src = file://URL`；`$("code").textContent = html`）、Preview/HTML 标签切换
- `app/renderer/index.html` — `<webview id="preview">`、`<pre id="code">`、tabs
- `app/renderer/preview-harness.js` — 注入预览页的「按 section 翻页」导航器

## 现象
- Provider = `mimo`（anthropic 格式，`mimo-v2.5-pro`，**很慢、带 thinking**），baseUrl 形如 `https://.../anthropic`
- 输入一份**很长的 9 页中文 prompt**（约 5KB，见 `examples/eldercare-prompt.txt`），点 Generate
- 等待后聊天区显示 `✓ Preview ready`（说明 `renderer.js` 的 `generate()` 没抛异常、走到了成功分支）
- **但右侧 Preview webview 全黑**；切到 **HTML 标签也空白**（看不到生成的代码）

## 已知 / 已排除
- **小 deck 正常**：用内置示例「three glowing orbs … silky morph」（单/双页）生成时预览正常。
- **端点本身正常**：直接 curl/fetch `POST {baseUrl}/v1/messages` 返回 200，SSE 里先有大量 `thinking_delta` 再有 `text_delta`；小请求（"count 1 to 5"）4 秒出结果。
- **大请求极慢**：带完整 systemPrompt 的小生成实测 **首 token 1526 秒、总 1565 秒**；9 页输出更大。
- `max_tokens` 当前设 8000（见 providers.js）。
- 预览机制已从 `data:` URL 改为 **写临时文件 + file:// URL**（main.js `agent:previewDoc`）。改动后**用户尚未在新构建上重新生成**，所以 file:// 修复未被验证。

## 最可疑的根因（按优先级）
1. **大输出被截断/失败**：mimo 对 9 页这种长输出可能超时、被 `max_tokens=8000` 截断、或几乎全在 `thinking` 通道、`text` 通道极少 → 最终 `html` 近乎空/不完整 → Preview 和 HTML 标签**都空**。
   - 注意：`renderer.js` 的「✓ Preview ready」**无论 html 是否为空都会显示**（只要 `generate()` 不抛错）——这是个误导，应当在 html 为空/过短时显式报错。
2. **webview 加载失败**：file:// 或 data: 文档没加载出来（webview 安全策略、URL 过长、或注入脚本报错把页面清空）。
3. **HTML 标签为空 ≠ 预览问题**：若 `$("code").textContent` 也空，强烈指向 #1（html 本身为空），而非渲染问题。

## 建议的排查步骤（确定性，绕开慢模型）
1. **隔离「生成」与「预览」**：用一份已知良好的多页 HTML（仓库里有 `/tmp/orb.html`，或自写 2 个 `<section class="ppt-slide">`）直接喂给 `agent:previewDoc` → 看 webview 能否渲染 file:// 文档。能 → 预览没问题，锅在生成；不能 → 预览/webview 的锅。
2. **打印 html 长度**：在 `renderer.js` 的 `generate()` 成功分支里 `console.log(currentHtml.length)`，并在 `r.html` 为空/`<` 开头不是 HTML 时显式在聊天区报错。
3. **落盘每次生成**：`main.js` 的 `agent:generate` 已加 `fs.writeFileSync(os.tmpdir()+"/ppt-last.html", html)`（需重启生效）。重启后生成一次，检查 `/tmp/ppt-last.html` 是否完整、是否含 9 个 `<section class="ppt-slide">`。
4. **流式累积 vs 返回值一致性**：确认 `providers.chat` 返回的 `full`（仅 `text_delta` 累积）就是最终 html；若 mimo 把内容放进了非 `text_delta` 的块（如 `output_text`/其他 delta 类型），`full` 会偏空——需要打印原始 SSE 事件类型核对。
5. **max_tokens / 超时**：把 `max_tokens` 提高（如 16000）并加请求超时与「截断检测」（stop_reason / 长度）。
6. **webview 调试**：临时 `win.webContents.openDevTools()` 或对 `<webview>` 监听 `did-fail-load` 事件，打印失败原因。

## 复现
1. `cd /Users/macalan/Documents/real-ppt-agent/app && npm start`
2. ⚙ Providers 配置 anthropic 格式的慢模型（或任意会产生 >50KB HTML 的长 prompt）
3. 粘贴 `examples/eldercare-prompt.txt` 全文，Generate
4. 观察：`✓ Preview ready` 出现但 Preview 与 HTML 标签均空白

## 期望
- 生成的完整 HTML 在 HTML 标签可见
- Preview webview 正确渲染（含多页 section 导航）
- 若生成为空/截断/超时，聊天区给出明确错误而非「Preview ready」
