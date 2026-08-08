import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export const MARKER_START = "<!-- preason:conventions:start -->";
export const MARKER_END = "<!-- preason:conventions:end -->";
export const GENERATED_NOTICE =
  "Generated from review-conventions.yml by scripts/sync-conventions.mjs — do not edit by hand.";

export function repoRoot() {
  // fileURLToPath, not URL.pathname: the latter percent-encodes spaces and
  // breaks on Windows drive letters, so a clone under "~/My Projects" fails.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
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
  doc.gate ??= {};
  doc.gate.require_ai_review ??= true;
  doc.gate.recheck_label ??= "recheck-gate";
  doc.gate.fork_policy ??= "skip";
  doc.gate.hotfix_label ??= "hotfix";
  doc.gate.hotfix_allowed ??= [];
  doc.verification ??= {};
  doc.verification.enabled ??= false;
  doc.verification.model ??= "claude-opus-5";
  doc.verification.votes ??= 1;
  doc.size ??= {};
  doc.size.max_changed_lines ??= 0;
  doc.size.max_changed_files ??= 0;
  doc.size.action ??= "warn";
  doc.size.label ??= "oversized-pr";
  doc.size.exclude ??= [];
  doc.review ??= {};
  doc.review.max_comments ??= 0;
  doc.review.require_evidence ??= false;
  doc.review.allow_no_findings ??= true;
  doc.review.blocker_requires_fix ??= false;
  doc.review.suppress ??= [];
  doc.ai_reviewers ??= [];
  doc.advisory_reviewers ??= [];
  doc.reviewers ??= {};
  doc.reviewers.pool ??= [];
  doc.reviewers.count ??= 1;
  doc.reviewers.risk_count ??= doc.reviewers.count;
  doc.reviewers.strategy ??= "expertise";
  doc.reviewers.criteria ??= {};
  doc.reviewers.criteria.rank ??= ["load", "expertise"];
  doc.reviewers.criteria.availability ??= true;
  doc.reviewers.criteria.expertise_files ??= 10;
  doc.reviewers.criteria.expertise_commits ??= 30;
  doc.sync ??= {};
  doc.sync.targets ??= ["claude", "agents", "copilot", "coderabbit"];
  doc.risk_paths ??= [];
  doc.risk_reviewers ??= [];
  doc.exempt_paths ??= [];
  doc.rules ??= { global: [], scoped: [] };
  doc.rules.global ??= [];
  doc.rules.scoped ??= [];
  validateConventions(doc, file);
  return doc;
}

// Collects every problem at once so a customization round-trip is one edit,
// not an error-by-error whack-a-mole. Runs on every load (sync, gate, assign).
export function validateConventions(doc, file = "review-conventions.yml") {
  const errors = [];
  const isStr = (v) => typeof v === "string" && v.trim().length > 0;
  const strArray = (v, name) => {
    if (!Array.isArray(v) || v.some((x) => !isStr(x))) {
      errors.push(`${name} must be a list of non-empty strings`);
      return false;
    }
    return true;
  };

  if (strArray(doc.severity.tags, "severity.tags")) {
    if (doc.severity.tags.length === 0) errors.push("severity.tags must not be empty");
    const lower = doc.severity.tags.map((t) => t.toLowerCase());
    if (new Set(lower).size !== lower.length) errors.push("severity.tags contains duplicates");
    for (const t of doc.severity.tags) {
      if (!/^[a-z0-9_-]+$/i.test(t)) {
        errors.push(`severity tag "${t}" may only contain letters, digits, "_" and "-"`);
      }
    }
    if (!lower.includes(String(doc.severity.default).toLowerCase())) {
      errors.push(`severity.default "${doc.severity.default}" is not one of severity.tags`);
    }
    if (strArray(doc.severity.block_on, "severity.block_on")) {
      for (const t of doc.severity.block_on) {
        if (!lower.includes(t.toLowerCase())) {
          errors.push(`severity.block_on entry "${t}" is not one of severity.tags`);
        }
      }
    }
  }

  if (typeof doc.gate.require_ai_review !== "boolean") {
    errors.push("gate.require_ai_review must be true or false");
  }
  if (!isStr(doc.gate.recheck_label)) {
    errors.push("gate.recheck_label must be a non-empty string");
  }
  if (!["skip", "block"].includes(doc.gate.fork_policy)) {
    errors.push('gate.fork_policy must be "skip" or "block"');
  }
  if (doc.gate.hotfix_label !== null && !isStr(doc.gate.hotfix_label)) {
    errors.push("gate.hotfix_label must be a non-empty string, or null to disable the bypass");
  }
  strArray(doc.gate.hotfix_allowed, "gate.hotfix_allowed");

  if (typeof doc.verification.enabled !== "boolean") {
    errors.push("verification.enabled must be true or false");
  }
  if (!isStr(doc.verification.model)) {
    errors.push("verification.model must be a non-empty model id");
  }
  if (!Number.isInteger(doc.verification.votes) || doc.verification.votes < 1) {
    errors.push("verification.votes must be an integer ≥ 1");
  }

  for (const key of ["max_changed_lines", "max_changed_files"]) {
    if (!Number.isInteger(doc.size[key]) || doc.size[key] < 0) {
      errors.push(`size.${key} must be an integer ≥ 0 (0 disables the check)`);
    }
  }
  if (!["warn", "block"].includes(doc.size.action)) {
    errors.push('size.action must be "warn" or "block"');
  }
  if (!isStr(doc.size.label)) errors.push("size.label must be a non-empty string");
  strArray(doc.size.exclude, "size.exclude");

  if (!Number.isInteger(doc.review.max_comments) || doc.review.max_comments < 0) {
    errors.push("review.max_comments must be an integer ≥ 0 (0 means no stated budget)");
  }
  for (const key of ["require_evidence", "allow_no_findings", "blocker_requires_fix"]) {
    if (typeof doc.review[key] !== "boolean") errors.push(`review.${key} must be true or false`);
  }
  strArray(doc.review.suppress, "review.suppress");

  strArray(doc.ai_reviewers, "ai_reviewers");
  strArray(doc.advisory_reviewers, "advisory_reviewers");
  const gatedSet = new Set(doc.ai_reviewers.map((l) => normalizeLogin(l)));
  for (const l of doc.advisory_reviewers) {
    if (gatedSet.has(normalizeLogin(l))) {
      errors.push(`"${l}" is in both ai_reviewers and advisory_reviewers — pick one`);
    }
  }
  if (!["expertise", "rotation"].includes(doc.reviewers.strategy)) {
    errors.push('reviewers.strategy must be "expertise" or "rotation"');
  }
  const crit = doc.reviewers.criteria;
  const RANK_KEYS = ["load", "expertise"];
  if (
    !Array.isArray(crit.rank) ||
    crit.rank.length === 0 ||
    crit.rank.some((k) => !RANK_KEYS.includes(k)) ||
    new Set(crit.rank).size !== crit.rank.length
  ) {
    errors.push(
      `reviewers.criteria.rank must be a non-empty, duplicate-free list drawn from: ${RANK_KEYS.join(", ")}`
    );
  }
  if (typeof crit.availability !== "boolean") {
    errors.push("reviewers.criteria.availability must be true or false");
  }
  for (const key of ["expertise_files", "expertise_commits"]) {
    if (!Number.isInteger(crit[key]) || crit[key] < 1 || crit[key] > 100) {
      errors.push(`reviewers.criteria.${key} must be an integer between 1 and 100`);
    }
  }
  const SYNC_TARGETS = ["claude", "agents", "copilot", "coderabbit"];
  if (
    !Array.isArray(doc.sync.targets) ||
    doc.sync.targets.some((t) => !SYNC_TARGETS.includes(t)) ||
    new Set(doc.sync.targets).size !== doc.sync.targets.length
  ) {
    errors.push(
      `sync.targets must be a duplicate-free list drawn from: ${SYNC_TARGETS.join(", ")} (empty disables sync)`
    );
  }
  strArray(doc.reviewers.pool, "reviewers.pool");
  strArray(doc.risk_reviewers, "risk_reviewers");
  strArray(doc.risk_paths, "risk_paths");
  strArray(doc.exempt_paths, "exempt_paths");
  for (const key of ["count", "risk_count"]) {
    const v = doc.reviewers[key];
    if (!Number.isInteger(v) || v < 0) {
      errors.push(`reviewers.${key} must be an integer ≥ 0 (0 disables assignment)`);
    }
  }
  if (doc.reviewers.risk_label != null && !isStr(doc.reviewers.risk_label)) {
    errors.push("reviewers.risk_label must be a non-empty string (or omitted)");
  }

  strArray(doc.rules.global, "rules.global");
  if (!Array.isArray(doc.rules.scoped)) {
    errors.push("rules.scoped must be a list");
  } else {
    const names = new Set();
    doc.rules.scoped.forEach((scope, i) => {
      const at = `rules.scoped[${i}]`;
      if (!isStr(scope?.name)) errors.push(`${at}.name is required`);
      else if (!/^[a-z0-9_-]+$/i.test(scope.name)) {
        errors.push(`${at}.name "${scope.name}" must be filename-safe (letters, digits, "_", "-")`);
      } else if (names.has(scope.name.toLowerCase())) {
        errors.push(`${at}.name "${scope.name}" is duplicated`);
      } else {
        names.add(scope.name.toLowerCase());
      }
      if (!isStr(scope?.applyTo)) errors.push(`${at}.applyTo (glob) is required`);
      strArray(scope?.rules ?? null, `${at}.rules`);
    });
  }

  if (errors.length) {
    throw new Error(
      `Invalid ${file}:\n` + errors.map((e) => `  - ${e}`).join("\n")
    );
  }
}

// --- login matching -------------------------------------------------------

export function normalizeLogin(login) {
  return String(login || "").toLowerCase().replace(/\[bot\]$/, "");
}

// Any AI reviewer, gated or advisory — used to tell "a review happened" from
// "nobody reviewed", and to keep bots out of the human reviewer count.
export function isAiReviewer(login, conventions) {
  const norm = normalizeLogin(login);
  return (
    conventions.ai_reviewers.some((l) => normalizeLogin(l) === norm) ||
    conventions.advisory_reviewers.some((l) => normalizeLogin(l) === norm)
  );
}

// Advisory reviewers are reported but can never block, whatever they tag their
// comments with. See advisory_reviewers in review-conventions.yml.
export function isAdvisoryReviewer(login, conventions) {
  const norm = normalizeLogin(login);
  return conventions.advisory_reviewers.some((l) => normalizeLogin(l) === norm);
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

// --- finding fingerprints -------------------------------------------------

// AI reviewers re-post findings the author already declined: every re-run on a
// new push re-raises the same comment as a fresh, unresolved thread. Without
// this, a rebutted [blocker] resurrects and re-blocks the merge on every push.
// The fingerprint deliberately excludes the line number (it shifts on rebase)
// and the severity tag, and keeps only a normalized prefix of the prose — an
// exact or near-exact re-post collides, a genuinely reworded finding does not.
export function findingFingerprint(path, body, conventions) {
  const tags = conventions.severity.tags.join("|");
  const normalized = String(body || "")
    .replace(new RegExp(`^\\s*(?:\\*\\*)?\\[?(?:${tags})\\]?(?:\\*\\*)?\\s*[:\\-\\]]?`, "i"), "")
    .replace(/```[\s\S]*?```/g, " ")      // drop suggestion blocks
    .replace(/`[^`]*`/g, " ")             // drop inline code
    .replace(/[^\p{L}\p{N}\s]/gu, " ")    // drop punctuation
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 200);
  return `${path || ""}::${normalized}`;
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
  const { review } = conventions;
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

  const discipline = [];
  if (review.max_comments > 0) {
    discipline.push(
      `Leave at most ${review.max_comments} comments on a pull request. If more than ` +
        `that seem warranted, report only the ${review.max_comments} most consequential. ` +
        `A reviewer that comments on everything gets ignored on everything.`
    );
  }
  if (review.allow_no_findings) {
    discipline.push(
      "Finding nothing is a correct and expected outcome. Do not manufacture a " +
        "finding to demonstrate that you reviewed the code; say you found nothing."
    );
  }
  if (review.require_evidence) {
    discipline.push(
      "Every comment must point at a specific line that this diff changed, and quote " +
        "the offending code. If you cannot quote the line, drop the finding."
    );
  }
  if (review.blocker_requires_fix) {
    const blockTags = conventions.severity.block_on.map((t) => `[${t}]`).join("/");
    discipline.push(
      `A ${blockTags} comment must include a concrete fix — a code suggestion where one ` +
        `applies. A finding that only describes a problem is far less likely to be acted ` +
        `on; if you cannot propose a fix, say what you would need to know to propose one.`
    );
  }

  if (discipline.length) {
    lines.push("");
    lines.push("### How much to say");
    lines.push("");
    lines.push(renderRules(discipline));
  }

  if (review.suppress.length) {
    lines.push("");
    lines.push("### Do not flag");
    lines.push("");
    lines.push(renderRules(review.suppress));
  }

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
