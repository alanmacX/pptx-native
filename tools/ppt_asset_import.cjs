#!/usr/bin/env node
/**
 * Import one remote or local asset into a reproducible local asset folder.
 *
 * Usage:
 *   node tools/ppt_asset_import.cjs --src https://example.com/photo.jpg --out outputs/assets/photo
 *   node tools/ppt_asset_import.cjs --src ./clip.mp4 --type video --out outputs/assets/clip
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

function parseArgs(argv) {
  const args = { type: "any", out: null, name: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--src") args.src = argv[++i];
    else if (arg === "--type") args.type = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--name") args.name = argv[++i];
    else if (arg === "--license") args.license = argv[++i];
    else if (arg === "--license-url") args.licenseUrl = argv[++i];
    else if (arg === "--credit") args.credit = argv[++i];
    else if (arg === "--page-url") args.pageUrl = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node tools/ppt_asset_import.cjs --src <url|path> --out outputs/assets/<name> [--type image|video|audio|any]",
    "",
    "The output folder receives the local file and assets.json provenance.",
  ].join("\n");
}

function mustFetch() {
  if (typeof fetch !== "function") {
    throw new Error("This script requires Node 18+ global fetch.");
  }
  return fetch;
}

function safeSlug(text, fallback = "asset") {
  const slug = String(text || "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

function extensionFor(src, mime) {
  const clean = String(src || "").split("?")[0].split("#")[0];
  const ext = path.extname(clean).replace(".", "").toLowerCase();
  if (ext) return ext;
  const byMime = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/ogg": "ogg",
  };
  return byMime[String(mime || "").toLowerCase()] || "bin";
}

function kindFromMime(mime, ext, declared) {
  const d = String(declared || "any").toLowerCase();
  if (["image", "video", "audio"].includes(d)) return d;
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  if (["mp4", "m4v", "mov", "webm"].includes(ext)) return "video";
  if (["mp3", "wav", "m4a", "aac", "ogg"].includes(ext)) return "audio";
  return "asset";
}

async function loadSource(src) {
  const text = String(src || "").trim();
  if (!text) throw new Error("--src is required");
  if (/^https?:\/\//i.test(text)) {
    const res = await mustFetch()(text, { headers: { "user-agent": "pptx-native-asset-import/1.0" } });
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      mime: (res.headers.get("content-type") || "").split(";")[0].toLowerCase(),
      sourceUrl: text,
      basename: path.basename(new URL(text).pathname) || "asset",
    };
  }
  const localPath = path.resolve(text.startsWith("file://") ? new URL(text).pathname : text);
  const bytes = fs.readFileSync(localPath);
  return {
    bytes,
    mime: "",
    sourceUrl: pathToFileURL(localPath).href,
    basename: path.basename(localPath),
  };
}

function snippetFor(asset) {
  const fileUrl = pathToFileURL(asset.localPath).href;
  if (asset.kind === "image") {
    return {
      html: `<img class="ppt-picture" src="${fileUrl}" style="position:absolute;left:80px;top:80px;width:420px;height:280px">`,
      scene: { type: "image", src: fileUrl, x: 80, y: 80, w: 420, h: 280 },
    };
  }
  if (asset.kind === "video") {
    return {
      html: `<video class="ppt-media" src="${fileUrl}" style="position:absolute;left:120px;top:90px;width:720px;height:405px"></video>`,
      scene: { type: "media", mediaType: "video", src: fileUrl, x: 120, y: 90, w: 720, h: 405 },
    };
  }
  if (asset.kind === "audio") {
    return {
      html: `<div class="ppt-media" data-media-type="audio" data-src="${fileUrl}" style="position:absolute;left:80px;top:540px;width:80px;height:80px"></div>`,
      scene: { type: "media", mediaType: "audio", src: fileUrl, x: 80, y: 540, w: 80, h: 80 },
    };
  }
  return { html: "", scene: {} };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const loaded = await loadSource(args.src);
  const ext = extensionFor(loaded.basename, loaded.mime);
  const kind = kindFromMime(loaded.mime, ext, args.type);
  const outDir = path.resolve(args.out || path.join("outputs", "assets", safeSlug(args.name || loaded.basename)));
  fs.mkdirSync(outDir, { recursive: true });
  const base = safeSlug(args.name || loaded.basename.replace(/\.[A-Za-z0-9]{2,5}$/g, ""), "asset");
  const localPath = path.join(outDir, `${base}.${ext}`);
  fs.writeFileSync(localPath, loaded.bytes);
  const asset = {
    title: args.name || loaded.basename,
    kind,
    mime: loaded.mime,
    sourceUrl: loaded.sourceUrl,
    pageUrl: args.pageUrl || "",
    license: args.license || "",
    licenseUrl: args.licenseUrl || "",
    credit: args.credit || "",
    localPath,
    sha256: crypto.createHash("sha256").update(loaded.bytes).digest("hex"),
    downloadedBytes: loaded.bytes.length,
  };
  const ledgerPath = path.join(outDir, "assets.json");
  let ledger = { source: "manual import", generatedAt: new Date().toISOString(), assets: [] };
  if (fs.existsSync(ledgerPath)) {
    try { ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8")); }
    catch { /* rewrite malformed ledger below */ }
  }
  ledger.generatedAt = new Date().toISOString();
  ledger.assets = [...(Array.isArray(ledger.assets) ? ledger.assets : []), asset];
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
  console.log(JSON.stringify({ ok: true, out: outDir, asset, snippets: snippetFor(asset) }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
