/**
 * Deterministic scene guards — the single place where "syntactically valid but
 * semantically conflicting" patterns are corrected before compilation.
 *
 * Each rule is a pure function (scene) -> number of corrections, pushing a
 * structured note into `corrections`. No LLM, no vision: every known bad pattern
 * becomes a rule here so the pipeline gets steadier over time and the same HTML
 * never re-triggers a fixed bug.
 *
 * applyGuards(scene) mutates the scene in place and returns:
 *   { scene, corrections: [{ rule, slide, target, message }] }
 */

const CANVAS_PAD = 4;

function effectsOf(slide) {
  const a = slide.animations;
  return a && Array.isArray(a.effects) ? a.effects : [];
}
function setEffects(slide, effects) {
  if (!effects.length) { delete slide.animations; return; }
  slide.animations = { framework: "ppt-compatible-v1", effects };
}

const ENTRANCE = new Set(["fade","wipe","blinds","box","checkerboard","circle",
  "diamond","dissolve","plus","randombars","wedge","wheel","appear"]);
const DECORATIVE_REVEALS = new Set(["blinds","box","checkerboard","circle",
  "diamond","dissolve","plus","randombars","wedge","wheel"]);
const EMPHASIS = new Set(["spin","grow","shrink","pulse"]);

function isEntranceOrExit(effect) {
  const e = String(effect || "");
  return ENTRANCE.has(e) || e.startsWith("exit-");
}
function compactToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[-_\s]/g, "");
}
function isElegantPreset(value) {
  const v = compactToken(value);
  return v === "elegant" || v === "calm" || v === "executive";
}
function isAmbientEffect(slide, effect) {
  return Boolean(effect.ambient) || compactToken(slide.motionIntent) === "ambient";
}
function elementByTarget(slide) {
  const out = new Map();
  for (const element of slide.elements || []) {
    const key = element?.source?.key;
    if (key && !out.has(key)) out.set(key, element);
  }
  return out;
}
function isLineLike(element) {
  if (!element) return false;
  if (["line", "polyline", "connector"].includes(String(element.type || "").toLowerCase())) return true;
  const w = Number(element.w || element.cx || 0);
  const h = Number(element.h || element.cy || 0);
  return w <= 6 || h <= 6;
}
function clampRepeat(effect) {
  if (effect.repeat == null) return false;
  const raw = String(effect.repeat).trim().toLowerCase();
  const n = Number(raw);
  if (raw !== "infinite" && (!Number.isFinite(n) || n <= 2)) return false;
  effect.repeat = "2";
  return true;
}
function clampDuration(effect, maxMs) {
  const current = Number(effect.durationMs ?? effect.duration);
  if (!Number.isFinite(current) || current <= maxMs) return false;
  effect.durationMs = maxMs;
  delete effect.duration;
  return true;
}

function isMorphTransition(value) {
  if (!value) return false;
  if (typeof value === "string") {
    return ["morph", "smooth", "平滑"].includes(value.trim().toLowerCase());
  }
  const type = String(value.type || value.transition || "").trim().toLowerCase();
  return ["morph", "smooth", "平滑"].includes(type);
}

/**
 * RULE morph-vs-entrance: a morph object's motion is owned by the between-slide
 * Morph. A within-slide entrance/exit on the same object conflicts with Morph and
 * breaks backward navigation in PowerPoint. Strip those.
 */
function ruleMorphEntrance(scene, corrections) {
  let n = 0;
  for (const slide of scene.slides || []) {
    const morphKeys = new Set(
      (slide.elements || [])
        .filter((e) => e.source && e.source.morph)
        .map((e) => e.source.key)
    );
    if (!morphKeys.size) continue;
    const kept = effectsOf(slide).filter((fx) => {
      if (morphKeys.has(fx.target) && isEntranceOrExit(fx.effect)) {
        corrections.push({ rule: "morph-vs-entrance", slide: slide.name,
          target: fx.target, message: `dropped ${fx.effect} on morph object` });
        n += 1; return false;
      }
      return true;
    });
    setEffects(slide, kept);
  }
  return n;
}

/**
 * RULE morph-slide-timing: PowerPoint for Mac can get stuck on backward slide
 * navigation when a slide has a Morph transition and its own p:timing tree. Keep
 * the Morph, drop same-slide animations, and let non-Morph slides own builds.
 */
function ruleMorphSlideTiming(scene, corrections) {
  let n = 0;
  for (const slide of scene.slides || []) {
    if (!isMorphTransition(slide.transition)) continue;
    const effects = effectsOf(slide);
    if (!effects.length) continue;
    corrections.push({
      rule: "morph-slide-timing",
      slide: slide.name,
      target: "slide",
      message: `dropped ${effects.length} same-slide animation(s) on Morph slide to preserve backward navigation`,
    });
    delete slide.animations;
    n += effects.length;
  }
  return n;
}

/**
 * RULE drop-phantom: zero-area shapes (e.g. a stage/wrapper element captured with
 * 0x0 size, or a collapsed container) are invisible noise. Remove them.
 */
function ruleDropPhantom(scene, corrections) {
  let n = 0;
  for (const slide of scene.slides || []) {
    const before = (slide.elements || []).length;
    slide.elements = (slide.elements || []).filter((e) => {
      // line/polyline/freeform are defined by point geometry, not w/h, so they
      // are never "zero-area phantoms" even with no box dimensions.
      const pointBased = e.type === "line" || e.type === "polyline" || e.type === "freeform";
      const w = Number(e.w || e.cx || 0), h = Number(e.h || e.cy || 0);
      const zero = !pointBased && (w <= 1 || h <= 1);
      if (zero) corrections.push({ rule: "drop-phantom", slide: slide.name,
        target: e.source && e.source.key, message: `removed zero-area ${e.type}` });
      return !zero;
    });
    n += before - slide.elements.length;
  }
  return n;
}

/**
 * RULE clip-offcanvas: an element entirely outside the canvas contributes nothing
 * — unless it is a morph object deliberately oversized to engulf the canvas. Drop
 * non-morph fully-off-canvas elements (a frequent layout/overflow mistake).
 */
function ruleClipOffCanvas(scene, corrections) {
  const W = Number(scene.size?.pxWidth || 1280);
  const H = Number(scene.size?.pxHeight || 720);
  let n = 0;
  for (const slide of scene.slides || []) {
    slide.elements = (slide.elements || []).filter((e) => {
      if (e.type === "line" || e.type === "polyline" || e.type === "freeform") return true; // point-based geometry
      if (e.source && e.source.morph) return true; // engulf objects may exceed canvas
      const x = Number(e.x || 0), y = Number(e.y || 0);
      const w = Number(e.w || e.cx || 0), h = Number(e.h || e.cy || 0);
      const off = (x + w <= CANVAS_PAD) || (y + h <= CANVAS_PAD) ||
                  (x >= W - CANVAS_PAD) || (y >= H - CANVAS_PAD);
      if (off) { corrections.push({ rule: "clip-offcanvas", slide: slide.name,
        target: e.source && e.source.key, message: "removed element fully off-canvas" }); n += 1; }
      return !off;
    });
  }
  return n;
}

/**
 * RULE elegant-motion-preset: `data-ppt-motion-preset="elegant"` is a promise
 * that the final timing tree will avoid decorative PowerPoint gallery effects
 * and repeated flourishes even if the HTML author drifted. This is intentionally
 * a final guard, after normalization/lint, so unattended deck generation still
 * lands on restrained motion.
 */
function ruleElegantMotionPreset(scene, corrections) {
  let n = 0;
  for (const slide of scene.slides || []) {
    if (!isElegantPreset(slide.motionPreset)) continue;
    const byTarget = elementByTarget(slide);
    let flourishCount = 0;
    const effects = effectsOf(slide).map((fx) => {
      let out = fx;
      const edit = () => {
        if (out === fx) out = { ...fx };
        return out;
      };
      const target = byTarget.get(fx.target);
      const lineLike = isLineLike(target);
      const rawEffect = String(fx.effect || "").trim();
      const effect = rawEffect.toLowerCase();
      const ambient = isAmbientEffect(slide, fx);
      if (DECORATIVE_REVEALS.has(effect)) {
        const e = edit();
        e.effect = lineLike ? "wipe" : "fade";
        if (lineLike && !e.direction) e.direction = "right";
        corrections.push({ rule: "elegant-motion-preset", slide: slide.name, target: fx.target,
          message: `remapped decorative ${rawEffect} entrance to ${e.effect}` });
        n += 1;
      } else if (effect.startsWith("exit-") && DECORATIVE_REVEALS.has(effect.slice(5))) {
        const e = edit();
        e.effect = lineLike ? "exit-wipe" : "exit-fade";
        if (lineLike && !e.direction) e.direction = "right";
        corrections.push({ rule: "elegant-motion-preset", slide: slide.name, target: fx.target,
          message: `remapped decorative ${rawEffect} exit to ${e.effect}` });
        n += 1;
      }

      const currentEffect = String(out.effect || "").toLowerCase();
      if (currentEffect === "spin" && !ambient) {
        const e = edit();
        e.effect = "pulse";
        e.scale = Math.min(Number(e.scale || 104), 106);
        delete e.spins;
        delete e.byDeg;
        corrections.push({ rule: "elegant-motion-preset", slide: slide.name, target: fx.target,
          message: "remapped spin to a small pulse under elegant motion preset" });
        n += 1;
      }

      if (EMPHASIS.has(String(out.effect || "").toLowerCase()) && !ambient) {
        flourishCount += 1;
        if (flourishCount > 1) {
          const e = edit();
          e.effect = "compose";
          e.scaleFrom = Number(e.scaleFrom || 0.98);
          e.scaleTo = Number(e.scaleTo || 1);
          e.durationMs = Math.min(Number(e.durationMs || e.duration || 360), 420);
          delete e.duration;
          delete e.repeat;
          delete e.autoRev;
          delete e.scale;
          delete e.spins;
          delete e.byDeg;
          corrections.push({ rule: "elegant-motion-preset", slide: slide.name, target: fx.target,
            message: "softened excess emphasis animation to a subtle compose settle" });
          n += 1;
        }
      }

      if (!ambient && clampRepeat(out)) {
        corrections.push({ rule: "elegant-motion-preset", slide: slide.name, target: fx.target,
          message: "clamped repeating animation to two iterations" });
        n += 1;
      }
      if (!ambient && !["motionpath", "mediaplay", "mediapause", "mediastop", "build"].includes(String(out.effect || "").toLowerCase()) &&
          clampDuration(out, 900)) {
        corrections.push({ rule: "elegant-motion-preset", slide: slide.name, target: fx.target,
          message: "clamped long non-motion animation duration to 900ms" });
        n += 1;
      }
      return out;
    });
    setEffects(slide, effects);
  }
  return n;
}

const RULES = [
  ruleMorphEntrance,
  ruleMorphSlideTiming,
  ruleDropPhantom,
  ruleClipOffCanvas,
  ruleElegantMotionPreset,
];

function applyGuards(scene) {
  const corrections = [];
  for (const rule of RULES) rule(scene, corrections);
  if (corrections.length) scene.guards = corrections;
  return { scene, corrections };
}

module.exports = { applyGuards };
