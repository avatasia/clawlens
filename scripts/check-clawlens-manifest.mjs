#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const pluginDir = path.join(repoRoot, "extensions", "clawlens");
const packageJsonPath = path.join(pluginDir, "package.json");
const pluginManifestPath = path.join(pluginDir, "openclaw.plugin.json");

const errors = [];
const warnings = [];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`Invalid JSON: ${path.relative(repoRoot, file)} (${String(err)})`);
    return null;
  }
}

function checkPluginManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    errors.push("openclaw.plugin.json must be a JSON object");
    return;
  }
  if (typeof manifest.id !== "string" || manifest.id.trim() === "") {
    errors.push("openclaw.plugin.json: `id` must be a non-empty string");
  }
  if (!("configSchema" in manifest) || typeof manifest.configSchema !== "object" || manifest.configSchema === null) {
    errors.push("openclaw.plugin.json: `configSchema` must exist and be an object");
  }
}

function checkPackageJson(pkg) {
  if (!pkg || typeof pkg !== "object") {
    errors.push("package.json must be a JSON object");
    return;
  }
  if (typeof pkg.name !== "string" || pkg.name.trim() === "") {
    errors.push("package.json: `name` must be a non-empty string");
  }
  if (!pkg.openclaw || typeof pkg.openclaw !== "object") {
    errors.push("package.json: missing `openclaw` object");
    return;
  }
  const openclaw = pkg.openclaw;
  if (!Array.isArray(openclaw.extensions) || openclaw.extensions.length === 0) {
    errors.push("package.json: `openclaw.extensions` must be a non-empty array");
  } else {
    for (const extensionEntry of openclaw.extensions) {
      if (typeof extensionEntry !== "string" || extensionEntry.trim() === "") {
        errors.push("package.json: each `openclaw.extensions` entry must be a non-empty string");
        continue;
      }
      const entryPath = path.resolve(pluginDir, extensionEntry);
      if (!fs.existsSync(entryPath)) {
        errors.push(`package.json: extension entry does not exist: ${extensionEntry}`);
      }
    }
  }

  if (!openclaw.install || typeof openclaw.install !== "object") {
    errors.push("package.json: missing `openclaw.install` object");
  } else {
    if (typeof openclaw.install.minHostVersion !== "string" || openclaw.install.minHostVersion.trim() === "") {
      errors.push("package.json: `openclaw.install.minHostVersion` must be a non-empty string");
    }
    if (typeof openclaw.install.npmSpec !== "string" || openclaw.install.npmSpec.trim() === "") {
      errors.push("package.json: `openclaw.install.npmSpec` must be a non-empty string");
    }
  }
}

function checkSdkImportStyle() {
  const entryFile = path.join(pluginDir, "index.ts");
  if (!fs.existsSync(entryFile)) {
    errors.push("extensions/clawlens/index.ts not found");
    return;
  }
  const content = fs.readFileSync(entryFile, "utf8");
  if (!content.includes("openclaw/plugin-sdk/")) {
    warnings.push("index.ts does not appear to import from `openclaw/plugin-sdk/<subpath>`");
  }
}

function main() {
  if (!fs.existsSync(pluginDir)) {
    console.error("Plugin directory not found: extensions/clawlens");
    process.exit(1);
  }
  if (!fs.existsSync(packageJsonPath)) {
    console.error("Missing file: extensions/clawlens/package.json");
    process.exit(1);
  }
  if (!fs.existsSync(pluginManifestPath)) {
    console.error("Missing file: extensions/clawlens/openclaw.plugin.json");
    process.exit(1);
  }

  const pkg = readJson(packageJsonPath);
  const manifest = readJson(pluginManifestPath);

  checkPackageJson(pkg);
  checkPluginManifest(manifest);
  checkSdkImportStyle();

  if (warnings.length > 0) {
    console.warn("Clawlens manifest checks warnings:");
    for (const warning of warnings) console.warn(`- ${warning}`);
  }

  if (errors.length > 0) {
    console.error("Clawlens manifest checks failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  console.log("Clawlens manifest checks passed.");
}

main();
