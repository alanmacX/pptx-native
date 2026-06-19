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
function isEntranceOrExit(effect) {
  const e = String(effect || "");
  return ENTRANCE.has(e) || e.startsWith("exit-");
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

const RULES = [
  ruleMorphEntrance,
  ruleMorphSlideTiming,
  ruleDropPhantom,
  ruleClipOffCanvas,
];

function applyGuards(scene) {
  const corrections = [];
  for (const rule of RULES) rule(scene, corrections);
  if (corrections.length) scene.guards = corrections;
  return { scene, corrections };
}

module.exports = { applyGuards };
