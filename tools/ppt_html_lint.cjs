#!/usr/bin/env node
/**
 * PPT-native HTML linter (backstop enforcement layer).
 *
 * Runs the page in a real browser and checks the PPT-native HTML subset from
 * docs/ppt-html-contract.md. Emits structured, no-vision feedback:
 *   { selector, level, rule, message, fix }
 *
 * This is the "catch the escapes" layer. The component library is the
 * "stay-on-rails" layer; this linter exists for when an agent hand-writes raw
 * HTML and strays outside the subset.
 *
 * Usage:
 *   node tools/ppt_html_lint.cjs input.html [--out report.json]
 * Exit code: 0 = no errors (warnings allowed), 2 = at least one error.
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

// Valid DSL vocab, sourced from capabilities.json when available.
function loadVocab() {
  const fallback = {
    entrance: ["fade", "blinds", "box", "checkerboard", "circle", "diamond",
      "dissolve", "plus", "randombars", "wedge", "wheel", "wipe", "appear"],
    emphasis: ["spin", "grow", "shrink", "pulse"],
    triggers: ["onClick", "withPrev", "withPrevious", "afterPrev", "afterPrevious", "auto"],
    shapes: ["rect", "roundRect", "ellipse", "line"],
  };
  // DSL accepts short aliases for the canonical capability trigger names.
  const triggerAliases = { withPrevious: "withPrev", afterPrevious: "afterPrev" };
  try {
    const caps = JSON.parse(fs.readFileSync(path.resolve("capabilities.json"), "utf8"));
    const w = caps.animation?.within || {};
    const canonical = w.triggers || ["onClick", "withPrevious", "afterPrevious", "auto"];
    const triggers = [];
    for (const t of canonical) {
      triggers.push(t);
      if (triggerAliases[t]) triggers.push(triggerAliases[t]);
    }
    return {
      entrance: [...(w.entrance || fallback.entrance), "appear"],
      emphasis: w.emphasis || fallback.emphasis,
      triggers: triggers.length ? triggers : fallback.triggers,
      shapes: caps.components?.shape?.presets || fallback.shapes,
    };
  } catch {
    return fallback;
  }
}

function parseArgs(argv) {
  const args = { input: null, out: null, width: 1200, height: 675 };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--width") args.width = Number(argv[++i]);
    else if (a === "--height") args.height = Number(argv[++i]);
    else if (!a.startsWith("--") && !args.input) args.input = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.input) {
    console.error("Usage: node tools/ppt_html_lint.cjs input.html [--out report.json]");
    process.exit(1);
  }
  const vocab = loadVocab();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: args.width, height: args.height } });
  await page.goto(pathToFileURL(path.resolve(args.input)).href, { waitUntil: "load" });
  await page.waitForTimeout(400);

  const violations = await page.evaluate((vocab) => {
    const out = [];
    const sel = (el) => {
      if (el.id) return `#${el.id}`;
      const cls = (el.className && el.className.baseVal !== undefined
        ? el.className.baseVal : el.className) || "";
      const c = String(cls).trim().split(/\s+/).filter(Boolean)[0];
      return `${el.tagName.toLowerCase()}${c ? "." + c : ""}`;
    };
    const add = (el, level, rule, message, fix) =>
      out.push({ selector: sel(el), level, rule, message, fix });

    const parseDecl = (v) => {
      const o = {};
      for (const part of String(v || "").split(";")) {
        const i = part.indexOf(":");
        if (i < 0) { const f = part.trim(); if (f) o[f] = true; continue; }
        o[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
      return o;
    };
    const styleDecl = (el, prop) => {
      const raw = el.getAttribute("style") || "";
      const re = new RegExp(`(?:^|;)\\s*${prop.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s*:\\s*([^;]+)`, "i");
      return (raw.match(re)?.[1] || "").trim();
    };
    const transformInfo = (value) => {
      const text = String(value || "").trim();
      if (!text || text === "none") return null;
      let m = null;
      try {
        const domMatrix = new DOMMatrixReadOnly(text);
        m = {
          a: domMatrix.a,
          b: domMatrix.b,
          c: domMatrix.c,
          d: domMatrix.d,
          e: domMatrix.e,
          f: domMatrix.f,
        };
      } catch {
        const nums = text.match(/matrix\(([^)]+)\)/i)?.[1]
          ?.split(",")
          .map((part) => Number(part.trim()));
        if (nums?.length === 6) {
          const [a, b, c, d, e, f] = nums;
          m = { a, b, c, d, e, f };
        }
      }
      if (!m || [m.a, m.b, m.c, m.d, m.e, m.f].some((n) => !Number.isFinite(n))) return null;
      const flip = (m.a * m.d - m.b * m.c) < 0; // negative determinant == a mirror
      const scaleX = Math.hypot(m.a, m.b);
      // Undo the mirror before measuring rotation/skew so a flip reads cleanly.
      const c = flip ? -m.c : m.c;
      const d = flip ? -m.d : m.d;
      const scaleY = Math.hypot(c, d);
      if (!scaleX || !scaleY) return null;
      const rotationDeg = Math.atan2(m.b, m.a) * 180 / Math.PI;
      const skew = Math.abs((m.a * c + m.b * d) / (scaleX * scaleY));
      return { rotationDeg, scaleX, scaleY, skew, flip };
    };
    // Native xfrm expresses rotation + flipH/flipV. Any transform that decomposes
    // to rotation and/or a mirror (no skew, unit scale) compiles natively — it is
    // read straight from CSS, no data-ppt-rotation declaration required.
    const isSimpleNativeTransform = (el, transform) => {
      const info = transformInfo(transform);
      if (!info) return false;
      return Math.abs(info.scaleX - 1) <= 0.02 &&
        Math.abs(info.scaleY - 1) <= 0.02 &&
        Math.abs(info.skew) <= 0.02;
    };
    const isZero = (value) => /^[-+]?0+(?:\.0+)?$/.test(String(value).trim());
    const hasPxUnit = (value) => /px\s*$/i.test(String(value).trim()) || isZero(value);
    const geometryPropsFor = (el) => {
      const cls = el.classList || { contains: () => false };
      if (cls.contains("ppt-shape")) return ["left", "top", "width", "height"];
      if (cls.contains("ppt-line")) return ["left", "top", "width", "height"];
      if (cls.contains("ppt-textbox")) return ["left", "top", "width"];
      return [];
    };

    const all = Array.from(document.querySelectorAll("*"));
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      const st = getComputedStyle(el);
      const visible = st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) > 0;
      const isNative = el.classList.contains("ppt-textbox") ||
        el.classList.contains("ppt-shape") || el.classList.contains("ppt-line");

      // 1. Banned element types.
      if (tag === "canvas") add(el, "error", "BANNED_ELEMENT",
        "<canvas>/WebGL has no native PPT target.",
        "Render the visual as SVG primitives or a data:image instead.");

      if (!visible) continue;

      // Elements carrying data-ppt-* have their filter/clip-path/transform owned
      // by ppt-anim-runtime (preview artifacts), so don't flag those as authored.
      const runtimeOwned = el.hasAttribute("data-ppt-anim") ||
        el.hasAttribute("data-ppt-build") || el.hasAttribute("data-ppt-glow");

      // 1b. Native object structure and geometry.
      if (isNative) {
        if (st.position !== "absolute")
          add(el, "error", "NATIVE_GEOMETRY",
            "PPT-native objects must be absolutely positioned.",
            "Add position:absolute and explicit left/top/width/height geometry.");
        const shape = el.getAttribute("data-shape");
        if (el.classList.contains("ppt-shape") && shape && !vocab.shapes.includes(shape))
          add(el, "error", "BAD_SHAPE",
            `Unsupported data-shape: ${shape}.`,
            "Use a preset from capabilities.json components.shape.presets (e.g. rect, roundRect, ellipse, hexagon, star5, chevron).");
        if (el.hasAttribute("data-ppt-rotation") && !Number.isFinite(Number(el.getAttribute("data-ppt-rotation"))))
          add(el, "error", "NATIVE_GEOMETRY",
            `Invalid data-ppt-rotation: ${el.getAttribute("data-ppt-rotation")}.`,
            "Use a numeric degree value, e.g. data-ppt-rotation=\"-8\".");
        if (el.parentElement?.closest(".ppt-shape"))
          add(el, "error", "NESTED_NATIVE",
            "Native objects nested inside .ppt-shape do not map cleanly to editable PPT objects.",
            "Make shapes/text sibling objects with their own absolute geometry.");
        for (const prop of geometryPropsFor(el)) {
          const value = styleDecl(el, prop);
          if (!value)
            add(el, "error", "NATIVE_GEOMETRY",
              `Missing explicit ${prop} in inline style.`,
              `Set ${prop}:<number>px${prop === "height" && el.classList.contains("ppt-line") ? " or height:0" : ""}.`);
          else if (!hasPxUnit(value))
            add(el, "error", "NATIVE_GEOMETRY",
              `${prop}:${value} is not PPT-native deterministic geometry.`,
              `Use px units, e.g. ${prop}:120px.`);
        }
      }

      // 2. Banned CSS that cannot land in native PPT.
      if (st.backdropFilter && st.backdropFilter !== "none")
        add(el, "error", "BANNED_CSS", "backdrop-filter is not natively representable.",
          "Remove it or bake a static frosted layer as a shape/image.");
      // blur() and drop-shadow() map to native effects (<a:blur>/<a:outerShdw>).
      // Any other filter primitive has no native target -> still a loss.
      if (!runtimeOwned && st.filter && st.filter !== "none") {
        const nativeFilter = /^(\s*(blur\([^)]*\)|drop-shadow\([^)]*\))\s*)+$/i.test(st.filter);
        if (!nativeFilter)
          add(el, "error", "BANNED_CSS", `filter: ${st.filter} is dropped (loss).`,
            "Only blur()/drop-shadow() compile natively; use data-ppt-glow / box-shadow / data-ppt-reflection for the rest.");
      }
      if (st.mixBlendMode && st.mixBlendMode !== "normal")
        add(el, "error", "BANNED_CSS", `mix-blend-mode: ${st.mixBlendMode} is dropped.`,
          "Pre-compose the color; blend modes are not native.");
      const transformIsNative = isNative && isSimpleNativeTransform(el, st.transform);
      if (!runtimeOwned && st.transform && st.transform !== "none" && !transformIsNative)
        add(el, "error", "BANNED_CSS", `transform: ${st.transform} is not native layout geometry.`,
          "Only rotate()/flip (scaleX(-1)/scaleY(-1)) compile to native xfrm; skew/scale/translate are not native geometry — use explicit left/top/width/height.");
      // flex/grid/normal-flow are allowed: the engine reads each element's
      // browser-computed box, so any CSS layout resolves to native geometry.
      if (/(auto|scroll)/.test(`${st.overflow} ${st.overflowX} ${st.overflowY}`) && tag !== "html" && tag !== "body")
        add(el, "error", "BANNED_CSS", "scrollable overflow is browser-only content.",
          "Render the intended state as visible native objects; do not use overflow:auto/scroll.");
      if (!runtimeOwned && st.clipPath && st.clipPath !== "none")
        add(el, "warn", "BANNED_CSS", "clip-path beyond simple rounding is dropped.",
          "Use a native shape geometry or a freeform path.");
      const bg = st.backgroundImage || "";
      // radial-gradient now compiles to a native path("circle") gradient fill.
      // conic has no native equivalent yet -> explicit loss, not a hard block.
      if (/conic-gradient/.test(bg))
        add(el, "warn", "BANNED_CSS", "conic-gradient has no native PPT fill; compiles as a flat color (loss).",
          "Use a linear-gradient or radial-gradient for a native gradient fill.");

      // 3. Animation must be declared via data-ppt-*.
      const hasAnim = (st.animationName && st.animationName !== "none") ||
        (st.transitionDuration && parseFloat(st.transitionDuration) > 0);
      const animDecl = el.getAttribute("data-ppt-anim");
      const buildDecl = el.getAttribute("data-ppt-build");
      const morphKey = el.getAttribute("data-morph");
      if (morphKey && animDecl && /(?:^|;)\s*(entrance|exit)\s*:/i.test(animDecl))
        add(el, "error", "MORPH_OBJECT_ANIMATION",
          "A data-morph object must not also have entrance/exit animation.",
          "Remove entrance/exit from the morphing object; animate sibling labels or non-morph objects instead.");
      if (hasAnim && !animDecl && !buildDecl)
        add(el, "error", "UNDECLARED_ANIMATION",
          "CSS animation/transition without data-ppt-* is not compiled.",
          "Declare intent, e.g. data-ppt-anim=\"entrance:fade; trigger:afterPrev\".");

      // 4. Validate data-ppt-anim DSL values.
      if (animDecl) {
        const d = parseDecl(animDecl);
        const eff = d.entrance || d.emphasis || (d.exit ? "exit:" + d.exit : null) ||
          (d.appear !== undefined ? "appear" : null) || (d.motion || d.path ? "motion" : null) ||
          (d.recolor ? "recolor" : null);
        if (!eff)
          add(el, "error", "DSL_NO_EFFECT", "data-ppt-anim has no recognized effect key.",
            "Add one of: entrance:/exit:/emphasis:/motion:/appear/recolor.");
        if (d.entrance && !vocab.entrance.includes(d.entrance))
          add(el, "error", "DSL_BAD_EFFECT", `entrance:${d.entrance} is not supported.`,
            `Use one of: ${vocab.entrance.join(", ")}.`);
        if (d.exit && !vocab.entrance.includes(d.exit))
          add(el, "error", "DSL_BAD_EFFECT", `exit:${d.exit} is not supported.`,
            `Use one of: ${vocab.entrance.join(", ")}.`);
        if (d.emphasis && !vocab.emphasis.includes(d.emphasis))
          add(el, "error", "DSL_BAD_EFFECT", `emphasis:${d.emphasis} is not supported.`,
            `Use one of: ${vocab.emphasis.join(", ")}.`);
        const trig = d.trigger;
        if (trig && !vocab.triggers.map((t) => t.toLowerCase()).includes(String(trig).toLowerCase()))
          add(el, "error", "DSL_BAD_TRIGGER", `trigger:${trig} is not a PPT trigger.`,
            "Use onClick / withPrev / afterPrev / auto. Banned: hover, scroll, infinite.");
      }
    }

    const transitionDecl = (slide) => parseDecl(slide.getAttribute("data-ppt-transition") || "");
    const isMorphTransition = (slide) => {
      const raw = String(slide.getAttribute("data-ppt-transition") || "").toLowerCase();
      const d = transitionDecl(slide);
      const type = String(d.type || d.transition || "").toLowerCase();
      return type === "morph" || type === "smooth" || raw.includes("平滑") ||
        raw.split(";").some((part) => ["morph", "smooth"].includes(part.trim().toLowerCase()));
    };
    const morphKeysFor = (slide) => Array.from(slide.querySelectorAll("[data-morph]"))
      .map((el) => String(el.getAttribute("data-morph") || "").trim())
      .filter(Boolean);
    const slides = Array.from(document.querySelectorAll("section.ppt-slide"));
    for (let i = 0; i < slides.length; i += 1) {
      const keys = morphKeysFor(slides[i]);
      const seen = new Set();
      for (const key of keys) {
        if (seen.has(key)) {
          add(slides[i], "error", "MORPH_KEY_DUPLICATE",
            `Multiple objects on one slide use data-morph="${key}".`,
            "Use one morph object per key per slide so PowerPoint byObject matching is deterministic.");
        }
        seen.add(key);
      }
      if (!isMorphTransition(slides[i])) continue;
      const timed = Array.from(slides[i].querySelectorAll("[data-ppt-anim],[data-ppt-build]"));
      if (timed.length) {
        add(slides[i], "error", "MORPH_SLIDE_TIMING",
          `Morph slide contains ${timed.length} same-slide animation declaration(s).`,
          "PowerPoint for Mac can get stuck when a Morph slide also has p:timing. Move builds to a non-Morph slide, or remove data-ppt-anim/data-ppt-build from this slide.");
      }
      if (i === 0) continue;
      const prev = new Set(morphKeysFor(slides[i - 1]));
      for (const key of keys) {
        if (!prev.has(key)) {
          add(slides[i], "error", "MORPH_NOT_ADJACENT",
            `data-morph="${key}" has no matching object on the immediately previous slide.`,
            "PowerPoint Morph compares only adjacent slides. Add a same-key seed object to the previous slide, or remove the morph transition.");
        }
      }
    }
    return out;
  }, vocab);

  await browser.close();

  const errors = violations.filter((v) => v.level === "error").length;
  const warnings = violations.filter((v) => v.level === "warn").length;
  const report = {
    ok: errors === 0,
    input: args.input,
    counts: { errors, warnings, total: violations.length },
    violations,
  };
  const text = JSON.stringify(report, null, 2);
  if (args.out) fs.writeFileSync(path.resolve(args.out), text);
  console.log(text);
  process.exit(errors === 0 ? 0 : 2);
}

main().catch((err) => { console.error("error:", err.message); process.exit(1); });
