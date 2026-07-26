// Browser-as-ground-truth motion sampling (web-motion-parity design, M1).
//
// The normalizer tags CSS animations it cannot statically map with
// data-ppt-motion-sampled (guaranteeing an #id). Inside html2scene's existing
// Playwright session, sampleMotionInPage scrubs those animations via the Web
// Animations API (pause + currentTime), sampling computed opacity/transform
// per keyframe knot plus uniform points. fitSampledTracks then lowers each
// sampled track onto the PROVEN writer row surface (compose / motionPath /
// spin / pulse / fade), so unmapped web motion compiles natively instead of
// being dropped. Every track yields either a row or a reported note — no
// silent loss.

// Runs in the page (page.evaluate(sampleMotionInPage)). Pure function of the
// animations' local time: pauses everything, scrubs, restores.
function sampleMotionInPage() {
  const UNIFORM_SAMPLES = 24;
  const slides = [...document.querySelectorAll(".ppt-slide, [data-ppt='slide']")];
  const results = [];
  const anims = document.getAnimations({ subtree: true });
  for (const anim of anims) {
    const effect = anim.effect;
    const target = effect && effect.target;
    if (!target || target.nodeType !== Node.ELEMENT_NODE) continue;
    if (!target.hasAttribute("data-ppt-motion-sampled")) continue;
    if (!target.id) continue; // normalize guarantees an id; skip defensively
    const slideEl = target.closest(".ppt-slide, [data-ppt='slide']");
    const slideIndex = slideEl ? Math.max(0, slides.indexOf(slideEl)) : 0;
    let timing;
    let keyframes = [];
    try {
      timing = effect.getComputedTiming();
      keyframes = effect.getKeyframes();
    } catch (e) {
      continue;
    }
    const duration = Number(timing.duration) || 0;
    if (!(duration > 0)) continue;
    const delay = Number(timing.delay) || 0;
    try { anim.pause(); } catch (e) { continue; }
    const prior = anim.currentTime;
    const ts = new Set();
    for (let s = 0; s <= UNIFORM_SAMPLES; s += 1) ts.add(s / UNIFORM_SAMPLES);
    for (const kf of keyframes) {
      if (kf.offset != null) ts.add(Math.max(0, Math.min(1, kf.offset)));
    }
    const channels = { opacity: [], tx: [], ty: [], sx: [], sy: [], rot: [] };
    for (const t of [...ts].sort((a, b) => a - b)) {
      anim.currentTime = delay + t * duration;
      const st = getComputedStyle(target);
      let m;
      try {
        m = st.transform && st.transform !== "none" ? new DOMMatrix(st.transform) : new DOMMatrix();
      } catch (e) {
        m = new DOMMatrix();
      }
      channels.opacity.push({ t, v: Number(st.opacity) });
      channels.tx.push({ t, v: m.e });
      channels.ty.push({ t, v: m.f });
      channels.sx.push({ t, v: Math.hypot(m.a, m.b) || 1 });
      channels.sy.push({ t, v: Math.hypot(m.c, m.d) || 1 });
      channels.rot.push({ t, v: (Math.atan2(m.b, m.a) * 180) / Math.PI });
    }
    anim.currentTime = prior;
    results.push({
      key: `#${target.id}`,
      slideIndex,
      delayMs: delay,
      durationMs: duration,
      iterations: timing.iterations === Infinity ? "infinite" : Number(timing.iterations) || 1,
      direction: String(timing.direction || "normal"),
      fill: String(timing.fill || "none"),
      cssEasing: String(timing.easing || "linear"),
      keyframeOffsets: keyframes.map((k) => k.offset).filter((o) => o != null),
      channels,
    });
  }
  return results;
}

// ---- Node-side fitting ------------------------------------------------------

const STAGE_W = 1280;
const STAGE_H = 720;

function span(samples) {
  if (!samples.length) return 0;
  const vs = samples.map((s) => s.v).filter(Number.isFinite);
  return vs.length ? Math.max(...vs) - Math.min(...vs) : 0;
}
function first(samples) { return samples.length ? samples[0].v : null; }
function last(samples) { return samples.length ? samples[samples.length - 1].v : null; }
function round(v, p = 2) {
  const f = 10 ** p;
  return Math.round(v * f) / f;
}

// Fit the sampled progress of the dominant channel to an easing. Returns
// { ease } when one of the writer's accel/decel tokens is close enough, else
// { ease, tmFilter } — a piecewise-linear time-remap of the EXACT sampled
// curve (gate-verified accepted by desktop PowerPoint).
function fitEase(track) {
  const chan = ["opacity", "ty", "tx", "sx", "rot"]
    .map((c) => track.channels[c])
    .find((c) => c && span(c) > 0.01);
  if (!chan) return { ease: "out" };
  const v0 = first(chan);
  const v1 = last(chan);
  if (!Number.isFinite(v0) || !Number.isFinite(v1) || Math.abs(v1 - v0) < 1e-6) return { ease: "out" };
  const progress = chan.map(({ t, v }) => ({ t, p: (v - v0) / (v1 - v0) }));
  const CANDIDATES = {
    linear: (t) => t,
    in: (t) => t * t,
    out: (t) => 1 - (1 - t) * (1 - t),
    inout: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  };
  let best = "out";
  let bestErr = Infinity;
  for (const [name, fn] of Object.entries(CANDIDATES)) {
    const err = progress.reduce((sum, { t, p }) => sum + (fn(t) - p) ** 2, 0);
    if (err < bestErr) { bestErr = err; best = name; }
  }
  const rms = Math.sqrt(bestErr / Math.max(1, progress.length));
  if (rms <= 0.04) return { ease: best };
  // Poor token fit (overshoot bezier, spring, linear() curve): emit the exact
  // sampled curve as a tmFilter. Values must be monotone-clamped to [0,1]?
  // No — tmFilter pairs may overshoot (that IS the overshoot); clamp only t.
  const N = 12;
  const pairs = [];
  for (let i = 0; i <= N; i += 1) {
    const t = i / N;
    let nearest = progress[0];
    for (const s of progress) if (Math.abs(s.t - t) < Math.abs(nearest.t - t)) nearest = s;
    pairs.push(`${round(t, 3)},${round(nearest.p, 3)}`);
  }
  return { ease: "linear", tmFilter: pairs.join("; ") };
}

// Lower one sampled track to a writer row. Returns { row } or { note } — a
// note is a reported disposition, never a silent drop.
function lowerSampledTrack(track) {
  const ch = track.channels;
  const o0 = first(ch.opacity);
  const o1 = last(ch.opacity);
  const fadesIn = Number.isFinite(o0) && Number.isFinite(o1) && o0 <= 0.1 && o1 >= 0.9;
  const fadesOut = Number.isFinite(o0) && Number.isFinite(o1) && o0 >= 0.9 && o1 <= 0.1;
  const dtx = (first(ch.tx) ?? 0) - (last(ch.tx) ?? 0);
  const dty = (first(ch.ty) ?? 0) - (last(ch.ty) ?? 0);
  const s0 = ((first(ch.sx) ?? 1) + (first(ch.sy) ?? 1)) / 2;
  const s1 = ((last(ch.sx) ?? 1) + (last(ch.sy) ?? 1)) / 2;
  const r0 = first(ch.rot) ?? 0;
  const r1 = last(ch.rot) ?? 0;
  const drot = r1 - r0;
  const scales = ch.sx.map((s, i) => (s.v + (ch.sy[i] ? ch.sy[i].v : s.v)) / 2);
  const isPulse = scales.length >= 3 && Math.max(...scales) >= 1.04 &&
    Math.abs(s0 - s1) <= 0.03;
  const loop = track.iterations === "infinite";
  const eased = fitEase(track);
  const base = {
    target: track.key,
    trigger: "withPrevious",
    delayMs: Math.max(0, Math.round(track.delayMs)),
    durationMs: Math.max(1, Math.round(track.durationMs)),
    ease: eased.ease,
    ...(eased.tmFilter ? { tmFilter: eased.tmFilter } : {}),
    sampled: true,
    ...(loop ? { repeat: "infinite", ambient: true } : {}),
    ...(track.direction.includes("alternate") ? { autoRev: true } : {}),
  };

  // Multi-waypoint translation (bounce/orbit/zig-zag): one native motion path
  // through every sampled keyframe knot, relative slide fractions, ending home.
  const knots = track.keyframeOffsets.length >= 3 ? track.keyframeOffsets : null;
  const txSpan = span(ch.tx);
  const tySpan = span(ch.ty);
  if (knots && (txSpan >= 2 || tySpan >= 2)) {
    const homeX = last(ch.tx) ?? 0;
    const homeY = last(ch.ty) ?? 0;
    const at = (samples, t) => {
      let bestSample = samples[0];
      for (const s of samples) if (Math.abs(s.t - t) < Math.abs(bestSample.t - t)) bestSample = s;
      return bestSample.v;
    };
    const pts = [...new Set([0, ...knots, 1])].sort((a, b) => a - b).map((t) => ({
      x: round((at(ch.tx, t) - homeX) / STAGE_W, 4),
      y: round((at(ch.ty, t) - homeY) / STAGE_H, 4),
    }));
    const path = "M " + pts.map((p) => `${p.x} ${p.y}`).join(" L ");
    return { row: { ...base, effect: "motionPath", pptPath: path } };
  }

  const hasTranslate = Math.abs(dtx) >= 1 || Math.abs(dty) >= 1;
  const hasScale = Math.abs(s1 - s0) >= 0.04;
  const hasRotate = Math.abs(drot) >= 2;
  const channelCount = [fadesIn || fadesOut, hasTranslate, hasScale, hasRotate].filter(Boolean).length;

  if (channelCount >= 2) {
    const row = { ...base, effect: "compose" };
    if (fadesIn) row.opacity = "in";
    else if (fadesOut) row.opacity = "out";
    if (hasTranslate) { row.x = round(dtx, 1); row.y = round(dty, 1); }
    if (hasScale) { row.scaleFrom = round(s0, 4); row.scaleTo = round(s1, 4); }
    if (hasRotate) { row.rotateFrom = round(r0, 3); row.rotateTo = round(r1, 3); }
    return { row };
  }
  if (fadesIn) return { row: { ...base, effect: "fade" } };
  if (fadesOut) return { row: { ...base, effect: "exit-fade" } };
  if (Math.abs(drot) >= 15) {
    return { row: { ...base, effect: "spin", byDeg: round(drot, 1) } };
  }
  if (isPulse) {
    return { row: { ...base, effect: "pulse", scale: round(Math.max(...scales) * 100, 1) } };
  }
  if (hasScale) {
    return { row: { ...base, effect: s1 > s0 ? "grow" : "shrink", scale: Math.max(1, round(s1 * 100, 1)) } };
  }
  if (hasTranslate) {
    return { row: { ...base, effect: "compose", opacity: undefined, x: round(dtx, 1), y: round(dty, 1) } };
  }
  const partial = Number.isFinite(o0) && Number.isFinite(o1) && Math.abs(o1 - o0) >= 0.1;
  if (partial) {
    // Transparency emphasis via p:anim style.opacity tavLst (ladder T2).
    return { row: { ...base, effect: "transparency", opacityFrom: round(o0, 3), opacityTo: round(o1, 3) } };
  }
  return {
    note: `sampled animation on ${track.key} has no channel the writer expresses yet ` +
      "(opacity/translate/scale/rotate all static); reported, not compiled",
  };
}

// tracks -> { rowsBySlide: Map<slideIndex, rows[]>, notes: [] }
function fitSampledTracks(tracks) {
  const rowsBySlide = new Map();
  const notes = [];
  for (const track of tracks || []) {
    const { row, note } = lowerSampledTrack(track);
    if (row) {
      if (!rowsBySlide.has(track.slideIndex)) rowsBySlide.set(track.slideIndex, []);
      rowsBySlide.get(track.slideIndex).push(row);
    }
    if (note) notes.push(note);
  }
  return { rowsBySlide, notes };
}

module.exports = { sampleMotionInPage, fitSampledTracks };
