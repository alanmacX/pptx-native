#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");
const { applyGuards } = require("./ppt_guards.cjs");

function parseArgs(argv) {
  const args = {
    input: null,
    out: null,
    ir: null,
    report: null,
    screenshots: null,
    steps: "0-21",
    width: 1200,
    height: 675,
    waitMs: 900,
    maxElements: 900,
    noImageReference: true,
    settleAnimations: true,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      return args;
    }
    if (!arg.startsWith("--") && !args.input) {
      args.input = arg;
      continue;
    }
    const next = argv[i + 1];
    if (arg === "--out") args.out = next, i += 1;
    else if (arg === "--ir") args.ir = next, i += 1;
    else if (arg === "--report") args.report = next, i += 1;
    else if (arg === "--screenshots") args.screenshots = next, i += 1;
    else if (arg === "--steps") args.steps = next, i += 1;
    else if (arg === "--width") args.width = Number(next), i += 1;
    else if (arg === "--height") args.height = Number(next), i += 1;
    else if (arg === "--wait-ms") args.waitMs = Number(next), i += 1;
    else if (arg === "--max-elements") args.maxElements = Number(next), i += 1;
    else if (arg === "--allow-image-reference") args.noImageReference = false;
    else if (arg === "--no-settle-animations") args.settleAnimations = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.help) {
    return args;
  }
  if (!args.input || !args.out) {
    throw new Error(usage());
  }
  return args;
}

function usage() {
  return [
    "Usage: node tools/html2scene.cjs input.html --out scene.json [options]",
    "",
    "Options:",
    "  --ir file                       Write browser-derived IR JSON.",
    "  --report file                   Write extraction/coverage report JSON.",
    "  --screenshots dir               Write optional QA screenshots. Screenshots are never compiler input.",
    "  --steps 0-21                    Step list or ranges to extract.",
    "  --width 1200 --height 675       Browser viewport in CSS pixels.",
    "  --wait-ms 900                   Wait after each step transition.",
    "  --max-elements 900              Per-slide DOM element extraction cap.",
    "  --no-settle-animations          Sample the live animation time instead of final structural state.",
    "  --allow-image-reference         Opt out of the no-image-reference contract metadata.",
  ].join("\n");
}

function parseSteps(value) {
  const out = [];
  for (const piece of String(value).split(",")) {
    if (!piece) continue;
    if (piece.includes("-")) {
      const [a, b] = piece.split("-").map(Number);
      const step = a <= b ? 1 : -1;
      for (let n = a; step > 0 ? n <= b : n >= b; n += step) out.push(n);
    } else {
      out.push(Number(piece));
    }
  }
  return [...new Set(out)].filter(Number.isFinite);
}

function ensureDir(fileOrDir, isDir = false) {
  const dir = isDir ? fileOrDir : path.dirname(fileOrDir);
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(file);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const input = path.resolve(args.input);
  const steps = parseSteps(args.steps);
  if (args.screenshots) ensureDir(path.resolve(args.screenshots), true);

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(input).href, { waitUntil: "load" });
  await page.waitForTimeout(500);

  const irSlides = [];
  // Deck model: "sections" is the primary model — each .ppt-slide element is one
  // slide. This is the natural way humans/LLMs write component-library decks. The
  // legacy single-stage + window.goToStep replay model is used ONLY when a step
  // flow actually exists; otherwise a static N-section deck (including a single
  // slide) maps 1:1 to N slides instead of being replayed against a default step
  // range.
  const sectionCount = await page.evaluate(
    () => document.querySelectorAll(".ppt-slide, [data-ppt='slide']").length
      || document.querySelectorAll("body > section").length
  );
  const hasStepFlow = await page.evaluate(
    () => typeof window.goToStep === "function" || typeof window.next === "function"
  );

  if (!hasStepFlow) {
    const slideCount = Math.max(sectionCount, 1);
    for (let i = 0; i < slideCount; i += 1) {
      if (args.settleAnimations) { await page.evaluate(settleAnimations); await page.waitForTimeout(30); }
      const slide = await page.evaluate(extractSlide, {
        step: i, slideIndex: i, maxElements: args.maxElements,
      });
      irSlides.push(slide);
    }
  } else {
    for (const step of steps) {
      await page.evaluate(async (targetStep) => {
        if (typeof window.goToStep === "function") window.goToStep(targetStep);
        else if (typeof window.next === "function") { while ((window.state || 0) < targetStep) window.next(); }
      }, step);
      await page.waitForTimeout(args.waitMs);
      if (args.settleAnimations) { await page.evaluate(settleAnimations); await page.waitForTimeout(50); }
      const shot = args.screenshots
        ? path.resolve(args.screenshots, `html-step-${String(step).padStart(2, "0")}.png`) : null;
      if (shot) await page.screenshot({ path: shot, fullPage: false });
      const slide = await page.evaluate(extractSlide, { step, screenshot: shot, maxElements: args.maxElements });
      irSlides.push(slide);
    }
  }

  const ir = {
    version: 1,
    source: input,
    extractedAt: new Date().toISOString(),
    viewport: { width: args.width, height: args.height },
    contract: {
      noImageReference: args.noImageReference,
      compilerInput: "dom-computed-style-and-structure",
      screenshots: args.screenshots ? "qa-only-not-compiler-input" : "disabled",
      rasterFallbacks: "forbidden",
      animationSampling: args.settleAnimations ? "settled-final-structural-state" : "live-time-sample",
    },
    slides: irSlides,
    animations: await page.evaluate(extractAnimations),
  };
  const scene = buildAuthorScene(ir);
  applyGuards(scene); // centralized deterministic conflict/cleanup rules
  const report = buildReport(ir, scene);

  writeJson(path.resolve(args.out), scene);
  if (args.ir) writeJson(path.resolve(args.ir), ir);
  if (args.report) writeJson(path.resolve(args.report), report);
  await browser.close();
  console.log(JSON.stringify({
    ok: true,
    out: path.resolve(args.out),
    ir: args.ir ? path.resolve(args.ir) : null,
    report: args.report ? path.resolve(args.report) : null,
    slides: scene.slides.length,
    authorElements: scene.slides.reduce((n, s) => n + s.elements.length, 0),
    unsupported: report.unsupported,
  }, null, 2));
}

function extractSlide(opts) {
  // The slide root is the coordinate origin AND the canvas. Recognizing the
  // PPT-native component class (.ppt-slide) keeps the authored stage size and the
  // compile canvas in lockstep, and excludes the stage from content shapes.
  let active = null;
  const slideSel = document.querySelectorAll(".ppt-slide, [data-ppt='slide']").length
    ? ".ppt-slide, [data-ppt='slide']" : "body > section";
  if (opts.slideIndex != null) {
    // sections mode: the i-th slide section IS this slide's stage
    active = document.querySelectorAll(slideSel)[opts.slideIndex] || null;
  }
  if (!active) active = document.querySelector(".slide.active")
    || document.querySelector(slideSel);
  if (!active) {
    active = [...document.querySelectorAll(".slide")]
      .map((el) => ({ el, z: Number(getComputedStyle(el).zIndex) || 0, opacity: Number(getComputedStyle(el).opacity) || 0 }))
      .sort((a, b) => b.z - a.z || b.opacity - a.opacity)[0]?.el;
  }
  const stage = active || document.querySelector(".stage") || document.body;
  if (!active) active = stage;
  const stageRect = stage.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  const elements = [];
  const svgElements = [];
  const images = [];
  const media = [];
  const unsupported = [];
  let order = 0;

  const toStageRect = (rect) => ({
    x: round(rect.left - stageRect.left),
    y: round(rect.top - stageRect.top),
    w: round(rect.width),
    h: round(rect.height),
    right: round(rect.right - stageRect.left),
    bottom: round(rect.bottom - stageRect.top),
  });
  const inStage = (box) => box.w > 0.75 && box.h > 0.75 && box.right >= -2 && box.bottom >= -2 && box.x <= stageRect.width + 2 && box.y <= stageRect.height + 2;
  const cumulativeOpacity = (el) => {
    let opacity = 1;
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== active) {
      const nodeStyle = getComputedStyle(node);
      if (nodeStyle.display === "none" || nodeStyle.visibility === "hidden") return 0;
      opacity *= Number(nodeStyle.opacity) || 0;
      node = node.parentElement;
    }
    return opacity;
  };
  const sourceAncestors = (el) => {
    const ids = [];
    const classes = [];
    let node = el.parentElement;
    while (node && node !== active && node.nodeType === Node.ELEMENT_NODE) {
      if (node.id) ids.push(node.id);
      classes.push(...[...node.classList]);
      node = node.parentElement;
    }
    return {
      ids: [...new Set(ids)],
      classes: [...new Set(classes)],
    };
  };
  const cssColor = (value) => {
    const raw = String(value || "").trim();
    const hex = raw.match(/^#([0-9a-fA-F]{3,8})$/);
    if (hex) {
      let text = hex[1];
      if (text.length === 3 || text.length === 4) text = [...text].map((ch) => ch + ch).join("");
      const alpha = text.length === 8 ? parseInt(text.slice(6, 8), 16) / 255 : 1;
      return { hex: text.slice(0, 6).toUpperCase(), alpha: Math.max(0, Math.min(1, alpha)) };
    }
    const m = raw.match(/rgba?\(([^)]+)\)/);
    if (!m) return { hex: null, alpha: 0 };
    const nums = m[1]
      .replace(/\//g, " ")
      .split(/[\s,]+/)
      .map((v) => Number(v.trim()))
      .filter((n) => Number.isFinite(n));
    const [r, g, b] = nums;
    const a = nums.length > 3 ? nums[3] : 1;
    return {
      hex: [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("").toUpperCase(),
      alpha: Math.max(0, Math.min(1, Number(a))),
    };
  };
  const svgPaint = (el, prop, style) => {
    // Declared paint only. A url(#gradient) reference is NOT guessed into a
    // representative solid — that was a heuristic; the agent declares a solid
    // paint or it is an explicit loss downstream.
    const styleValue = prop === "stroke" ? style.stroke : style.fill;
    const rawValue = el.getAttribute(prop) || styleValue;
    return cssColor(rawValue);
  };
  // Split a comma-separated argument list at top-level commas only (so the
  // commas inside rgb(...) / rgba(...) do not break stop parsing).
  const splitTopLevel = (s) => {
    const out = [];
    let depth = 0;
    let cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      if (ch === "," && depth === 0) { out.push(cur); cur = ""; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out;
  };
  // CSS direction keyword -> angle in deg (CSS convention: 0deg = to top,
  // increasing clockwise). Corner angles are the canonical 45deg multiples.
  const DIRECTION_DEG = {
    "to top": 0, "to right": 90, "to bottom": 180, "to left": 270,
    "to top right": 45, "to right top": 45,
    "to bottom right": 135, "to right bottom": 135,
    "to bottom left": 225, "to left bottom": 225,
    "to top left": 315, "to left top": 315,
  };
  // Parse a computed background-image gradient into native-intent geometry:
  // { type, angle (linear, deg), colors:[{hex,alpha,pos}] }. The browser hands
  // us a fully-resolved string, so angle/type/stop positions are all recoverable
  // — none of it has to be dropped.
  const parseGradient = (image) => {
    const m = image.match(/\b(linear|radial|conic)-gradient\s*\(([\s\S]*)\)/);
    if (!m) return null;
    const type = m[1];
    const args = splitTopLevel(m[2]).map((a) => a.trim()).filter(Boolean);
    if (!args.length) return null;
    let angle = type === "linear" ? 180 : undefined; // CSS linear default = to bottom
    // The first arg is the direction/shape header only if it has no color.
    const isColorTok = (t) => /rgba?\(|#[0-9a-fA-F]{3,8}|^[a-z]+$/i.test(t) && !/gradient|circle|ellipse|^to\b|deg$|^at\b/i.test(t);
    let stopArgs = args;
    if (!isColorTok(args[0])) {
      const head = args[0].toLowerCase();
      const deg = head.match(/(-?[\d.]+)deg/);
      if (deg) angle = ((parseFloat(deg[1]) % 360) + 360) % 360;
      else if (DIRECTION_DEG[head] != null) angle = DIRECTION_DEG[head];
      stopArgs = args.slice(1);
    }
    const stops = stopArgs.map((tok) => {
      const cm = tok.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
      if (!cm) return null;
      const col = cssColor(cm[0]);
      if (!col.hex || col.alpha <= 0.015) return null;
      const pm = tok.slice(cm.index + cm[0].length).match(/(-?[\d.]+)%/);
      return { ...col, pos: pm ? Math.max(0, Math.min(100, parseFloat(pm[1]))) : null };
    }).filter(Boolean).slice(0, 8);
    if (stops.length < 2) return null;
    return { type, angle, colors: stops };
  };
  const cssBackground = (style) => {
    const color = cssColor(style.backgroundColor);
    const image = String(style.backgroundImage || "");
    const backgroundClip = String(style.backgroundClip || "");
    const webkitBackgroundClip = String(style.webkitBackgroundClip || "");
    const gradient = image.includes("gradient") ? parseGradient(image) : null;
    const colors = gradient ? gradient.colors : [];
    return {
      ...color,
      image: image && image !== "none" ? image : null,
      gradient,
      clipText: Boolean(gradient) && (backgroundClip.includes("text") || webkitBackgroundClip.includes("text")),
    };
  };
  const textColorFor = (style, background) => {
    const textFill = cssColor(style.webkitTextFillColor);
    if (textFill.hex && textFill.alpha > 0.015) return textFill;
    if (background?.clipText && background.gradient?.colors?.length) return background.gradient.colors[0];
    return cssColor(style.color);
  };
  const px = (value) => {
    const n = Number(String(value || "").replace("px", ""));
    return Number.isFinite(n) ? n : 0;
  };
  // Vertical text anchor for a textbox. Authors express it the natural CSS way
  // (flex/grid centering) or explicitly via data-ppt-valign. Default top.
  const readValign = (el, style) => {
    const attr = (el.getAttribute("data-ppt-valign") || "").trim().toLowerCase();
    if (attr) {
      if (attr === "middle" || attr === "center") return "ctr";
      if (attr === "bottom" || attr === "end") return "b";
      return "top";
    }
    const disp = style.display || "";
    if (disp.includes("flex") || disp.includes("grid")) {
      const column = (style.flexDirection || "").startsWith("column");
      const main = ((column ? style.justifyContent : style.alignItems) || "").toLowerCase();
      if (main.includes("center")) return "ctr";
      if (main.includes("flex-end") || main.includes("end")) return "b";
    }
    return "top";
  };
  const blockTextRunsFor = (el) => {
    const runs = [];
    const blockLike = (style) => {
      const display = style.display || "";
      return display === "block"
        || display === "flow-root"
        || display === "flex"
        || display === "grid"
        || display === "table"
        || display === "list-item";
    };
    const appendBreak = () => {
      if (runs.length && !runs[runs.length - 1].break) runs.push({ text: "\n", break: true });
    };
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        // Emit the text node as a SINGLE run and let PowerPoint perform line
        // wrapping inside the box. We deliberately do NOT split at the browser's
        // soft-wrap positions: PowerPoint's font metrics differ (notably wider
        // for CJK), so baking the browser's visual lines as hard breaks makes PPT
        // re-wrap each baked line -> orphaned characters and vertical overflow.
        // Real line breaks come only from <br>/block flow (handled below).
        const text = (node.textContent || "").replace(/\s+/g, " ");
        if (!text.trim()) return;
        const owner = node.parentElement || el;
        const ownerStyle = getComputedStyle(owner);
        const ownerBg = cssBackground(ownerStyle);
        runs.push({
          text,
          fontFamily: ownerStyle.fontFamily,
          fontSize: px(ownerStyle.fontSize),
          fontWeight: ownerStyle.fontWeight,
          fontStyle: ownerStyle.fontStyle,
          lineHeight: px(ownerStyle.lineHeight),
          letterSpacing: px(ownerStyle.letterSpacing),
          color: textColorFor(ownerStyle, ownerBg),
          opacity: round(cumulativeOpacity(owner), 4),
        });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "SVG"].includes(node.tagName)) return;
      // An authored <br> is an explicit, intended line break -> preserve it.
      if (node.tagName === "BR") { appendBreak(); return; }
      const nodeStyle = getComputedStyle(node);
      if (nodeStyle.display === "none" || nodeStyle.visibility === "hidden" || (Number(nodeStyle.opacity) || 0) <= 0.015) return;
      const breaksFlow = node !== el && blockLike(nodeStyle);
      if (breaksFlow) appendBreak();
      [...node.childNodes].forEach(walk);
      if (breaksFlow) appendBreak();
    };
    [...el.childNodes].forEach(walk);
    while (runs.length && runs[runs.length - 1].break) runs.pop();
    return runs;
  };
  const zIndex = (style) => {
    const z = Number(style.zIndex);
    return Number.isFinite(z) ? z : 0;
  };
  const createsStackingContext = (style) => {
    const z = Number(style.zIndex);
    const positionedWithZ = style.position !== "static" && Number.isFinite(z);
    return positionedWithZ
      || (Number(style.opacity) || 1) < 1
      || (style.transform && style.transform !== "none")
      || (style.filter && style.filter !== "none")
      || (style.backdropFilter && style.backdropFilter !== "none")
      || (style.mixBlendMode && style.mixBlendMode !== "normal")
      || (style.isolation && style.isolation === "isolate")
      || (style.clipPath && style.clipPath !== "none");
  };
  const stackPath = (el) => {
    const chain = [];
    let node = el;
    while (node && node !== active && node.nodeType === Node.ELEMENT_NODE) {
      chain.unshift(node);
      node = node.parentElement;
    }
    const path = [];
    for (const item of chain) {
      const itemStyle = getComputedStyle(item);
      const z = Number(itemStyle.zIndex);
      if (Number.isFinite(z) && itemStyle.zIndex !== "auto") {
        path.push(z);
      } else if (createsStackingContext(itemStyle)) {
        path.push(0);
      }
    }
    return path.length ? path : [0];
  };
  // ---- Class-driven declarative reader ----
  // Only PPT-native component elements compile, and every visual value is read
  // straight from what the agent declared (design tokens) — never inferred from a
  // computed-style heuristic. Non-component visual elements become explicit losses.
  const COMPONENT_SEL = ".ppt-textbox, .ppt-shape, .ppt-line, .ppt-picture, .ppt-media";
  const SVG_PRIMITIVES = new Set(["path", "circle", "rect", "line", "polyline", "polygon", "text"]);
  const isContainerClass = (el) =>
    el.classList.contains("ppt-slide") || el.classList.contains("ppt-group") ||
    el.classList.contains("ppt-stagger") || el.classList.contains("ppt-abs");
  const directText = (el) =>
    [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent || "").trim());
  const resolveUrl = (value) => {
    const text = String(value || "").trim();
    if (!text) return null;
    try { return new URL(text, document.baseURI).href; }
    catch { return text; }
  };
  // Decompose a computed 2D transform into the native-expressible parts:
  // rotation (deg) + flipH/flipV. Pure rotation, pure flipH (scaleX(-1)), pure
  // flipV (scaleY(-1)) and rotation+flip combos all map to PowerPoint's xfrm.
  // Skew or non-unit scale are not native geometry -> returned as null (loss).
  const nativeTransform = (style) => {
    const t = String(style.transform || "");
    if (!t || t === "none") return null;
    const nums = t.match(/matrix\(([^)]+)\)/)?.[1]?.split(",").map((n) => Number(n.trim()));
    if (!nums || nums.length !== 6 || nums.some((n) => !Number.isFinite(n))) return null;
    const [a, b, c, d] = nums;
    const det = a * d - b * c;
    const flipV = det < 0; // negative determinant == one mirror; treat as flipV
    // Undo the mirror so the residual is a pure rotation we can read cleanly.
    const a2 = a, b2 = b, c2 = flipV ? -c : c, d2 = flipV ? -d : d;
    const sx = Math.hypot(a2, b2), sy = Math.hypot(c2, d2);
    if (!sx || !sy) return null;
    if (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02) return null; // scaled -> loss
    const skew = Math.abs((a2 * c2 + b2 * d2) / (sx * sy));
    if (skew > 0.02) return null; // skewed -> loss
    let rotation = Math.atan2(b2, a2) * 180 / Math.PI;
    if (Math.abs(rotation) < 0.01) rotation = 0;
    return { rotation, flipH: false, flipV };
  };
  const commonFor = (el, style, box, tag) => {
    const declaredRot = Number(el.getAttribute("data-ppt-rotation"));
    const css = nativeTransform(style);
    // Declared intent wins; otherwise read rotation/flip straight from CSS.
    const rot = Number.isFinite(declaredRot) ? declaredRot : (css ? css.rotation : NaN);
    const flipH = css ? css.flipH : false;
    const flipV = css ? css.flipV : false;
    return {
      flipH,
      flipV,
      key: stableKey(el, tag),
      tag,
      id: el.id || null,
      classes: [...el.classList],
      ancestorIds: sourceAncestors(el).ids,
      ancestorClasses: sourceAncestors(el).classes,
      box,
      zIndex: zIndex(style),
      stackPath: stackPath(el),
      order: order++,
      opacity: round(cumulativeOpacity(el), 4),
      transform: null,
      transformInfo: null,
      layoutBox: box,
      rotation: Number.isFinite(rot) && Math.abs(rot) > 0.01 ? round(rot, 3) : null,
      animationName: style.animationName && style.animationName !== "none" ? style.animationName : null,
      animationDuration: style.animationDuration || null,
      animationDelay: style.animationDelay || null,
      transition: style.transitionProperty && style.transitionProperty !== "all 0s ease 0s" ? style.transitionProperty : null,
      clip: null,
      morph: el.getAttribute("data-morph") || null,
      dataShape: el.getAttribute("data-shape") || null,
      pptAnimRaw: el.getAttribute("data-ppt-anim") || null,
      pptBuildRaw: el.getAttribute("data-ppt-build") || null,
      pptGlowRaw: el.getAttribute("data-ppt-glow") || null,
      pptBlurRaw: el.getAttribute("data-ppt-blur") || null,
      pptReflectionRaw: el.getAttribute("data-ppt-reflection") || null,
      cssFilter: style.filter && style.filter !== "none" ? String(style.filter) : null,
      pptMorphRaw: el.getAttribute("data-ppt-morph") || null,
    };
  };
  const animationTargetKeyFor = (el) => {
    const tag = el.tagName.toLowerCase();
    const base = stableKey(el, tag);
    return el.classList.contains("ppt-textbox") ? `${base}/text-flow` : base;
  };
  const parseSeqDecl = (value) => {
    const out = {};
    for (const part of String(value || "").split(";")) {
      const idx = part.indexOf(":");
      if (idx < 0) {
        const flag = part.trim();
        if (flag) out[flag] = true;
        continue;
      }
      const key = part.slice(0, idx).trim();
      if (key) out[key] = part.slice(idx + 1).trim();
    }
    return out;
  };
  const sequencesFor = (root) => {
    const sequences = [];
    for (const el of root.querySelectorAll("[data-ppt-sequence]")) {
      const raw = el.getAttribute("data-ppt-sequence") || "";
      const d = parseSeqDecl(raw);
      let candidates = [];
      if (d.selector) {
        try { candidates = [...el.querySelectorAll(d.selector)]; }
        catch { candidates = []; }
      } else {
        candidates = [...el.querySelectorAll(COMPONENT_SEL)];
      }
      const targets = [];
      for (const candidate of candidates) {
        if (!candidate.matches(COMPONENT_SEL)) continue;
        const key = animationTargetKeyFor(candidate);
        if (key && !targets.includes(key)) targets.push(key);
      }
      if (targets.length) sequences.push({ raw, targets });
    }
    return sequences;
  };
  // Collect [data-ppt-motif] containers. A motif names an information structure
  // (timeline, layers, comparison, ...); the node side maps it to a choreography
  // built from existing primitives. We only gather the children + their settled
  // centers here so the mapping can order them along an axis without DOM access.
  const KNOWN_MOTIFS = new Set(["timeline", "layers", "comparison", "metriccluster"]);
  const motifsFor = (root) => {
    const motifs = [];
    for (const el of root.querySelectorAll("[data-ppt-motif]")) {
      const raw = el.getAttribute("data-ppt-motif") || "";
      const name = (raw.split(";")[0] || "").trim().toLowerCase();
      if (!name) continue;
      if (!KNOWN_MOTIFS.has(name)) {
        // Report rather than silently no-op: a typo'd motif should not vanish.
        unsupported.push({ kind: "motif", name, reason: `unknown data-ppt-motif "${name}"` });
        continue;
      }
      const params = parseSeqDecl(raw);
      let spine = null;
      const items = [];
      for (const c of el.querySelectorAll(COMPONENT_SEL)) {
        if (!c.matches(COMPONENT_SEL)) continue;
        const key = animationTargetKeyFor(c);
        if (!key) continue;
        const role = (c.getAttribute("data-ppt-role") || "").trim().toLowerCase();
        const b = toStageRect(c.getBoundingClientRect());
        const isLine = c.classList.contains("ppt-line") || c.tagName.toLowerCase() === "svg";
        const rec = { key, role, cx: b.x + b.w / 2, cy: b.y + b.h / 2, w: b.w, h: b.h };
        if (!spine && (role === "spine" || isLine)) spine = rec;
        else items.push(rec);
      }
      motifs.push({ name, raw, params, spine, items });
    }
    return motifs;
  };
  // How many visual lines does this element's text occupy in the settled render?
  // Used to decide wrapping: a box the author sized for ONE line must not be left
  // on wrap="square", because PowerPoint's wider CJK metrics reflow it to two.
  const textLineCount = (node) => {
    try {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      if (!rects.length) return 1;
      const tops = [];
      for (const r of rects) {
        if (!tops.some((t) => Math.abs(t - r.top) <= 2)) tops.push(r.top);
      }
      return Math.max(1, tops.length);
    } catch { return 1; }
  };
  const textRecord = (el, style, common, bg, border, hasShadow) => {
    const runs = blockTextRunsFor(el);
    if (!runs.length) return null;
    return {
      ...common,
      key: `${common.key}/text-flow`,
      text: runs.map((run) => run.text).join(""),
      textRuns: runs,
      isTextBlock: true,
      singleLine: textLineCount(el) === 1,
      fontFamily: style.fontFamily,
      fontSize: px(style.fontSize),
      fontWeight: style.fontWeight,
      fontStyle: style.fontStyle,
      lineHeight: px(style.lineHeight),
      letterSpacing: px(style.letterSpacing),
      textAlign: style.textAlign,
      valign: readValign(el, style),
      color: textColorFor(style, bg),
      background: bg && (bg.alpha > 0.015 || bg.gradient) ? bg : { hex: null, alpha: 0 },
      border: border || { color: { hex: null, alpha: 0 }, width: 0, radius: "0px" },
      boxShadow: hasShadow ? style.boxShadow : null,
      hasPaint: false,
    };
  };

  // Elements already emitted as a text box; their descendants are read as inline
  // runs, so skip them to avoid emitting the same text twice.
  const textRoots = [];
  for (const el of active.querySelectorAll("*")) {
    if (elements.length >= opts.maxElements) break;
    const tag = el.tagName.toLowerCase();
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    if (textRoots.some((r) => r !== el && r.contains(el))) continue;
    const box = toStageRect(el.getBoundingClientRect());

    // SVG primitives are leaf content: read declared geometry/paint directly.
    if (SVG_PRIMITIVES.has(tag) && el.closest("svg")) {
      const svg = el.closest("svg");
      const ownerBox = toStageRect(svg.getBoundingClientRect());
      svgElements.push({
        ...commonFor(el, style, box, tag),
        svgBox: ownerBox,
        d: el.getAttribute("d"), cx: el.getAttribute("cx"), cy: el.getAttribute("cy"), r: el.getAttribute("r"),
        x: el.getAttribute("x"), y: el.getAttribute("y"), width: el.getAttribute("width"), height: el.getAttribute("height"),
        rx: el.getAttribute("rx"), ry: el.getAttribute("ry"),
        x1: el.getAttribute("x1"), y1: el.getAttribute("y1"), x2: el.getAttribute("x2"), y2: el.getAttribute("y2"),
        pointsAttr: el.getAttribute("points"),
        points: svgPointsFor(el, tag, svg),
        text: tag === "text" ? (el.textContent || "").trim() : "",
        fontFamily: style.fontFamily, fontSize: px(style.fontSize), fontWeight: style.fontWeight, fontStyle: style.fontStyle,
        textAlign: style.textAnchor === "middle" ? "center" : style.textAnchor === "end" ? "right" : "left",
        fillRaw: el.getAttribute("fill") || style.fill,
        strokeRaw: el.getAttribute("stroke") || style.stroke,
        fill: svgPaint(el, "fill", style),
        stroke: svgPaint(el, "stroke", style),
        strokeWidth: px(style.strokeWidth), strokeDasharray: style.strokeDasharray,
        strokeLinecap: style.strokeLinecap, strokeLinejoin: style.strokeLinejoin,
        markerEnd: el.getAttribute("marker-end") || style.markerEnd || null,
        raw: el.outerHTML.slice(0, 1600),
      });
      continue;
    }
    if (tag === "svg") continue; // container; its primitives are handled individually

    // <img> or .ppt-picture -> native picture.
    if (tag === "img" || el.classList.contains("ppt-picture")) {
      const imgNode = tag === "img" ? el : el.querySelector("img");
      const src = imgNode ? (imgNode.currentSrc || imgNode.src || null) : resolveUrl(el.getAttribute("data-src"));
      images.push({
        ...commonFor(el, style, box, tag),
        src,
        boxShadow: style.boxShadow && style.boxShadow !== "none" ? style.boxShadow : null,
      });
      continue;
    }

    // <video>/<audio> or .ppt-media -> native media picture with embedded media.
    if (tag === "video" || tag === "audio" || el.classList.contains("ppt-media")) {
      const mediaNode = tag === "video" || tag === "audio" ? el : el.querySelector("video,audio");
      const mediaTag = mediaNode ? mediaNode.tagName.toLowerCase() : "";
      const sourceNode = mediaNode ? mediaNode.querySelector("source") : null;
      const src = mediaNode
        ? (mediaNode.currentSrc || mediaNode.src || (sourceNode ? sourceNode.src : null))
        : resolveUrl(el.getAttribute("data-src"));
      const declaredType = (el.getAttribute("data-media-type") || el.getAttribute("data-kind") || "").toLowerCase();
      const mediaType = declaredType === "audio" || declaredType === "video"
        ? declaredType
        : mediaTag === "audio" ? "audio" : "video";
      const poster = mediaTag === "video"
        ? (mediaNode.getAttribute("poster") ? resolveUrl(mediaNode.getAttribute("poster")) : (mediaNode.poster || null))
        : resolveUrl(el.getAttribute("data-poster"));
      media.push({
        ...commonFor(el, style, box, tag),
        mediaType,
        src,
        poster,
        boxShadow: style.boxShadow && style.boxShadow !== "none" ? style.boxShadow : null,
      });
      continue;
    }

    // div-based components: only the component ROOT emits; inner nodes (inline
    // text runs etc.) are read by the root, so skip anything nested in a component.
    const componentRoot = el.closest(COMPONENT_SEL);
    if (componentRoot && componentRoot !== el) continue;

    const bg = cssBackground(style);
    const border = cssColor(style.borderColor);
    const hasShadow = Boolean(style.boxShadow && style.boxShadow !== "none");
    const common = commonFor(el, style, box, tag);

    if (el.classList.contains("ppt-line")) {
      const lineColor = cssColor(style.borderTopColor || style.borderColor);
      elements.push({
        ...common,
        isPptLine: true,
        line: {
          fill: lineColor.hex,
          alpha: lineColor.alpha * common.opacity,
          width: px(style.borderTopWidth || style.borderWidth) || 1,
          tailEnd: (el.getAttribute("data-arrow") || "").toLowerCase() === "end" ? "triangle" : null,
        },
        text: "",
        background: { hex: null, alpha: 0 },
        border: { color: lineColor, width: px(style.borderTopWidth || style.borderWidth) || 1, radius: "0px" },
        hasPaint: false,
      });
      continue;
    }

    if (el.classList.contains("ppt-shape")) {
      elements.push({
        ...common,
        text: "",
        fontFamily: style.fontFamily,
        fontSize: px(style.fontSize),
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        lineHeight: px(style.lineHeight),
        letterSpacing: px(style.letterSpacing),
        textAlign: style.textAlign,
        color: textColorFor(style, bg),
        background: bg,
        border: { color: border, width: px(style.borderWidth), radius: style.borderRadius },
        boxShadow: hasShadow ? style.boxShadow : null,
        hasPaint: true,
      });
      // A shape may carry its own label text (e.g. a button); emit as a sibling run.
      if (directText(el) || el.querySelector("span,strong,em,b,i,u")) {
        const rec = textRecord(el, style, common, null, null, false);
        if (rec) elements.push(rec);
      }
      continue;
    }

    if (el.classList.contains("ppt-textbox")) {
      const rec = textRecord(el, style, common, bg, { color: border, width: px(style.borderWidth), radius: style.borderRadius }, hasShadow);
      if (rec) elements.push(rec);
      continue;
    }

    if (isContainerClass(el)) continue; // structural containers carry no paint

    // ---- Auto-recognition: plain HTML/CSS, no component classes required. ----
    // The browser has already laid the page out (flex/grid/%/normal flow all
    // resolve to the computed box we read above), so we just classify each element
    // by what it is: text holder -> textbox, painted box -> shape, anything else
    // is a pure layout container whose children are emitted on their own.
    const paints = bg.alpha > 0.015 || Boolean(bg.gradient) || (border.alpha > 0.015 && px(style.borderWidth) > 0);
    const ownText = directText(el);
    if (box.w <= 1 || box.h <= 1) continue;
    if (ownText) {
      // Text element (h1..h6, p, span, li, a, td, blockquote, div with text…).
      // It reads its own inline runs, so skip descendants afterwards.
      const rec = textRecord(
        el, style, common,
        paints ? bg : { hex: null, alpha: 0 },
        { color: border, width: px(style.borderWidth), radius: style.borderRadius },
        hasShadow,
      );
      if (rec) { elements.push(rec); textRoots.push(el); }
      continue;
    }
    if (paints) {
      // Painted box with no direct text (a card/panel/divider) -> native shape.
      // Children paint/text emit on top of it.
      elements.push({
        ...common,
        text: "",
        fontFamily: style.fontFamily,
        fontSize: px(style.fontSize),
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        lineHeight: px(style.lineHeight),
        letterSpacing: px(style.letterSpacing),
        textAlign: style.textAlign,
        color: textColorFor(style, bg),
        background: bg,
        border: { color: border, width: px(style.borderWidth), radius: style.borderRadius },
        boxShadow: hasShadow ? style.boxShadow : null,
        hasPaint: true,
      });
      continue;
    }
    // Pure layout container (no paint, no own text) -> nothing to emit; its
    // children are visited by the loop on their own.
  }

  const stageStyle = getComputedStyle(active);
  return {
    step: opts.step,
    slideId: active.id || null,
    screenshot: opts.screenshot || null,
    activeBox: toStageRect(activeRect),
    stage: { width: stageRect.width, height: stageRect.height },
    background: cssBackground(stageStyle),
    pptTransitionRaw: active.getAttribute("data-ppt-transition") || null,
    sequences: sequencesFor(active),
    motifs: motifsFor(active),
    elements,
    svgElements,
    images,
    media,
    unsupported,
  };

  function round(n, digits = 2) {
    const p = 10 ** digits;
    return Math.round(Number(n) * p) / p;
  }
  function svgPointToStage(svg, x, y) {
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(Number(x) || 0, Number(y) || 0).matrixTransform(matrix);
    return { x: round(point.x - stageRect.left), y: round(point.y - stageRect.top) };
  }
  function parseSvgPoints(text) {
    const nums = String(text || "").match(/-?[\d.]+(?:e[-+]?\d+)?/gi)?.map(Number) || [];
    const points = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      points.push([nums[i], nums[i + 1]]);
    }
    return points;
  }
  function svgPointsFor(el, tag, svg) {
    try {
      if (tag === "line") {
        return [
          svgPointToStage(svg, el.getAttribute("x1"), el.getAttribute("y1")),
          svgPointToStage(svg, el.getAttribute("x2"), el.getAttribute("y2")),
        ].filter(Boolean);
      }
      if (tag === "polyline" || tag === "polygon") {
        const points = parseSvgPoints(el.getAttribute("points")).map(([x, y]) => svgPointToStage(svg, x, y)).filter(Boolean);
        if (tag === "polygon" && points.length > 2) points.push({ ...points[0] });
        return points;
      }
      if (tag === "path" && typeof el.getTotalLength === "function" && typeof el.getPointAtLength === "function") {
        const total = el.getTotalLength();
        if (!Number.isFinite(total) || total <= 0) return [];
        const segments = Math.max(2, Math.min(36, Math.ceil(total / 24)));
        const points = [];
        for (let i = 0; i <= segments; i += 1) {
          const p = el.getPointAtLength((total * i) / segments);
          const mapped = svgPointToStage(svg, p.x, p.y);
          if (mapped) points.push(mapped);
        }
        return points;
      }
    } catch {
      return [];
    }
    return [];
  }
  function stableKey(el, tag) {
    if (el.id) return `#${el.id}`;
    return domPath(el, tag);
  }
  function domPath(el, tag) {
    const parts = [];
    let node = el;
    while (node && node !== active && node.nodeType === Node.ELEMENT_NODE) {
      const parent = node.parentElement;
      const siblings = parent ? [...parent.children].filter((child) => child.tagName === node.tagName) : [];
      const nth = Math.max(1, siblings.indexOf(node) + 1);
      const cls = [...node.classList].slice(0, 3).join(".");
      parts.unshift(`${node.tagName.toLowerCase()}${cls ? "." + cls : ""}:nth-of-type(${nth})`);
      node = parent;
    }
    return `${tag}:${parts.join(">") || "root"}`;
  }
}

function extractAnimations() {
  const keyframes = [];
  for (const sheet of document.styleSheets) {
    let rules = [];
    try {
      rules = sheet.cssRules ? [...sheet.cssRules] : [];
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) {
        keyframes.push({
          name: rule.name,
          cssText: rule.cssText,
          frames: [...rule.cssRules].map((frame) => ({ keyText: frame.keyText, style: frame.style.cssText })),
        });
      }
    }
  }
  return { keyframes };
}

async function settleAnimations() {
  const animations = document.getAnimations({ subtree: true });
  for (const animation of animations) {
    const effect = animation.effect;
    if (!effect || typeof effect.getComputedTiming !== "function") continue;
    const timing = effect.getComputedTiming();
    try {
      if (!Number.isFinite(timing.endTime)) {
        animation.currentTime = 0;
        animation.pause();
        continue;
      }
      const endTime = Math.max(0, timing.endTime - 0.001);
      animation.currentTime = endTime;
      animation.pause();
    } catch {
      // Some browser-generated transition animations reject currentTime writes.
    }
  }
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function buildAuthorScene(ir) {
  const slides = ir.slides.map((slide) => {
    const elements = [];
    let compiledSvgElements = 0;
    const slideBg = slide.background || {};
    if (slideBg.gradient) {
      const source = { key: "active-slide/background", id: slide.slideId || null, classes: [], tag: "slide" };
      elements.push({
        type: "shape",
        name: "slide background gradient",
        shape: "rect",
        x: 0,
        y: 0,
        w: slide.stage?.width || ir.viewport.width,
        h: slide.stage?.height || ir.viewport.height,
        fill: null,
        fillAlpha: 0,
        fillGradient: {
          type: slideBg.gradient.type,
          angle: slideBg.gradient.angle,
          colors: slideBg.gradient.colors.map((color) => ({
            hex: color.hex,
            alpha: color.alpha,
            pos: color.pos,
          })),
        },
        line: { fill: null, alpha: 0, width: 0 },
        _stackPath: [-10000],
        _order: -10000,
        source,
        morphKey: morphKeyForSource(source),
      });
    }
    const sorted = [...slide.elements].sort(comparePaintOrder);
    const textElements = [];
    for (const el of sorted) {
      const box = authoredBox(el);
      if (el.isPptLine && box.w > 0.5) {
        const source = sourceRef(el);
        elements.push({
          type: "line",
          name: sourceName(el, "line"),
          x1: box.x,
          y1: box.y + box.h / 2,
          x2: box.x + box.w,
          y2: box.y + box.h / 2,
          line: el.line || { fill: el.border?.color?.hex || "111111", alpha: el.opacity ?? 1, width: el.border?.width || 1 },
          arrow: Boolean(el.line?.tailEnd),
          _zIndex: el.zIndex,
          _stackPath: el.stackPath || [el.zIndex || 0],
          _order: el.order,
          source,
          morphKey: morphKeyForSource(source),
        });
        continue;
      }
      if (el.hasPaint && box.w > 1 && box.h > 1) {
        const shape = classifyShape({ ...el, box });
        const source = sourceRef(el);
        elements.push({
          type: "shape",
          name: sourceName(el, "box"),
          shape,
          x: box.x,
          y: box.y,
          w: box.w,
          h: box.h,
          rotation: authorRotation(el),
          flipH: el.flipH || false,
          flipV: el.flipV || false,
          fill: el.background.alpha > 0.015 ? el.background.hex : null,
          fillAlpha: el.background.alpha * el.opacity,
          fillGradient: el.background.gradient
            ? {
                type: el.background.gradient.type,
                angle: el.background.gradient.angle,
                colors: el.background.gradient.colors.map((color) => ({
                  hex: color.hex,
                  alpha: color.alpha * el.opacity,
                  pos: color.pos,
                })),
              }
            : null,
          line: {
            fill: el.border.color.alpha > 0.015 && el.border.width > 0 ? el.border.color.hex : null,
            alpha: el.border.color.alpha * el.opacity,
            width: el.border.width || 0,
          },
          radiusPx: cssRadiusPx(el.border.radius, box),
          shadow: parseBoxShadow(el.boxShadow),
          _zIndex: el.zIndex,
          _stackPath: el.stackPath || [el.zIndex || 0],
          _order: el.order,
          source,
          morphKey: morphKeyForSource(source),
        });
      }
      if (el.isTextBlock) {
        elements.push(authorTextBlockElement(el));
      } else if (el.text) {
        textElements.push(el);
      }
    }
    for (const image of slide.images || []) {
      if (!isSupportedImageSrc(image.src)) continue;
      const source = sourceRef(image);
      const box = authoredBox(image);
      elements.push({
        type: "image",
        name: sourceName(image, "image"),
        src: image.src,
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        rotation: authorRotation(image),
        shadow: parseBoxShadow(image.boxShadow),
        _zIndex: image.zIndex || 0,
        _stackPath: image.stackPath || [image.zIndex || 0],
        _order: image.order || 0,
        source,
        morphKey: morphKeyForSource(source),
      });
    }
    for (const item of slide.media || []) {
      if (!isSupportedMediaSrc(item.src)) continue;
      const source = sourceRef(item);
      const box = authoredBox(item);
      const poster = isSupportedImageSrc(item.poster) ? item.poster : undefined;
      elements.push({
        type: "media",
        name: sourceName(item, item.mediaType === "audio" ? "audio" : "media"),
        mediaType: item.mediaType === "audio" ? "audio" : "video",
        src: item.src,
        ...(poster ? { poster } : {}),
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        rotation: authorRotation(item),
        shadow: parseBoxShadow(item.boxShadow),
        _zIndex: item.zIndex || 0,
        _stackPath: item.stackPath || [item.zIndex || 0],
        _order: item.order || 0,
        source,
        morphKey: morphKeyForSource(source),
      });
    }
    for (const svgElement of slide.svgElements || []) {
      const authored = authorSvgElements(svgElement);
      if (authored.length) {
        compiledSvgElements += 1;
        elements.push(...authored);
      }
    }
    elements.push(...groupTextRuns(textElements).map(authorTextElement));
    elements.sort(comparePaintOrder);
    applyPptGlow(slide, elements);
    applyPptEffects(slide, elements);
    const firstStep = ir.slides[0]?.step;
    const animations = slideAnimationsFor(slide, elements);
    return {
      name: slide.slideId || `step-${slide.step}`,
      sourceStep: slide.step,
      sourceSlideId: slide.slideId,
      background: slideBg.alpha > 0.015 && !slideBg.gradient ? slideBg.hex : "FFFFFF",
      transition: pptTransitionFor(slide, slide.step === firstStep),
      animations: animations.length ? { framework: "ppt-compatible-v1", effects: animations } : undefined,
      elements,
      unsupported: {
        svgElements: Math.max(0, slide.svgElements.length - compiledSvgElements),
        images: (slide.images || []).filter((image) => !isSupportedImageSrc(image.src)).length,
        media: (slide.media || []).filter((item) => !isSupportedMediaSrc(item.src)).length,
        cssOnly: slide.unsupported.length,
      },
    };
  });
  return {
    title: "HTML extracted PPTX scene",
    source: ir.source,
    extractor: "tools/html2scene.cjs",
    contract: ir.contract,
    size: {
      cx: 12192000,
      cy: 6858000,
      // Map px->EMU using the authored slide stage size, not the browser
      // viewport, so a 1280x720 .ppt-slide fills the canvas without overflow.
      pxWidth: Math.round(ir.slides[0]?.stage?.width || ir.viewport.width),
      pxHeight: Math.round(ir.slides[0]?.stage?.height || ir.viewport.height),
    },
    slides,
  };
}

function authorRotation(el) {
  const value = Number(el?.rotation);
  if (!Number.isFinite(value) || Math.abs(value) < 0.01) return null;
  return roundNumber(value, 3);
}

function isSupportedImageSrc(src) {
  const text = String(src || "");
  return text.startsWith("data:image/") || text.startsWith("file://") || /^\/[^/]/.test(text);
}

function isSupportedMediaSrc(src) {
  const text = String(src || "");
  return text.startsWith("data:video/") || text.startsWith("data:audio/") ||
    text.startsWith("file://") || /^\/[^/]/.test(text);
}

function authoredBox(el) {
  const fallback = el?.box || { x: 0, y: 0, w: 0, h: 0, right: 0, bottom: 0 };
  if (authorRotation(el) == null) return fallback;
  const box = el?.layoutBox || fallback;
  if (!Number.isFinite(Number(box.w)) || !Number.isFinite(Number(box.h)) || box.w <= 0 || box.h <= 0) {
    return fallback;
  }
  return box;
}

// Slide transition from a declarative data-ppt-transition. The compiler must
// not invent Morph transitions; that changes authored slide intent and can make
// unrelated objects appear to animate between pages.
function pptTransitionFor(slide, isFirst) {
  const raw = slide.pptTransitionRaw;
  if (raw) {
    const d = {};
    for (const part of String(raw).split(";")) {
      const i = part.indexOf(":");
      if (i < 0) { const f = part.trim(); if (f) d.type = d.type || f; continue; }
      d[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    const type = (d.type || d.transition || "morph").toLowerCase();
    if (type === "none") return undefined;
    if (type === "morph" || type === "smooth" || type === "平滑") {
      return {
        type: "morph",
        option: d.option || "byObject",
        durationMs: Number(d.dur || d.durationMs || 1000),
        speed: d.speed || "slow",
      };
    }
    return type; // fade/push/wipe/split
  }
  if (isFirst) return "fade";
  return undefined;
}

function slideAnimationsFor(slide, elements) {
  // Animations come only from agent-declared data-ppt-* intent. The compiler
  // never choreographs a specific deck for the agent.
  return dedupeAnimations([
    ...declaredPptAnimations(slide, elements),
    ...declaredPptSequences(slide, elements),
    ...declaredPptMotifs(slide, elements),
  ]);
}

// ---- Motif choreography -----------------------------------------------------
// A motif maps an information structure to animation rows built from existing
// primitives. Each function is pure: (motifRecord, elements) -> rows[], using
// the same row shape as declaredPptSequences. No new OOXML writers.
// See docs/motif-choreography-proposal.md.

// timeline: draw the axis (spine) first, then resolve nodes/cards in reading
// order along the axis, each drifting the last few px into place and settling.
function timelineMotif(motif) {
  const p = motif.params || {};
  const axis = String(p.axis || "x").toLowerCase() === "y" ? "y" : "x";
  const from = String(p.from || (axis === "x" ? "left" : "top")).toLowerCase();
  const dur = numberOr(p.dur, 520);
  const gap = numberOr(firstDefined(p.gap, p.stagger), 140);
  const overlap = numberOr(p.overlap, 120);
  const baseDelay = numberOr(p.delay, 0);
  const firstTrigger = normalizePptTrigger(firstDefined(p.trigger, "afterPrev"));
  const rows = [];
  let first = true;
  const push = (target, intent, delayMs) => {
    if (!intent) return;
    rows.push({ ...intent, target, trigger: first ? firstTrigger : "withPrevious", delayMs });
    first = false;
  };

  const spineDur = Math.max(dur, 640);
  if (motif.spine) {
    push(motif.spine.key, pptAnimToIntent({ entrance: "wipe", dur: spineDur }), baseDelay);
  }
  const spineLead = motif.spine ? spineDur - overlap : 0;

  const ordered = [...(motif.items || [])].sort((a, b) => (axis === "x" ? a.cx - b.cx : a.cy - b.cy));
  if (from === "right" || from === "bottom") ordered.reverse();
  const drift = from === "right" || from === "bottom" ? 24 : -24;
  ordered.forEach((it, i) => {
    const intent = pptAnimToIntent({
      compose: true,
      opacity: "in",
      x: axis === "x" ? drift : 0,
      y: axis === "x" ? 18 : drift,
      scaleFrom: 0.96,
      scaleTo: 1,
      dur,
    });
    push(it.key, intent, baseDelay + spineLead + i * gap);
  });
  return rows;
}

// layers: a stacked band diagram resolves top -> bottom in a tight cascade,
// each band settling down a few px. No spine.
function layersMotif(motif) {
  const p = motif.params || {};
  const dur = numberOr(p.dur, 460);
  const gap = numberOr(firstDefined(p.gap, p.stagger), 70);
  const baseDelay = numberOr(p.delay, 0);
  const firstTrigger = normalizePptTrigger(firstDefined(p.trigger, "afterPrev"));
  const ordered = [...(motif.items || [])].sort((a, b) => a.cy - b.cy);
  return ordered.map((it, i) => ({
    ...pptAnimToIntent({ compose: true, opacity: "in", y: -16, scaleFrom: 0.98, scaleTo: 1, dur }),
    target: it.key,
    trigger: i === 0 ? firstTrigger : "withPrevious",
    delayMs: baseDelay + i * gap,
  }));
}

// comparison: left and right columns enter symmetrically from their own edge,
// paired by row so each row's two sides arrive together; an optional center
// divider (role:center) resolves last.
function comparisonMotif(motif) {
  const p = motif.params || {};
  const dur = numberOr(p.dur, 520);
  const gap = numberOr(firstDefined(p.gap, p.stagger), 120);
  const baseDelay = numberOr(p.delay, 0);
  const firstTrigger = normalizePptTrigger(firstDefined(p.trigger, "afterPrev"));
  const items = motif.items || [];
  const xs = items.map((it) => it.cx);
  const mid = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0;
  const center = items.filter((it) => it.role === "center");
  const sided = items.filter((it) => it.role !== "center");
  const left = sided.filter((it) => it.role === "left" || (!it.role && it.cx < mid)).sort((a, b) => a.cy - b.cy);
  const right = sided.filter((it) => it.role === "right" || (!it.role && it.cx >= mid)).sort((a, b) => a.cy - b.cy);
  const rows = [];
  let first = true;
  const emit = (it, driftX, delayMs) => {
    rows.push({
      ...pptAnimToIntent({ compose: true, opacity: "in", x: driftX, scaleFrom: 0.97, scaleTo: 1, dur }),
      target: it.key,
      trigger: first ? firstTrigger : "withPrevious",
      delayMs,
    });
    first = false;
  };
  const rowCount = Math.max(left.length, right.length);
  for (let i = 0; i < rowCount; i++) {
    const delayMs = baseDelay + i * gap;
    if (left[i]) emit(left[i], -28, delayMs);
    if (right[i]) emit(right[i], 28, delayMs);
  }
  center.forEach((it) => emit(it, 0, baseDelay + rowCount * gap));
  return rows;
}

// metricCluster: KPI tiles rise softly in reading order with gentle overlap.
function metricClusterMotif(motif) {
  const p = motif.params || {};
  const dur = numberOr(p.dur, 520);
  const gap = numberOr(firstDefined(p.gap, p.stagger), 90);
  const baseDelay = numberOr(p.delay, 0);
  const firstTrigger = normalizePptTrigger(firstDefined(p.trigger, "afterPrev"));
  const ordered = [...(motif.items || [])].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  return ordered.map((it, i) => ({
    ...pptAnimToIntent({ compose: true, opacity: "in", y: 18, scaleFrom: 0.96, scaleTo: 1, dur }),
    target: it.key,
    trigger: i === 0 ? firstTrigger : "withPrevious",
    delayMs: baseDelay + i * gap,
  }));
}

const MOTIF_REGISTRY = {
  timeline: timelineMotif,
  layers: layersMotif,
  comparison: comparisonMotif,
  metriccluster: metricClusterMotif,
};

function declaredPptMotifs(slide, elements) {
  const rows = [];
  for (const motif of slide.motifs || []) {
    const fn = MOTIF_REGISTRY[motif && motif.name];
    if (!fn) continue;
    rows.push(...fn(motif, elements));
  }
  return rows.filter((row) => row.target && animationTargetExists(elements, row.target));
}

// Parse a "k:v; k:v" declarative string into a plain object.
function parsePptDecl(value) {
  const out = {};
  if (!value) return out;
  for (const part of String(value).split(";")) {
    const idx = part.indexOf(":");
    if (idx < 0) {
      const flag = part.trim();
      if (flag) out[flag] = true;
      continue;
    }
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function normalizePptTrigger(value) {
  const t = String(value || "").trim().toLowerCase().replace(/[-_\s]/g, "");
  if (t === "withprev" || t === "withprevious" || t === "with") return "withPrevious";
  if (t === "afterprev" || t === "afterprevious" || t === "after") return "afterPrevious";
  if (t === "auto") return "auto";
  return "onClick";
}

// One element may declare several animations, "|"-separated, played in sequence.
// Each segment is an independent data-ppt-anim declaration.
function pptAnimIntents(raw) {
  return String(raw || "")
    .split("|")
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => pptAnimToIntent(parsePptDecl(seg)))
    .filter(Boolean);
}

// Map a parsed data-ppt-anim declaration to a scene animation intent.
function pptAnimToIntent(d) {
  const trigger = normalizePptTrigger(d.trigger || d.start);
  const base = { trigger };
  if (d.dur != null) base.durationMs = Number(d.dur);
  if (d.delay != null) base.delayMs = Number(d.delay);
  if (d.ease != null) base.ease = String(d.ease).trim().toLowerCase();
  if (d.dist != null) base.dist = Number(d.dist);
  if (d.repeat != null) base.repeat = String(d.repeat).trim();
  if (d.alt !== undefined || d.autoRev !== undefined) base.autoRev = true;
  const mediaCommand = mediaCommandFor(d);
  if (mediaCommand) {
    const out = { ...base, effect: `media${mediaCommand[0].toUpperCase()}${mediaCommand.slice(1)}` };
    if (d.cmd || d.command) out.cmd = String(d.cmd || d.command);
    if (d.startSeconds != null || d.startSec != null || d.fromSeconds != null) {
      out.startSeconds = Number(d.startSeconds ?? d.startSec ?? d.fromSeconds);
    }
    if (d.cmdDurationMs != null) out.cmdDurationMs = Number(d.cmdDurationMs);
    return out;
  }
  if (d.compose !== undefined || d.combo !== undefined || d.effect === "compose" || d.effect === "combo" || d.entrance === "compose") {
    const out = { ...base, effect: "compose" };
    const opacity = String(d.opacity || d.fade || "").trim().toLowerCase();
    if (opacity) out.opacity = opacity;
    for (const [key, outKey] of [
      ["x", "x"], ["y", "y"], ["dx", "x"], ["dy", "y"],
      ["scaleFrom", "scaleFrom"], ["scaleTo", "scaleTo"],
      ["rotateFrom", "rotateFrom"], ["rotateTo", "rotateTo"],
    ]) {
      if (d[key] != null) out[outKey] = Number(d[key]);
    }
    if (d.motion || d.path) out.pptPath = String(d.path || d.motion);
    if (d.recolor || d.toColor) out.toColor = String(d.recolor || d.toColor);
    return out;
  }
  if (d.entrance) return { ...base, effect: String(d.entrance) };
  if (d.appear !== undefined) return { ...base, effect: "appear" };
  if (d.exit) return { ...base, effect: `exit-${String(d.exit)}` };
  if (d.emphasis) {
    const out = { ...base, effect: String(d.emphasis) };
    if (d.spins != null) out.spins = Number(d.spins);
    if (d.byDeg != null) out.byDeg = Number(d.byDeg);
    if (d.scale != null) out.scale = Number(d.scale);
    return out;
  }
  if (d.motion || d.path) {
    return { ...base, effect: "motionPath", pptPath: String(d.path || d.motion) };
  }
  if (d.recolor) {
    return { ...base, effect: "recolor", toColor: String(d.recolor) };
  }
  return null;
}

function mediaCommandFor(d) {
  const raw = String(d.media || d.mediaCommand || d.effect || d.type || d.cmd || d.command || "").trim().toLowerCase();
  const compact = raw.replace(/[-_\s]/g, "");
  if (compact === "mediaplay" || compact === "playmedia" || compact === "play" || d.play !== undefined) return "play";
  if (compact === "mediapause" || compact === "pausemedia" || compact === "pause" || d.pause !== undefined) return "pause";
  if (compact === "mediastop" || compact === "stopmedia" || compact === "stop" || d.stop !== undefined) return "stop";
  return null;
}

function declaredPptAnimations(slide, elements) {
  const rows = [];
  for (const el of authoredNativeSources(slide)) {
    const source = sourceRef(el);
    // GUARD: data-ppt-anim and data-ppt-build must NOT coexist on the same element.
    // Combining them generates conflicting shape-level + paragraph-level animation OOXML
    // that PowerPoint flags as corrupt and "repairs" by deleting all animations.
    // When both are present, honour data-ppt-anim and silently drop data-ppt-build.
    if (el.pptAnimRaw && el.pptBuildRaw) {
      // Conflict resolution (e.g. morph object + entrance) is centralized in
      // tools/ppt_guards.cjs and runs on the assembled scene.
      for (const intent of pptAnimIntents(el.pptAnimRaw)) rows.push({ ...intent, target: source.key });
      // data-ppt-build intentionally skipped — mixing with data-ppt-anim is invalid.
      continue;
    }
    if (el.pptAnimRaw) {
      // A "|"-separated list chains multiple animations on one element, in order
      // (rise | pulse | exit) — the engine's coherent multi-animation primitive.
      for (const intent of pptAnimIntents(el.pptAnimRaw)) rows.push({ ...intent, target: source.key });
    }
    if (el.pptBuildRaw) {
      const d = parsePptDecl(el.pptBuildRaw);
      rows.push({
        effect: "build",
        target: source.key,
        trigger: normalizePptTrigger(d.trigger),
        buildEffect: d.effect || d.buildEffect || "fade",
        ...(d.dur != null ? { durationMs: Number(d.dur) } : {}),
      });
    }
  }
  return rows.filter((row) => row.target && animationTargetExists(elements, row.target));
}

function authoredNativeSources(slide) {
  return [
    ...(slide.elements || []),
    ...(slide.images || []),
    ...(slide.media || []),
    ...(slide.svgElements || []),
  ];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sequenceBaseIntent(d) {
  const hasEffect = d.compose !== undefined || d.combo !== undefined || d.effect || d.entrance ||
    d.exit || d.emphasis || d.motion || d.path || d.appear !== undefined || d.recolor;
  const decl = { ...d };
  if (!hasEffect || d.mode === "stagger" || d.stagger !== undefined) {
    decl.compose = true;
    decl.opacity = firstDefined(d.opacity, "in");
    decl.x = firstDefined(d.x, d.dx, -42);
    decl.y = firstDefined(d.y, d.dy, 16);
    decl.scaleFrom = firstDefined(d.scaleFrom, 0.96);
    decl.scaleTo = firstDefined(d.scaleTo, 1);
  }
  delete decl.selector;
  delete decl.targets;
  delete decl.gap;
  delete decl.overlap;
  delete decl.stagger;
  delete decl.mode;
  return pptAnimToIntent(decl);
}

function declaredPptSequences(slide, elements) {
  const rows = [];
  for (const sequence of slide.sequences || []) {
    const targets = Array.isArray(sequence.targets) ? sequence.targets : [];
    if (!targets.length) continue;
    const d = parsePptDecl(sequence.raw || "");
    const base = sequenceBaseIntent(d);
    if (!base) continue;
    const duration = numberOr(base.durationMs, numberOr(d.dur, 520));
    const overlap = numberOr(d.overlap, 0);
    const gap = numberOr(firstDefined(d.gap, d.stagger), Math.max(0, duration - overlap));
    const baseDelay = numberOr(base.delayMs, numberOr(d.delay, 0));
    const firstTrigger = normalizePptTrigger(firstDefined(d.trigger, "afterPrev"));
    targets.forEach((target, index) => {
      const delayMs = baseDelay + Math.max(0, index * gap);
      rows.push({
        ...base,
        target,
        trigger: index === 0 ? firstTrigger : "withPrevious",
        delayMs,
      });
    });
  }
  return rows.filter((row) => row.target && animationTargetExists(elements, row.target));
}

// Apply data-ppt-glow onto authored scene elements by source key.
function applyPptGlow(slide, elements) {
  const glowByKey = new Map();
  for (const el of authoredNativeSources(slide)) {
    if (!el.pptGlowRaw) continue;
    const d = parsePptDecl(el.pptGlowRaw);
    glowByKey.set(sourceRef(el).key, {
      color: (d.color || "#FFFFFF").replace("#", ""),
      radius: Number(d.radius || d.blur || 12),
      alpha: d.alpha != null ? Number(d.alpha) : 1,
    });
  }
  if (!glowByKey.size) return;
  for (const e of elements) {
    const key = e.source?.key;
    if (key && glowByKey.has(key)) e.glow = glowByKey.get(key);
  }
}

// Apply blur + reflection onto authored scene elements by source key. Blur comes
// from data-ppt-blur OR native CSS filter:blur(); reflection from data-ppt-reflection.
function applyPptEffects(slide, elements) {
  const blurByKey = new Map();
  const reflByKey = new Map();
  for (const el of authoredNativeSources(slide)) {
    const key = sourceRef(el).key;
    let blurPx = el.pptBlurRaw != null ? Number(el.pptBlurRaw) : null;
    if (!Number.isFinite(blurPx) || blurPx <= 0) {
      const m = String(el.cssFilter || "").match(/blur\(\s*([\d.]+)px\s*\)/i);
      blurPx = m ? Number(m[1]) : null;
    }
    if (Number.isFinite(blurPx) && blurPx > 0) blurByKey.set(key, { radius: blurPx });
    if (el.pptReflectionRaw != null) {
      const d = parsePptDecl(el.pptReflectionRaw);
      reflByKey.set(key, {
        alpha: d.alpha != null ? Number(d.alpha) : 0.5,
        dist: d.dist != null ? Number(d.dist) : 0,
        blur: d.blur != null ? Number(d.blur) : 0,
      });
    }
  }
  if (!blurByKey.size && !reflByKey.size) return;
  for (const e of elements) {
    const key = e.source?.key;
    if (!key) continue;
    if (blurByKey.has(key)) e.blur = blurByKey.get(key);
    if (reflByKey.has(key)) e.reflection = reflByKey.get(key);
  }
}

function animationTargetForElement(element) {
  return element?.source?.key || element?.name || null;
}

function animationTargetExists(elements, target) {
  const key = String(target || "");
  return elements.some((element) => animationTargetForElement(element) === key);
}

function dedupeAnimations(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = [row.effect, row.target, row.delayMs, row.durationMs, row.start].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function stackPathOf(item) {
  return item._stackPath || item.stackPath || [item._zIndex ?? item.zIndex ?? 0];
}

function compareStackPath(a, b) {
  const aa = stackPathOf(a);
  const bb = stackPathOf(b);
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i += 1) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function comparePaintOrder(a, b) {
  return compareStackPath(a, b) || ((a._order ?? a.order ?? 0) - (b._order ?? b.order ?? 0));
}

function firstPaintItem(items) {
  return items.slice().sort(comparePaintOrder)[0] || {};
}

function authorSvgElements(el) {
  const source = sourceRef(el);
  const common = {
    _zIndex: el.zIndex || 0,
    _stackPath: el.stackPath || [el.zIndex || 0],
    _order: el.order || 0,
    source,
    morphKey: morphKeyForSource(source),
  };
  const line = svgLine(el);
  if (el.tag === "text" && String(el.text || "").trim()) {
    return [{
      type: "text",
      name: sourceName(el, "svg-text"),
      x: el.box.x,
      y: el.box.y,
      w: Math.max(el.box.w + 8, 12),
      h: Math.max(el.box.h + 4, 12),
      text: String(el.text || "").trim(),
      fontSize: cssPxToPt(el.fontSize || 14),
      lineHeight: el.lineHeight ? cssPxToPt(el.lineHeight) : null,
      font: preferredFont(el.fontFamily, el.text),
      latinFont: firstFont(el.fontFamily) || "Times New Roman",
      color: el.fill?.hex || "1F2937",
      alpha: (el.fill?.alpha ?? 1) * (el.opacity ?? 1),
      bold: fontIsBold(el.fontWeight),
      italic: el.fontStyle === "italic",
      align: normalizeAlign(el.textAlign),
      valign: "top",
      wrap: "none",
      autofit: "none",
      ...common,
    }];
  }
  if (el.tag === "rect") {
    const radius = Math.max(Number(el.rx) || 0, Number(el.ry) || 0);
    return [svgShape(el, clippedBackdropShape(el) || (radius > 2 ? "roundRect" : "rect"), common, line)];
  }
  if (el.tag === "circle") {
    return [svgShape(el, "ellipse", common, line)];
  }
  if (el.tag === "path" && svgLooksLikeStar(el)) {
    return [svgShape(el, "star5", common, line)];
  }
  if (hasVisibleLine(line) && (el.tag === "line" || el.tag === "polyline" || el.tag === "polygon" || el.tag === "path") && Array.isArray(el.points) && el.points.length >= 2) {
    return [{
      type: "polyline",
      name: sourceName(el, "svg-line"),
      points: el.points.map((point) => [point.x, point.y]),
      line,
      arrow: hasSvgArrow(el),
      ...common,
    }];
  }
  // Filled arbitrary path/polygon: emit a native closed freeform (custGeom)
  // from sampled points instead of dropping it as a loss or faking a rect.
  if (
    ["path", "polygon", "polyline"].includes(el.tag) &&
    (el.fill?.alpha ?? 0) > 0.015 &&
    Array.isArray(el.points) &&
    el.points.length >= 3
  ) {
    return [{
      type: "freeform",
      name: sourceName(el, "svg-freeform"),
      points: el.points.map((point) => [point.x, point.y]),
      closed: true,
      fill: el.fill.hex,
      fillAlpha: (el.fill.alpha ?? 0) * (el.opacity ?? 1),
      line: hasVisibleLine(line) ? line : { fill: null, width: 0 },
      ...common,
    }];
  }
  if (!["path", "polygon", "polyline"].includes(el.tag) && (el.fill?.alpha ?? 0) > 0.015 && el.box.w > 1 && el.box.h > 1) {
    return [svgShape(el, "rect", common, line)];
  }
  return [];
}

function hasVisibleLine(line) {
  return Boolean(line?.fill) && (Number(line?.alpha) || 0) > 0.015 && (Number(line?.width) || 0) > 0;
}

function svgShape(el, shape, common, line) {
  const box = clippedBackdropShape(el) ? el.clip.box : el.box;
  return {
    type: "shape",
    name: sourceName(el, `svg-${shape}`),
    shape,
    x: box.x,
    y: box.y,
    w: Math.max(box.w, 1),
    h: Math.max(box.h, 1),
    fill: (el.fill?.alpha ?? 0) > 0.015 ? el.fill.hex : null,
    fillAlpha: (el.fill?.alpha ?? 0) * (el.opacity ?? 1),
    line,
    radiusPx: shape === "roundRect" ? svgRadiusPx(el) : 0,
    ...common,
  };
}

function svgRadiusPx(el) {
  const rx = Math.max(Number(el.rx) || 0, Number(el.ry) || 0);
  if (!rx) return 0;
  const rawWidth = Number(el.width) || 0;
  const scale = rawWidth > 0 ? (el.box.w || 0) / rawWidth : 1;
  return Math.max(0, rx * scale);
}

function clippedBackdropShape(el) {
  const clip = el.clip;
  if (!clip?.box || !clip.shape || clip.shape === "rect") return null;
  if (!boxesNearlyEqual(el.box, clip.box, 3)) return null;
  return clip.shape;
}

function boxesNearlyEqual(a, b, tolerance) {
  return Math.abs((a?.x ?? 0) - (b?.x ?? 0)) <= tolerance
    && Math.abs((a?.y ?? 0) - (b?.y ?? 0)) <= tolerance
    && Math.abs((a?.w ?? 0) - (b?.w ?? 0)) <= tolerance
    && Math.abs((a?.h ?? 0) - (b?.h ?? 0)) <= tolerance;
}

function svgLine(el) {
  const alpha = (el.stroke?.alpha ?? 0) * (el.opacity ?? 1);
  const width = Number(el.strokeWidth) || 0;
  const line = {
    fill: alpha > 0.015 && width > 0 ? el.stroke.hex : null,
    alpha,
    width,
  };
  if (svgDash(el.strokeDasharray)) line.dash = svgDash(el.strokeDasharray);
  return line;
}

function svgDash(value) {
  const text = String(value || "").trim();
  if (!text || text === "none") return null;
  const nums = text.match(/[\d.]+/g)?.map(Number).filter((n) => n > 0) || [];
  if (!nums.length) return null;
  if (nums.some((n) => n > 20)) return null;
  return nums.length <= 2 ? "dash" : "dashDot";
}

function hasSvgArrow(el) {
  const marker = String(el.markerEnd || "");
  return marker && marker !== "none";
}

function svgLooksLikeStar(el) {
  const d = String(el.d || "").replace(/\s+/g, "");
  return d.startsWith("M70.5L8.35.1L135.5") || d.includes("L10.413.2L710.6L3.613.2");
}

function authorTextBlockElement(el) {
  const source = sourceRef(el);
  const box = authoredBox(el);
  const runs = (el.textRuns || []).map((run) => {
    if (run.break) return { text: "\n", break: true };
    return {
      text: run.text,
      fontSize: cssPxToPt(run.fontSize || el.fontSize || 14),
      lineHeight: run.lineHeight ? cssPxToPt(run.lineHeight) : null,
      font: preferredFont(run.fontFamily || el.fontFamily, run.text),
      latinFont: firstFont(run.fontFamily || el.fontFamily) || "Times New Roman",
      color: run.color?.hex || el.color?.hex || "1F2937",
      alpha: (run.color?.alpha ?? 1) * (run.opacity ?? el.opacity ?? 1),
      bold: fontIsBold(run.fontWeight),
      italic: run.fontStyle === "italic",
    };
  });
  const firstRun = runs.find((run) => !run.break) || null;
  const fallbackRun = firstRun || {
    fontSize: cssPxToPt(el.fontSize || 14),
    lineHeight: el.lineHeight ? cssPxToPt(el.lineHeight) : null,
    font: preferredFont(el.fontFamily, el.text),
    latinFont: firstFont(el.fontFamily) || "Times New Roman",
    color: el.color?.hex || "1F2937",
    alpha: (el.color?.alpha ?? 1) * (el.opacity ?? 1),
    bold: fontIsBold(el.fontWeight),
    italic: el.fontStyle === "italic",
  };
  return {
    type: "text",
    name: sourceName(el, "text-flow"),
    x: box.x,
    y: box.y,
    w: Math.max(box.w, 12),
    h: Math.max(box.h + 4, 12),
    rotation: authorRotation(el),
    text: runs.map((run) => run.break ? "\n" : run.text).join(""),
    runs: runs.length ? runs : undefined,
    fontSize: fallbackRun.fontSize,
    lineHeight: fallbackRun.lineHeight,
    font: fallbackRun.font,
    latinFont: fallbackRun.latinFont,
    color: fallbackRun.color,
    alpha: fallbackRun.alpha,
    bold: fallbackRun.bold,
    italic: fallbackRun.italic,
    align: normalizeAlign(el.textAlign),
    valign: el.valign || "top",
    // A box the author sized for a single line stays single: wrap="none" lets the
    // text extend instead of reflowing under PowerPoint's wider CJK metrics. Real
    // multi-line blocks (incl. authored <br>) keep wrap="square".
    wrap: el.singleLine ? "none" : "square",
    autofit: "none",
    _zIndex: el.zIndex || 0,
    _stackPath: el.stackPath || [el.zIndex || 0],
    _order: el.order || 0,
    source,
    morphKey: morphKeyForSource(source),
  };
}

function authorTextElement(group) {
  const runs = group.items.map((el) => ({
    text: el.text,
    fontSize: cssPxToPt(el.fontSize || 14),
    lineHeight: el.lineHeight ? cssPxToPt(el.lineHeight) : null,
    font: preferredFont(el.fontFamily, el.text),
    latinFont: firstFont(el.fontFamily) || "Times New Roman",
    color: el.color.hex || "1F2937",
    alpha: el.color.alpha * el.opacity,
    bold: fontIsBold(el.fontWeight),
    italic: el.fontStyle === "italic",
  }));
  const first = group.items[0];
  const paintItem = firstPaintItem(group.items);
  const rotation = group.items.length === 1 ? authorRotation(first) : null;
  const box = rotation == null ? null : authoredBox(first);
  const text = runs.map((run) => run.text).join("");
  const source = group.items.length > 1 ? group.items.map(sourceRef) : sourceRef(first);
  return {
    type: "text",
    name: sourceName(first, group.items.length > 1 ? "text-line" : "text"),
    x: box ? box.x : group.x,
    y: box ? box.y : group.y,
    w: box ? Math.max(box.w, 12) : Math.max(group.w + 12, group.w * 1.12),
    h: box ? Math.max(box.h + 4, 12) : Math.max(group.h + 4, group.h * 1.08),
    rotation,
    text,
    runs: group.items.length > 1 ? runs : undefined,
    fontSize: runs[0].fontSize,
    lineHeight: runs[0].lineHeight,
    font: runs[0].font,
    latinFont: runs[0].latinFont,
    color: runs[0].color,
    alpha: runs[0].alpha,
    bold: runs[0].bold,
    italic: runs[0].italic,
    align: normalizeAlign(first.textAlign),
    valign: "top",
    wrap: "none",
    autofit: "none",
    _zIndex: paintItem.zIndex || 0,
    _stackPath: paintItem.stackPath || [paintItem.zIndex || 0],
    _order: Math.min(...group.items.map((el) => el.order || 0)),
    source,
    morphKey: morphKeyForSource(source),
  };
}

function groupTextRuns(textElements) {
  const groups = [];
  const sorted = [...textElements].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x || a.order - b.order);
  for (const el of sorted) {
    if (isDecorativeText(el.text)) {
      groups.push(makeTextGroup([el]));
      continue;
    }
    const previous = groups[groups.length - 1];
    if (previous && !previous.decorative && belongsToLine(previous, el)) {
      previous.items.push(el);
      refreshTextGroup(previous);
    } else {
      groups.push(makeTextGroup([el]));
    }
  }
  return groups.sort((a, b) => comparePaintOrder(firstPaintItem(a.items), firstPaintItem(b.items)));
}

function makeTextGroup(items) {
  const group = { items: [...items], decorative: items.every((el) => isDecorativeText(el.text)) };
  refreshTextGroup(group);
  return group;
}

function refreshTextGroup(group) {
  group.items.sort((a, b) => a.box.x - b.box.x || a.order - b.order);
  group.x = Math.min(...group.items.map((el) => el.box.x));
  group.y = Math.min(...group.items.map((el) => el.box.y));
  const right = Math.max(...group.items.map((el) => el.box.right));
  const bottom = Math.max(...group.items.map((el) => el.box.bottom));
  group.w = right - group.x;
  group.h = bottom - group.y;
  group.centerY = group.y + group.h / 2;
  group.right = right;
  group.fontSize = Math.max(...group.items.map((el) => Number(el.fontSize) || 0));
}

function belongsToLine(group, el) {
  if (isDecorativeText(el.text)) return false;
  const cy = el.box.y + el.box.h / 2;
  const fontDelta = Math.abs((Number(el.fontSize) || 0) - group.fontSize);
  const verticalTolerance = Math.max(6, group.h * 0.38);
  const gap = el.box.x - group.right;
  return Math.abs(cy - group.centerY) <= verticalTolerance && fontDelta <= 3 && gap >= -4 && gap <= 42;
}

function isDecorativeText(text) {
  return /^[+\-−×÷*]+$/.test(String(text || "").trim());
}

function buildReport(ir, scene) {
  const unsupported = {
    svgElements: scene.slides.reduce((n, s) => n + (s.unsupported?.svgElements || 0), 0),
    images: ir.slides.reduce((n, s) => n + s.images.filter((image) => !isSupportedImageSrc(image.src)).length, 0),
    media: ir.slides.reduce((n, s) => n + (s.media || []).filter((item) => !isSupportedMediaSrc(item.src)).length, 0),
    cssOnly: ir.slides.reduce((n, s) => n + s.unsupported.length, 0),
    keyframes: ir.animations.keyframes.length,
    rotatedNative: ir.slides.reduce(
      (n, s) => n + [...(s.elements || []), ...(s.images || []), ...(s.media || [])].filter((el) => authorRotation(el) != null).length,
      0,
    ),
  };
  const motionCandidates = [];
  for (let i = 1; i < ir.slides.length; i += 1) {
    const prev = new Map(ir.slides[i - 1].elements.map((el) => [el.key, el]));
    for (const el of ir.slides[i].elements) {
      const before = prev.get(el.key);
      if (!before) continue;
      const dx = el.box.x - before.box.x;
      const dy = el.box.y - before.box.y;
      const dw = el.box.w - before.box.w;
      const dh = el.box.h - before.box.h;
      const da = el.opacity - before.opacity;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dw) + Math.abs(dh) + Math.abs(da) > 2) {
        motionCandidates.push({
          key: el.key,
          fromStep: ir.slides[i - 1].step,
          toStep: ir.slides[i].step,
          from: before.box,
          to: el.box,
          opacity: [before.opacity, el.opacity],
        });
      }
    }
  }
  return {
    source: ir.source,
    contract: ir.contract,
    slides: ir.slides.length,
    authorSlides: scene.slides.length,
    extractedElements: ir.slides.reduce((n, s) => n + s.elements.length, 0),
    authorElements: scene.slides.reduce((n, s) => n + s.elements.length, 0),
    nativeImages: scene.slides.reduce((n, s) => n + s.elements.filter((el) => el.type === "image").length, 0),
    nativeMedia: scene.slides.reduce((n, s) => n + s.elements.filter((el) => el.type === "media").length, 0),
    unsupported,
    keyframes: ir.animations.keyframes.map((k) => k.name),
    motionCandidates: motionCandidates.slice(0, 200),
    message: "This is a frontend-derived structural extraction report. HTML screenshots are QA evidence only; the compiler must not use image references or raster fallbacks.",
  };
}

function classifyShape(el) {
  // Declared geometry wins, as-is: any OOXML prstGeom the agent put in data-shape
  // is honored. The compiler passes the full preset enum through, so we never clamp
  // the agent's choice to a subset. ("line" on a painted box maps to a plain rect.)
  const declared = String(el.dataShape || "").trim();
  if (declared) return declared === "line" ? "rect" : declared;
  // No data-shape: derive geometry deterministically from the declared
  // border-radius token only — 50% is an ellipse, a positive px radius is a
  // roundRect, otherwise a rect. No fuzzy aspect-ratio inference.
  const radius = String(el.border.radius || "");
  if (/(^|\s)50%/.test(radius)) return "ellipse";
  const pxRadius = Number(radius.match(/[\d.]+/)?.[0] || 0);
  return pxRadius > 2 ? "roundRect" : "rect";
}

function cssRadiusPx(radius, box) {
  const text = String(radius || "");
  const minDim = Math.max(1, Math.min(box?.w || 0, box?.h || 0));
  if (text.includes("50%")) return minDim / 2;
  const px = Number(text.match(/[\d.]+/)?.[0] || 0);
  return Number.isFinite(px) ? Math.max(0, Math.min(px, minDim / 2)) : 0;
}

function parseBoxShadow(value) {
  const text = String(value || "").trim();
  if (!text || text === "none") return null;
  const candidates = splitShadowList(text)
    .filter((part) => !/\binset\b/i.test(part))
    .map(parseSingleShadow)
    .filter(Boolean);
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.alpha * Math.max(1, b.blur)) - (a.alpha * Math.max(1, a.blur)));
  return candidates[0];
}

function splitShadowList(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter(Boolean);
}

function parseSingleShadow(text) {
  const colorMatch = text.match(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/);
  const color = parseShadowColor(colorMatch?.[0] || "");
  const alpha = color.alpha;
  if (!color.hex || alpha <= 0.015) return null;
  const withoutColor = colorMatch ? text.replace(colorMatch[0], " ") : text;
  const nums = (withoutColor.match(/-?[\d.]+px|-?[\d.]+/g) || []).map((n) => Number(String(n).replace("px", "")));
  if (nums.length < 2) return null;
  const offsetX = nums[0] || 0;
  const offsetY = nums[1] || 0;
  const rawBlur = Math.max(0, nums[2] || 0);
  const spread = nums[3] || 0;
  const effectiveBlur = Math.max(0, rawBlur + Math.min(0, spread));
  const spreadFactor = spread < 0 && rawBlur > 0 ? Math.max(0.1, effectiveBlur / rawBlur) : 1;
  const distanceScale = spread < 0 ? 0.35 : 0.6;
  const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY) * distanceScale;
  const direction = (Math.atan2(offsetY, offsetX) * 180 / Math.PI + 360) % 360;
  return {
    color: color.hex,
    alpha: roundNumber(alpha * 0.45 * spreadFactor, 4),
    offsetX: roundNumber(offsetX),
    offsetY: roundNumber(offsetY),
    blur: roundNumber((effectiveBlur || rawBlur) * 0.8),
    distance: roundNumber(distance),
    direction: roundNumber(direction),
  };
}

function parseShadowColor(raw) {
  const text = String(raw || "").trim();
  const hex = text.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) {
    let value = hex[1];
    if (value.length === 3 || value.length === 4) value = [...value].map((ch) => ch + ch).join("");
    const alpha = value.length === 8 ? parseInt(value.slice(6, 8), 16) / 255 : 1;
    return { hex: value.slice(0, 6).toUpperCase(), alpha };
  }
  const rgba = text.match(/rgba?\(([^)]+)\)/);
  if (!rgba) return { hex: null, alpha: 0 };
  const nums = rgba[1].split(",").map((piece) => Number(piece.trim()));
  const [r, g, b] = nums;
  const alpha = nums.length > 3 ? nums[3] : 1;
  return {
    hex: [r, g, b].map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0")).join("").toUpperCase(),
    alpha: Math.max(0, Math.min(1, Number(alpha))),
  };
}

function roundNumber(n, digits = 2) {
  const p = 10 ** digits;
  return Math.round(Number(n) * p) / p;
}

function sourceName(el, suffix) {
  return `${suffix} ${el.id ? "#" + el.id : el.classes.length ? "." + el.classes.slice(0, 2).join(".") : el.tag}`.slice(0, 80);
}

function sourceRef(el) {
  return {
    key: el.key,
    id: el.id,
    classes: el.classes || [],
    ancestorIds: el.ancestorIds || [],
    ancestorClasses: el.ancestorClasses || [],
    tag: el.tag,
    morph: el.morph || null,
  };
}

function morphKeyForSource(source) {
  // Only objects with an EXPLICIT data-morph get a shared morph identity (and thus
  // the "!!" force-pair name PowerPoint uses to morph them across slides). Giving
  // every element a unique morph key named every shape "!!…", which forced
  // PowerPoint to morph-match ALL shapes by name, found no matches (names are
  // per-slide unique), and broke the transition. Non-morph objects must keep a
  // normal name so PowerPoint handles them with its default enter/exit matching.
  if (source && source.morph) return `morph-${stableHash(String(source.morph))}`;
  return null;
}

function stableHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function firstFont(fontFamily) {
  const first = String(fontFamily || "").split(",")[0]?.trim().replace(/^['"]|['"]$/g, "");
  return first || "Songti SC";
}

function preferredFont(fontFamily, text) {
  const families = String(fontFamily || "")
    .split(",")
    .map((name) => name.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
  if (/[\u3400-\u9FFF]/.test(String(text || ""))) {
    const cjk = families.find((name) => /Songti|STSong|SimSun|Noto Serif SC|PingFang|Heiti|Microsoft YaHei|KaiTi/i.test(name));
    if (cjk) return cjk;
  }
  return families[0] || "Songti SC";
}

function cssPxToPt(value) {
  return Math.max(1, Math.round(Number(value) * 77.25) / 100);
}

function fontIsBold(weight) {
  const n = Number(weight);
  return Number.isFinite(n) ? n >= 600 : String(weight || "").includes("bold");
}

function normalizeAlign(value) {
  if (value === "center") return "center";
  if (value === "right" || value === "end") return "right";
  return "left";
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
