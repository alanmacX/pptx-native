# pptx-native

把普通的 HTML/CSS 编译成原生、可编辑的 PowerPoint (.pptx)。

你写一页网页，工具把它变成真正的 PowerPoint 原生对象——形状、文本、渐变、动画时间轴，不是截图，打开就能编辑。

以 [Claude Code Skill](skills/pptx-native/SKILL.md) 形式交付。模型写 HTML/CSS，工具负责编译。


## 为什么这么做

核心想法很简单：AI 能写出很好的 HTML/CSS，pptx 也是结构化格式，那就让它直接写，工具负责忠实编译就行了。别加多余的限制。

具体来说：

**天花板跟着 PowerPoint 走，不跟着编译器走。** 早期做法是编译器没实现的就 linter 报错禁掉，这是本末倒置。现在的做法是去补编译器；实在没有原生对应的，显式记为 loss，不会静默丢。

**就写正常 HTML/CSS。** html2scene 用 Playwright 渲染页面，读每个元素的计算盒子（getBoundingClientRect）。flex、grid、百分比、正常文档流全部可用——浏览器会解析成具体像素。普通的 h1/p/div 自动识别成文本框/形状/图片，不需要专有 class。

**工具不管审美。** 版式配色字体动效全部由模型根据用户需求决定。工具本身不预装模板、不预设主题，连默认色板都是中性灰阶。


## 编译管线

```
HTML/CSS -> normalize -> lint -> html2scene -> pptx_native create -> validate -> pack -> .pptx
```

- **normalize**: 真实浏览器里清理 HTML，保留可原生表达的 CSS（blur、@keyframes、flex/grid），剥离无原生对应的
- **lint**: 校验无法落地的写法，给修复建议
- **html2scene**: Playwright 渲染，读计算后的几何与样式，输出场景 JSON
- **pptx_native create**: 场景 JSON 编译成 OOXML 包（author.py 是核心）
- **validate**: 校验结构正确性
- **pack**: 打包 .pptx

CSS 动画会被编译成 PowerPoint 原生时间轴：@keyframes 里的 opacity + transform + 颜色 -> animEffect / animMotion / animScale / animRot / animClr。多步关键帧追踪成运动路径，多动画可串联。


## 能力

全部从普通 CSS 编译为原生 OOXML：

- 填充：纯色、线性渐变、径向渐变
- 效果：box-shadow、blur、辉光、倒影
- 几何：任意 CSS 布局 -> 计算盒; rotate / flip
- 动画：入场组合、缓动（含 cubic-bezier）、延迟错峰、循环、填充色动画、多步关键帧
- 跨页 Morph：data-morph="key" -> PowerPoint 平滑变换
- 转场：fade / push / wipe / split / morph
- 图片：data URI -> 原生图片
- 原生对象：165 套形状预设、可编辑表格、数据图表、演讲者备注

无法原生表达的会显式记为 loss：conic 渐变、clip-path、mix-blend-mode、非 opacity/transform/颜色的 @keyframes 属性等。


## 快速开始

依赖：Node、Python 3、Playwright Chromium。

```bash
# 装依赖（一次性）
skills/pptx-native/scripts/setup.sh

# 编译
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

在 Claude Code 里，把 `skills/pptx-native/` 软链到 `~/.claude/skills/`，模型会自动使用。


## 目录结构

```
pptx_native/        Python 写出器（author.py 是核心）
tools/              Node 工具链：normalize / lint / html2scene
app/engine/         pipeline.js 串起编译管线
capabilities.json   机器可读的能力清单
skills/pptx-native/ skill 打包：SKILL.md + build.sh + setup.sh
```
