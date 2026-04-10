#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

const pluginRoot = path.join(root, "extensions", "clawlens");
const indexFile = path.join(pluginRoot, "index.ts");
const srcDir = path.join(pluginRoot, "src");
const openclawRefRoot = path.join(root, "projects-ref", "openclaw");
const sdkRoot = path.join(openclawRefRoot, "src", "plugin-sdk");

function collectTsFiles(dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

function extractImports(content) {
  const subpaths = [];
  const fromRegex =
    /\b(?:import|export)\s+(?:type\s+)?[\s\S]*?\bfrom\s*["']openclaw\/plugin-sdk\/([^"']+)["']/g;
  const sideEffectRegex = /\bimport\s*["']openclaw\/plugin-sdk\/([^"']+)["']/g;

  let match;
  while ((match = fromRegex.exec(content)) !== null) {
    subpaths.push(match[1]);
  }
  while ((match = sideEffectRegex.exec(content)) !== null) {
    subpaths.push(match[1]);
  }
  return subpaths;
}

if (!fs.existsSync(openclawRefRoot)) {
  console.error(
    `[verify-local-imports] missing reference repo: ${path.relative(root, openclawRefRoot)}`
  );
  process.exit(1);
}

if (!fs.existsSync(indexFile)) {
  console.error(
    `[verify-local-imports] missing plugin entry file: ${path.relative(root, indexFile)}`
  );
  process.exit(1);
}

const sourceFiles = [indexFile, ...collectTsFiles(srcDir)];
const importsToSources = new Map();

for (const file of sourceFiles) {
  const content = fs.readFileSync(file, "utf8");
  const subpaths = extractImports(content);
  for (const subpath of subpaths) {
    if (!importsToSources.has(subpath)) {
      importsToSources.set(subpath, new Set());
    }
    importsToSources.get(subpath).add(path.relative(root, file));
  }
}

if (importsToSources.size === 0) {
  console.log("[verify-local-imports] no openclaw/plugin-sdk/* imports found");
  process.exit(0);
}

let hasFailure = false;
for (const [subpath, sources] of importsToSources.entries()) {
  const normalized = subpath.split("/").join(path.sep);
  const candidates = [
    path.join(sdkRoot, `${normalized}.ts`),
    path.join(sdkRoot, `${normalized}.js`),
    path.join(sdkRoot, normalized, "index.ts"),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  const fromText = Array.from(sources).join(", ");

  if (resolved) {
    console.log(
      `[verify-local-imports] OK openclaw/plugin-sdk/${subpath} -> ${path.relative(root, resolved)} (from ${fromText})`
    );
  } else {
    hasFailure = true;
    console.log(
      `[verify-local-imports] MISSING openclaw/plugin-sdk/${subpath} (from ${fromText})`
    );
  }
}

process.exit(hasFailure ? 1 : 0);
