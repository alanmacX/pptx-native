#!/usr/bin/env node
// Generate and verify a native surface smoke deck.
// It exercises carriers + effects + timing, then inspects the packed PPTX.
// Usage: node tools/ppt_surface_smoke.cjs [--out outputs/native-surface-smoke]
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const MP4_STUB = "AAAA";

function parseArgs(argv) {
  const out = { outDir: "outputs/native-surface-smoke" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") out.outDir = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || process.cwd(),
    encoding: "utf8",
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${cmd} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout || "";
}

function scene() {
  const imageUri = `data:image/png;base64,${PNG_1X1}`;
  const videoUri = `data:video/mp4;base64,${MP4_STUB}`;
  return {
    size: { cx: 12192000, cy: 6858000, pxWidth: 1280, pxHeight: 720 },
    title: "Native surface smoke",
    theme: {
      name: "Surface Smoke",
      colors: { accent1: "4F8DF7", accent2: "58D68D", accent3: "F8C471", dk2: "101315", lt2: "F7FAFC" },
      fonts: { majorLatin: "Aptos Display", minorLatin: "Aptos", majorEa: "PingFang SC", minorEa: "PingFang SC" },
    },
    slides: [
      {
        name: "carriers-effects",
        background: "101315",
        notes: "Surface smoke: carriers, static effects, and timing targets.",
        transition: { type: "fade", durationMs: 350 },
        elements: [
          {
            type: "shape", name: "shape-carrier", shape: "roundRect",
            x: 60, y: 70, w: 210, h: 120, fill: "accent1",
            line: { fill: "F7FAFC", width: 2, dash: "dash" },
            shadow: { color: "000000", blur: 12, distance: 3, direction: 45, alpha: 0.35 },
            glow: { color: "8FD3FF", radius: 9, alpha: 0.7 },
            blur: { radius: 2 },
            reflection: { alpha: 0.25, dist: 2, blur: 2 },
            text: "Shape", fontSize: 22, color: "FFFFFF", align: "center", valign: "mid",
          },
          {
            type: "freeform", name: "freeform-carrier",
            points: [[360, 74], [520, 110], [495, 215], [330, 190]],
            closed: true, fill: "accent3", line: { fill: "F7FAFC", width: 2 },
            shadow: { color: "000000", blur: 10, distance: 2, direction: 45, alpha: 0.3 },
            glow: { color: "FFE4A3", radius: 7, alpha: 0.65 },
            blur: { radius: 2 },
            reflection: { alpha: 0.2, dist: 2, blur: 2 },
          },
          {
            type: "image", name: "picture-carrier", src: imageUri,
            x: 620, y: 70, w: 135, h: 135,
            shadow: { color: "000000", blur: 12, distance: 3, direction: 45, alpha: 0.35 },
            glow: { color: "D7F9FF", radius: 8, alpha: 0.65 },
            blur: { radius: 2 },
            reflection: { alpha: 0.25, dist: 2, blur: 2 },
          },
          {
            type: "media", name: "media-carrier", mediaType: "video", src: videoUri, poster: imageUri,
            x: 790, y: 70, w: 170, h: 96,
            shadow: { color: "000000", blur: 10, distance: 3, direction: 45, alpha: 0.3 },
            glow: { color: "BDF5FF", radius: 7, alpha: 0.6 },
            blur: { radius: 2 },
            reflection: { alpha: 0.2, dist: 2, blur: 2 },
          },
          { type: "line", name: "connector-carrier", x1: 990, y1: 140, x2: 1180, y2: 140, line: { fill: "EAF2F8", width: 4, dash: "lgDash" }, arrow: "triangle" },
          {
            type: "text", name: "textbox-carrier", x: 60, y: 280, w: 470, h: 88,
            text: "Textbox carrier", fontSize: 28, color: "F7FAFC",
            runs: [
              { text: "Textbox ", bold: true, color: "F7FAFC" },
              { text: "carrier", color: "58D68D" },
            ],
          },
          {
            type: "table", name: "table-carrier", x: 60, y: 410, w: 520, h: 160,
            columns: [190, 165, 165], fontSize: 16, headerFill: "accent1", headerColor: "FFFFFF", rowFill: "1B2226", borderColor: "38434A",
            rows: [
              ["Carrier", "Property", "Status"],
              ["picture", "blur", { text: "compiles", color: "58D68D", bold: true }],
              ["connector", "glow", { text: "gap", color: "F8C471", bold: true }],
            ],
          },
          {
            type: "chart", name: "chart-carrier", chartType: "column", x: 700, y: 330, w: 430, h: 250,
            title: "Carrier coverage", legend: true, categories: ["shape", "picture", "chart"],
            series: [{ name: "count", values: [4, 4, 2], color: "accent2" }],
          },
        ],
        animations: {
          framework: "ppt-compatible-v1",
          effects: [
            { target: "shape-carrier", effect: "compose", opacity: "in", x: -36, scaleFrom: 0.96, scaleTo: 1, durationMs: 360, ease: "out" },
            { target: "freeform-carrier", effect: "compose", opacity: "in", x: -36, rotateFrom: -4, rotateTo: 0, durationMs: 360, delayMs: 90, trigger: "withPrevious" },
            { target: "picture-carrier", effect: "compose", opacity: "in", x: -36, durationMs: 360, delayMs: 180, trigger: "withPrevious" },
            { target: "media-carrier", effect: "compose", opacity: "in", x: -30, scaleFrom: 0.94, scaleTo: 1, durationMs: 360, delayMs: 220, trigger: "withPrevious" },
            { target: "media-carrier", effect: "mediaPlay", delayMs: 650, trigger: "withPrevious" },
            { target: "media-carrier", effect: "mediaPause", delayMs: 820, trigger: "withPrevious" },
            { target: "media-carrier", effect: "mediaStop", delayMs: 980, trigger: "withPrevious" },
            { target: "connector-carrier", effect: "motionPath", pptPath: "M 0 0 L 0.18 0", durationMs: 560, delayMs: 220, trigger: "withPrevious" },
            { target: "textbox-carrier", effect: "build", buildEffect: "fade", durationMs: 280, delayMs: 260, trigger: "withPrevious" },
            { target: "table-carrier", effect: "fade", durationMs: 300, delayMs: 420, trigger: "withPrevious" },
            { target: "chart-carrier", effect: "wipe", durationMs: 420, delayMs: 520, trigger: "withPrevious" },
          ],
        },
      },
      {
        name: "morph-target",
        background: "101315",
        transition: { type: "morph", option: "byObject", durationMs: 900 },
        elements: [
          { type: "shape", name: "morph-shape", morphKey: "surface-morph", shape: "ellipse", x: 820, y: 160, w: 210, h: 210, fill: "accent2", line: { fill: "F7FAFC", width: 2 } },
          { type: "text", name: "morph-label", x: 180, y: 260, w: 480, h: 80, text: "Morph carrier", fontSize: 38, color: "F7FAFC" },
        ],
      },
    ],
  };
}

function inspect(pptx) {
  const py = `
import json, sys, zipfile
pptx=sys.argv[1]
with zipfile.ZipFile(pptx) as z:
    texts={n:z.read(n).decode('utf-8') for n in z.namelist() if n.endswith('.xml')}
joined='\\n'.join(texts.values())
slide1=texts.get('ppt/slides/slide1.xml','')
slide2=texts.get('ppt/slides/slide2.xml','')
out={
  'pic': joined.count('<p:pic>'),
  'media': joined.count('<p14:media'),
  'videoFile': joined.count('<a:videoFile'),
  'cmd': joined.count('<p:cmd'),
  'mediaPlay': joined.count('cmd="playFrom(0.0)"'),
  'mediaPause': joined.count('cmd="togglePause"'),
  'mediaStop': joined.count('cmd="stop"'),
  'shape': joined.count('<p:sp>'),
  'connector': joined.count('<p:cxnSp>'),
  'graphicFrame': joined.count('<p:graphicFrame>'),
  'table': joined.count('<a:tbl>'),
  'chart': joined.count('<c:chart'),
  'blur': joined.count('<a:blur'),
  'glow': joined.count('<a:glow'),
  'reflection': joined.count('<a:reflection'),
  'shadow': joined.count('<a:outerShdw'),
  'animEffect': joined.count('<p:animEffect'),
  'animMotion': joined.count('<p:animMotion'),
  'animScale': joined.count('<p:animScale'),
  'animRot': joined.count('<p:animRot'),
  'buildParagraph': joined.count('<p:bldP'),
  'morph': joined.count('p159:morph'),
  'slide1Timing': slide1.count('<p:timing>'),
  'slide2Transition': slide2.count('<p:transition'),
}
print(json.dumps(out, indent=2))
`;
  return JSON.parse(run(process.env.PPT_PYTHON || "python3", ["-c", py, pptx], { capture: true }));
}

function assertExpectations(counts) {
  const expectations = {
    pic: 2,
    media: 1,
    videoFile: 1,
    cmd: 3,
    mediaPlay: 1,
    mediaPause: 1,
    mediaStop: 1,
    connector: 1,
    graphicFrame: 2,
    table: 1,
    chart: 1,
    blur: 4,
    glow: 4,
    reflection: 4,
    shadow: 4,
    animEffect: 5,
    animMotion: 4,
    buildParagraph: 1,
    morph: 1,
    slide1Timing: 1,
    slide2Transition: 1,
  };
  const failures = [];
  for (const [key, min] of Object.entries(expectations)) {
    if ((counts[key] || 0) < min) failures.push(`${key}: expected >= ${min}, got ${counts[key] || 0}`);
  }
  return failures;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node tools/ppt_surface_smoke.cjs [--out outputs/native-surface-smoke]");
    return;
  }
  const outDir = path.resolve(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const scenePath = path.join(outDir, "scene.json");
  const deckDir = path.join(outDir, "deck");
  const pptxPath = path.join(outDir, "native-surface-smoke.pptx");
  const reportPath = path.join(outDir, "surface-smoke-report.json");

  fs.writeFileSync(scenePath, JSON.stringify(scene(), null, 2));
  const py = process.env.PPT_PYTHON || "python3";
  run(py, ["-m", "pptx_native", "create", scenePath, "--out", deckDir, "--force"], { capture: true });
  run(py, ["-m", "pptx_native", "validate", deckDir], { capture: true });
  run(py, ["-m", "pptx_native", "pack", deckDir, "--out", pptxPath], { capture: true });
  const counts = inspect(pptxPath);
  const failures = assertExpectations(counts);
  const report = { ok: failures.length === 0, out: pptxPath, counts, failures };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exit(1);
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
