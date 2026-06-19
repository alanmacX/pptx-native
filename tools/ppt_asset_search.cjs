#!/usr/bin/env node
/**
 * Search and optionally download reusable slide assets with provenance.
 *
 * Default source: Wikimedia Commons. It requires no API key and exposes
 * author/license/source metadata, which keeps generated decks reproducible.
 *
 * Usage:
 *   node tools/ppt_asset_search.cjs --query "solar panel closeup" --type image
 *   node tools/ppt_asset_search.cjs --query "ocean waves" --type video --download --out outputs/assets/waves
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

function parseArgs(argv) {
  const args = { type: "image", limit: 8, out: null, download: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--query" || arg === "-q") args.query = argv[++i];
    else if (arg === "--type") args.type = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--download") args.download = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage:",
    "  node tools/ppt_asset_search.cjs --query <text> [--type image|video|audio|any] [--limit 8]",
    "  node tools/ppt_asset_search.cjs --query <text> --download --out outputs/assets/<name>",
    "",
    "Notes:",
    "  - Downloads are local files plus assets.json provenance.",
    "  - PPTX authoring should embed local/data assets, not hotlink remote URLs.",
  ].join("\n");
}

function mustFetch() {
  if (typeof fetch !== "function") {
    throw new Error("This script requires Node 18+ global fetch.");
  }
  return fetch;
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function metaValue(meta, key) {
  return cleanText(meta?.[key]?.value || "");
}

function mimeMatches(mime, type) {
  const m = String(mime || "").toLowerCase();
  if (!m) return false;
  if (type === "any") return /^(image|video|audio)\//.test(m);
  return m.startsWith(`${type}/`);
}

function extensionFor(url, mime) {
  const cleanUrl = String(url || "").split("?")[0].split("#")[0];
  const ext = path.extname(cleanUrl).replace(".", "").toLowerCase();
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
  };
  return byMime[String(mime || "").toLowerCase()] || "bin";
}

function safeSlug(text, fallback = "asset") {
  const slug = String(text || "")
    .replace(/^File:/i, "")
    .replace(/\.[A-Za-z0-9]{2,5}$/g, "")
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return slug || fallback;
}

async function searchCommons(query, type, limit) {
  const fetchFn = mustFetch();
  const url = new URL(COMMONS_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrsearch", query);
  url.searchParams.set("gsrlimit", String(Math.max(limit * 4, limit)));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|mime|size|extmetadata");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");
  const res = await fetchFn(url, { headers: { "user-agent": "pptx-native-asset-search/1.0" } });
  if (!res.ok) throw new Error(`Commons search failed: HTTP ${res.status}`);
  const json = await res.json();
  const pages = Object.values(json.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0));
  const results = [];
  for (const page of pages) {
    const info = page.imageinfo?.[0] || {};
    if (!mimeMatches(info.mime, type)) continue;
    const meta = info.extmetadata || {};
    results.push({
      title: page.title,
      mime: info.mime || "",
      bytes: info.size || null,
      width: info.width || null,
      height: info.height || null,
      url: info.url || "",
      pageUrl: info.descriptionurl || "",
      license: metaValue(meta, "LicenseShortName"),
      licenseUrl: metaValue(meta, "LicenseUrl"),
      artist: metaValue(meta, "Artist"),
      credit: metaValue(meta, "Credit"),
      description: metaValue(meta, "ImageDescription") || metaValue(meta, "ObjectName"),
      source: "Wikimedia Commons",
    });
    if (results.length >= limit) break;
  }
  return results;
}

async function downloadAssets(results, outDir) {
  const fetchFn = mustFetch();
  fs.mkdirSync(outDir, { recursive: true });
  const downloaded = [];
  for (let i = 0; i < results.length; i += 1) {
    const item = results[i];
    if (!item.url) continue;
    const res = await fetchFn(item.url, { headers: { "user-agent": "pptx-native-asset-search/1.0" } });
    if (!res.ok) {
      downloaded.push({ ...item, downloadError: `HTTP ${res.status}` });
      continue;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const ext = extensionFor(item.url, item.mime);
    const file = `${String(i + 1).padStart(2, "0")}-${safeSlug(item.title, `asset-${i + 1}`)}.${ext}`;
    const localPath = path.join(outDir, file);
    fs.writeFileSync(localPath, bytes);
    downloaded.push({
      ...item,
      localPath,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      downloadedBytes: bytes.length,
    });
  }
  const ledger = {
    source: "Wikimedia Commons",
    generatedAt: new Date().toISOString(),
    assets: downloaded,
  };
  fs.writeFileSync(path.join(outDir, "assets.json"), JSON.stringify(ledger, null, 2));
  return downloaded;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.query) throw new Error("--query is required");
  const type = String(args.type || "image").toLowerCase();
  if (!["image", "video", "audio", "any"].includes(type)) {
    throw new Error("--type must be image, video, audio, or any");
  }
  const limit = Math.max(1, Math.min(30, Number(args.limit) || 8));
  const results = await searchCommons(args.query, type, limit);
  const finalResults = args.download
    ? await downloadAssets(results, path.resolve(args.out || path.join("outputs", "assets", safeSlug(args.query))))
    : results;
  console.log(JSON.stringify({
    ok: true,
    query: args.query,
    type,
    count: finalResults.length,
    out: args.download ? path.resolve(args.out || path.join("outputs", "assets", safeSlug(args.query))) : null,
    results: finalResults,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
