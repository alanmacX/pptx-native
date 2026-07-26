#!/usr/bin/env node
// Motion choreography gates: compile the example fixtures and assert the
// cluster/origin invariants the taste layer promises. Run from the repo (or
// engine) root:
//   node tools/ppt_motion_gates.cjs
// Exit 0 = all gates pass; exit 1 = environment SKIP (no Playwright);
// exit 2 = at least one assertion failed or a fixture failed to compile;
// exit 3 = fixtures not found (running outside a repo checkout).
//
// Gates:
//  G1 sequence-cluster-smoke — sequence pages are cluster-atomic:
//     structural wrappers and flat ≥60%-contained siblings each collapse to
//     one delay slot with identical motion params; a full-width panel
//     (>25% of the stage) never swallows the bullet build on top of it.
//  G2 motif-timeline-smoke — the spine wipes first, milestones grow out of
//     the spine (offset rows), on-spine dots pop from scaleFrom 0.2.
//  G3 motif-gallery-smoke — hubSpoke satellites emanate (nonzero start
//     offsets, scaleFrom 0.7); every same-delay slot is atomic (identical
//     motion params across members).

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const HTML2SCENE = path.join(__dirname, "html2scene.cjs");
// Fixtures live at the repo root; the engine copy of this script sits four
// levels deeper (skills/pptx-native/scripts/engine/tools).
const EXAMPLES = [
  path.join(ROOT, "examples"),
  path.resolve(ROOT, "..", "..", "..", "..", "examples"),
].find((p) => fs.existsSync(p));

function resolvePlaywrightPath() {
  const candidates = [
    process.env.PPT_NODE_PATH,
    path.join(ROOT, "skills", "pptx-native", "scripts", "engine", "node_modules"),
    path.join(ROOT, "node_modules"),
  ].filter(Boolean);
  for (const cand of candidates) {
    // Resolve against the candidate directory itself, not this process's cwd.
    try {
      require.resolve("playwright", { paths: [cand] });
      return cand;
    } catch { /* try next */ }
  }
  return null;
}

function compile(fixture, nodePath) {
  const input = path.join(EXAMPLES, fixture);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-gates-"));
  const out = path.join(dir, "scene.json");
  try {
    execFileSync(process.execPath, [HTML2SCENE, input, "--out", out], {
      env: { ...process.env, NODE_PATH: nodePath },
      stdio: ["ignore", "ignore", "inherit"],
    });
    return JSON.parse(fs.readFileSync(out, "utf8"));
  } catch (err) {
    console.error(`FAIL: html2scene could not compile ${fixture}: ${err.message}`);
    process.exit(2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const failures = [];
function assert(cond, gate, message) {
  if (!cond) failures.push(`${gate}: ${message}`);
}

function effectsOf(slide) {
  return ((slide.animations || {}).effects || []).filter((r) => !r.ambient);
}

function slotsOf(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.delayMs || 0;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([delayMs, members]) => ({ delayMs, members }));
}

const MOTION_KEYS = ["effect", "x", "y", "scaleFrom", "scaleTo", "rotateFrom", "rotateTo", "opacity", "durationMs", "ease"];
function motionSignature(row) {
  return JSON.stringify(MOTION_KEYS.map((k) => row[k] ?? null));
}

function assertAtomicSlots(slots, gate, label) {
  for (const slot of slots) {
    const signatures = new Set(slot.members.map(motionSignature));
    assert(signatures.size === 1, gate,
      `${label}: slot at ${slot.delayMs}ms mixes ${signatures.size} motion signatures across ${slot.members.length} members`);
  }
}

function main() {
  if (!EXAMPLES) {
    console.error("SKIP: motion-gate fixtures not found — examples/ ships with the repo, not the packaged skill; run from a repo checkout.");
    process.exit(3);
  }
  const nodePath = resolvePlaywrightPath();
  if (!nodePath) {
    console.error("SKIP: Playwright not found (run skills/pptx-native/scripts/setup.sh, or set PPT_NODE_PATH).");
    process.exit(1);
  }

  // --- G1: sequence cluster-atomic ---
  {
    const scene = compile("sequence-cluster-smoke.html", nodePath);
    const [s1, s2, s3, s4, s5] = scene.slides;
    for (const [slide, label] of [[s1, "structural"], [s2, "geometric"]]) {
      const seqRows = effectsOf(slide).filter((r) => String(r.target).includes("nth-of-type"));
      const slots = slotsOf(seqRows);
      assert(slots.length === 3, "G1", `${label}: expected 3 cluster slots, got ${slots.length}`);
      for (const slot of slots) {
        assert(slot.members.length === 3, "G1",
          `${label}: slot at ${slot.delayMs}ms has ${slot.members.length} members, expected 3 (card+chip+text)`);
      }
      assertAtomicSlots(slots, "G1", label);
    }
    // Frame guard, three authoring variants: flat siblings on a panel (s3),
    // bullets nested INSIDE the panel (s4), and a lone oversized layout
    // wrapper (s5). A frame must never swallow the list build.
    for (const [slide, label, expected] of [
      [s3, "panel guard (flat)", 5],
      [s4, "panel guard (nested)", 5],
      [s5, "layout wrapper", 4],
    ]) {
      const rows = effectsOf(slide).filter((r) => String(r.target).includes("nth-of-type"));
      const slots = slotsOf(rows);
      assert(slots.length === expected, "G1",
        `${label}: expected ${expected} slots, got ${slots.length}`);
      assert(slots.every((slot) => slot.members.length === 1), "G1",
        `${label}: a frame swallowed part of the list build`);
    }
  }

  // --- G2: timeline origin continuity ---
  {
    const scene = compile("motif-timeline-smoke.html", nodePath);
    const rows = effectsOf(scene.slides[0]);
    assert(rows.length > 0, "G2", "timeline produced no animation rows");
    const spine = rows[0];
    assert(spine.effect === "wipe", "G2", `first row should wipe the spine, got "${spine.effect}"`);
    const milestones = rows.slice(1).filter((r) => r.effect === "compose");
    assert(milestones.length > 0, "G2", "no compose milestone rows after the spine");
    assert(milestones.every((r) => (r.x || 0) !== 0 || (r.y || 0) !== 0 || r.scaleFrom === 0.2), "G2",
      "a milestone enters with no offset from the spine and no on-spine pop");
    assert(milestones.some((r) => r.scaleFrom === 0.2), "G2",
      "no on-spine dot pops from scaleFrom 0.2");
    assertAtomicSlots(slotsOf(milestones), "G2", "timeline");
  }

  // --- G3: hubSpoke emanation + atomic slots ---
  // Gallery fixture slide order: 1 layers, 2 comparison, 3 metricCluster,
  // 4 hubSpoke. Comparison INTENTIONALLY pairs left/right clusters on one
  // delay with mirrored offsets, so the same-signature check skips it —
  // atomicity there is per-cluster, not per-slot.
  {
    const scene = compile("motif-gallery-smoke.html", nodePath);
    let sawSatellite = false;
    const COMPARISON_SLIDE = 1;
    scene.slides.forEach((slide, i) => {
      const rows = effectsOf(slide);
      if (i !== COMPARISON_SLIDE) assertAtomicSlots(slotsOf(rows), "G3", `slide ${i + 1}`);
      for (const r of rows) {
        if (r.effect === "compose" && r.scaleFrom === 0.7 && ((r.x || 0) !== 0 || (r.y || 0) !== 0)) sawSatellite = true;
      }
    });
    assert(sawSatellite, "G3", "no hubSpoke satellite emanates (compose, scaleFrom 0.7, nonzero start offset)");
  }

  if (failures.length) {
    console.error(`FAIL ${failures.length} gate assertion(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(2);
  }
  console.log("PASS: all motion gates green (G1 sequence clusters, G2 timeline origin, G3 hubSpoke emanation).");
}

main();
