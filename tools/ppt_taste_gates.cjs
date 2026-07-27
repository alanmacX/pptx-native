#!/usr/bin/env node
// Regression gate for the anti-AI presentation taste rules.
// Exit 0 = every owner-reported tell is detected; exit 1 = no Playwright;
// exit 2 = a rule regressed; exit 3 = fixture missing.

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LINTER = path.join(__dirname, "ppt_html_lint.cjs");
const FIXTURE = path.join(ROOT, "examples", "anti-ai-taste-smoke.html");

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
  if (!fs.existsSync(FIXTURE)) {
    console.error(`SKIP: fixture not found: ${FIXTURE}`);
    process.exit(3);
  }
  const nodePath = resolvePlaywrightPath();
  if (!nodePath) {
    console.error("SKIP: Playwright not found (run skills/pptx-native/scripts/setup.sh, or set PPT_NODE_PATH).");
    process.exit(1);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-taste-gates-"));
  const out = path.join(dir, "lint.json");
  try {
    const runLint = (input, reportPath) => {
      const lint = spawnSync(process.execPath, [LINTER, input, "--out", reportPath], {
        env: { ...process.env, NODE_PATH: nodePath },
        stdio: ["ignore", "ignore", "inherit"],
      });
      // The fixture intentionally contains anti-patterns and may also trip
      // structural errors. The linter writes its report before returning 2.
      if (![0, 2].includes(lint.status) || !fs.existsSync(reportPath)) {
        console.error(`FAIL: linter did not produce a report (exit ${lint.status}).`);
        process.exit(2);
      }
      return JSON.parse(fs.readFileSync(reportPath, "utf8"));
    };
    const report = runLint(FIXTURE, out);
    const found = new Set(report.violations.map((v) => v.rule));
    const expected = [
      "AI_EN_EYEBROW",
      "AI_TITLE_LOCKUP_MONOTONY",
      "AI_FOOTNOTE_FURNITURE",
      "AI_CARD_GRID_MONOTONY",
      "AI_TEXT_WALL",
      "AI_IMAGE_SCARCITY",
      "AI_CHART_DECORATION",
      "AI_ROBOTIC_COPY",
      "MORPH_CONTINUITY_MISSED",
    ];
    const missing = expected.filter((rule) => !found.has(rule));
    if (missing.length) {
      console.error(`FAIL: missing taste rules: ${missing.join(", ")}`);
      process.exit(2);
    }

    // The explicit abstract-deck strategy is a real waiver, not dead syntax.
    const waivedFixture = path.join(dir, "waived.html");
    const waivedOut = path.join(dir, "waived.json");
    const waivedHtml = fs.readFileSync(FIXTURE, "utf8")
      .replace("<body>", '<body data-ppt-visual-strategy="diagram-only">')
      .replace('data-ppt-role="chart"', 'data-ppt-role="chart" data-ppt-evidence="增长只来自第二季度"');
    fs.writeFileSync(waivedFixture, waivedHtml);
    const waived = new Set(runLint(waivedFixture, waivedOut).violations.map((v) => v.rule));
    const leakedWaivers = ["AI_IMAGE_SCARCITY", "AI_CHART_DECORATION"].filter((rule) => waived.has(rule));
    if (leakedWaivers.length) {
      console.error(`FAIL: explicit taste waivers did not clear: ${leakedWaivers.join(", ")}`);
      process.exit(2);
    }
    console.log(`PASS: anti-AI taste gate detected ${expected.length} owner-reported rule families.`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
