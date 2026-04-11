#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import childProcess from "node:child_process";

const repoRoot = process.cwd();
const docsDir = path.join(repoRoot, "docs");
const historyDir = path.join(docsDir, "archive", "history");
const historyReadme = path.join(historyDir, "README.md");
const topLevelDateRe = /\d{4}-\d{2}-\d{2}/;
const markdownLinkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
const runAll = process.argv.includes("--all");
const strictMode = process.argv.includes("--strict");

const errors = [];
const warnings = [];

function pushError(message) {
  errors.push(message);
}

function pushWarning(message) {
  warnings.push(message);
}

function pushIndexIssue(message) {
  if (strictMode) pushError(message);
  else pushWarning(message);
}

function walk(dir, out = []) {
  const skipDirs = new Set(["node_modules", ".git", "dist", "build"]);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(repoRoot, file);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function checkTopLevelNoDateFile() {
  const entries = fs.readdirSync(docsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (!topLevelDateRe.test(entry.name)) continue;
    pushError(
      `Top-level docs file must not include date in filename: ${path.join("docs", entry.name)}`,
    );
  }
}

function checkHistoryReadmeCoverage() {
  if (!fs.existsSync(historyReadme)) {
    pushError("Missing history index: docs/archive/history/README.md");
    return;
  }
  const content = fs.readFileSync(historyReadme, "utf8");
  const files = fs.readdirSync(historyDir)
    .filter((name) => name.endsWith("_HISTORY.md"));
  for (const file of files) {
    const targetRe = new RegExp(`\\[[^\\]]+\\]\\(${escapeRegExp(file)}\\)`);
    if (!targetRe.test(content)) {
      pushError(`History file is not indexed in docs/archive/history/README.md: ${file}`);
    }
  }
}

function checkSubdirReadmeCoverage() {
  const subdirs = [
    { dir: path.join(docsDir, "plans"), label: "docs/plans" },
    { dir: path.join(docsDir, "research"), label: "docs/research" },
    { dir: path.join(docsDir, "prompts"), label: "docs/prompts" },
  ];
  for (const { dir, label } of subdirs) {
    if (!fs.existsSync(dir)) continue;
    const readme = path.join(dir, "README.md");
    if (!fs.existsSync(readme)) {
      pushError(`Missing index: ${label}/README.md`);
      continue;
    }
    const content = fs.readFileSync(readme, "utf8");
    const files = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".md") && name !== "README.md");
    for (const file of files) {
      const targetRe = new RegExp(`\\[[^\\]]+\\]\\(${escapeRegExp(file)}\\)`);
      if (!targetRe.test(content)) {
        pushError(`File is not indexed in ${label}/README.md: ${file}`);
      }
    }
  }
}

function checkRootReadmeCompleteness() {
  const rootReadme = path.join(repoRoot, "README.md");
  if (!fs.existsSync(rootReadme)) return;
  const content = fs.readFileSync(rootReadme, "utf8");
  const topLevelDocs = fs.readdirSync(docsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name);
  for (const file of topLevelDocs) {
    const linkRe = new RegExp(`\\[[^\\]]+\\]\\(docs/${escapeRegExp(file)}\\)`);
    if (!linkRe.test(content)) {
      pushWarning(`Top-level doc not listed in README.md: docs/${file}`);
    }
  }
}

const validTypePrefixes = new Set([
  "ANALYSIS", "RESEARCH", "IMPLEMENTATION", "PROMPT", "REVIEW",
  "FIX", "CHANGELOG", "POSTMORTEM", "GOVERNANCE", "PLAYBOOK", "HISTORY",
]);

function checkDatedFileNamingConvention() {
  const allDocs = walk(docsDir).filter((f) => f.endsWith(".md"));
  for (const file of allDocs) {
    const name = path.basename(file, ".md");
    if (!topLevelDateRe.test(name)) continue;
    const prefix = name.split("_")[0];
    if (!validTypePrefixes.has(prefix)) {
      pushWarning(`Dated file has non-standard TYPE prefix "${prefix}": ${rel(file)}`);
    }
  }
}

function isSkippableLink(target) {
  return (
    target.startsWith("http://")
    || target.startsWith("https://")
    || target.startsWith("mailto:")
    || target.startsWith("#")
  );
}

function cleanLinkTarget(target) {
  const trimmed = target.trim().replace(/^<|>$/g, "");
  const noAnchor = trimmed.split("#")[0];
  return noAnchor.split("?")[0];
}

function listStagedDocsFiles() {
  try {
    const out = childProcess.execSync(
      "git diff --cached --name-only --diff-filter=ACMR",
      { encoding: "utf8", cwd: repoRoot },
    );
    return out.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((file) => file.startsWith("docs/") && file.endsWith(".md"))
      .map((file) => path.join(repoRoot, file));
  } catch {
    return [];
  }
}

function listTargetDocsFiles() {
  if (runAll) return walk(docsDir).filter((file) => file.endsWith(".md"));
  return listStagedDocsFiles().filter((file) => fs.existsSync(file));
}

function stripFencedCodeBlocks(text) {
  return text.replace(/^```[\s\S]*?^```/gm, "");
}

function stripInlineCode(text) {
  // Strip double backtick spans first, then single
  return text.replace(/``[^`]+``/g, "").replace(/`[^`]+`/g, "");
}

function checkRelativeLinksResolve(files) {
  for (const file of files) {
    const content = stripInlineCode(stripFencedCodeBlocks(fs.readFileSync(file, "utf8")));
    let match;
    while ((match = markdownLinkRe.exec(content)) !== null) {
      const rawTarget = match[2];
      if (isSkippableLink(rawTarget)) continue;
      const target = cleanLinkTarget(rawTarget);
      if (!target) continue;
      if (path.isAbsolute(target)) {
        pushError(`Absolute link path is not allowed in ${rel(file)}: ${rawTarget}`);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), target);
      if (!fs.existsSync(resolved)) {
        pushError(`Broken link in ${rel(file)}: ${rawTarget}`);
      }
    }
  }
}

function checkNoAbsoluteProjectPath(files) {
  const escapedRoot = escapeRegExp(repoRoot);
  const repoRootRe = new RegExp(escapedRoot);
  const obviousAbsRe = /(?:\/home\/[^/\s]+|\/Users\/[^/\s]+|\/root)\/github\/clawlens/;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    if (repoRootRe.test(content) || obviousAbsRe.test(content)) {
      pushError(`Absolute project path found in ${rel(file)}`);
    }
  }
}

function listCodeFilesForIndexChecks() {
  const dirs = ["extensions", "scripts"]
    .map((d) => path.join(repoRoot, d))
    .filter((d) => fs.existsSync(d));
  const files = [];
  for (const dir of dirs) {
    for (const full of walk(dir)) {
      if (!/\.(ts|tsx|js|mjs|cjs)$/.test(full)) continue;
      files.push(full);
    }
  }
  return files;
}

function parseCodeIndexMarkers(codeFiles) {
  const markerRe = /^\s*(?:\/\/|#)\s*(DOC_INDEX|ROLLBACK_INDEX):\s*([A-Z0-9_]{1,60})(?:\s*->\s*(\S+))?\s*$/;
  const markers = [];
  for (const file of codeFiles) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(markerRe);
      if (!m) continue;
      markers.push({
        type: m[1],
        id: m[2],
        target: m[3] ?? "",
        file,
        line: i + 1,
      });
    }
  }
  return markers;
}

function parseDocCodeIndexes(docFiles) {
  const indexes = [];
  const byId = new Map();

  for (const file of docFiles) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let current = null;
    let inFiles = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const head = line.match(/^\s*CODE_INDEX:\s*([A-Z0-9_]{1,60})\s*$/);
      if (head) {
        if (current) indexes.push(current);
        current = { id: head[1], file, line: i + 1, files: [], entryPoints: [] };
        inFiles = false;
        continue;
      }
      if (!current) continue;
      if (/^\s*files:\s*$/.test(line)) {
        inFiles = true;
        continue;
      }
      const list = line.match(/^\s*-\s+(\S+)/);
      if (inFiles && list) {
        current.files.push(list[1]);
        continue;
      }
      const ep = line.match(/^\s*entry_points:\s*(.+)\s*$/);
      if (ep) {
        current.entryPoints = ep[1]
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        inFiles = false;
        continue;
      }
      if (/^\s*$/.test(line) || /^CODE_INDEX:/.test(line) || /^\S/.test(line)) {
        inFiles = false;
      }
    }
    if (current) indexes.push(current);
  }

  for (const item of indexes) {
    const arr = byId.get(item.id) ?? [];
    arr.push(item);
    byId.set(item.id, arr);
  }
  return { indexes, byId };
}

function checkDocCodeBidirectionalIndexes() {
  const codeFiles = listCodeFilesForIndexChecks();
  const docFiles = walk(docsDir).filter((f) => f.endsWith(".md"));
  const codeMarkers = parseCodeIndexMarkers(codeFiles);
  const docIndexes = parseDocCodeIndexes(docFiles);

  for (const marker of codeMarkers) {
    const source = `${rel(marker.file)}:${marker.line}`;
    if (!marker.target) {
      pushIndexIssue(`[INDEX] missing target doc path for ${marker.type}:${marker.id} at ${source}`);
      continue;
    }
    if (path.isAbsolute(marker.target)) {
      pushIndexIssue(`[INDEX] absolute doc path is not allowed for ${marker.type}:${marker.id} at ${source}`);
      continue;
    }
    const docPath = path.resolve(repoRoot, marker.target);
    if (!fs.existsSync(docPath)) {
      pushIndexIssue(`[INDEX] target doc not found for ${marker.type}:${marker.id} at ${source}: ${marker.target}`);
      continue;
    }
    const matches = (docIndexes.byId.get(marker.id) ?? []).filter((entry) => entry.file === docPath);
    if (matches.length === 0) {
      pushIndexIssue(
        `[INDEX] missing CODE_INDEX:${marker.id} in ${rel(docPath)} (referenced by ${source})`,
      );
    }
  }

  // Governance rule: same ID may appear in multiple code files,
  // but all markers for that ID must point to the same target doc.
  const codeIdTargets = new Map();
  for (const marker of codeMarkers) {
    if (!marker.target) continue;
    const arr = codeIdTargets.get(marker.id) ?? [];
    arr.push(marker);
    codeIdTargets.set(marker.id, arr);
  }
  for (const [id, entries] of codeIdTargets) {
    const targets = new Set(entries.map((entry) => entry.target));
    if (targets.size > 1) {
      const detail = entries
        .map((entry) => `${rel(entry.file)}:${entry.line} -> ${entry.target}`)
        .join(", ");
      pushIndexIssue(`[INDEX] ${id} points to different docs: ${detail}`);
    }
  }

  for (const [id, entries] of docIndexes.byId) {
    const docSet = new Set(entries.map((entry) => rel(entry.file)));
    if (docSet.size > 1) {
      pushIndexIssue(`[INDEX] CODE_INDEX id duplicated across docs: ${id} -> ${[...docSet].join(", ")}`);
    }

    const codeMatches = codeMarkers.filter((marker) => marker.id === id);
    if (codeMatches.length === 0) {
      pushIndexIssue(`[INDEX] CODE_INDEX:${id} has no matching DOC_INDEX/ROLLBACK_INDEX in code`);
    }

    for (const entry of entries) {
      const where = `${rel(entry.file)}:${entry.line}`;
      if (!entry.files.length) {
        pushIndexIssue(`[INDEX] CODE_INDEX:${id} missing files list at ${where}`);
      }
      const resolvedFiles = [];
      for (const linked of entry.files) {
        if (path.isAbsolute(linked)) {
          pushIndexIssue(`[INDEX] CODE_INDEX:${id} contains absolute file path at ${where}: ${linked}`);
          continue;
        }
        const resolved = path.resolve(repoRoot, linked);
        if (!fs.existsSync(resolved)) {
          pushIndexIssue(`[INDEX] CODE_INDEX:${id} references missing file at ${where}: ${linked}`);
          continue;
        }
        resolvedFiles.push(resolved);
      }
      if (entry.entryPoints.length > 0) {
        for (const symbol of entry.entryPoints) {
          const found = resolvedFiles.some((filePath) => {
            try {
              const content = fs.readFileSync(filePath, "utf8");
              return content.includes(symbol);
            } catch {
              return false;
            }
          });
          if (!found) {
            pushWarning(
              `[INDEX] CODE_INDEX:${id} entry_points symbol not found: ${symbol} (declared at ${where})`,
            );
          }
        }
      }
    }
  }
}

// ── New automated checks ──────────────────────────────────────────────────

const backtickPathPrefixes = [
  "docs/", "archive/", "plans/", "research/", "prompts/",
  "patches/", "extensions/", "scripts/", "projects-ref/",
];
const backtickPathRe = new RegExp(
  "`(" + backtickPathPrefixes.map(escapeRegExp).join("|") + ")[^`]*\\.\\w+`",
  "g",
);

function checkBacktickPathValidity(files) {
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const content = stripFencedCodeBlocks(raw);
    let match;
    while ((match = backtickPathRe.exec(content)) !== null) {
      const refPath = match[0].slice(1, -1); // strip backticks
      // Skip glob patterns — they aren't literal file references
      if (refPath.includes("*")) continue;
      const resolved = path.resolve(repoRoot, refPath);
      if (!fs.existsSync(resolved)) {
        pushWarning(`Stale backtick path in ${rel(file)}: \`${refPath}\` (file not found)`);
      }
    }
  }
}

function checkLinkTextTargetMismatch(files) {
  const filenameLikeRe = /\.\w{1,5}$/;
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const content = stripFencedCodeBlocks(raw);
    let match;
    while ((match = markdownLinkRe.exec(content)) !== null) {
      const text = match[1];
      const rawTarget = match[2];
      if (isSkippableLink(rawTarget)) continue;
      if (!filenameLikeRe.test(text)) continue;
      const target = cleanLinkTarget(rawTarget);
      if (!target) continue;
      const textBase = path.basename(text);
      const targetBase = path.basename(target);
      if (textBase !== targetBase) {
        pushWarning(
          `Link text/target basename mismatch in ${rel(file)}: text="${text}" target="${target}"`,
        );
      }
    }
  }
}

function main() {
  if (!fs.existsSync(docsDir)) {
    console.error("docs/ not found");
    process.exit(1);
  }

  const targetFiles = listTargetDocsFiles();

  checkTopLevelNoDateFile();
  checkHistoryReadmeCoverage();
  checkSubdirReadmeCoverage();
  checkDocCodeBidirectionalIndexes();

  if (runAll) {
    checkRootReadmeCompleteness();
    checkDatedFileNamingConvention();
  }

  if (targetFiles.length === 0) {
    console.log("No staged docs markdown changes found. Running structural checks only.");
  } else {
    checkRelativeLinksResolve(targetFiles);
    checkNoAbsoluteProjectPath(targetFiles);
    checkBacktickPathValidity(targetFiles);
    checkLinkTextTargetMismatch(targetFiles);
  }

  if (warnings.length > 0) {
    console.error("Docs governance warnings:");
    for (const item of warnings) console.error(`- ${item}`);
  }

  if (errors.length > 0) {
    console.error("Docs governance checks failed:");
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
  }

  console.log(strictMode
    ? "Docs governance checks passed (strict mode)."
    : "Docs governance checks passed.");
}

main();
