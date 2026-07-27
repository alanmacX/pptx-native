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

function loadLayoutSpecs() {
  const fallback = {
    cover: { family: "opening", requiredRegions: ["title"], maxTitleLines: 2 },
    statement: { family: "assertion", requiredRegions: ["title"], maxTitleLines: 2 },
    split: { family: "media", requiredRegions: ["copy", "media"], maxTitleLines: 2 },
    editorial: { family: "media", requiredRegions: ["title", "media"], maxTitleLines: 1 },
    "hero-media": { family: "media", requiredRegions: ["media", "title"], maxTitleLines: 2 },
    metric: { family: "data", requiredRegions: ["title", "metric"], maxTitleLines: 1 },
    comparison: { family: "relation", requiredRegions: ["left", "right"], maxTitleLines: 1 },
    timeline: { family: "sequence", requiredRegions: ["canvas"], maxTitleLines: 1 },
    process: { family: "sequence", requiredRegions: ["canvas"], maxTitleLines: 1 },
    evidence: { family: "media", requiredRegions: ["visual", "interpretation"], maxTitleLines: 1 },
    gallery: { family: "media", requiredRegions: ["primary"], maxTitleLines: 1 },
    matrix: { family: "relation", requiredRegions: ["canvas"], maxTitleLines: 1 },
    closing: { family: "closing", requiredRegions: ["title"], maxTitleLines: 2 },
    custom: { family: "custom", requiredRegions: [], maxTitleLines: 2 },
  };
  const candidates = [
    path.resolve(__dirname, "..", "skills", "pptx-native", "references", "layout-presets.json"),
    path.resolve(__dirname, "..", "..", "..", "references", "layout-presets.json"),
    path.resolve(__dirname, "..", "references", "layout-presets.json"),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      if (parsed && parsed.presets && typeof parsed.presets === "object") return parsed.presets;
    } catch { /* try the next location */ }
  }
  return fallback;
}

// Valid DSL vocab, sourced from capabilities.json when available.
function loadVocab() {
  const layouts = loadLayoutSpecs();
  const fallback = {
    entrance: ["fade", "blinds", "box", "checkerboard", "circle", "diamond",
      "dissolve", "plus", "randombars", "wedge", "wheel", "wipe", "appear"],
    emphasis: ["spin", "grow", "shrink", "pulse", "transparency", "dim", "opacity"],
    triggers: ["onClick", "withPrev", "withPrevious", "afterPrev", "afterPrevious", "auto"],
    shapes: ["rect", "roundRect", "ellipse", "line"],
    layouts,
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
    const emphasisAliases = { transparency: ["dim", "opacity"] };
    const emphasis = [];
    for (const e of w.emphasis || fallback.emphasis) {
      emphasis.push(e);
      for (const alias of emphasisAliases[e] || []) emphasis.push(alias);
    }
    return {
      entrance: [...(w.entrance || fallback.entrance), "appear"],
      emphasis,
      triggers: triggers.length ? triggers : fallback.triggers,
      shapes: caps.components?.shape?.presets || fallback.shapes,
      layouts,
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
  const browser = process.env.PPT_BROWSER_WS
    ? await chromium.connect(process.env.PPT_BROWSER_WS)
    : await chromium.launch({ headless: true });
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
    const designRationale = (el) => {
      const owner = el?.closest?.("[data-ppt-design-rationale]") ||
        document.body?.closest?.("[data-ppt-design-rationale]") ||
        document.documentElement;
      return String(owner?.getAttribute?.("data-ppt-design-rationale") || "").trim();
    };
    const hasDesignRationale = (el) => designRationale(el).length >= 6;

    const parseDecl = (v) => {
      const o = {};
      for (const part of String(v || "").split(";")) {
        const i = part.indexOf(":");
        if (i < 0) { const f = part.trim(); if (f) o[f] = true; continue; }
        o[part.slice(0, i).trim()] = part.slice(i + 1).trim();
      }
      return o;
    };
    const animSegments = (v) => String(v || "").split("|").map((s) => s.trim()).filter(Boolean);
    const compactToken = (v) => String(v || "").trim().toLowerCase().replace(/[-_\s]/g, "");
    const knownMotionPresets = new Set(["elegant", "calm", "executive", "neutral", "technical", "expressive", "none"]);
    const layoutSpecs = vocab.layouts || {};
    const knownLayouts = new Set(Object.keys(layoutSpecs));
    const knownMotionIntents = new Set([
      "hierarchy", "flow", "sequence", "timeline", "comparison", "layers",
      "metriccluster", "hubspoke", "statechange", "gallery", "mediareveal", "ambient",
    ]);
    const knownAmbientModes = new Set(["drift", "float", "pan", "breathe", "pulse", "shimmer", "sweep", "recolor", "path", "orbit", "media", "play", "rotate"]);
    const decorativeReveals = new Set([
      "blinds", "box", "checkerboard", "circle", "diamond",
      "dissolve", "plus", "randombars", "wedge", "wheel",
    ]);
    const emphasisEffects = new Set(["spin", "grow", "shrink", "pulse", "transparency", "dim", "opacity"]);
    const segmentEffect = (segment) => {
      const d = parseDecl(segment);
      const isCompose = d.compose !== undefined || d.combo !== undefined ||
        d.effect === "compose" || d.effect === "combo" || d.entrance === "compose";
      if (isCompose) return "compose";
      if (d.entrance) return compactToken(d.entrance);
      if (d.exit) return `exit-${compactToken(d.exit)}`;
      if (d.emphasis) return compactToken(d.emphasis);
      if (d.motion || d.path) return "motionpath";
      if (d.appear !== undefined) return "appear";
      if (d.recolor) return "recolor";
      if (d.media || d.mediaCommand) return "media";
      return "";
    };
    const motionPresetFor = (el) =>
      el.closest("[data-ppt-motion-preset]")?.getAttribute("data-ppt-motion-preset") ||
      document.body?.getAttribute("data-ppt-motion-preset") ||
      document.documentElement?.getAttribute("data-ppt-motion-preset") ||
      "";
    const motionIntentFor = (el) =>
      el.closest("[data-ppt-motion-intent]")?.getAttribute("data-ppt-motion-intent") ||
      document.body?.getAttribute("data-ppt-motion-intent") ||
      document.documentElement?.getAttribute("data-ppt-motion-intent") ||
      "";
    const allowsAmbient = (el, slide) => {
      const purpose = compactToken(el.getAttribute("data-ppt-motion-purpose") || el.getAttribute("data-motion-purpose"));
      return el.hasAttribute("data-ppt-ambient") || slide?.hasAttribute("data-ppt-ambient") ||
        compactToken(motionIntentFor(slide || el)) === "ambient" ||
        /^(ambient|background|backdrop|loop|atmosphere|texture|bg)$/.test(purpose);
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
      if (cls.contains("ppt-picture")) return ["left", "top", "width", "height"];
      if (cls.contains("ppt-media")) return ["left", "top", "width", "height"];
      if (cls.contains("ppt-textbox")) return ["left", "top", "width"];
      return [];
    };

    const all = Array.from(document.querySelectorAll("*"));
    for (const el of all) {
      const tag = el.tagName.toLowerCase();
      const st = getComputedStyle(el);
      const visible = st.display !== "none" && st.visibility !== "hidden" && Number(st.opacity) > 0;
      const isNative = el.classList.contains("ppt-textbox") ||
        el.classList.contains("ppt-shape") || el.classList.contains("ppt-line") ||
        el.classList.contains("ppt-picture") || el.classList.contains("ppt-media");

      // 1. Banned element types.
      if (tag === "canvas") add(el, "error", "BANNED_ELEMENT",
        "<canvas>/WebGL has no native PPT target.",
        "Render the visual as SVG primitives or a data:image instead.");

      if (!visible) continue;

      // Elements carrying data-ppt-* have their filter/clip-path/transform owned
      // by ppt-anim-runtime (preview artifacts), so don't flag those as authored.
      const runtimeOwned = el.hasAttribute("data-ppt-anim") ||
        el.hasAttribute("data-ppt-build") || el.hasAttribute("data-ppt-glow") ||
        el.hasAttribute("data-ppt-ambient");

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
        const presetRegion = el.hasAttribute("data-ppt-region") &&
          Boolean(el.closest("[data-ppt-layout]"));
        for (const prop of geometryPropsFor(el)) {
          const value = styleDecl(el, prop);
          const computedValue = String(st[prop] || "").trim();
          if (!value && presetRegion && hasPxUnit(computedValue))
            continue;
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
      if (morphKey && animDecl && animSegments(animDecl).some((seg) => /(?:^|;)\s*(entrance|exit)\s*:/i.test(seg)))
        add(el, "error", "MORPH_OBJECT_ANIMATION",
          "A data-morph object must not also have entrance/exit animation.",
          "Remove entrance/exit from the morphing object; animate sibling labels or non-morph objects instead.");
      if (hasAnim && !animDecl && !buildDecl && !el.hasAttribute("data-ppt-motion-sampled"))
        add(el, "error", "UNDECLARED_ANIMATION",
          "CSS animation/transition without data-ppt-* is not compiled.",
          "Declare intent, e.g. data-ppt-anim=\"entrance:fade; trigger:afterPrev\".");

      // 4. Validate data-ppt-anim DSL values.
      if (animDecl) {
        for (const segment of animSegments(animDecl)) {
          const d = parseDecl(segment);
          const isCompose = d.compose !== undefined || d.combo !== undefined ||
            d.effect === "compose" || d.effect === "combo" || d.entrance === "compose";
          const mediaCommand = d.media || d.mediaCommand ||
            (["mediaPlay", "mediaPause", "mediaStop", "play", "pause", "stop"].includes(d.effect) ? d.effect : null) ||
            (d.play !== undefined ? "play" : d.pause !== undefined ? "pause" : d.stop !== undefined ? "stop" : null);
          const eff = isCompose ? "compose" : d.entrance || d.emphasis || (d.exit ? "exit:" + d.exit : null) ||
            (d.appear !== undefined ? "appear" : null) || (d.motion || d.path ? "motion" : null) ||
            (d.recolor ? "recolor" : null) || (mediaCommand ? "media" : null);
          if (!eff)
            add(el, "error", "DSL_NO_EFFECT", "data-ppt-anim has no recognized effect key.",
              "Add one of: compose, entrance:/exit:/emphasis:/motion:/appear/recolor.");
          if (d.entrance && !isCompose && !vocab.entrance.includes(d.entrance))
            add(el, "error", "DSL_BAD_EFFECT", `entrance:${d.entrance} is not supported.`,
              `Use one of: ${vocab.entrance.join(", ")} or compose.`);
          // Exit vocabulary = entrance mirrors + the harvested exit-only names.
          const exitExtras = ["flyout", "floatout", "shrinkturn", "growturn"];
          if (d.exit && !vocab.entrance.includes(d.exit) && !exitExtras.includes(compactToken(d.exit)))
            add(el, "error", "DSL_BAD_EFFECT", `exit:${d.exit} is not supported.`,
              `Use one of: ${vocab.entrance.join(", ")}, ${exitExtras.join(", ")}.`);
          if (d.emphasis && !vocab.emphasis.includes(d.emphasis))
            add(el, "error", "DSL_BAD_EFFECT", `emphasis:${d.emphasis} is not supported.`,
              `Use one of: ${vocab.emphasis.join(", ")}.`);
          if (mediaCommand) {
            const normalized = String(mediaCommand).toLowerCase().replace(/[-_\s]/g, "").replace(/^media/, "");
            if (!["play", "pause", "stop"].includes(normalized))
              add(el, "error", "DSL_BAD_EFFECT", `media:${mediaCommand} is not supported.`,
                "Use media:play, media:pause, or media:stop.");
          }
          const trig = d.trigger;
          const isClickTrigger = /^click\(\s*[^)]+\s*\)$/i.test(String(trig || ""));
          if (trig && !isClickTrigger && !vocab.triggers.map((t) => t.toLowerCase()).includes(String(trig).toLowerCase()))
            add(el, "error", "DSL_BAD_TRIGGER", `trigger:${trig} is not a PPT trigger.`,
              "Use onClick / withPrev / afterPrev / auto / click(#target). Banned: hover, scroll, infinite.");
        }
      }
      const sequenceDecl = el.getAttribute("data-ppt-sequence");
      if (sequenceDecl) {
        const d = parseDecl(sequenceDecl);
        let targets = [];
        const componentSel = ".ppt-textbox,.ppt-shape,.ppt-line,.ppt-picture,.ppt-media";
        if (d.selector) {
          try { targets = Array.from(el.querySelectorAll(d.selector)); }
          catch {
            add(el, "error", "SEQUENCE_BAD_SELECTOR", `Invalid data-ppt-sequence selector: ${d.selector}.`,
              "Use a valid CSS selector scoped to the sequence container.");
          }
        } else {
          targets = Array.from(el.querySelectorAll(componentSel));
        }
        targets = targets.filter((target) => target.matches(componentSel));
        if (!targets.length)
          add(el, "error", "SEQUENCE_NO_TARGETS",
            "data-ppt-sequence has no native child targets.",
            "Put .ppt-textbox/.ppt-shape/.ppt-line/.ppt-picture/.ppt-media elements inside the sequence container, or provide selector:<child selector>.");
        for (const key of ["gap", "overlap", "dur", "delay", "x", "y", "scaleFrom", "scaleTo", "rotateFrom", "rotateTo"]) {
          if (d[key] != null && !Number.isFinite(Number(d[key])))
            add(el, "error", "SEQUENCE_BAD_NUMBER", `${key}:${d[key]} is not numeric.`,
              "Use numeric millisecond or transform values, e.g. gap:90; y:16; scaleFrom:.96.");
        }
        const trig = d.trigger;
        if (trig && !vocab.triggers.map((t) => t.toLowerCase()).includes(String(trig).toLowerCase()))
          add(el, "error", "SEQUENCE_BAD_TRIGGER", `trigger:${trig} is not a PPT trigger.`,
            "Use onClick / withPrev / afterPrev / auto.");
      }
      const ambientDecl = el.getAttribute("data-ppt-ambient");
      if (ambientDecl) {
        const d = parseDecl(ambientDecl);
        let targets = [];
        const componentSel = ".ppt-textbox,.ppt-shape,.ppt-line,.ppt-picture,.ppt-media";
        if (d.selector) {
          try { targets = Array.from(el.querySelectorAll(d.selector)); }
          catch {
            add(el, "error", "AMBIENT_BAD_SELECTOR", `Invalid data-ppt-ambient selector: ${d.selector}.`,
              "Use a valid CSS selector scoped to the ambient container.");
          }
        } else if (el.matches(componentSel)) {
          targets = [el];
        } else {
          targets = Array.from(el.querySelectorAll(componentSel));
        }
        targets = targets.filter((target) => target.matches(componentSel));
        if (!targets.length)
          add(el, "error", "AMBIENT_NO_TARGETS",
            "data-ppt-ambient has no native targets.",
            "Put .ppt-shape/.ppt-picture/.ppt-media targets inside the ambient container, or provide selector:<child selector>.");
        const mode = compactToken(d.mode || d.type || d.effect || d.ambient ||
          Object.keys(d).find((key) => knownAmbientModes.has(compactToken(key))) || "drift");
        if (!knownAmbientModes.has(mode))
          add(el, "error", "AMBIENT_BAD_MODE", `data-ppt-ambient mode "${mode}" is not supported.`,
            `Use one of: ${Array.from(knownAmbientModes).join(", ")}.`);
        for (const key of ["gap", "stagger", "dur", "duration", "delay", "x", "y", "dx", "dy", "scaleFrom", "scaleTo", "spins", "byDeg", "startSeconds"]) {
          if (d[key] != null && !Number.isFinite(Number(d[key])))
            add(el, "error", "AMBIENT_BAD_NUMBER", `${key}:${d[key]} is not numeric.`,
              "Use numeric values, e.g. dur:9000; x:18; scaleTo:1.015.");
        }
      }
      const motifDecl = el.getAttribute("data-ppt-motif");
      if (motifDecl) {
        // Keep in sync with MOTIF_REGISTRY in tools/html2scene.cjs.
        const knownMotifs = ["timeline", "layers", "comparison", "metriccluster", "hubspoke"];
        const name = String(motifDecl.split(";")[0] || "").trim().toLowerCase();
        const componentSel = ".ppt-textbox,.ppt-shape,.ppt-line,.ppt-picture,.ppt-media,svg line,svg polyline";
        if (!name || !knownMotifs.includes(name))
          add(el, "warn", "MOTIF_UNKNOWN", `data-ppt-motif "${name}" is not a known motif.`,
            `Use one of: ${knownMotifs.join(", ")}. See docs/motif-choreography-proposal.md.`);
        else if (!Array.from(el.querySelectorAll(componentSel)).some((c) => c.matches(componentSel)))
          add(el, "warn", "MOTIF_NO_TARGETS",
            "data-ppt-motif has no native child targets to choreograph.",
            "Put .ppt-shape/.ppt-textbox/.ppt-line or SVG line/polyline elements inside the motif container.");
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
    const slides = Array.from(document.querySelectorAll("section.ppt-slide,.ppt-slide,[data-ppt='slide'],section.slide"))
      .filter((slide, i, arr) => arr.indexOf(slide) === i);

    // --- Guided composition pass ---------------------------------------------
    // Layout presets are style-neutral silhouettes. They make the Agent name
    // the information geometry it chose, while keeping palette/type/assets free.
    {
      const declared = [];
      const lineCount = (el) => {
        try {
          const range = document.createRange();
          range.selectNodeContents(el);
          const tops = [];
          for (const r of range.getClientRects()) {
            if (r.width < 1 || r.height < 1) continue;
            if (!tops.some((top) => Math.abs(top - r.top) < 2)) tops.push(r.top);
          }
          return Math.max(1, tops.length);
        } catch {
          return 1;
        }
      };
      const exemptSmallText = new Set(["caption", "source", "footnote", "axis", "legend", "label", "context"]);

      slides.forEach((slide, i) => {
        const raw = String(slide.getAttribute("data-ppt-layout") || "").trim();
        const layout = raw.toLowerCase();
        if (!raw) return;
        if (!knownLayouts.has(layout)) {
          add(slide, "error", "DESIGN_LAYOUT_UNKNOWN",
            `Unknown data-ppt-layout="${raw}".`,
            `Use one of: ${Array.from(knownLayouts).join(", ")}. See references/layout-presets.md.`);
          declared.push({ layout, family: "unknown", slide, index: i });
          return;
        }

        const spec = layoutSpecs[layout] || {};
        const family = compactToken(spec.family || layout);
        declared.push({ layout, family, slide, index: i });
        for (const role of spec.requiredRegions || []) {
          if (!slide.querySelector(`[data-ppt-region="${role}"]`)) {
            add(slide, "warn", "DESIGN_LAYOUT_ROLE_MISSING",
              `${layout} layout is missing required region "${role}".`,
              "Add the semantic region or choose a layout whose information relationship matches the slide.");
          }
        }

        const texts = Array.from(slide.querySelectorAll(".ppt-textbox"))
          .map((el) => ({
            el,
            fs: parseFloat(getComputedStyle(el).fontSize) || 0,
            copy: (el.textContent || "").replace(/\s+/g, " ").trim(),
          }))
          .filter((t) => t.copy);
        const explicitTitle = slide.querySelector('[data-ppt-region="title"],[data-ppt-role="title"]');
        const title = explicitTitle
          ? texts.find((t) => t.el === explicitTitle)
          : texts.slice().sort((a, b) => b.fs - a.fs)[0];
        if (title) {
          const largeTitleLayouts = new Set(["cover", "statement", "closing"]);
          const floor = largeTitleLayouts.has(layout) ? 48 : 34;
          if (title.fs < floor) {
            add(title.el, "warn", "DESIGN_TITLE_TOO_SMALL",
              `${layout} title is ${Math.round(title.fs)}px; the default floor is ${floor}px.`,
              "Shorten the claim or adapt the silhouette before shrinking the title.");
          }
          const maxLines = Number(spec.maxTitleLines || 1);
          const lines = lineCount(title.el);
          if (lines > maxLines) {
            add(title.el, "warn", "DESIGN_TITLE_WRAP",
              `${layout} title occupies ${lines} lines; this silhouette allows ${maxLines}.`,
              "Shorten the title, widen its region, or choose a silhouette designed for a longer claim.");
          }
        }

        const tinyProse = texts.find((t) => {
          if (t === title || t.fs >= 16 || t.copy.length <= 24) return false;
          const role = compactToken(t.el.getAttribute("data-ppt-region") ||
            t.el.getAttribute("data-ppt-role") || "");
          return !exemptSmallText.has(role);
        });
        if (tinyProse) {
          add(tinyProse.el, "warn", "DESIGN_BODY_TOO_SMALL",
            `Body prose is ${Math.round(tinyProse.fs)}px; the default floor is 16px.`,
            "Shorten the copy or change the silhouette instead of shrinking prose.");
        }
      });

      if (slides.length >= 6 && declared.length === 0) {
        add(slides[0], "warn", "DESIGN_LAYOUT_PLAN_MISSING",
          `${slides.length}-slide deck declares no data-ppt-layout composition plan.`,
          "Choose a content-led silhouette per slide from layout-presets.md, or declare custom for a deliberate original composition.");
      }
      if (slides.length >= 6 && declared.length >= Math.ceil(slides.length * 0.75)) {
        const unique = new Set(declared
          .filter((d) => d.family !== "custom" && d.family !== "unknown")
          .map((d) => d.layout));
        const deckRationale = String(
          document.body?.getAttribute("data-ppt-design-rationale") ||
          document.documentElement?.getAttribute("data-ppt-design-rationale") || "").trim();
        if (unique.size < 3 && deckRationale.length < 6) {
          add(slides[0], "warn", "DESIGN_LAYOUT_VARIETY",
            `Only ${unique.size} registered silhouette(s) are used across ${declared.length} planned slides.`,
            "Vary the information geometry, or declare a deck-level data-ppt-design-rationale when systematic repetition is the visual concept.");
        }
      }
      for (let i = 2; i < declared.length; i += 1) {
        const trio = declared.slice(i - 2, i + 1);
        if (trio[0].index + 1 !== trio[1].index || trio[1].index + 1 !== trio[2].index) continue;
        if (trio.every((d) => d.family === trio[0].family && d.family !== "custom" && d.family !== "unknown")) {
          const morphChain = isMorphTransition(trio[1].slide) && isMorphTransition(trio[2].slide);
          if (!morphChain && !hasDesignRationale(trio[2].slide)) {
            add(trio[2].slide, "warn", "DESIGN_SILHOUETTE_REPEAT",
              `Three consecutive slides use the "${trio[0].family}" silhouette family.`,
              "Change the geometry, use a deliberate adjacent Morph sequence, or state the repetition's purpose in data-ppt-design-rationale.");
          }
        }
      }
    }

    for (let i = 0; i < slides.length; i += 1) {
      const presetRaw = motionPresetFor(slides[i]);
      const preset = compactToken(presetRaw || "elegant");
      const intentRaw = motionIntentFor(slides[i]);
      const intent = compactToken(intentRaw);
      if (presetRaw && !knownMotionPresets.has(preset)) {
        add(slides[i], "warn", "MOTION_PRESET_UNKNOWN",
          `Unknown data-ppt-motion-preset="${presetRaw}".`,
          "Use elegant (default), neutral, technical, expressive, or none.");
      }
      if (intentRaw && !knownMotionIntents.has(intent)) {
        add(slides[i], "warn", "MOTION_INTENT_UNKNOWN",
          `Unknown data-ppt-motion-intent="${intentRaw}".`,
          "Use hierarchy, flow, sequence, timeline, comparison, layers, metricCluster, hubSpoke, stateChange, gallery, mediaReveal, or ambient.");
      }
      const animatedEls = Array.from(slides[i].querySelectorAll("[data-ppt-anim],[data-ppt-build]"));
      const ambientEls = Array.from(slides[i].querySelectorAll("[data-ppt-ambient]"));
      const hasOrchestrator = Boolean(slides[i].querySelector("[data-ppt-sequence],[data-ppt-motif],[data-ppt-ambient]")) ||
        intent === "statechange" || intent === "ambient" || isMorphTransition(slides[i]);
      if ((animatedEls.length + ambientEls.length) >= 3 && !intentRaw) {
        add(slides[i], "warn", "MOTION_INTENT_MISSING",
          `Slide has ${animatedEls.length + ambientEls.length} animation declarations but no data-ppt-motion-intent.`,
          "Declare the choreography goal on the slide, e.g. data-ppt-motion-intent=\"hierarchy\" or use data-ppt-motif/data-ppt-sequence.");
      }
      if (animatedEls.length >= 4 && !hasOrchestrator) {
        add(slides[i], "warn", "MOTION_ORCHESTRATION_WEAK",
          `Slide has ${animatedEls.length} individual animations without a container/motif orchestrator.`,
          "Use data-ppt-sequence for grouped reveals, data-ppt-motif for semantic structures, or one compose entrance on the primary focus.");
      }
      if (intent === "timeline" && !slides[i].querySelector("[data-ppt-motif],[data-ppt-sequence]") && animatedEls.length >= 3) {
        add(slides[i], "warn", "MOTION_TIMELINE_NOT_ORCHESTRATED",
          "Timeline intent is declared but the slide still uses individual animations.",
          "Use data-ppt-motif=\"timeline; axis:x|y; from:left|right|top|bottom\" or one data-ppt-sequence on the timeline container.");
      }
      if (preset === "elegant" || preset === "calm" || preset === "executive") {
        const families = new Set();
        let flourish = 0;
        for (const el of animatedEls) {
          for (const segment of animSegments(el.getAttribute("data-ppt-anim"))) {
            const d = parseDecl(segment);
            const effect = segmentEffect(segment);
            const base = effect.startsWith("exit-") ? effect.slice(5) : effect;
            if (decorativeReveals.has(base)) {
              add(el, "warn", "MOTION_PRESET_DECORATIVE_EFFECT",
                `${effect} is decorative under the elegant motion preset.`,
                "Use compose, fade, wipe on lines/spines, or a semantic motif instead.");
            }
            if (emphasisEffects.has(effect)) {
              flourish += 1;
              families.add("emphasis");
            } else if (effect) {
              families.add(effect);
            }
            const repeat = compactToken(d.repeat);
            const repeatN = Number(d.repeat);
            if (!allowsAmbient(el, slides[i]) && (repeat === "infinite" || (Number.isFinite(repeatN) && repeatN > 2))) {
              add(el, "warn", "MOTION_PRESET_LOOP",
                "Repeating animation exceeds elegant preset limits.",
                "Use at most repeat:2, or mark a purposeful ambient element with data-ppt-motion-intent=\"ambient\".");
            }
          }
        }
        if (flourish > 1) {
          add(slides[i], "warn", "MOTION_FLOURISH_OVERUSE",
            `Elegant preset allows at most one emphasis flourish per slide; found ${flourish}.`,
            "Keep one purposeful emphasis and convert the rest to compose/fade/sequence timing.");
        }
        if (families.size > 3) {
          add(slides[i], "warn", "MOTION_STYLE_MIXED",
            `Elegant preset should not mix ${families.size} animation families on one slide.`,
            "Choose one primary motion grammar: compose hierarchy, sequence cascade, motif choreography, or Morph.");
        }
      }

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
      if (i > 0 && !isMorphTransition(slides[i])) {
        const prev = new Set(morphKeysFor(slides[i - 1]));
        const shared = [...new Set(keys.filter((key) => prev.has(key)))];
        if (shared.length) {
          add(slides[i], "warn", "MORPH_CONTINUITY_MISSED",
            `${shared.length} persistent object key(s) continue from the previous slide without a Morph transition: ${shared.slice(0, 4).join(", ")}.`,
            "Use data-ppt-transition=\"type:morph; option:byObject\" so the same subject transforms continuously instead of disappearing and being rebuilt.");
        }
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

    // --- Anti-AI taste pass ---------------------------------------------------
    // Deck-level tells the owner flagged as instant AI giveaways. All warns:
    // taste nudges with concrete fixes, not compile blockers.
    {
      const slideRects = slides.map((s) => s.getBoundingClientRect());
      // "CJK deck" includes kana and hangul: the wide-char budget and the
      // eyebrow check apply to all East Asian decks, not just Chinese.
      const hasCJK = (t) => /[㐀-鿿぀-ヿ가-힯]/.test(t || "");
      const deckIsCJK = hasCJK(document.body ? document.body.textContent || "" : "");
      // East Asian WIDE chars (hanzi incl. Ext-B, kana, hangul, fullwidth
      // punctuation) count 1 unit, anything else 0.5 — the 45-units budget
      // from prompt-orchestration.md maps to ~45 wide chars or ~90 latin.
      const WIDE = /[　-〿぀-ヿㇰ-ㇿ㐀-鿿가-힯豈-﫿＀-｠￠-￦]|[\u{20000}-\u{2FFFD}]/u;
      const charUnits = (t) => {
        let units = 0;
        for (const ch of (t || "").replace(/\s+/g, "")) units += WIDE.test(ch) ? 1 : 0.5;
        return Math.round(units);
      };
      const filledEl = (el) => {
        const st = getComputedStyle(el);
        const bg = st.backgroundColor || "";
        const m = bg.match(/rgba?\(([^)]+)\)/);
        // Non-rgb serializations (oklch/lab/color()) are opaque paints.
        const alpha = m ? Number(m[1].split(",")[3] ?? 1) : (bg && bg !== "transparent" ? 1 : 0);
        return alpha > 0.03 || /gradient/.test(st.backgroundImage || "");
      };
      let topLeftTitles = 0;
      let footnoteSlides = 0;
      let gridSlides = 0;
      slides.forEach((s, i) => {
        const rect = slideRects[i];
        const intentionalDesign = hasDesignRationale(s);
        // same-size rectangle grid — checked before the texts bail-out so
        // pure-shape card pages (labels written inside shapes) still count.
        // Cards built as filled textboxes count too, and 3-in-a-row (the
        // classic AI three-card band) is enough per slide. Legit data
        // lattices opt out via data-ppt-role="table" on their container.
        const shapes = [
          ...Array.from(s.querySelectorAll(".ppt-shape")),
          ...Array.from(s.querySelectorAll(".ppt-textbox")).filter(filledEl),
        ]
          .filter((el) => !el.closest('[data-ppt-role="table"]'))
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 60 && r.height > 40);
        const sizeKey = (r) => `${Math.round(r.width / 8)}x${Math.round(r.height / 8)}`;
        const sizes = {};
        shapes.forEach((r) => { sizes[sizeKey(r)] = (sizes[sizeKey(r)] || 0) + 1; });
        if (!intentionalDesign && Object.values(sizes).some((n) => n >= 3)) gridSlides += 1;
        const texts = Array.from(s.querySelectorAll(".ppt-textbox"))
          .map((el) => ({ el, r: el.getBoundingClientRect(), fs: parseFloat(getComputedStyle(el).fontSize) || 0 }))
          .filter((t) => (t.el.textContent || "").trim());
        if (!texts.length) return;
        const title = texts.slice().sort((a, b) => b.fs - a.fs)[0];
        const tx = (title.r.left - rect.left) / Math.max(1, rect.width);
        const ty = (title.r.top - rect.top) / Math.max(1, rect.height);
        if (!intentionalDesign && tx < 0.16 && ty < 0.22) topLeftTitles += 1;
        // Small English kicker above OR below a large CJK title. The below-title
        // form is just as templated as the classic eyebrow, so check the whole
        // title lockup rather than only text whose bottom edge is above it.
        if (deckIsCJK) {
          const englishKicker = texts.find((t) => {
            if (t === title || t.fs >= title.fs * 0.68 || t.fs > 18) return false;
            const copy = (t.el.textContent || "").trim();
            if (!/^[\x20-\x7E]+$/.test(copy) || !/[A-Za-z]/.test(copy) ||
                copy.length < 3 || copy.length > 48) return false;
            const verticalGap = t.r.bottom <= title.r.top
              ? title.r.top - t.r.bottom
              : t.r.top >= title.r.bottom ? t.r.top - title.r.bottom : 0;
            const horizontalOverlap = Math.max(0,
              Math.min(t.r.right, title.r.right) - Math.max(t.r.left, title.r.left));
            const overlapRatio = horizontalOverlap / Math.max(1, Math.min(t.r.width, title.r.width));
            return verticalGap <= title.fs * 2.2 && overlapRatio >= 0.35;
          });
          if (englishKicker && !intentionalDesign) {
            add(englishKicker.el, "warn", "AI_EN_EYEBROW",
              "Small English kicker paired with a large CJK title is a template tell.",
              "Delete it, or use a local-language context label only where it changes how the title is read.");
          }
        }
        const isFootnote = (t) => t.fs <= 13 && (t.r.top - rect.top) / Math.max(1, rect.height) > 0.88;
        if (!intentionalDesign && texts.some(isFootnote)) footnoteSlides += 1;
        // Text-wall check against the authoring budget (prompt-orchestration.md
        // Content Density): ≤4 body blocks per slide, ≤45 CJK-equivalent chars
        // per block. Fires per slide with 50% slack on the per-block budget.
        // Footnotes sit outside the budget ("Footnotes: one line, muted") —
        // their abuse is AI_FOOTNOTE_FURNITURE's job, not this rule's.
        const body = texts.filter((t) => t !== title && !isFootnote(t));
        const proseBlocks = body.filter((t) => charUnits(t.el.textContent) > 20);
        const overBlocks = body.filter((t) => charUnits(t.el.textContent) > 68);
        if (proseBlocks.length > 4 || overBlocks.length > 0) {
          const worst = Math.max(0, ...body.map((t) => charUnits(t.el.textContent)));
          add(s, "warn", "AI_TEXT_WALL",
            `${proseBlocks.length} prose blocks, longest ${worst} chars — budget is ≤4 blocks of ≤45 CJK-equivalent chars.`,
            "The slide carries the verdict; move the prose to speaker notes, keep one claim + a number/image per slide (prompt-orchestration.md Content Density).");
        }
      });
      // Deck-level monotony thresholds: the tells read as AI well before they
      // hit every page, so half the deck (min 3 slides) is enough to warn.
      // The min-3 floor also keeps 1-2 slide decks quiet on its own.
      const monotony = Math.max(3, Math.ceil(slides.length * 0.5));
      if (topLeftTitles >= monotony) {
        add(slides[0], "warn", "AI_TITLE_LOCKUP_MONOTONY",
          `The big-title-top-left lockup repeats on ${topLeftTitles}/${slides.length} slides.`,
          "Vary title placement: centered cover, left-third split, bottom-anchored image slide, one full-bleed statement slide.");
      }
      if (footnoteSlides >= monotony) {
        add(slides[0], "warn", "AI_FOOTNOTE_FURNITURE",
          `${footnoteSlides}/${slides.length} slides carry a bottom footnote strip.`,
          "Footnotes only where a source needs citing — not as page furniture.");
      }
      if (gridSlides >= monotony) {
        add(slides[0], "warn", "AI_CARD_GRID_MONOTONY",
          `${gridSlides}/${slides.length} slides are same-size rectangle grids.`,
          "Vary unit sizes by importance, break one grid with a full-width band, a diagram, or a single strong number.");
      }
      // Image scarcity: "one token image somewhere" does not rescue a long
      // text-and-boxes deck. Count image-bearing slides, not raw image tags.
      // Only sources the compiler turns into native pictures count — CSS
      // url()/svg image are dropped and must not mask a genuinely sparse deck.
      // Abstract/data/type-led decks may explicitly declare their visual
      // strategy; the waiver is reviewable instead of silently inferred.
      const visualStrategy = compactToken(
        document.body?.getAttribute("data-ppt-visual-strategy") ||
        document.documentElement?.getAttribute("data-ppt-visual-strategy") || "");
      const imageOptional = new Set(["abstract", "diagram", "diagramonly", "data", "dataonly", "typographic", "typeonly"]);
      const imageSlides = slides.filter((s) =>
        s.querySelector("img, .ppt-picture, .ppt-media")).length;
      const imageFloor = Math.max(2, Math.ceil(slides.length * 0.25));
      if (slides.length >= 6 && imageSlides < imageFloor && !imageOptional.has(visualStrategy)) {
        add(slides[0], "warn", "AI_IMAGE_SCARCITY",
          `Only ${imageSlides}/${slides.length} slides contain a native image; expected at least ${imageFloor} for an image-led or concrete deck.`,
          "Add a few real, sourced images where they provide evidence, or explicitly mark a genuinely abstract deck with data-ppt-visual-strategy=\"diagram-only|data-only|typographic\".");
      }
      // A chart needs a sentence-level reason to exist. This cannot prove the
      // data is truthful, but it stops decorative charts from entering the
      // deck without an author naming the claim they support.
      for (const chart of document.querySelectorAll('[data-ppt-role="chart"]')) {
        const evidence = (chart.getAttribute("data-ppt-evidence") || "").trim();
        if (!evidence) {
          add(chart, "warn", "AI_CHART_DECORATION",
            "Chart has no declared evidence claim and may be decorative.",
            "Add data-ppt-evidence=\"<the slide claim this chart proves>\"; if no precise claim fits, cut the chart.");
        }
      }
      // High-signal robotic-copy scan (full banlist: design-and-motion.md).
      const banned = [
        "赋能", "抓手", "闭环", "底层逻辑", "组合拳", "沉淀",
        "综上所述", "总而言之", "值得注意的是", "众所周知",
        "共创辉煌", "砥砺前行", "携手共进", "谱写新篇章", "共创美好未来",
        "取得显著成效", "深远影响", "机遇与挑战并存", "双刃剑",
        "据研究显示", "相关数据表明", "有专家指出",
      ];
      slides.forEach((s) => {
        const text = s.textContent || "";
        const hits = banned.filter((w) => text.includes(w));
        if (hits.length) {
          add(s, "warn", "AI_ROBOTIC_COPY",
            `AI-flavored phrasing: ${hits.slice(0, 4).join("、")}.`,
            "Replace with the plain verb / a number / a named source — see design-and-motion.md Copy Hygiene.");
        }
      });
    }

    // --- Layout geometry pass -------------------------------------------------
    // Deterministic checks that catch a whole class of silent misalignment a
    // clean compile ("ok:true / 0 losses") does NOT catch: overlay content that
    // pokes out of the card/panel it visually sits on (classically because a
    // .ppt-stagger/.ppt-group is offset and its sibling overlay text was authored
    // in the container's 0-based frame, so it lands shifted by the group offset),
    // and text that bleeds off the slide. These are warnings, not errors, but the
    // workflow requires reviewing them before declaring the deck done.
    const TOL = 6; // px of allowed bleed before we consider content "outside"
    const rectOf = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
    };
    const hasFill = (el) => {
      const s = getComputedStyle(el);
      const bg = s.backgroundColor || "";
      const m = bg.match(/rgba?\(([^)]+)\)/);
      const alpha = m ? Number(m[1].split(",")[3] ?? 1) : (bg && bg !== "transparent" ? 1 : 0);
      return (alpha > 0.03) || /gradient/.test(s.backgroundImage || "");
    };
    for (const slide of slides) {
      const slideRect = rectOf(slide);
      const panels = Array.from(slide.querySelectorAll(".ppt-shape")).filter((p) => {
        const shape = (p.getAttribute("data-shape") || "rect").toLowerCase();
        return (shape === "rect" || shape === "roundRect".toLowerCase()) && hasFill(p);
      }).map((p) => ({ el: p, r: rectOf(p) }));
      const contents = Array.from(slide.querySelectorAll(".ppt-textbox, .ppt-picture, .ppt-media"));
      for (const c of contents) {
        const cr = rectOf(c);
        if (!cr.w || !cr.h) continue;
        // Text that runs off the slide is almost always clipped/broken.
        if (c.classList.contains("ppt-textbox")) {
          if (cr.left < slideRect.left - TOL || cr.top < slideRect.top - TOL ||
              cr.right > slideRect.right + TOL || cr.bottom > slideRect.bottom + TOL) {
            add(c, "warn", "LAYOUT_TEXT_OFFSLIDE",
              "Text extends past the slide edge and will be clipped.",
              "Move it inside the slide or shrink the box; if it wraps to more lines in PowerPoint than in the browser, give the box more width/height.");
          }
        }
        // Find the filled panel this content sits on top of (max intersection),
        // skipping panels it is nested in (those share the same frame already).
        let best = null, bestArea = 0;
        for (const p of panels) {
          if (p.el === c || p.el.contains(c) || c.contains(p.el)) continue;
          const ix = Math.max(0, Math.min(cr.right, p.r.right) - Math.max(cr.left, p.r.left));
          const iy = Math.max(0, Math.min(cr.bottom, p.r.bottom) - Math.max(cr.top, p.r.top));
          const area = ix * iy;
          if (area > bestArea) { bestArea = area; best = p; }
        }
        if (!best) continue;
        const onPanel = bestArea >= cr.w * cr.h * 0.25; // meaningfully overlapping
        const couldFit = cr.w <= best.r.w + 1 && cr.h <= best.r.h + 1;
        const pokesOut = cr.left < best.r.left - TOL || cr.top < best.r.top - TOL ||
          cr.right > best.r.right + TOL || cr.bottom > best.r.bottom + TOL;
        if (onPanel && couldFit && pokesOut) {
          add(c, "warn", "LAYOUT_PANEL_OVERFLOW",
            "This content sits on a card/panel it would fit inside, but spills past the panel edge — usually a coordinate-frame mistake (e.g. authored in a .ppt-stagger/.ppt-group's local frame without adding the container's offset).",
            "Either place this element inside the same container as the panel so they share one coordinate frame, or add the container's left/top offset to this element's position.");
        }
      }
    }
    return out;
  }, vocab);

  await browser.close();

  const advisoryRules = new Set([
    "DESIGN_LAYOUT_PLAN_MISSING",
    "DESIGN_LAYOUT_VARIETY",
    "DESIGN_SILHOUETTE_REPEAT",
    "AI_TITLE_LOCKUP_MONOTONY",
    "AI_EN_EYEBROW",
    "AI_FOOTNOTE_FURNITURE",
    "AI_CARD_GRID_MONOTONY",
    "AI_IMAGE_SCARCITY",
    "AI_ROBOTIC_COPY",
  ]);
  const contractRules = new Set([
    "DESIGN_LAYOUT_UNKNOWN",
    "DESIGN_LAYOUT_ROLE_MISSING",
    "AI_CHART_DECORATION",
  ]);
  for (const violation of violations) {
    if (advisoryRules.has(violation.rule)) violation.kind = "advisory";
    else if (contractRules.has(violation.rule) || violation.level === "error") violation.kind = "contract";
    else violation.kind = "quality";
  }
  const errors = violations.filter((v) => v.level === "error").length;
  const warnings = violations.filter((v) => v.level === "warn").length;
  const quality = violations.filter((v) => v.kind === "quality").length;
  const contract = violations.filter((v) => v.kind === "contract").length;
  const advisory = violations.filter((v) => v.kind === "advisory").length;
  const report = {
    ok: errors === 0,
    input: args.input,
    counts: { errors, warnings, quality, contract, advisory, total: violations.length },
    violations,
  };
  const text = JSON.stringify(report, null, 2);
  if (args.out) fs.writeFileSync(path.resolve(args.out), text);
  console.log(text);
  process.exit(errors === 0 ? 0 : 2);
}

main().catch((err) => { console.error("error:", err.message); process.exit(1); });
