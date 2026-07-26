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
  const args = { type: "image", limit: 8, out: null, download: false, source: "auto" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--query" || arg === "-q") args.query = argv[++i];
    else if (arg === "--type") args.type = argv[++i];
    else if (arg === "--limit") args.limit = Number(argv[++i]);
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--download") args.download = true;
    else if (arg === "--source") args.source = argv[++i];
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

// Openverse (openverse.org): CC/PD images+audio aggregated from many hosts.
// No API key for anonymous use. Better "stock photo" hit rate than Commons
// for modern/commercial-looking subjects, same provenance discipline.
async function searchOpenverse(query, type, limit) {
  if (!["image", "audio", "any"].includes(type)) return [];
  const fetchFn = mustFetch();
  const kinds = type === "any" ? ["images", "audio"] : type === "image" ? ["images"] : ["audio"];
  const results = [];
  for (const kind of kinds) {
    const url = new URL(`https://api.openverse.org/v1/${kind}/`);
    url.searchParams.set("q", query);
    url.searchParams.set("page_size", String(Math.min(20, Math.max(limit, 1))));
    url.searchParams.set("license_type", "all-cc,commercial");
    const res = await fetchFn(url, { headers: { "user-agent": "pptx-native-asset-search/1.0" } });
    if (!res.ok) continue; // soft-fail: other sources still answer
    const json = await res.json();
    for (const item of json.results || []) {
      results.push({
        title: item.title || "",
        mime: item.filetype ? `${kind === "audio" ? "audio" : "image"}/${item.filetype}` : "",
        bytes: item.filesize || null,
        width: item.width || null,
        height: item.height || null,
        url: item.url || "",
        pageUrl: item.foreign_landing_url || "",
        license: item.license ? `CC ${String(item.license).toUpperCase()} ${item.license_version || ""}`.trim() : "",
        licenseUrl: item.license_url || "",
        artist: item.creator || "",
        credit: item.source || item.provider || "",
        description: item.title || "",
        source: `Openverse (${item.provider || "unknown"})`,
      });
      if (results.length >= limit) break;
    }
  }
  return results.slice(0, limit);
}

// Pexels: high-quality stock photos/videos. Only used when PEXELS_API_KEY is
// set (free key from pexels.com/api); silently absent otherwise.
async function searchPexels(query, type, limit) {
  const key = process.env.PEXELS_API_KEY;
  if (!key || !["image", "video", "any"].includes(type)) return [];
  const fetchFn = mustFetch();
  const results = [];
  const wantImage = type === "image" || type === "any";
  const wantVideo = type === "video" || type === "any";
  if (wantImage) {
    const url = new URL("https://api.pexels.com/v1/search");
    url.searchParams.set("query", query);
    url.searchParams.set("per_page", String(Math.min(20, limit)));
    const res = await fetchFn(url, { headers: { Authorization: key } });
    if (res.ok) {
      const json = await res.json();
      for (const p of json.photos || []) {
        results.push({
          title: p.alt || "", mime: "image/jpeg", bytes: null,
          width: p.width || null, height: p.height || null,
          url: p.src?.large2x || p.src?.original || "", pageUrl: p.url || "",
          license: "Pexels License", licenseUrl: "https://www.pexels.com/license/",
          artist: p.photographer || "", credit: "Pexels",
          description: p.alt || "", source: "Pexels",
        });
      }
    }
  }
  if (wantVideo) {
    const url = new URL("https://api.pexels.com/videos/search");
    url.searchParams.set("query", query);
    url.searchParams.set("per_page", String(Math.min(10, limit)));
    const res = await fetchFn(url, { headers: { Authorization: key } });
    if (res.ok) {
      const json = await res.json();
      for (const v of json.videos || []) {
        const file = (v.video_files || []).sort((a, b) => (b.width || 0) - (a.width || 0))[0];
        if (!file) continue;
        results.push({
          title: `pexels-video-${v.id}`, mime: file.file_type || "video/mp4", bytes: null,
          width: file.width || null, height: file.height || null,
          url: file.link || "", pageUrl: v.url || "",
          license: "Pexels License", licenseUrl: "https://www.pexels.com/license/",
          artist: v.user?.name || "", credit: "Pexels",
          description: "", source: "Pexels",
        });
      }
    }
  }
  return results.slice(0, limit);
}

// Query the chosen source(s). "auto" = every available source in parallel,
// interleaved so the caller sees a diverse pool (Pexels joins only when
// PEXELS_API_KEY is set).
async function searchAll(source, query, type, limit) {
  const run = (name) => {
    if (name === "commons") return searchCommons(query, type, limit).catch(() => []);
    if (name === "openverse") return searchOpenverse(query, type, limit).catch(() => []);
    if (name === "pexels") return searchPexels(query, type, limit).catch(() => []);
    throw new Error(`Unknown --source: ${name} (use commons|openverse|pexels|auto)`);
  };
  if (source !== "auto") return run(source);
  const pools = await Promise.all([run("pexels"), run("openverse"), run("commons")]);
  const merged = [];
  for (let i = 0; merged.length < limit; i += 1) {
    let advanced = false;
    for (const pool of pools) {
      if (i < pool.length && merged.length < limit) {
        merged.push(pool[i]);
        advanced = true;
      }
    }
    if (!advanced) break;
  }
  return merged;
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
  const results = await searchAll(String(args.source || "auto"), args.query, type, limit);
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
