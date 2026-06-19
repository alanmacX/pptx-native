# pptx-native

> 把普通的 **HTML/CSS** 编译成**原生、可编辑**的 PowerPoint（`.pptx`）。

你像写网页一样写一页幻灯片，工具把它编译成真正的 PowerPoint 原生对象——真实的形状、文本、渐变、效果和动画时间轴。**不是截图、不是图片**，打开后每个元素都能在 PowerPoint 里继续编辑。

它以一个 [Claude Code Skill](skills/pptx-native/SKILL.md) 的形式交付：由模型（host Claude）按用户需求写 HTML/CSS，工具负责编译。

---

## 一、设计理念（为什么是这样）

这个项目的核心，是一条贯穿始终的原则：

> **不要给模型设围栏。AI 本来就能写出很好的 HTML/CSS，那么面向同样结构化的 pptx 词汇，它也能做好——工具的职责是「把能表达的忠实编译」，而不是「限制能表达什么」。**

由此推导出三条具体设计决策：

1. **天花板是「PowerPoint 原生支持什么」，而不是「编译器现在写得出什么」。**
   早期版本的做法是：HTML 用了某个特性（径向渐变、blur、flip、transform…），编译器没实现 → 干脆用 linter **报错禁止**。这是本末倒置。正确做法是**去补编译器**，把这些映射成 pptx 原生表达；实在没有原生对应的，**显式记为 loss（可见的损失），绝不静默降级**。

2. **作者就写正常的 HTML/CSS，不用学专有 DSL。**
   关键认识：html2scene 用真实浏览器（Playwright）渲染页面，读取每个元素**计算后的盒子**（`getBoundingClientRect`）。这意味着 **flex / grid / 百分比 / 正常文档流 全部可用**——它们都会被浏览器解析成具体像素。所谓「必须用 px、必须绝对定位、必须加 `.ppt-*` 类」其实是**自己加的多余围栏**，已全部拆除。现在普通的 `<h1>/<p>/<div>` 会被**自动识别**成文本框 / 形状 / 图片。

3. **工具不持任何审美立场。**
   版式、配色、字体、密度、动效——全部由**模型读用户需求当场决定**，就像设计任意网页一样。工具本身**不预装设计模板、不预设主题**（连默认主题色板都改成了中性灰阶；只保留 OOXML 格式必需的中性兜底）。审美 = 模型 + 用户输入，不是 baked-in 的默认。

---

## 二、工作原理

一条编译管线，从 HTML 到 `.pptx`：

```
HTML/CSS ─▶ normalize ─▶ lint ─▶ html2scene ─▶ pptx_native create ─▶ validate ─▶ pack ─▶ .pptx
```

| 阶段 | 做什么 |
|---|---|
| **normalize** | 在真实浏览器里清理 HTML：把可原生表达的 CSS（如 `filter:blur`、`@keyframes` 动画、flex/grid 布局）保留并解析,只剥离真正无原生对应的东西 |
| **lint** | 校验是否有无法落地的写法,**给出可修复建议**,而不是粗暴禁止 |
| **html2scene** | 用 Playwright 渲染,读取每个元素**计算后的几何与样式**,识别成「原生意图场景 JSON」（形状/文本/线/图片/动画/转场） |
| **pptx_native create** | 把场景 JSON 编译成 OOXML 包目录（`pptx_native/author.py` 是核心写出器） |
| **validate** | 校验关系、内容类型、动画目标等结构正确性 |
| **pack** | 打包成 `.pptx` |

最终返回一个 JSON 报告：`ok` / `lint` / `losses`（哪些 CSS 没能原生映射，显式列出）/ `validate`。模型据此自纠,直到 `ok:true` 且没有意外 loss。

**关键设计：CSS 动画 → 原生时间轴。** 作者写普通 `@keyframes` + `animation`，引擎读取 `opacity` + `transform`(位移/缩放/旋转) + 时间/缓动/循环/颜色，编译成 PowerPoint 原生的并行行为（`animEffect` / `animMotion` / `animScale` / `animRot` / `animClr`）。多个动画可串联（CSS `animation:` 列表），多步关键帧（bounce/wiggle）会被追踪成一条原生运动路径。

---

## 三、能力一览

全部从普通 CSS 编译为 **原生** OOXML，无法表达的会显式记为 loss：

- **填充**：纯色、线性渐变（角度+色标）、**径向渐变**（`<a:path path="circle">`）
- **效果**：`box-shadow`、`filter:blur()` → `<a:blur>`、辉光、倒影
- **几何**：任意 CSS 布局（flex/grid/正常流）→ 读计算盒;`transform: rotate / scaleX(-1) / scaleY(-1)` → 原生旋转/翻转
- **动画**（写 CSS 即可）：淡入+位移/缩放组合入场、缓动（含 cubic-bezier 近似）、延迟/错峰、**循环**（`infinite` + `alternate`）、**填充色动画**、**多动画串联**、**多步关键帧 → 运动路径**
- **跨页 Morph**：`data-morph="key"` 在相邻两页的同一对象上 → PowerPoint 平滑变换（靠 `!!` 前缀同名强制配对）
- **转场**：`fade / push / wipe / split / morph`
- **图片**：`<img src="data:image/...">`（data URI）→ 原生图片
- **原生对象**：165 套 OOXML 形状预设、可编辑表格、数据图表、演讲者备注

---

## 四、快速开始

依赖：Node、Python 3、Playwright Chromium（首次装一次）。

```bash
# 1) 一次性安装依赖（把 playwright + chromium 装进 skill 自带目录）
skills/pptx-native/scripts/setup.sh

# 2) 写一页 HTML（就是普通网页，1280×720 一个 <section> 一页）
#    见 skills/pptx-native/SKILL.md 的契约说明

# 3) 编译成 pptx
skills/pptx-native/scripts/build.sh deck.html deck.pptx
```

最小示例：

```html
<section style="width:1280px;height:720px;background:#fff;
        display:flex;flex-direction:column;justify-content:center;padding:96px">
  <style>
    @keyframes rise{ from{opacity:0;transform:translateY(20px)} to{opacity:1} }
    h1{ animation:rise .5s ease-out both }
  </style>
  <h1 style="font-size:64px">就写普通 HTML/CSS</h1>
  <p style="font-size:24px;color:#64748b">工具把它编译成原生、可编辑的 PowerPoint</p>
</section>
```

> 在 Claude Code 里，直接把 `skills/pptx-native/` 软链到 `~/.claude/skills/`，模型会自动识别并使用这个 skill。

---

## 五、目录结构

```
pptx_native/        Python 写出器:场景 JSON → OOXML(author.py 是核心)
tools/              Node 工具链:normalize / lint / html2scene(读浏览器计算几何)
app/engine/         pipeline.js:串起整条编译管线
capabilities.json   单一事实源:机器可读的「什么能编译」清单
skills/pptx-native/ 打包成 skill:SKILL.md(纯机制,无审美立场)+ build.sh / setup.sh
docs/               契约与 OOXML 资料
web/                预览运行时
```

---

## 六、诚实的边界

PowerPoint 的原生模型**不是 CSS 的超集**,所以做不到字面意义的「所有 CSS」。当前契约是:**能原生表达的忠实编译,不能的显式记为 loss(绝不静默丢)**,并持续扩大覆盖面。

已知不映射(会报 loss):conic 渐变(压成纯色)、`filter` 中 blur/drop-shadow 以外的原语、`clip-path`、`mix-blend-mode`、`@keyframes` 里非 opacity/transform/颜色 的属性、PowerPoint 不支持的弹性回弹缓动。

---

🤖 本项目在 [Claude Code](https://claude.com/claude-code) 协助下开发。
