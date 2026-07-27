#!/usr/bin/env node
// Regression gate for guided layout presets and design lint.
// Exit 0 = registry/CSS/lint/compile contracts pass; exit 1 = no Playwright;
// exit 2 = a contract regressed; exit 3 = fixture or registry missing.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LINTER = path.join(__dirname, "ppt_html_lint.cjs");
const HTML2SCENE = path.join(__dirname, "html2scene.cjs");
const FIXTURE = path.join(ROOT, "examples", "layout-preset-smoke.html");
const REGISTRY = path.join(ROOT, "skills", "pptx-native", "references", "layout-presets.json");
const CSS = path.join(ROOT, "skills", "pptx-native", "assets", "ppt-components.css");

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(2);
}

function resolvePlaywrightPath() {
  const candidates = [
    process.env.PPT_NODE_PATH,
    path.join(ROOT, "skills", "pptx-native", "scripts", "engine", "node_modules"),
    path.join(ROOT, "node_modules"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      require.resolve("playwright", { paths: [candidate] });
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}

function main() {
  for (const required of [FIXTURE, REGISTRY, CSS]) {
    if (!fs.existsSync(required)) {
      console.error(`SKIP: required design artifact not found: ${required}`);
      process.exit(3);
    }
  }
  const nodePath = resolvePlaywrightPath();
  if (!nodePath) {
    console.error("SKIP: Playwright not found (run skills/pptx-native/scripts/setup.sh, or set PPT_NODE_PATH).");
    process.exit(1);
  }

  const registry = JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  const presets = registry.presets || {};
  const css = fs.readFileSync(CSS, "utf8");
  const missingCss = Object.keys(presets)
    .filter((name) => name !== "custom")
    .filter((name) => !css.includes(`data-ppt-layout="${name}"`));
  if (missingCss.length) fail(`registry presets missing CSS geometry: ${missingCss.join(", ")}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-design-gates-"));
  try {
    const runLint = (input, reportPath) => {
      const result = spawnSync(process.execPath, [LINTER, input, "--out", reportPath], {
        env: { ...process.env, NODE_PATH: nodePath },
        stdio: ["ignore", "ignore", "inherit"],
      });
      if (![0, 2].includes(result.status) || !fs.existsSync(reportPath)) {
        fail(`linter did not produce a report for ${path.basename(input)} (exit ${result.status})`);
      }
      return JSON.parse(fs.readFileSync(reportPath, "utf8"));
    };

    // Positive: CSS-supplied region geometry is native-valid and the six-slide
    // sequence has deliberate silhouette/type rhythm.
    const positive = runLint(FIXTURE, path.join(dir, "positive.json"));
    const positiveBad = positive.violations.filter((v) =>
      v.level === "error" || v.rule === "NATIVE_GEOMETRY" || v.rule.startsWith("DESIGN_"));
    if (positiveBad.length) {
      fail(`positive preset fixture produced ${positiveBad.map((v) => v.rule).join(", ")}`);
    }

    const scenePath = path.join(dir, "scene.json");
    const compile = spawnSync(process.execPath, [HTML2SCENE, FIXTURE, "--out", scenePath], {
      env: { ...process.env, NODE_PATH: nodePath },
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (compile.status !== 0 || !fs.existsSync(scenePath)) fail("layout preset fixture did not compile to scene JSON");
    const scene = JSON.parse(fs.readFileSync(scenePath, "utf8"));
    if ((scene.slides || []).length !== 6) fail(`expected 6 compiled slides, got ${(scene.slides || []).length}`);
    const invalidBox = (scene.slides || []).flatMap((slide) => slide.elements || []).find((el) =>
      ["text", "shape", "image", "media"].includes(el.type) &&
      (!(Number(el.w) > 0) || !(Number(el.h) > 0)));
    if (invalidBox) fail(`compiled preset element has an invalid box: ${invalidBox.name || invalidBox.type}`);

    // Negative: every design rule family is executable, not prose-only.
    const badSlides = Array.from({ length: 6 }, (_, i) => `
      <section class="ppt-slide" data-ppt-layout="statement">
        <div class="ppt-textbox" data-ppt-region="title" style="font-size:20px;">Tiny repeated title ${i + 1}</div>
        <div class="ppt-textbox" data-ppt-region="support" style="font-size:12px;">This deliberately long body sentence is too small for audience-facing slide prose.</div>
      </section>`).join("");
    const negativePath = path.join(dir, "negative.html");
    fs.writeFileSync(negativePath, `<!doctype html><html><head>
      <link rel="stylesheet" href="${CSS}">
      </head><body>${badSlides}
      <section class="ppt-slide" data-ppt-layout="mystery">
        <div class="ppt-textbox" style="left:72px;top:72px;width:700px;font-size:40px;">Unknown</div>
      </section>
      <section class="ppt-slide" data-ppt-layout="split">
        <div class="ppt-textbox" data-ppt-region="title" style="font-size:40px;">Missing regions</div>
      </section>
      </body></html>`);
    const negative = new Set(runLint(negativePath, path.join(dir, "negative.json"))
      .violations.map((v) => v.rule));
    const expected = [
      "DESIGN_LAYOUT_UNKNOWN",
      "DESIGN_LAYOUT_ROLE_MISSING",
      "DESIGN_TITLE_TOO_SMALL",
      "DESIGN_BODY_TOO_SMALL",
      "DESIGN_SILHOUETTE_REPEAT",
      "DESIGN_LAYOUT_VARIETY",
    ];
    const missing = expected.filter((rule) => !negative.has(rule));
    if (missing.length) fail(`negative fixture did not trigger: ${missing.join(", ")}`);

    const classified = runLint(negativePath, path.join(dir, "classified.json"));
    const kindFor = (rule) => classified.violations.find((v) => v.rule === rule)?.kind;
    if (kindFor("DESIGN_TITLE_TOO_SMALL") !== "quality") {
      fail("title readability finding is not classified as quality");
    }
    if (kindFor("DESIGN_LAYOUT_UNKNOWN") !== "contract") {
      fail("unknown layout finding is not classified as contract");
    }
    if (kindFor("DESIGN_LAYOUT_VARIETY") !== "advisory") {
      fail("layout variety finding is not classified as advisory");
    }

    const rationalePath = path.join(dir, "rationale.html");
    fs.writeFileSync(rationalePath, `<!doctype html><html><body
      data-ppt-design-rationale="A repeated centered chapter ritual is the deliberate visual system">
      ${Array.from({ length: 6 }, (_, i) => `
        <section class="ppt-slide" data-ppt-layout="statement">
          <div class="ppt-textbox" data-ppt-region="title" style="font-size:52px;">Ritual ${i + 1}</div>
          <div class="ppt-textbox" data-ppt-region="support" style="font-size:18px;">Deliberate repetition</div>
        </section>`).join("")}
      </body></html>`);
    const rationalized = new Set(runLint(rationalePath, path.join(dir, "rationale.json"))
      .violations.map((v) => v.rule));
    if (rationalized.has("DESIGN_LAYOUT_VARIETY") ||
        rationalized.has("DESIGN_SILHOUETTE_REPEAT")) {
      fail("explicit design rationale did not waive composition advisories");
    }

    const unplannedPath = path.join(dir, "unplanned.html");
    fs.writeFileSync(unplannedPath, `<!doctype html><html><body>${Array.from({ length: 6 }, (_, i) =>
      `<section class="ppt-slide"><div class="ppt-textbox" style="left:80px;top:80px;width:800px;font-size:40px;">Slide ${i + 1}</div></section>`
    ).join("")}</body></html>`);
    const unplanned = new Set(runLint(unplannedPath, path.join(dir, "unplanned.json"))
      .violations.map((v) => v.rule));
    if (!unplanned.has("DESIGN_LAYOUT_PLAN_MISSING")) fail("unplanned deck did not trigger DESIGN_LAYOUT_PLAN_MISSING");

    console.log(`PASS: ${Object.keys(presets).length} guided layouts, CSS geometry, design lint, and scene compilation are aligned.`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
