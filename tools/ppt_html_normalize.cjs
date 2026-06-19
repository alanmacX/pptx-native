#!/usr/bin/env node
/**
 * Deterministic HTML normalizer for the PPT-native subset.
 *
 * This is the raw-HTML sibling of tools/ppt_guards.cjs. Guards fix extracted
 * scene conflicts; this normalizer fixes common authoring mistakes before lint,
 * extraction, and compile. It runs in Chromium so fixes can use actual DOM boxes
 * instead of brittle text-only rewrites.
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { chromium } = require("playwright");

function parseArgs(argv) {
  const args = { input: null, out: null, width: 1280, height: 720 };
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
    console.error("Usage: node tools/ppt_html_normalize.cjs input.html [--out output.html]");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1,
    javaScriptEnabled: false,
  });
  await page.goto(pathToFileURL(path.resolve(args.input)).href, { waitUntil: "load" });
  await page.waitForTimeout(50);
  const result = await page.evaluate(normalizeDom);
  await browser.close();

  const html = "<!doctype html>\n" + result.html;
  if (args.out) fs.writeFileSync(path.resolve(args.out), html, "utf8");
  console.log(JSON.stringify({
    ok: true,
    changed: result.corrections.length > 0,
    corrections: result.corrections,
    out: args.out ? path.resolve(args.out) : null,
  }, null, 2));
}

function normalizeDom() {
  const corrections = [];
  const nativeSelector = ".ppt-shape,.ppt-textbox,.ppt-line";
  const nativeTags = new Set(["ppt-shape", "ppt-textbox", "ppt-line"]);
  // Any declared data-shape is honored — the compiler passes the full OOXML preset
  // enum through, so the normalizer must NOT clobber e.g. hexagon back to rect.
  const shapeSet = new Set(["rect", "roundRect", "ellipse", "line"]);
  const EMPHASIS = new Set(["spin", "grow", "shrink", "pulse"]);
  const keyframes = collectKeyframes();

  function selector(el) {
    if (el.id) return `#${el.id}`;
    const cls = [...(el.classList || [])][0];
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}`;
  }
  function add(el, rule, message) {
    corrections.push({ rule, selector: selector(el), message });
  }
  function rawStyleProp(el, prop) {
    return rawStylePropFrom(el.getAttribute("style") || "", prop);
  }
  function rawStylePropFrom(raw, prop) {
    const esc = prop.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
    return (raw.match(new RegExp(`(?:^|;)\\s*${esc}\\s*:\\s*([^;]+)`, "i"))?.[1] || "").trim();
  }
  function isZero(v) {
    return /^[-+]?0+(?:\.0+)?$/.test(String(v).trim());
  }
  function unitlessNumber(v) {
    const raw = String(v || "").trim();
    return /^[-+]?\d+(?:\.\d+)?$/.test(raw) && !isZero(raw) ? Number(raw) : null;
  }
  function insetValue(rawStyle, prop) {
    const raw = rawStylePropFrom(rawStyle, "inset");
    if (!raw) return "";
    const parts = raw.split(/\s+/).filter(Boolean);
    if (!parts.length || parts.length > 4) return "";
    const [top, right = top, bottom = top, left = right] = parts;
    if (prop === "top") return top;
    if (prop === "left") return left;
    return "";
  }
  function px(n) {
    return `${Math.round(Number(n) * 100) / 100}px`;
  }
  function round(n, digits = 2) {
    const p = 10 ** digits;
    return Math.round(Number(n) * p) / p;
  }
  function transformInfo(value) {
    const text = String(value || "").trim();
    if (!text || text === "none") return null;
    const rotate = text.match(/rotate\(\s*([-+]?\d+(?:\.\d+)?)deg\s*\)/i);
    const scale = text.match(/scale\(\s*([-+]?\d+(?:\.\d+)?)(?:\s*,\s*([-+]?\d+(?:\.\d+)?))?\s*\)/i);
    const translate = text.match(/translate\(\s*([-+]?\d+(?:\.\d+)?)(?:px)?(?:\s*,\s*([-+]?\d+(?:\.\d+)?)(?:px)?)?\s*\)/i);
    const translateX = text.match(/translateX\(\s*([-+]?\d+(?:\.\d+)?)(?:px)?\s*\)/i);
    const translateY = text.match(/translateY\(\s*([-+]?\d+(?:\.\d+)?)(?:px)?\s*\)/i);
    if (rotate || scale || translate || translateX || translateY) {
      const scaleX = scale ? Number(scale[1]) : 1;
      const scaleY = scale ? Number(scale[2] || scale[1]) : 1;
      const tx = translate ? Number(translate[1]) : translateX ? Number(translateX[1]) : 0;
      const ty = translate ? Number(translate[2] || 0) : translateY ? Number(translateY[1]) : 0;
      return {
        rotationDeg: rotate ? round(Number(rotate[1]), 3) : 0,
        scaleX: round(Math.abs(scaleX), 4),
        scaleY: round(Math.abs(scaleY), 4),
        flip: (scaleX < 0) !== (scaleY < 0),
        skew: 0,
        translateX: round(tx, 3),
        translateY: round(ty, 3),
      };
    }
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
    const scaleX = Math.hypot(m.a, m.b);
    const scaleY = Math.hypot(m.c, m.d);
    if (!scaleX || !scaleY) return null;
    const flip = (m.a * m.d - m.b * m.c) < 0;
    const rotationDeg = Math.atan2(m.b, m.a) * 180 / Math.PI;
    const skew = Math.abs((m.a * m.c + m.b * m.d) / (scaleX * scaleY));
    return {
      rotationDeg: round(rotationDeg, 3),
      scaleX: round(scaleX, 4),
      scaleY: round(scaleY, 4),
      flip,
      skew: round(skew, 4),
      translateX: round(m.e, 3),
      translateY: round(m.f, 3),
    };
  }
  function simpleNativeRotation(value) {
    const info = transformInfo(value);
    if (!info || info.flip) return null; // flips are decoded natively downstream, not rewritten to rotation
    if (Math.abs(info.rotationDeg) < 0.01) return null;
    if (Math.abs(info.scaleX - 1) > 0.02 || Math.abs(info.scaleY - 1) > 0.02) return null;
    if (Math.abs(info.skew) > 0.02) return null;
    return info.rotationDeg;
  }
  function collectKeyframes() {
    const out = new Map();
    for (const sheet of document.styleSheets) {
      let rules = [];
      try {
        rules = sheet.cssRules ? [...sheet.cssRules] : [];
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule.type !== CSSRule.KEYFRAMES_RULE) continue;
        out.set(rule.name, [...rule.cssRules].map((frame) => ({
          keyText: frame.keyText,
          opacity: frame.style.opacity || "",
          transform: frame.style.transform || "",
          backgroundColor: frame.style.backgroundColor || frame.style.background || "",
          color: frame.style.color || "",
        })));
      }
    }
    return out;
  }
  function firstListValue(value) {
    return String(value || "").split(",")[0]?.trim() || "";
  }
  function timeMs(value, fallback) {
    const raw = firstListValue(value);
    if (!raw) return fallback;
    try {
      if (raw.endsWith("ms")) return Math.max(0, Math.round(Number(raw.slice(0, -2))));
      if (raw.endsWith("s")) return Math.max(0, Math.round(Number(raw.slice(0, -1)) * 1000));
      return Math.max(0, Math.round(Number(raw)));
    } catch {
      return fallback;
    }
  }
  function frameOffset(keyText) {
    const text = String(keyText || "").toLowerCase();
    if (text.includes("from")) return 0;
    if (text.includes("to")) return 100;
    const n = Number(text.match(/-?\d+(?:\.\d+)?/)?.[0]);
    return Number.isFinite(n) ? n : null;
  }
  function endpointFrames(frames) {
    const expanded = [];
    for (const frame of frames || []) {
      for (const part of String(frame.keyText || "").split(",")) {
        const offset = frameOffset(part);
        if (offset != null) expanded.push({ ...frame, offset });
      }
    }
    const from = expanded.find((frame) => frame.offset === 0) || expanded.sort((a, b) => a.offset - b.offset)[0];
    const to = expanded.find((frame) => frame.offset === 100) || expanded.sort((a, b) => b.offset - a.offset)[0];
    return { from, to, all: expanded };
  }
  function transformOrIdentity(value) {
    return transformInfo(value) || {
      rotationDeg: 0,
      scaleX: 1,
      scaleY: 1,
      skew: 0,
      translateX: 0,
      translateY: 0,
    };
  }
  // Normalize a CSS color (#rgb / #rrggbb / rgb()/rgba()) to RRGGBB, or "".
  function colorHex(value) {
    const s = String(value || "").trim();
    if (!s) return "";
    let m = s.match(/^#([0-9a-f]{3})$/i);
    if (m) return m[1].split("").map((c) => c + c).join("").toUpperCase();
    m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) return m[1].toUpperCase();
    m = s.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      const n = m[1].split(/[\s,/]+/).map(Number).filter((x) => Number.isFinite(x));
      if (n.length >= 3) return n.slice(0, 3)
        .map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("").toUpperCase();
    }
    return "";
  }
  // Map a CSS animation-timing-function to the engine's ease vocabulary.
  function easeFromTiming(value) {
    const t = String(firstListValue(value) || "").toLowerCase();
    if (t.includes("ease-in-out")) return "inout";
    if (t.includes("ease-out")) return "out";
    if (t.includes("ease-in")) return "in";
    if (t.includes("linear")) return "linear";
    if (t.startsWith("cubic-bezier")) {
      // Approximate: small first control point => starts fast (ease-out feel).
      const n = t.match(/cubic-bezier\(([^)]+)\)/);
      const p = n ? n[1].split(",").map(Number) : [];
      if (p.length === 4) {
        const easeIn = p[1] < 0.2, easeOut = p[3] > 0.8;
        if (easeIn && easeOut) return "inout";
        if (easeOut) return "out";
        if (easeIn) return "in";
      }
      return "out";
    }
    return "out"; // CSS "ease" and default — decelerate, the tasteful default
  }
  // Read CSS @keyframes the way the model naturally writes them and map to a
  // native intent. We honor opacity + transform (translate / scale / rotate)
  // TOGETHER (the modern "fade + settle" look), plus duration / delay / easing,
  // instead of collapsing to one canned preset. Properties with no native
  // animation target fall through (explicit loss downstream), never silent.
  function nthListValue(value, i) {
    const parts = String(value || "").split(",");
    return (parts[i] ?? parts[parts.length - 1] ?? "").trim();
  }
  // Map the i-th animation in a (possibly comma-separated) CSS animation list.
  function cssAnimationIntentAt(st, i) {
    const name = nthListValue(st.animationName, i);
    if (!name || name === "none") return null;
    const frames = keyframes.get(name);
    if (!frames?.length) return null;
    const { from, to, all } = endpointFrames(frames);
    if (!from || !to) return null;
    const dur = timeMs(nthListValue(st.animationDuration, i), 500);
    const delay = timeMs(nthListValue(st.animationDelay, i), 0);
    const ease = easeFromTiming(nthListValue(st.animationTimingFunction, i));
    // Looping: CSS iteration-count -> repeat, direction:alternate -> autoRev.
    const iter = nthListValue(st.animationIterationCount, i).toLowerCase();
    const dir = nthListValue(st.animationDirection, i).toLowerCase();
    let loop = "";
    if (iter === "infinite") loop += "; repeat:infinite";
    else { const n = Number(iter); if (Number.isFinite(n) && n > 1) loop += `; repeat:${n}`; }
    if (dir.includes("alternate")) loop += "; alt";
    // Infinite loops are ambient/continuous (a rotating backdrop, a pulsing dot):
    // start them with the slide and let them run, rather than queueing them in the
    // click/after entrance chain.
    const trig = iter === "infinite" ? "withPrev" : "afterPrev";
    const timing = `trigger:${trig}; dur:${dur}; delay:${delay}; ease:${ease}${loop}`;

    const fo = Number(from.opacity), too = Number(to.opacity);
    const fadesIn = Number.isFinite(fo) && Number.isFinite(too) && fo <= 0.1 && too >= 0.9;
    const fadesOut = Number.isFinite(fo) && Number.isFinite(too) && fo >= 0.9 && too <= 0.1;

    const a = transformOrIdentity(from.transform);
    const b = transformOrIdentity(to.transform);
    // Start offset relative to the END (home) position, in px.
    const dtx = round(a.translateX - b.translateX, 1);
    const dty = round(a.translateY - b.translateY, 1);
    const scaleA = (a.scaleX + a.scaleY) / 2, scaleB = (b.scaleX + b.scaleY) / 2;
    const drot = round(b.rotationDeg - a.rotationDeg, 2);

    // Multi-frame scale that peaks then returns ~ start = pulse (emphasis).
    const scales = all.map((f) => transformOrIdentity(f.transform))
      .map((i) => (i.scaleX + i.scaleY) / 2).filter(Number.isFinite);
    const isPulse = scales.length >= 3 && Math.max(...scales) >= 1.05 && Math.abs(scaleA - scaleB) <= 0.05;

    // Composite keyframes are the natural "web motion" case: opacity, translate,
    // scale, rotate, and fill color change together. Preserve the full intent as
    // one low-level native composition so the writer can emit concurrent
    // animEffect + animMotion + animScale + animRot + animClr primitives.
    const fromBg = colorHex(from.backgroundColor), toBg = colorHex(to.backgroundColor);
    const hasTranslate = Math.abs(dtx) >= 1 || Math.abs(dty) >= 1;
    const hasScale = Math.abs(scaleB - scaleA) >= 0.04;
    const hasRotate = Math.abs(drot) >= 2;
    const hasColor = !!(fromBg && toBg && fromBg !== toBg);
    const channelCount = [fadesIn || fadesOut, hasTranslate, hasScale, hasRotate, hasColor].filter(Boolean).length;
    if (channelCount >= 2) {
      const parts = ["compose"];
      if (fadesIn) parts.push("opacity:in");
      else if (fadesOut) parts.push("opacity:out");
      if (hasTranslate) parts.push(`x:${dtx}`, `y:${dty}`);
      if (hasScale) parts.push(`scaleFrom:${round(scaleA, 4)}`, `scaleTo:${round(scaleB, 4)}`);
      if (hasRotate) parts.push(`rotateFrom:${round(a.rotationDeg, 3)}`, `rotateTo:${round(b.rotationDeg, 3)}`);
      if (hasColor) parts.push(`recolor:#${toBg}`);
      parts.push(timing);
      return parts.join("; ");
    }

    if (fadesIn) {
      // Combined entrance: fade + the dominant transform delta.
      if (Math.abs(dty) >= 6 && Math.abs(dty) >= Math.abs(dtx)) {
        return `entrance:${dty > 0 ? "rise" : "slidedown"}; dist:${Math.abs(dty)}; ${timing}`;
      }
      if (Math.abs(dtx) >= 6) {
        return `entrance:${dtx > 0 ? "slideleft" : "slideright"}; dist:${Math.abs(dtx)}; ${timing}`;
      }
      if (scaleA < scaleB - 0.04) return `entrance:zoom; ${timing}`;
      return `entrance:fade; ${timing}`;
    }
    if (fadesOut) return `exit:fade; ${timing}`;

    // No opacity change — pure transform emphasis.
    if (Math.abs(drot) >= 30 && Math.abs(scaleA - scaleB) <= 0.05) {
      return `emphasis:spin; byDeg:${drot}; ${timing}`;
    }
    if (isPulse) return `emphasis:pulse; scale:${round(Math.max(...scales) * 100, 1)}; ${timing}`;
    if (Math.abs(scaleB - scaleA) >= 0.08 && Math.abs(drot) <= 1) {
      const pct = Math.max(1, round(scaleB * 100, 1));
      return `${scaleB > scaleA ? "emphasis:grow" : "emphasis:shrink"}; scale:${pct}; ${timing}`;
    }
    // Fill-color shift -> native animClr.
    if (fromBg && toBg && fromBg !== toBg) return `recolor:#${toBg}; ${timing}`;

    // Multi-step translate trajectory (bounce / wiggle / zig-zag) -> ONE native
    // motion path tracing every keyframe. This faithfully represents intermediate
    // keyframes via the proven animMotion primitive (no fragile per-frame tavLst).
    const pts = all
      .filter((f) => f.offset != null)
      .sort((a, b) => a.offset - b.offset)
      .map((f) => {
        const t = transformOrIdentity(f.transform);
        return { x: round(t.translateX / 1280, 4), y: round(t.translateY / 720, 4) };
      });
    if (pts.length >= 3 && pts.some((p) => Math.abs(p.x) > 0.001 || Math.abs(p.y) > 0.001)) {
      const path = "M " + pts.map((p) => `${p.x} ${p.y}`).join(" L ");
      return `motion:${path}; ${timing}`;
    }
    return null;
  }
  // A CSS `animation:` list (comma-separated) chains several animations on one
  // element. Map each in order and join with "|" so they play in sequence —
  // this is how CSS-authored multi-step motion ("rise, then pulse, then exit")
  // reaches the engine's coherent multi-animation primitive.
  function cssAnimationIntent(el, st) {
    const names = String(st.animationName || "").split(",")
      .map((s) => s.trim()).filter((s) => s && s !== "none");
    if (!names.length) return null;
    const intents = [];
    for (let i = 0; i < names.length; i++) {
      const intent = cssAnimationIntentAt(st, i);
      if (intent) intents.push(intent);
    }
    return intents.length ? intents.join(" | ") : null;
  }
  function geometryProps(el) {
    if (el.classList.contains("ppt-textbox")) return ["left", "top", "width"];
    if (el.classList.contains("ppt-shape")) return ["left", "top", "width", "height"];
    if (el.classList.contains("ppt-line")) return ["left", "top", "width", "height"];
    return [];
  }
  function slideFor(el) {
    return el.closest(".ppt-slide,[data-ppt='slide']") || document.querySelector(".ppt-slide,[data-ppt='slide']");
  }
  function rectRelativeToSlide(el) {
    const slide = slideFor(el);
    if (!slide) return null;
    // Bake geometry relative to the element's *positioning context*, not the
    // slide. An inline left/top is interpreted by the browser against the
    // nearest positioned ancestor (offsetParent). If we baked slide-relative
    // coordinates into a child that stays inside a positioned container
    // (.ppt-group / .ppt-stagger / any .ppt-abs wrapper), the container's own
    // offset would be applied a second time at render -> elements drift by the
    // container offset (and bare `0` gets clobbered into a non-zero value).
    // Using offsetParent keeps the value consistent with how it is laid out.
    const a = el.getBoundingClientRect();
    if (!a.width && !a.height) return null;
    let ctx = el.offsetParent;
    // offsetParent can be null (static/fixed) or escape the slide; fall back to
    // the slide so direct children behave exactly as before.
    if (!ctx || ctx === document.body || ctx === document.documentElement ||
        !slide.contains(ctx)) {
      ctx = slide;
    }
    const b = ctx.getBoundingClientRect();
    return {
      left: a.left - b.left,
      top: a.top - b.top,
      width: a.width,
      height: a.height,
    };
  }
  function keepVisualBox(el) {
    const r = rectRelativeToSlide(el);
    if (!r) return false;
    el.style.position = "absolute";
    el.style.left = px(r.left);
    el.style.top = px(r.top);
    if (!el.classList.contains("ppt-textbox")) el.style.height = px(r.height);
    el.style.width = px(r.width);
    return true;
  }
  function colorList(value) {
    return [...String(value || "").matchAll(/rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/g)].map((m) => m[0]);
  }
  function fixSvgFillAsBackground(el) {
    // Agents sometimes write fill:#color (SVG-only) instead of background:#color.
    // Convert any inline fill: that looks like a color to background: for native elements.
    const style = el.getAttribute("style") || "";
    const fillMatch = style.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/);
    if (!fillMatch) return;
    const fillValue = fillMatch[1].trim();
    if (!fillValue || fillValue === "none" || fillValue === "transparent") return;
    // Only migrate if it looks like a color (hex, rgb, named color, hsl)
    if (!/^(#[0-9a-fA-F]{3,8}|rgb|rgba|hsl|hsla|[a-zA-Z]+)/.test(fillValue)) return;
    // Replace fill: with background: in the style string
    const newStyle = style.replace(/(?:^|;)\s*fill\s*:[^;]*/g, (m) => m.startsWith(";") ? "" : "").replace(/^;/, "").trim();
    el.setAttribute("style", newStyle);
    if (!el.style.background && !el.style.backgroundColor) {
      el.style.background = fillValue;
    }
    add(el, "normalize-fill-to-bg", `converted fill:${fillValue} to background:${fillValue}`);
  }
  function fixGradient(el, st) {
    const bg = st.backgroundImage || "";
    // radial-gradient now compiles to a native path("circle") fill — leave it.
    // Only conic has no native equivalent, so flatten that to a linear gradient.
    if (!/conic-gradient/i.test(bg)) return;
    const colors = colorList(bg).slice(0, 4);
    if (colors.length >= 2) el.style.background = `linear-gradient(135deg, ${colors.join(", ")})`;
    else if (colors.length === 1) el.style.background = colors[0];
    else el.style.backgroundImage = "none";
    add(el, "normalize-gradient", "converted conic gradient to PPT-native background");
  }
  function fixShapeKind(el, st) {
    if (!el.classList.contains("ppt-shape")) return;
    // Defensively migrate the incorrect attribute name agents sometimes write.
    const wrongAttr = el.getAttribute("data-ppt-shape");
    if (wrongAttr && !el.getAttribute("data-shape")) {
      el.setAttribute("data-shape", wrongAttr);
      el.removeAttribute("data-ppt-shape");
      add(el, "normalize-shape-attr", `migrated data-ppt-shape="${wrongAttr}" to data-shape`);
    }
    const current = el.getAttribute("data-shape");
    if (current) {
      // Honor any declared preset (full OOXML enum). Only the ellipse gets a
      // preview-parity border-radius since its geometry is fixed.
      if (current === "ellipse" && !String(st.borderRadius || "").includes("50%")) {
        el.style.borderRadius = "50%";
        add(el, "normalize-shape-preview", "added border-radius:50% for data-shape=ellipse preview parity");
      }
      return;
    }
    const radius = String(st.borderRadius || "");
    const box = el.getBoundingClientRect();
    const min = Math.min(box.width || 0, box.height || 0);
    const max = Math.max(box.width || 0, box.height || 0);
    let kind = "rect";
    if (radius.includes("50%") || (min > 0 && min / Math.max(1, max) > 0.82 && parseFloat(radius) > min * 0.35)) kind = "ellipse";
    else if (parseFloat(radius) > 2) kind = "roundRect";
    el.setAttribute("data-shape", kind);
    if (kind === "ellipse") el.style.borderRadius = "50%";
    add(el, "normalize-shape", `set missing/invalid data-shape to ${kind}`);
  }
  function fixNativeGeometry(el) {
    const originalStyle = el.getAttribute("style") || "";
    const hadInset = Boolean(rawStylePropFrom(originalStyle, "inset") || rawStyleProp(el, "inset"));
    const computed = getComputedStyle(el);
    el.style.position = "absolute";
    if (hadInset) {
      el.style.removeProperty("inset");
      add(el, "normalize-geometry", "expanded and removed inset shorthand");
    }
    for (const prop of geometryProps(el)) {
      const currentStyle = el.getAttribute("style") || "";
      const raw = rawStylePropFrom(originalStyle, prop) ||
        rawStyleProp(el, prop) ||
        insetValue(originalStyle, prop) ||
        insetValue(currentStyle, prop);
      const n = unitlessNumber(raw);
      if (n != null) {
        el.style.setProperty(prop, px(n));
        add(el, "normalize-geometry", `added px unit to ${prop}`);
        continue;
      }
      // Non-px unit (%, vw, vh, em, calc…): bake the element's true rendered px
      // from its DOM box. Transform-based centering is handled separately by
      // removeBannedCss/keepVisualBox, so skip when a transform is present to
      // avoid double-applying the translate.
      if (raw && !/px\s*$/i.test(String(raw).trim())) {
        const hasTransform = getComputedStyle(el).transform !== "none";
        if (!hasTransform) {
          const r = rectRelativeToSlide(el);
          if (r) {
            const value = prop === "left" ? r.left : prop === "top" ? r.top : prop === "width" ? r.width : r.height;
            if (Number.isFinite(value) && (prop === "left" || prop === "top" || value > 0)) {
              el.style.setProperty(prop, px(value));
              add(el, "normalize-geometry", `converted ${prop} non-px unit to px from DOM box`);
              continue;
            }
          }
        }
      }
      if (raw && /px\s*$/i.test(String(raw).trim()) && !rawStylePropFrom(originalStyle, prop)) {
        el.style.setProperty(prop, raw);
        add(el, "normalize-geometry", `expanded ${prop} from inset/computed geometry`);
        continue;
      }
      if (!raw) {
        const computedValue = computed[prop];
        if (computedValue && computedValue !== "auto" && /px\s*$/i.test(String(computedValue).trim())) {
          const numeric = parseFloat(computedValue);
          if (Number.isFinite(numeric) && (prop === "left" || prop === "top" || numeric > 0)) {
            el.style.setProperty(prop, px(numeric));
            add(el, "normalize-geometry", `filled missing ${prop} from computed style`);
            continue;
          }
        }
        const r = rectRelativeToSlide(el);
        if (!r) continue;
        const value = prop === "left" ? r.left : prop === "top" ? r.top : prop === "width" ? r.width : r.height;
        if (Number.isFinite(value) && (prop === "left" || prop === "top" || value > 0)) {
          el.style.setProperty(prop, px(value));
          add(el, "normalize-geometry", `filled missing ${prop} from DOM box`);
        }
      }
    }
  }
  function removeBannedCss(el, st) {
    const hasAnimation = st.animationName && st.animationName !== "none";
    const hasTransition = st.transitionDuration && parseFloat(st.transitionDuration) > 0;
    let mappedAnimationIntent = null;
    if ((hasAnimation || hasTransition) && !el.hasAttribute("data-ppt-anim") && !el.hasAttribute("data-ppt-build")) {
      mappedAnimationIntent = hasAnimation ? cssAnimationIntent(el, st) : null;
      if (mappedAnimationIntent) {
        el.setAttribute("data-ppt-anim", mappedAnimationIntent);
        el.style.animation = "none";
        el.style.transition = "none";
        add(el, "map-css-animation", `converted CSS keyframes to ${mappedAnimationIntent}`);
      }
    }
    if (st.backdropFilter && st.backdropFilter !== "none") {
      el.style.backdropFilter = "none";
      el.style.webkitBackdropFilter = "none";
      add(el, "drop-banned-css", "removed backdrop-filter");
    }
    if (st.filter && st.filter !== "none") {
      // blur()/drop-shadow() compile to native effects downstream — keep them.
      const nativeFilter = /^(\s*(blur\([^)]*\)|drop-shadow\([^)]*\))\s*)+$/i.test(st.filter);
      if (!nativeFilter) {
        el.style.filter = "none";
        add(el, "drop-banned-css", "removed filter");
      }
    }
    if (st.mixBlendMode && st.mixBlendMode !== "normal") {
      el.style.mixBlendMode = "normal";
      add(el, "drop-banned-css", "removed mix-blend-mode");
    }
    if (st.transform && st.transform !== "none") {
      // A transform that decomposes to rotation and/or a flip (no skew/scale) is
      // native xfrm geometry — leave it for html2scene to decode. Only mapped
      // animation transforms or non-native ones (skew/scale/translate) are stripped.
      const info = el.matches(nativeSelector) ? transformInfo(st.transform) : null;
      const isNativeXfrm = info &&
        Math.abs(info.scaleX - 1) <= 0.02 &&
        Math.abs(info.scaleY - 1) <= 0.02 &&
        Math.abs(info.skew) <= 0.02;
      if (mappedAnimationIntent) {
        el.style.transform = "none";
        el.style.perspective = "none";
        el.style.transformStyle = "flat";
        add(el, "drop-banned-css", "neutralized mapped CSS animation transform");
      } else if (isNativeXfrm) {
        // Preserve as-is; rotation + flipH/flipV are read natively downstream.
      } else {
        if (el.matches(nativeSelector)) keepVisualBox(el);
        el.style.transform = "none";
        el.style.perspective = "none";
        el.style.transformStyle = "flat";
        add(el, "drop-banned-css", "removed transform/perspective layout");
      }
    }
    // flex/grid/normal-flow are fine: the browser resolves them to concrete boxes
    // that html2scene reads via getBoundingClientRect. Leave layout untouched.
    if (/(auto|scroll)/.test(`${st.overflow} ${st.overflowX} ${st.overflowY}`) && el.tagName !== "HTML" && el.tagName !== "BODY") {
      el.style.overflow = "hidden";
      el.style.overflowX = "hidden";
      el.style.overflowY = "hidden";
      add(el, "drop-banned-css", "replaced scrollable overflow with hidden");
    }
    if ((hasAnimation || hasTransition) && !mappedAnimationIntent && !el.hasAttribute("data-ppt-anim") && !el.hasAttribute("data-ppt-build")) {
      el.style.animation = "none";
      el.style.animationName = "none";
      el.style.transition = "none";
      el.style.transitionProperty = "none";
      add(el, "drop-banned-css", "removed undeclared CSS animation/transition");
    }
  }
  function animParts(raw) {
    return String(raw || "").split(";").map((s) => s.trim()).filter(Boolean);
  }
  function animSegments(raw) {
    return String(raw || "").split("|").map((s) => s.trim()).filter(Boolean);
  }
  function partKey(part) {
    const i = part.indexOf(":");
    return (i < 0 ? part : part.slice(0, i)).trim();
  }
  // entrance:/exit: with an EMPHASIS effect is a common model mistake — remap to emphasis:.
  function fixDslAnim(el) {
    const raw = el.getAttribute("data-ppt-anim");
    if (!raw) return;
    let changed = false;
    const out = animSegments(raw).map((seg) => animParts(seg).map((p) => {
        const i = p.indexOf(":");
        if (i < 0) return p;
        const k = p.slice(0, i).trim();
        const v = p.slice(i + 1).trim();
        if ((k === "entrance" || k === "exit") && EMPHASIS.has(v)) { changed = true; return `emphasis:${v}`; }
        return p;
      }).join("; "));
    if (changed) {
      el.setAttribute("data-ppt-anim", out.join(" | "));
      add(el, "normalize-anim", "remapped entrance/exit emphasis effect to emphasis:");
    }
  }
  // A Morph object must not carry entrance/exit — Morph owns its motion.
  function fixMorphObjectAnim(el) {
    if (!el.hasAttribute("data-morph")) return;
    const raw = el.getAttribute("data-ppt-anim");
    if (!raw) return;
    let changed = false;
    const keptSegments = [];
    for (const seg of animSegments(raw)) {
      const parts = animParts(seg);
      const kept = parts.filter((p) => partKey(p) !== "entrance" && partKey(p) !== "exit");
      if (kept.length !== parts.length) changed = true;
      const hasEffect = kept.some((p) => ["emphasis", "motion", "appear", "compose", "combo", "effect"].includes(partKey(p)));
      if (hasEffect) keptSegments.push(kept.join("; "));
    }
    if (changed) {
      // Keep the declaration only if a real effect key remains; otherwise a bare
      // trigger/dur leftover would trip DSL_NO_EFFECT — drop the whole attribute.
      if (keptSegments.length) el.setAttribute("data-ppt-anim", keptSegments.join(" | "));
      else el.removeAttribute("data-ppt-anim");
      add(el, "normalize-morph", "removed entrance/exit from data-morph object (Morph owns its motion)");
    }
  }
  // PowerPoint-for-Mac can hang when a Morph-target slide also has p:timing; the
  // compiler guard drops same-slide animations there, so strip them up front to keep
  // the preview honest and lint green.
  function fixMorphSlideTiming() {
    for (const slide of document.querySelectorAll(".ppt-slide,[data-ppt='slide']")) {
      const t = slide.getAttribute("data-ppt-transition") || "";
      if (!/morph|smooth|平滑/i.test(t)) continue;
      for (const el of slide.querySelectorAll("[data-ppt-anim],[data-ppt-build]")) {
        if (el.hasAttribute("data-morph")) continue; // the morph object itself is fine
        let removed = false;
        if (el.hasAttribute("data-ppt-anim")) { el.removeAttribute("data-ppt-anim"); removed = true; }
        if (el.hasAttribute("data-ppt-build")) { el.removeAttribute("data-ppt-build"); removed = true; }
        if (removed) add(el, "normalize-morph-slide", "removed same-slide animation on Morph slide (matches compiler guard)");
      }
    }
  }
  function flattenNestedNative() {
    const nested = [...document.querySelectorAll(nativeSelector)]
      .filter((el) => el.parentElement && el.parentElement.closest(".ppt-shape"));
    for (const el of nested) {
      const slide = slideFor(el);
      if (!slide) continue;
      keepVisualBox(el);
      slide.appendChild(el);
      add(el, "flatten-nested-native", "moved nested native object to slide root");
    }
  }

  for (const el of [...document.querySelectorAll("*")]) {
    const st = getComputedStyle(el);
    if (el.matches(nativeSelector)) {
      fixSvgFillAsBackground(el);
      fixShapeKind(el, st);
      fixNativeGeometry(el);
    }
    fixGradient(el, st);
    removeBannedCss(el, st);
    if (el.hasAttribute("data-ppt-anim")) { fixDslAnim(el); fixMorphObjectAnim(el); }
  }
  flattenNestedNative();
  fixMorphSlideTiming();
  for (const el of [...document.querySelectorAll(nativeSelector)]) {
    fixNativeGeometry(el);
  }

  return { html: document.documentElement.outerHTML, corrections };
}

main().catch((err) => { console.error("error:", err.message); process.exit(1); });
