// Adversarial verification of blocking findings.
//
// A [blocker] tag is the reviewing model's own severity judgement, and models
// rate findings more severe than humans do — so gating merges on an unfiltered
// first pass blocks on things that should not block. Every AI review system
// that reaches usable precision adds a second stage; this is ours.
//
// Each blocking finding gets an independent call that is asked to REFUTE it.
// Only findings that survive hold the merge.
//
// FAILS SAFE, ALWAYS. A missing API key, a network error, a refusal, malformed
// output, an unparseable response — every failure path leaves the finding
// blocking. A broken verifier makes the gate noisier, never more permissive.

import Anthropic from "@anthropic-ai/sdk";
import { globToRegExp } from "./conventions.mjs";

const MAX_PATCH_CHARS = 24_000;

// Bump when the judging standard changes: cached verdicts from an older
// verifier are dropped and re-judged, instead of an old standard's verdict
// sticking forever.
export const VERIFIER_VERSION = 2;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    real: {
      type: "boolean",
      description:
        "true if this is a genuine defect that must be fixed before merge; " +
        "false if it is wrong, speculative, already handled, or below the bar.",
    },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: {
      type: "string",
      description: "One or two sentences. Cite the specific line if you are confirming.",
    },
  },
  required: ["real", "confidence", "reason"],
  additionalProperties: false,
};

const SYSTEM = `You are the second stage of a code review pipeline. A first-pass \
reviewer flagged a finding as blocking, meaning the pull request cannot merge \
until it is resolved. Your job is to try to REFUTE that finding.

First-pass reviewers over-flag: they raise issues that are speculative, already \
handled elsewhere in the diff, based on a misreading, or real but not \
merge-blocking. Blocking a merge has a real cost, and a reviewer that blocks on \
weak findings gets ignored on strong ones.

A finding is real if EITHER of these holds:

1. It describes a concrete defect: visible in the changed lines you were given \
(not assumed from code you cannot see), and shipping it would cause incorrect \
behavior, data loss, a security hole, or a breaking change for callers.

2. It enforces one of the team review rules provided below, and the rule's \
condition is actually met by this change. Team rules are this repository's \
definition of merge-blocking — a rule may demand process (for example, a \
rollback plan stated in the PR description) rather than a code change, and \
enforcing it is still real. Check the PR description you were given before \
concluding a required statement is missing.

Otherwise, default to refuting. If the finding is neither a defect you can pin \
to a changed line nor the enforcement of a listed team rule, it is not real. \
If you are genuinely torn, set confidence to "low" and explain what you would \
need to see.`;

// The team rules that apply to this file — the verifier must not refute a
// finding for being "process, not a defect" when the process is exactly what
// the team's conventions mandate for this path.
function rulesForPath(conventions, path) {
  return conventions.rules.scoped
    .filter((scope) => globToRegExp(scope.applyTo).test(path || ""))
    .flatMap((scope) => scope.rules);
}

function buildPrompt(finding, patch, { conventions, prTitle, prBody }) {
  const rules = rulesForPath(conventions, finding.path);
  return [
    `File: ${finding.path}`,
    "",
    "Finding flagged as blocking:",
    finding.body.trim(),
    "",
    rules.length
      ? ["Team review rules for this file:", ...rules.map((r) => `- ${r}`), ""].join("\n")
      : "",
    "Pull request title and description (verbatim):",
    "```",
    `${prTitle || "(no title)"}`,
    "",
    `${prBody || "(no description)"}`.slice(0, 4000),
    "```",
    "",
    "The changed lines in this file:",
    "```diff",
    patch || "(no patch available — the file may be binary or too large)",
    "```",
    "",
    "Is this finding real, by the standard in your instructions?",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

async function judgeOnce(client, model, finding, patch, ctx) {
  const response = await client.messages.create({
    model,
    // max_tokens caps thinking + answer together, and thinking is on by
    // default on current models. Too tight a cap truncates mid-JSON, which
    // reads as a verifier failure and blocks the finding unverified.
    max_tokens: 8000,
    system: SYSTEM,
    messages: [{ role: "user", content: buildPrompt(finding, patch, ctx) }],
    output_config: {
      format: { type: "json_schema", schema: VERDICT_SCHEMA },
    },
  });

  // A safety refusal carries no content — treat it as "could not verify".
  if (response.stop_reason === "refusal") {
    throw new Error(`verifier refused (${response.stop_details?.category ?? "unspecified"})`);
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("verifier returned no text");
  const parsed = JSON.parse(text);
  if (typeof parsed.real !== "boolean") throw new Error("verifier returned no verdict");
  return parsed;
}

async function judge(client, model, votes, finding, patch, ctx) {
  const attempts = await Promise.allSettled(
    Array.from({ length: votes }, () => judgeOnce(client, model, finding, patch, ctx))
  );
  const verdicts = attempts.filter((a) => a.status === "fulfilled").map((a) => a.value);

  if (!verdicts.length) {
    const why = attempts[0]?.reason?.message ?? "unknown error";
    return { status: "unverified", reason: why };
  }

  // Refute only on a majority of *successful* votes: a partially failed panel
  // should not be easier to refute than a complete one.
  const refuting = verdicts.filter((v) => !v.real);
  if (refuting.length > verdicts.length / 2) {
    return {
      status: "refuted",
      reason: refuting[0].reason,
      confidence: refuting[0].confidence,
      votes: `${refuting.length}/${verdicts.length}`,
    };
  }
  const confirming = verdicts.find((v) => v.real) ?? verdicts[0];
  return {
    status: "confirmed",
    reason: confirming.reason,
    confidence: confirming.confidence,
    votes: `${verdicts.length - refuting.length}/${verdicts.length}`,
  };
}

/**
 * Verify blocking findings. Returns the same findings with a `.verdict`
 * attached: "confirmed" (still blocks), "refuted" (does not block), or
 * "unverified" (still blocks — verification could not run).
 *
 * `patchesByPath` maps a file path to its unified diff for this PR. Diff-only
 * context is deliberate: on published benchmarks, review models get *worse*
 * monotonically as more surrounding context is added.
 */
export async function verifyBlockers(findings, { conventions, patchesByPath, apiKey, prTitle, prBody }) {
  const { enabled, model, votes } = conventions.verification;

  if (!enabled || !findings.length) {
    return findings.map((f) => ({ ...f, verdict: { status: "skipped" } }));
  }
  if (!apiKey) {
    return findings.map((f) => ({
      ...f,
      verdict: { status: "unverified", reason: "ANTHROPIC_API_KEY is not set" },
    }));
  }

  const client = new Anthropic({ apiKey, maxRetries: 2 });

  // Findings are few by construction; a small cap keeps burst load sane without
  // needing a queue.
  const out = [];
  const CONCURRENCY = 4;
  for (let i = 0; i < findings.length; i += CONCURRENCY) {
    const batch = findings.slice(i, i + CONCURRENCY);
    out.push(
      ...(await Promise.all(
        batch.map(async (f) => {
          const patch = (patchesByPath.get(f.path) || "").slice(0, MAX_PATCH_CHARS);
          try {
            return { ...f, verdict: await judge(client, model, votes, f, patch, { conventions, prTitle, prBody }) };
          } catch (e) {
            return { ...f, verdict: { status: "unverified", reason: e.message } };
          }
        })
      ))
    );
  }
  return out;
}

export function blocksMerge(finding) {
  return finding.verdict.status !== "refuted";
}
