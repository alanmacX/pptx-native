#!/usr/bin/env node
// Query the native PowerPoint carrier/property matrix before authoring.
// Usage:
//   node tools/ppt_surface_audit.cjs
//   node tools/ppt_surface_audit.cjs --carrier picture
//   node tools/ppt_surface_audit.cjs --property blur
//   node tools/ppt_surface_audit.cjs --check picture blur
//   node tools/ppt_surface_audit.cjs --json --carrier shape
const fs = require("node:fs");
const path = require("node:path");

function usage() {
  return [
    "Usage:",
    "  node tools/ppt_surface_audit.cjs",
    "  node tools/ppt_surface_audit.cjs --carrier picture",
    "  node tools/ppt_surface_audit.cjs --property blur",
    "  node tools/ppt_surface_audit.cjs --check picture blur",
    "  node tools/ppt_surface_audit.cjs --json --carrier shape",
  ].join("\n");
}

function parseArgs(argv) {
  const out = { json: false, carrier: null, property: null, check: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--carrier") out.carrier = argv[++i];
    else if (arg === "--property") out.property = argv[++i];
    else if (arg === "--check") out.check = [argv[++i], argv[++i]];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function loadCapabilities() {
  const file = path.resolve("capabilities.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function normalized(value) {
  return String(value || "").trim();
}

function has(list, value) {
  const target = normalized(value);
  return Array.isArray(list) && list.some((item) => normalized(item) === target);
}

function carrierReport(caps, name) {
  const carrier = caps.surface?.carriers?.[name];
  if (!carrier) return null;
  const matrix = caps.surface?.propertyMatrix || {};
  const properties = Object.entries(matrix)
    .filter(([, entry]) => has(entry.compilesOn, name) || has(entry.gapsOn, name))
    .map(([property, entry]) => ({
      property,
      status: has(entry.compilesOn, name) ? "compiles" : "gap",
      notAnimatable: Boolean(entry.notAnimatable),
    }));
  return { name, ...carrier, propertyStatus: properties };
}

function propertyReport(caps, name) {
  const entry = caps.surface?.propertyMatrix?.[name];
  if (!entry) return null;
  return { property: name, ...entry };
}

function checkReport(caps, carrier, property) {
  const c = carrierReport(caps, carrier);
  const p = propertyReport(caps, property);
  if (!c || !p) return { carrier, property, status: "unknown", ok: false };
  if (has(p.compilesOn, carrier)) {
    return {
      carrier,
      property,
      status: "compiles",
      ok: true,
      note: p.notAnimatable ? "Compiles as a static property; not animatable directly." : undefined,
    };
  }
  if (has(p.gapsOn, carrier)) {
    return { carrier, property, status: "gap", ok: false };
  }
  return { carrier, property, status: "not-listed", ok: false };
}

function textSummary(caps) {
  const carriers = caps.surface?.carriers || {};
  const matrix = caps.surface?.propertyMatrix || {};
  const lines = [];
  lines.push("Native surface carriers:");
  for (const [name, carrier] of Object.entries(carriers)) {
    lines.push(`- ${name}: ${carrier.ooxmlTarget} [${carrier.status}]`);
    lines.push(`  properties: ${(carrier.properties || []).join(", ") || "(none)"}`);
    lines.push(`  effects: ${(carrier.effects || []).join(", ") || "(none)"}`);
    lines.push(`  gaps: ${(carrier.gaps || []).join(", ") || "(none)"}`);
  }
  lines.push("");
  lines.push("Property matrix:");
  for (const [name, entry] of Object.entries(matrix)) {
    lines.push(`- ${name}: compiles on ${(entry.compilesOn || []).join(", ") || "(none)"}; gaps on ${(entry.gapsOn || []).join(", ") || "(none)"}`);
  }
  return lines.join("\n");
}

function print(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (!value) {
    console.error("No matching surface entry.");
    process.exitCode = 2;
    return;
  }
  if (value.name) {
    console.log(`${value.name}: ${value.ooxmlTarget} [${value.status}]`);
    console.log(`properties: ${(value.properties || []).join(", ") || "(none)"}`);
    console.log(`effects: ${(value.effects || []).join(", ") || "(none)"}`);
    console.log(`timing: ${(value.timing || []).join(", ") || "(none)"}`);
    console.log(`gaps: ${(value.gaps || []).join(", ") || "(none)"}`);
    if (value.note) console.log(`note: ${value.note}`);
    if (value.propertyStatus?.length) {
      console.log("matrix:");
      for (const item of value.propertyStatus) {
        console.log(`- ${item.property}: ${item.status}${item.notAnimatable ? " (static only)" : ""}`);
      }
    }
    return;
  }
  if (value.status) {
    console.log(`${value.carrier}.${value.property}: ${value.status}`);
    if (value.note) console.log(`note: ${value.note}`);
    process.exitCode = value.ok ? 0 : 1;
    return;
  }
  if (value.property) {
    console.log(`${value.property}: compiles on ${(value.compilesOn || []).join(", ") || "(none)"}`);
    console.log(`gaps on: ${(value.gapsOn || []).join(", ") || "(none)"}`);
    if (value.notAnimatable) console.log("note: static property only; decompose for progressive animation.");
    return;
  }
  console.log(String(value));
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(2);
  }
  if (args.help) {
    console.log(usage());
    return;
  }
  const caps = loadCapabilities();
  if (!caps.surface?.carriers || !caps.surface?.propertyMatrix) {
    console.error("capabilities.json has no surface carrier matrix.");
    process.exit(2);
  }
  if (args.check) return print(checkReport(caps, args.check[0], args.check[1]), args.json);
  if (args.carrier) return print(carrierReport(caps, args.carrier), args.json);
  if (args.property) return print(propertyReport(caps, args.property), args.json);
  if (args.json) return print(caps.surface, true);
  console.log(textSummary(caps));
}

main();
