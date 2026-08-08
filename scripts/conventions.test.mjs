// Unit tests for the logic the gate and the assigner depend on.
//
//   npm test
//
// These cover the pure functions only — no network. The parts that talk to
// GitHub are exercised by opening a real PR (see docs/design.md § Runtime flow).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadConventions,
  validateConventions,
  parseSeverity,
  isBlocking,
  isAiReviewer,
  normalizeLogin,
  globToRegExp,
  matchesAny,
  findingFingerprint,
  MARKER_START,
  MARKER_END,
  spliceMarkedBlock,
} from "./lib/conventions.mjs";

const base = loadConventions();
const clone = (patch = {}) => {
  const c = structuredClone(base);
  for (const [k, v] of Object.entries(patch)) {
    c[k] = v && typeof v === "object" && !Array.isArray(v) ? { ...c[k], ...v } : v;
  }
  return c;
};

// --- shipped config -------------------------------------------------------

test("the shipped review-conventions.yml is valid", () => {
  assert.equal(base.version, 1);
  assert.ok(base.rules.global.length > 0, "has global rules");
  assert.ok(base.severity.tags.includes(base.severity.default), "default is a known tag");
});

test("gate options default sensibly", () => {
  assert.equal(base.gate.require_ai_review, true, "fails closed by default");
  assert.equal(base.gate.fork_policy, "skip");
  assert.ok(base.gate.recheck_label);
  assert.equal(base.reviewers.risk_count, base.reviewers.count || base.reviewers.risk_count);
});

// --- severity parsing -----------------------------------------------------

test("severity tags parse in the forms reviewers actually emit", () => {
  assert.equal(parseSeverity("[blocker] SQL injection", base), "blocker");
  assert.equal(parseSeverity("**[blocker]** SQL injection", base), "blocker");
  assert.equal(parseSeverity("blocker: floating point money", base), "blocker");
  assert.equal(parseSeverity("  [NIT] naming", base), "nit");
});

test("a tag only counts as the first token", () => {
  // Otherwise a comment merely *discussing* severity would block the merge.
  assert.equal(parseSeverity("this is not a [blocker] but worth noting", base), "warn");
});

test("untagged comments fall back to the configured default", () => {
  assert.equal(parseSeverity("Looks risky to me", base), base.severity.default);
  const failClosed = clone({ severity: { default: "blocker" } });
  assert.equal(parseSeverity("Looks risky to me", failClosed), "blocker");
  assert.ok(isBlocking(parseSeverity("Looks risky", failClosed), failClosed));
});

test("a custom severity vocabulary works end to end", () => {
  const custom = clone({
    severity: { tags: ["critical", "major", "minor"], default: "minor", block_on: ["critical"] },
  });
  validateConventions(custom);
  assert.equal(parseSeverity("[critical] race condition", custom), "critical");
  assert.equal(parseSeverity("no tag here", custom), "minor");
  assert.ok(isBlocking("critical", custom));
  assert.ok(!isBlocking("major", custom));
});

// --- AI reviewer identification -------------------------------------------

test("bot logins match regardless of suffix or case", () => {
  assert.ok(isAiReviewer("Copilot", base));
  assert.ok(isAiReviewer("copilot-pull-request-reviewer[bot]", base));
  assert.ok(isAiReviewer("github-actions[bot]", base));
  assert.equal(normalizeLogin("Claude[bot]"), "claude");
});

test("humans are not treated as AI reviewers", () => {
  assert.ok(!isAiReviewer("alice", base));
  assert.ok(!isAiReviewer("", base));
  assert.ok(!isAiReviewer(undefined, base));
});

// --- glob matching --------------------------------------------------------

test("** spans path segments, * does not", () => {
  assert.ok(matchesAny("app/db/migrations/0001.sql", ["**/migrations/**"]));
  assert.ok(matchesAny("migrations/0001.sql", ["**/migrations/**"]), "zero leading segments");
  assert.ok(!matchesAny("app/models.py", ["**/migrations/**"]));
  assert.ok(globToRegExp("*.md").test("README.md"));
  assert.ok(!globToRegExp("*.md").test("docs/a.md"), "* must not cross a slash");
  assert.ok(globToRegExp("v?.txt").test("v1.txt"));
});

test("risk paths from the shipped config match their intended files", () => {
  for (const f of ["src/payments/charge.js", "src/auth/login.js", "db/migrations/0002.sql"]) {
    assert.ok(matchesAny(f, base.risk_paths), `${f} is a risk path`);
  }
  assert.ok(!matchesAny("src/ui/button.tsx", base.risk_paths));
});

test("the AI-only tier needs the whole diff to be exempt", () => {
  const exempt = ["docs/**", "**/*.md"];
  assert.ok(["docs/a.md", "README.md"].every((f) => matchesAny(f, exempt)));
  assert.ok(!["docs/a.md", "src/x.ts"].every((f) => matchesAny(f, exempt)));
});

// --- finding fingerprints -------------------------------------------------

const FINDING = "Money is a float here; use integer minor units.";

test("a re-posted finding collides with the resolved original", () => {
  const original = findingFingerprint("src/a.js", `[blocker] ${FINDING}`, base);
  assert.equal(findingFingerprint("src/a.js", `**[blocker]** ${FINDING}`, base), original);
  assert.equal(findingFingerprint("src/a.js", `[warn] ${FINDING}`, base), original, "tag change");
  assert.equal(
    findingFingerprint("src/a.js", `[blocker] ${FINDING}\n\`\`\`js\nconst x = 1;\n\`\`\``, base),
    original,
    "an added suggestion block is ignored"
  );
});

test("genuinely different findings do not collide", () => {
  const original = findingFingerprint("src/a.js", `[blocker] ${FINDING}`, base);
  assert.notEqual(findingFingerprint("src/b.js", `[blocker] ${FINDING}`, base), original);
  assert.notEqual(
    findingFingerprint("src/a.js", "[blocker] Missing idempotency key on retry.", base),
    original
  );
});

// --- config validation ----------------------------------------------------

test("validation reports every problem at once", () => {
  const bad = clone();
  bad.severity.default = "nope";
  bad.severity.block_on = ["blocker", "ghost"];
  bad.reviewers.count = -1;
  bad.gate.fork_policy = "ignore";
  bad.rules.scoped.push({ name: "auth", applyTo: "**/auth/**", rules: ["duplicate name"] });

  assert.throws(
    () => validateConventions(bad),
    (err) => {
      for (const needle of [
        "severity.default",
        "ghost",
        "reviewers.count",
        "fork_policy",
        "duplicated",
      ]) {
        assert.ok(err.message.includes(needle), `reports ${needle}`);
      }
      return true;
    }
  );
});

test("scoped rules need a filename-safe unique name and a glob", () => {
  for (const scope of [
    { applyTo: "**/x/**", rules: ["r"] }, // no name
    { name: "bad name/../x", applyTo: "**/x/**", rules: ["r"] }, // unsafe name
    { name: "ok", rules: ["r"] }, // no applyTo
    { name: "ok", applyTo: "**/x/**" }, // no rules
  ]) {
    const bad = clone();
    bad.rules.scoped = [scope];
    assert.throws(() => validateConventions(bad), /Invalid/);
  }
});

test("reviewer counts must be non-negative integers", () => {
  for (const patch of [{ count: 1.5 }, { count: -1 }, { risk_count: "two" }]) {
    assert.throws(() => validateConventions(clone({ reviewers: patch })), /reviewers\./);
  }
  assert.doesNotThrow(() => validateConventions(clone({ reviewers: { count: 0 } })));
});

// --- generated-block splicing ---------------------------------------------

test("splicing replaces an existing block instead of appending", () => {
  const block = `${MARKER_START}\nnew\n${MARKER_END}`;
  const existing = `intro\n\n${MARKER_START}\nold\n${MARKER_END}\n\noutro\n`;
  const out = spliceMarkedBlock(existing, block);
  assert.ok(out.includes("new") && !out.includes("old"));
  assert.ok(out.startsWith("intro") && out.trimEnd().endsWith("outro"), "hand-written text survives");
  assert.equal(out.match(new RegExp(MARKER_START, "g")).length, 1, "exactly one block");
});

test("splicing appends when no block is present yet", () => {
  const block = `${MARKER_START}\nnew\n${MARKER_END}`;
  const out = spliceMarkedBlock("intro\n", block);
  assert.ok(out.startsWith("intro"));
  assert.ok(out.includes(MARKER_START));
});
