#!/usr/bin/env node
// Compiles review-conventions.yml into every tool-specific config file.
//
//   node scripts/sync-conventions.mjs          # write the generated files
//   node scripts/sync-conventions.mjs --check  # exit 1 if any file is out of date (CI)

import fs from "node:fs";
import path from "node:path";
import {
  GENERATED_NOTICE,
  repoRoot,
  loadConventions,
  buildMarkedBlock,
  spliceMarkedBlock,
  buildCopilotScopedFile,
  buildCodeRabbitConfig,
} from "./lib/conventions.mjs";

const root = repoRoot();
const checkOnly = process.argv.includes("--check");
const conventions = loadConventions(root);
const block = buildMarkedBlock(conventions);
const enabled = new Set(conventions.sync.targets);

/** @type {{file: string, content: string}[]} */
const targets = [];

// Marked-block targets: a managed region inside a file the user may also edit —
// only the region between the markers is generated. AGENTS.md is the
// cross-tool convention file most non-Claude AI reviewers and agents read.
const splicedTargets = [
  ["claude", "CLAUDE.md"],
  ["agents", "AGENTS.md"],
  ["copilot", ".github/copilot-instructions.md"],
];
for (const [target, rel] of splicedTargets) {
  if (!enabled.has(target)) continue;
  const abs = path.join(root, rel);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  targets.push({ file: rel, content: spliceMarkedBlock(existing, block) });
}

// Copilot path-scoped instruction files: fully generated, one per scope.
const instructionsDir = ".github/instructions";
const expectedScoped = new Set();
if (enabled.has("copilot")) {
  for (const scope of conventions.rules.scoped) {
    const rel = path.join(instructionsDir, `${scope.name}.review.instructions.md`);
    expectedScoped.add(rel);
    targets.push({ file: rel, content: buildCopilotScopedFile(scope, conventions) });
  }
}

// CodeRabbit config: fully generated.
if (enabled.has("coderabbit")) {
  targets.push({ file: ".coderabbit.yaml", content: buildCodeRabbitConfig(conventions) });
}

// Stale generated files count as drift too: scoped files whose scope was
// renamed/removed (or whose target was disabled), and a fully-generated
// .coderabbit.yaml left behind after its target was disabled. Marked-block
// files of a disabled target are left alone — they may carry user content.
const staleScoped = (fs.existsSync(path.join(root, instructionsDir))
  ? fs.readdirSync(path.join(root, instructionsDir))
  : []
)
  .filter((f) => f.endsWith(".review.instructions.md"))
  .map((f) => path.join(instructionsDir, f))
  .filter((rel) => !expectedScoped.has(rel));

if (!enabled.has("coderabbit")) {
  const abs = path.join(root, ".coderabbit.yaml");
  if (fs.existsSync(abs) && fs.readFileSync(abs, "utf8").includes(GENERATED_NOTICE)) {
    staleScoped.push(".coderabbit.yaml");
  }
}

const drifted = [];
for (const { file, content } of targets) {
  const abs = path.join(root, file);
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
  if (current === content) continue;
  drifted.push(file);
  if (!checkOnly) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}
for (const rel of staleScoped) {
  drifted.push(`${rel} (stale)`);
  if (!checkOnly) fs.rmSync(path.join(root, rel));
}

if (checkOnly) {
  if (drifted.length) {
    console.error("Generated review-convention files are out of date:\n");
    for (const f of drifted) console.error(`  - ${f}`);
    console.error("\nRun `node scripts/sync-conventions.mjs` and commit the result.");
    process.exit(1);
  }
  console.log("Review-convention files are in sync.");
} else if (drifted.length) {
  console.log("Updated:");
  for (const f of drifted) console.log(`  - ${f}`);
} else {
  console.log("Already in sync — nothing to do.");
}
