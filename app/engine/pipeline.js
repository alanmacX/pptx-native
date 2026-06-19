#!/usr/bin/env node
/**
 * Engine orchestrator (no GUI). Chains the existing pure-JS tools and the
 * compiler into one call so any shell (Electron now, native later) drives the
 * same deterministic path:
 *
 *   html string -> lint -> html2scene -> compile -> pack -> .pptx
 *
 * The compiler step is isolated behind compilePptx(): today it shells out to the
 * Python pptx_native module; the planned TS port replaces ONLY this function and
 * removes the Python dependency without touching the rest of the app.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");

// Bundled Chromium / Playwright runtime used by html2scene + lint, so extraction
// is engine-consistent regardless of OS. Configurable via env for packaging.
const NODE_BIN = process.env.PPT_NODE_BIN ||
  "/Users/macalan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node";
const NODE_MODULES = process.env.PPT_NODE_PATH ||
  "/Users/macalan/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
const PYTHON = process.env.PPT_PYTHON || "python3";

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: NODE_MODULES },
    ...opts,
  });
  if (r.error) throw r.error;
  return r;
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ppt-"));
}

/** Lint HTML. Returns { ok, counts, violations }. Does not throw on violations. */
function lint(htmlPath) {
  const r = run(NODE_BIN, [path.join(REPO, "tools/ppt_html_lint.cjs"), htmlPath]);
  try { return JSON.parse(r.stdout); }
  catch { return { ok: false, counts: { errors: 1 }, violations: [], raw: r.stdout + r.stderr }; }
}

function normalize(htmlPath, outPath) {
  const args = [path.join(REPO, "tools/ppt_html_normalize.cjs"), htmlPath];
  if (outPath) args.push("--out", outPath);
  const r = run(NODE_BIN, args);
  try { return JSON.parse(r.stdout); }
  catch { return { ok: false, changed: false, corrections: [], raw: r.stdout + r.stderr }; }
}

function normalizeHtml(html) {
  const dir = tmpdir();
  const htmlPath = path.join(dir, "input.html");
  const outPath = path.join(dir, "normalized.html");
  fs.writeFileSync(htmlPath, String(html || ""));
  const report = normalize(htmlPath, outPath);
  const normalized = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : String(html || "");
  return { html: normalized, report };
}

function lintHtml(html) {
  const normalized = normalizeHtml(html);
  const dir = tmpdir();
  const htmlPath = path.join(dir, "lint.html");
  fs.writeFileSync(htmlPath, normalized.html);
  const report = lint(htmlPath);
  report.normalization = normalized.report;
  return report;
}

function normalizeAndLintHtml(html) {
  const normalized = normalizeHtml(html);
  const dir = tmpdir();
  const htmlPath = path.join(dir, "lint.html");
  fs.writeFileSync(htmlPath, normalized.html);
  const lintReport = lint(htmlPath);
  lintReport.normalization = normalized.report;
  return { html: normalized.html, normalization: normalized.report, lint: lintReport };
}

/** Extract HTML -> scene JSON. */
function extract(htmlPath, scenePath, { steps = "0", width = 1280, height = 720 } = {}) {
  const r = run(NODE_BIN, [
    path.join(REPO, "tools/html2scene.cjs"), htmlPath,
    "--steps", String(steps), "--width", String(width), "--height", String(height),
    "--out", scenePath,
  ]);
  if (!fs.existsSync(scenePath)) throw new Error("extract failed: " + r.stderr);
  return JSON.parse(fs.readFileSync(scenePath, "utf8"));
}

/**
 * Compile scene -> .pptx. ISOLATED Python dependency (the only one).
 * Replace this function with a TS implementation to drop Python entirely.
 */
function compilePptx(scenePath, outPptx) {
  const deckDir = path.join(path.dirname(scenePath), "deck");
  let r = run(PYTHON, ["-m", "pptx_native", "create", scenePath, "--out", deckDir, "--force"]);
  if (r.status !== 0) throw new Error("compile failed: " + r.stderr);
  const createReport = JSON.parse(r.stdout);
  r = run(PYTHON, ["-m", "pptx_native", "validate", deckDir]);
  const validate = JSON.parse(r.stdout);
  run(PYTHON, ["-m", "pptx_native", "pack", deckDir, "--out", outPptx]);
  return { losses: createReport.losses || [], validate };
}

/** Full pipeline. Returns a structured report for the UI / LLM auto-fix loop. */
function buildFromHtml(html, outPptx, opts = {}) {
  const dir = tmpdir();
  const htmlPath = path.join(dir, "slide.html");
  const checked = normalizeAndLintHtml(html);
  fs.writeFileSync(htmlPath, checked.html);
  const scenePath = path.join(dir, "scene.json");
  const scene = extract(htmlPath, scenePath, opts);
  const compile = compilePptx(scenePath, outPptx);
  return {
    ok: checked.lint.ok && compile.validate.ok,
    out: outPptx,
    lint: checked.lint,
    normalization: checked.normalization,
    losses: compile.losses,
    guards: scene.guards || [],
    validate: { ok: compile.validate.ok, errors: compile.validate.errors },
    slides: scene.slides.length,
  };
}

module.exports = { lint, normalize, normalizeHtml, normalizeAndLintHtml, lintHtml, extract, compilePptx, buildFromHtml };

// CLI: node pipeline.js input.html out.pptx [--steps 0-1]
if (require.main === module) {
  const args = process.argv.slice(2);
  const input = args[0];
  const out = args[1];
  const stepsIdx = args.indexOf("--steps");
  const steps = stepsIdx >= 0 ? args[stepsIdx + 1] : "0";
  if (!input || !out) {
    console.error("Usage: node pipeline.js input.html out.pptx [--steps 0-1]");
    process.exit(1);
  }
  const html = fs.readFileSync(path.resolve(input), "utf8");
  const report = buildFromHtml(html, path.resolve(out), { steps });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 2);
}
