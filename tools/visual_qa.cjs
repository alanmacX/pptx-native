#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");
const pixelmatchModule = require("pixelmatch");

const pixelmatch = pixelmatchModule.default || pixelmatchModule;

function usage() {
  return [
    "Usage: node tools/visual_qa.cjs --pptx deck.pptx --out visual-qa [options]",
    "",
    "Options:",
    "  --html file                  Capture HTML QA screenshots via tools/html2scene.cjs.",
    "  --html-dir dir               Use existing HTML screenshots named html-step-00.png, ...",
    "  --steps 0-21                 Step list or ranges. Step N compares to PPT slide N+1.",
    "  --width 1200 --height 675    HTML viewport and expected rendered image size.",
    "  --wait-ms 900                HTML wait after each step transition.",
    "  --ppt-dpi 90                 PowerPoint PDF rasterization DPI. 90 maps 960x540pt to 1200x675px.",
    "  --threshold 0.12             Pixelmatch color threshold.",
    "  --skip-html-capture          Do not run html2scene even when --html is provided.",
    "",
    "This tool creates QA images only. Screenshots are never compiler input.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = {
    html: null,
    htmlDir: null,
    pptx: null,
    out: null,
    steps: "0-21",
    width: 1200,
    height: 675,
    waitMs: 900,
    pptDpi: 90,
    threshold: 0.12,
    skipHtmlCapture: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      return args;
    }
    const next = argv[i + 1];
    if (arg === "--html") args.html = next, i += 1;
    else if (arg === "--html-dir") args.htmlDir = next, i += 1;
    else if (arg === "--pptx") args.pptx = next, i += 1;
    else if (arg === "--out") args.out = next, i += 1;
    else if (arg === "--steps") args.steps = next, i += 1;
    else if (arg === "--width") args.width = Number(next), i += 1;
    else if (arg === "--height") args.height = Number(next), i += 1;
    else if (arg === "--wait-ms") args.waitMs = Number(next), i += 1;
    else if (arg === "--ppt-dpi") args.pptDpi = Number(next), i += 1;
    else if (arg === "--threshold") args.threshold = Number(next), i += 1;
    else if (arg === "--skip-html-capture") args.skipHtmlCapture = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.pptx || !args.out || (!args.html && !args.htmlDir)) {
    throw new Error(usage());
  }
  return args;
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

function ensureEmptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function run(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, {
    encoding: opts.encoding || "utf8",
    stdio: opts.stdio || "pipe",
    env: { ...process.env, ...(opts.env || {}) },
  });
}

function findCommand(name) {
  try {
    return run("which", [name]).trim();
  } catch {
    return null;
  }
}

function exportPowerPointPdf(pptx, pdf) {
  const script = [
    "on run argv",
    "set pptPath to item 1 of argv",
    "set pdfPath to item 2 of argv",
    "tell application \"Microsoft PowerPoint\"",
    "open POSIX file pptPath",
    "delay 1",
    "set pres to active presentation",
    "save pres in POSIX file pdfPath as save as PDF",
    "close pres saving no",
    "end tell",
    "end run",
  ].join("\n");
  run("osascript", ["-e", script, pptx, pdf]);
}

function captureHtml(args, outDir) {
  const scene = path.join(outDir, "html-scene.json");
  const ir = path.join(outDir, "html-ir.json");
  const report = path.join(outDir, "html-report.json");
  const htmlShots = path.join(outDir, "html");
  ensureEmptyDir(htmlShots);
  run(process.execPath, [
    path.resolve("tools/html2scene.cjs"),
    path.resolve(args.html),
    "--steps", args.steps,
    "--out", scene,
    "--ir", ir,
    "--report", report,
    "--screenshots", htmlShots,
    "--width", String(args.width),
    "--height", String(args.height),
    "--wait-ms", String(args.waitMs),
  ], { stdio: "inherit" });
  return htmlShots;
}

function renderPpt(args, outDir) {
  const pptDir = path.join(outDir, "ppt");
  ensureEmptyDir(pptDir);
  const pdf = path.join(outDir, "ppt-render.pdf");
  fs.rmSync(pdf, { force: true });
  exportPowerPointPdf(path.resolve(args.pptx), pdf);
  const pdftoppm = findCommand("pdftoppm");
  if (!pdftoppm) throw new Error("pdftoppm is required to rasterize PowerPoint's PDF export.");
  run(pdftoppm, ["-png", "-r", String(args.pptDpi), pdf, path.join(pptDir, "ppt-slide")]);
  return { pptDir, pdf };
}

async function imageRaw(file, expectedWidth, expectedHeight) {
  const img = sharp(file).ensureAlpha();
  const meta = await img.metadata();
  if (meta.width !== expectedWidth || meta.height !== expectedHeight) {
    const resized = await img.resize(expectedWidth, expectedHeight, { fit: "fill" }).raw().toBuffer();
    return { data: resized, width: expectedWidth, height: expectedHeight, resizedFrom: { width: meta.width, height: meta.height } };
  }
  return { data: await img.raw().toBuffer(), width: meta.width, height: meta.height, resizedFrom: null };
}

function computeChannels(a, b) {
  let abs = 0;
  let sq = 0;
  let maxDelta = 0;
  const pixels = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const d = Math.abs(a[i + c] - b[i + c]);
      abs += d;
      sq += d * d;
      if (d > maxDelta) maxDelta = d;
    }
  }
  const channels = pixels * 3;
  return {
    meanAbs: abs / channels,
    meanAbsNorm: abs / channels / 255,
    rmse: Math.sqrt(sq / channels),
    rmseNorm: Math.sqrt(sq / channels) / 255,
    maxDelta,
  };
}

async function compareOne({ step, htmlFile, pptFile, diffFile, contactFile, width, height, threshold }) {
  const html = await imageRaw(htmlFile, width, height);
  const ppt = await imageRaw(pptFile, width, height);
  const diff = Buffer.alloc(width * height * 4);
  const mismatchPixels = pixelmatch(html.data, ppt.data, diff, width, height, {
    threshold,
    includeAA: false,
    alpha: 0.55,
    diffColor: [255, 0, 80],
    aaColor: [255, 180, 0],
  });
  const channel = computeChannels(html.data, ppt.data);
  await sharp(diff, { raw: { width, height, channels: 4 } }).png().toFile(diffFile);
  await sharp({
    create: { width: width * 3, height, channels: 4, background: "#ffffff" },
  }).composite([
    { input: htmlFile, left: 0, top: 0 },
    { input: pptFile, left: width, top: 0 },
    { input: diffFile, left: width * 2, top: 0 },
  ]).png().toFile(contactFile);
  return {
    step,
    pptSlide: step + 1,
    html: htmlFile,
    ppt: pptFile,
    diff: diffFile,
    contact: contactFile,
    mismatchPixels,
    mismatchRatio: mismatchPixels / (width * height),
    ...channel,
    resized: { html: html.resizedFrom, ppt: ppt.resizedFrom },
  };
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function writeMarkdown(file, report) {
  const lines = [];
  lines.push("# Visual QA: HTML vs PowerPoint");
  lines.push("");
  lines.push("Screenshots are QA artifacts only and are not compiler input.");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- Slides compared: ${report.summary.slidesCompared}`);
  lines.push(`- Average mismatch ratio: ${(report.summary.averageMismatchRatio * 100).toFixed(2)}%`);
  lines.push(`- Worst mismatch ratio: ${(report.summary.worstMismatchRatio * 100).toFixed(2)}% on step ${report.summary.worstStep} / PPT slide ${report.summary.worstPptSlide}`);
  lines.push(`- Average mean absolute channel error: ${report.summary.averageMeanAbs.toFixed(2)} / 255`);
  lines.push("");
  lines.push("## Worst Slides");
  lines.push("");
  lines.push("| Step | PPT slide | Mismatch | Mean abs | Contact |");
  lines.push("| ---: | ---: | ---: | ---: | --- |");
  for (const row of report.results.slice().sort((a, b) => b.mismatchRatio - a.mismatchRatio).slice(0, 8)) {
    lines.push(`| ${row.step} | ${row.pptSlide} | ${(row.mismatchRatio * 100).toFixed(2)}% | ${row.meanAbs.toFixed(2)} | ${path.relative(path.dirname(file), row.contact)} |`);
  }
  lines.push("");
  lines.push("## All Slides");
  lines.push("");
  lines.push("| Step | PPT slide | Mismatch | Mean abs | RMSE |");
  lines.push("| ---: | ---: | ---: | ---: | ---: |");
  for (const row of report.results) {
    lines.push(`| ${row.step} | ${row.pptSlide} | ${(row.mismatchRatio * 100).toFixed(2)}% | ${row.meanAbs.toFixed(2)} | ${row.rmse.toFixed(2)} |`);
  }
  lines.push("");
  fs.writeFileSync(file, lines.join("\n"), "utf8");
}

function pptName(slideNumber) {
  return `ppt-slide-${String(slideNumber).padStart(2, "0")}.png`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const steps = parseSteps(args.steps);
  const outDir = path.resolve(args.out);
  ensureDir(outDir);

  let htmlDir;
  if (args.html && !args.skipHtmlCapture) {
    htmlDir = captureHtml(args, outDir);
  } else {
    htmlDir = path.resolve(args.htmlDir || path.join(outDir, "html"));
  }

  const { pptDir, pdf } = renderPpt(args, outDir);
  const diffDir = path.join(outDir, "diff");
  const contactDir = path.join(outDir, "contact");
  ensureEmptyDir(diffDir);
  ensureEmptyDir(contactDir);

  const results = [];
  for (const step of steps) {
    const htmlFile = path.join(htmlDir, `html-step-${String(step).padStart(2, "0")}.png`);
    const pptFile = path.join(pptDir, pptName(step + 1));
    if (!fs.existsSync(htmlFile)) throw new Error(`Missing HTML screenshot: ${htmlFile}`);
    if (!fs.existsSync(pptFile)) throw new Error(`Missing PPT render: ${pptFile}`);
    results.push(await compareOne({
      step,
      htmlFile,
      pptFile,
      diffFile: path.join(diffDir, `diff-step-${String(step).padStart(2, "0")}.png`),
      contactFile: path.join(contactDir, `contact-step-${String(step).padStart(2, "0")}.png`),
      width: args.width,
      height: args.height,
      threshold: args.threshold,
    }));
  }

  const averageMismatchRatio = results.reduce((sum, row) => sum + row.mismatchRatio, 0) / results.length;
  const averageMeanAbs = results.reduce((sum, row) => sum + row.meanAbs, 0) / results.length;
  const worst = results.slice().sort((a, b) => b.mismatchRatio - a.mismatchRatio)[0];
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    contract: {
      screenshots: "qa-only-not-compiler-input",
      compilerInput: "none",
      htmlReference: "visual-qa-only",
      pptReference: "PowerPoint-PDF-render",
    },
    inputs: {
      html: args.html ? path.resolve(args.html) : null,
      htmlDir,
      pptx: path.resolve(args.pptx),
      pdf,
    },
    settings: {
      steps,
      width: args.width,
      height: args.height,
      pptDpi: args.pptDpi,
      threshold: args.threshold,
    },
    summary: {
      slidesCompared: results.length,
      averageMismatchRatio,
      averageMeanAbs,
      worstMismatchRatio: worst?.mismatchRatio || 0,
      worstStep: worst?.step,
      worstPptSlide: worst?.pptSlide,
    },
    results,
  };
  const jsonPath = path.join(outDir, "visual-report.json");
  const mdPath = path.join(outDir, "visual-report.md");
  writeJson(jsonPath, report);
  writeMarkdown(mdPath, report);
  console.log(JSON.stringify({
    ok: true,
    out: outDir,
    report: jsonPath,
    markdown: mdPath,
    summary: report.summary,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
