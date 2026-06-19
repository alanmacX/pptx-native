# PowerPoint Native Vocabulary Survey (observed 2026-06-06)

Surveyed live in Microsoft PowerPoint (Mac) to ground the component library in
PowerPoint's *real* native "材料库", not in what the current compiler happens to
emit. This is the reference for completing `web/ppt-components.css` and the
`capabilities.json` `declared-gap` entries. Status columns reflect the compiler
as of the Phase 0/1 refactor.

## Insert — native object library (插入 ribbon)

| PowerPoint object | OOXML | compiler status |
|---|---|---|
| 文本框 Text Box | `p:sp`/`a:txBody` | ✅ compiles |
| 形状 Shapes | `p:sp`/`a:prstGeom` | ✅ compiles (passthrough; expose full preset set) |
| 图片 Picture | `p:pic`/`a:blip` | ✅ compiles (data: only; crop = gap) |
| 表格 Table | `p:graphicFrame`/`a:tbl` | ✅ compiles (no merged cells yet) |
| 图表 Chart | `p:graphicFrame`/`c:chart` | ✅ compiles (bar/column/line/pie + embedded xlsx) |
| SmartArt | `p:graphicFrame`/`dgm:*` | ❌ declared-gap |
| 图标 Icons | `p:pic` (svg blip) | ❌ declared-gap |
| 3D 模型 3D Model | `p:graphicFrame`/`model3d` | ❌ declared-gap |
| 艺术字 WordArt | `p:sp` + text effects | ❌ declared-gap |
| 视频 / 音频 Media | `p:pic`/`a:videoFile`/`a:audioFile` + `p14:media` | ✅ embeds local/data media; playback commands gap |
| 公式 Equation | `a:m` (OMML) | ❌ declared-gap |
| 缩放定位 Zoom | section zoom | ❌ declared-gap |
| 链接 / 动作 Link/Action | `a:hlinkClick` | ❌ gap (hyperlinks easy win) |

## Shapes — preset geometry categories (形状 gallery)

Full standard OOXML `presetGeometry` set (~187), categories observed:
线条/Lines · 矩形/Rectangles · 基本形状/Basic Shapes · 箭头总汇/Block Arrows ·
公式形状/Equation Shapes · 流程图/Flowchart · 星与旗帜/Stars & Banners ·
标注/Callouts · 动作按钮/Action Buttons.

→ Component library should expose the **whole preset set** via `data-shape`, since
`author.py::_preset_geom_xml` already passes any preset through. Current
`_SHAPE_PRESETS` (28) is an arbitrary subset — widen to the full vetted list.
Lines/connectors also have **curved/bent/elbow** variants (`a:cxnSp` with
`bentConnector`/`curvedConnector`) — currently only straight (`bentOrCurved:false`).

## Transitions — between-slide (切换 ribbon)

Morph (平滑) is a **first-class** transition, alongside a large gallery:
Subtle (Fade/Push/Wipe/Split/Reveal/Cut/Random Bars/Shape/Uncover/Cover/Flash),
Exciting (Fall Over/Drape/Curtains/Wind/Prestige/Fracture/Crush/Peel Off/Page
Curl/Airplane/Origami/Dissolve/Checkerboard/Blinds/Clock/Ripple/Honeycomb/
Glitter/Vortex/Shred/Switch/Flip/Gallery/Cube/Doors/Box/Comb/Zoom/Pan/Ferris
Wheel/Conveyor/Rotate/Window/Orbit/Fly Through), plus **Morph**.
Controls: 效果选项 Effect Options · 持续时间 Duration · 声音 Sound · 换片方式 Advance.

→ compiler today: fade/push/wipe/split + morph(byObject/Word/Char). The rest are
`declared-gap`. Morph choreography (what carries across) is the high-value target.

## Animations — within-slide, four families (动画 ribbon)

| family | PowerPoint | compiler |
|---|---|---|
| 进入 Entrance | Appear, Fade, Fly In, Float In, Split, Wipe, Shape, Wheel, Random Bars, Grow&Turn, Zoom, Swivel, Bounce, Blinds, Checkerboard, Dissolve, Circle, Diamond, Plus, Wedge | ✅ 11 + appear; rest gap |
| 强调 Emphasis | Pulse, Color Pulse, Teeter, Spin, Grow/Shrink, Desaturate, Darken, Lighten, Transparency, Object/Fill/Line/Font/Brush Color, Complementary, Bold Flash/Reveal, Wave, Underline | ✅ spin/grow/shrink/pulse; rest gap |
| 退出 Exit | mirror of entrance | ✅ exit-<entrance>; rest gap |
| 路径动画 Motion Paths | Lines, Arcs, Turns, Shapes, Loops, Custom | ⚠️ raw `pptPath` only; named presets = gap |

Timing controls: 开始 Start (onClick/withPrevious/afterPrevious) · 持续时间 Duration ·
延迟 Delay · 触发器 Triggers · 动画刷 Painter · 动画窗格 Pane (sequence ordering).

## Takeaways for the component library

1. ✅ DONE — `data-shape` opened to the **full preset set** (165).
2. ✅ DONE — native **table**, native **chart** (+ embedded workbook), **theme tokens**,
   **speaker notes** now compile (native-intent scene JSON; see `docs/native-authoring.md`).
   Remaining `declared-gap` writers: **hyperlinks/actions**, **curved/elbow connectors**,
   **WordArt/text effects**, **sections**, **merged table cells**, then SmartArt / 3D.
3. Animation/transition vocab is already the richest part — extend entrance/emphasis
   lists toward the full galleries and add **named motion-path presets** + **morph
   choreography**.
4. Nothing here needs HTML reverse-engineering. Each maps to a declarative
   component/attribute the agent authors directly.

Authoritative status always lives in `capabilities.json` (reflected from the
compiler); this survey is a point-in-time map, not the source of truth.
