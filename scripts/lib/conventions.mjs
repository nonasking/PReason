import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

export const MARKER_START = "<!-- review-gate:conventions:start -->";
export const MARKER_END = "<!-- review-gate:conventions:end -->";
export const GENERATED_NOTICE =
  "Generated from review-conventions.yml by scripts/sync-conventions.mjs — do not edit by hand.";

export function repoRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
}

export function loadConventions(root = repoRoot()) {
  const file = path.join(root, "review-conventions.yml");
  const doc = yaml.load(fs.readFileSync(file, "utf8"));
  if (!doc || doc.version !== 1) {
    throw new Error(`Unsupported or missing "version" in ${file} (expected 1)`);
  }
  doc.severity ??= {};
  doc.severity.tags ??= ["blocker", "warn", "nit"];
  doc.severity.default ??= "warn";
  doc.severity.block_on ??= ["blocker"];
  doc.ai_reviewers ??= [];
  doc.reviewers ??= {};
  doc.reviewers.pool ??= [];
  doc.reviewers.count ??= 1;
  doc.risk_paths ??= [];
  doc.risk_reviewers ??= [];
  doc.rules ??= { global: [], scoped: [] };
  doc.rules.global ??= [];
  doc.rules.scoped ??= [];
  return doc;
}

// --- login matching -------------------------------------------------------

export function normalizeLogin(login) {
  return String(login || "").toLowerCase().replace(/\[bot\]$/, "");
}

export function isAiReviewer(login, conventions) {
  const norm = normalizeLogin(login);
  return conventions.ai_reviewers.some((l) => normalizeLogin(l) === norm);
}

// --- severity parsing -----------------------------------------------------

// A tag counts only when it is the first token of the comment, per the
// convention. Accepts "[blocker]", "**[blocker]**", "blocker:" variants.
export function parseSeverity(body, conventions) {
  const tags = conventions.severity.tags.join("|");
  const re = new RegExp(`^\\s*(?:\\*\\*)?\\[?(${tags})\\]?(?:\\*\\*)?\\s*[:\\-\\]]?`, "i");
  const m = String(body || "").match(re);
  return m ? m[1].toLowerCase() : conventions.severity.default;
}

export function isBlocking(severity, conventions) {
  return conventions.severity.block_on.map((s) => s.toLowerCase()).includes(severity);
}

// --- glob matching (supports **, *, ?) ------------------------------------

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" matches zero or more path segments; bare "**" matches anything
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\.[]{}()+^$|".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(filePath, globs) {
  return globs.some((g) => globToRegExp(g).test(filePath));
}

// --- rendering ------------------------------------------------------------

function renderRules(rules) {
  return rules.map((r) => `- ${r.replace(/\s+/g, " ").trim()}`).join("\n");
}

export function renderConventionsMarkdown(conventions) {
  const lines = [];
  lines.push("## Code review conventions");
  lines.push("");
  lines.push(
    `Severity contract: every review comment starts with one of ` +
      conventions.severity.tags.map((t) => `\`[${t}]\``).join(", ") +
      `. Untagged comments are treated as \`[${conventions.severity.default}]\`. ` +
      `Unresolved ${conventions.severity.block_on.map((t) => `\`[${t}]\``).join("/")} ` +
      `comments block the merge gate.`
  );
  lines.push("");
  lines.push("### All files");
  lines.push("");
  lines.push(renderRules(conventions.rules.global));
  for (const scope of conventions.rules.scoped) {
    lines.push("");
    lines.push(`### ${scope.name} (\`${scope.applyTo}\`)`);
    lines.push("");
    lines.push(renderRules(scope.rules));
  }
  lines.push("");
  return lines.join("\n");
}

// The exact prompt block given to AI reviewers (Claude workflow reads this).
export function renderReviewPrompt(conventions) {
  return [
    "You are reviewing a pull request. Follow these conventions exactly.",
    "",
    renderConventionsMarkdown(conventions),
  ].join("\n");
}

// --- generated file builders ----------------------------------------------

export function buildMarkedBlock(conventions) {
  return [
    MARKER_START,
    `<!-- ${GENERATED_NOTICE} -->`,
    "",
    renderConventionsMarkdown(conventions),
    MARKER_END,
  ].join("\n");
}

// Replace (or append) the marked block inside an existing file's content.
export function spliceMarkedBlock(existing, block) {
  const start = existing.indexOf(MARKER_START);
  const end = existing.indexOf(MARKER_END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + MARKER_END.length);
  }
  const sep = existing.length && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
  return existing + sep + block + "\n";
}

export function buildCopilotScopedFile(scope, conventions) {
  return [
    "---",
    `applyTo: "${scope.applyTo}"`,
    "---",
    "",
    `<!-- ${GENERATED_NOTICE} -->`,
    "",
    `# Review conventions: ${scope.name}`,
    "",
    `Severity tags (${conventions.severity.tags.map((t) => `[${t}]`).join(", ")}) are mandatory as the first token of every review comment.`,
    "",
    renderRules(scope.rules),
    "",
  ].join("\n");
}

export function buildCodeRabbitConfig(conventions) {
  const pathInstructions = [
    {
      path: "**",
      instructions: conventions.rules.global.join("\n"),
    },
    ...conventions.rules.scoped.map((scope) => ({
      path: scope.applyTo,
      instructions: scope.rules.join("\n"),
    })),
  ];
  const config = {
    reviews: {
      path_instructions: pathInstructions,
    },
  };
  return `# ${GENERATED_NOTICE}\n` + yaml.dump(config, { lineWidth: 100 });
}
