#!/usr/bin/env node
// Compiles review-conventions.yml into every tool-specific config file.
//
//   node scripts/sync-conventions.mjs          # write the generated files
//   node scripts/sync-conventions.mjs --check  # exit 1 if any file is out of date (CI)

import fs from "node:fs";
import path from "node:path";
import {
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

/** @type {{file: string, content: string}[]} */
const targets = [];

// 1–2. CLAUDE.md and copilot-instructions.md: managed block inside a file the
// user may also edit — only the region between the markers is generated.
for (const rel of ["CLAUDE.md", ".github/copilot-instructions.md"]) {
  const abs = path.join(root, rel);
  const existing = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  targets.push({ file: rel, content: spliceMarkedBlock(existing, block) });
}

// 3. Copilot path-scoped instruction files: fully generated, one per scope.
const instructionsDir = ".github/instructions";
const expectedScoped = new Set();
for (const scope of conventions.rules.scoped) {
  const rel = path.join(instructionsDir, `${scope.name}.review.instructions.md`);
  expectedScoped.add(rel);
  targets.push({ file: rel, content: buildCopilotScopedFile(scope, conventions) });
}

// 4. CodeRabbit config: fully generated.
targets.push({ file: ".coderabbit.yaml", content: buildCodeRabbitConfig(conventions) });

// Stale scoped files (scope renamed/removed in the source) count as drift too.
const staleScoped = (fs.existsSync(path.join(root, instructionsDir))
  ? fs.readdirSync(path.join(root, instructionsDir))
  : []
)
  .filter((f) => f.endsWith(".review.instructions.md"))
  .map((f) => path.join(instructionsDir, f))
  .filter((rel) => !expectedScoped.has(rel));

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
