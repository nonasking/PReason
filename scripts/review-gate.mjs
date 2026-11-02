#!/usr/bin/env node
// Merge gate: fails while any unresolved AI review thread carries a blocking
// severity tag. Runs as a required status check — the PR author must resolve
// (fix) or reply-and-resolve (rebut) every [blocker] before a human is pulled in.
//
// Three things this deliberately does NOT do naively:
//   * pass when no AI reviewer posted at all (fail-open — see gate.require_ai_review)
//   * block on findings the author already dismissed on an earlier push
//     (AI reviewers re-post declined comments verbatim on every re-run)
//   * fail on fork PRs, where AI review cannot run at all (no secrets)
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), PR_NUMBER

import fs from "node:fs";
import {
  loadConventions,
  isAiReviewer,
  parseSeverity,
  isBlocking,
  findingFingerprint,
  isAdvisoryReviewer,
  normalizeLogin,
  matchesAny,
} from "./lib/conventions.mjs";
import { verifyBlockers, blocksMerge, VERIFIER_VERSION } from "./lib/verify.mjs";
import {
  parseVerdictCache,
  buildGateComment,
  isGateComment,
  findGateComment,
} from "./lib/gate-report.mjs";

const token = process.env.GITHUB_TOKEN;
const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
const prNumber = Number(process.env.PR_NUMBER);
if (!token || !owner || !repo || !prNumber) {
  console.error("Missing GITHUB_TOKEN, GITHUB_REPOSITORY, or PR_NUMBER");
  process.exit(2);
}

const conventions = loadConventions();
const api = `https://api.github.com/repos/${owner}/${repo}`;
const report = [];

function say(line = "") {
  report.push(line);
}

function finish(code) {
  const summary = report.join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
  }
  process.exit(code);
}

async function rest(pathname, options = {}) {
  const res = await fetch(`${api}${pathname}`, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`${options.method || "GET"} ${pathname} → ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

// Follows pagination. A busy PR can have more than 100 comments; reading only
// the first page would miss the gate's own comment, start a new one, and drop
// the verdict cache (re-verifying, possibly with a different verdict).
async function restAll(pathname, maxPages = 20) {
  const sep = pathname.includes("?") ? "&" : "?";
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await rest(`${pathname}${sep}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

say("## Review gate");
say("");

// --- preflight: draft and fork PRs ---------------------------------------

const pr = await rest(`/pulls/${prNumber}`);

if (pr.draft) {
  say("PR is a draft — gate skipped.");
  finish(0);
}

// Fork PRs get a read-only GITHUB_TOKEN and no repository secrets, so the AI
// review job cannot run. Failing here would make fork PRs permanently
// unmergeable behind a required check.
const isFork = pr.head?.repo?.full_name !== `${owner}/${repo}`;
if (isFork) {
  const label = conventions.reviewers.risk_label;
  if (conventions.gate.fork_policy === "block") {
    say("Fork PR: AI review cannot run (no secrets on fork PRs) and `gate.fork_policy` is `block`.");
    finish(1);
  }
  say("Fork PR: AI review cannot run (fork PRs receive a read-only token and no secrets).");
  say("");
  say(`Gate passed without AI review — this PR needs full human review${label ? ` (labeled \`${label}\`)` : ""}.`);
  if (label) {
    await rest(`/issues/${prNumber}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [label] }),
    }).catch((e) => say(`\n_(could not apply label: ${e.message})_`));
  }
  finish(0);
}

// --- the gate's sticky comment -------------------------------------------

// The report is mirrored into a PR comment (authors don't read the Actions
// tab), which also carries the verdict cache. Best-effort: a comment failure
// never changes the verdict.
const issueComments = await restAll(`/issues/${prNumber}/comments`).catch(() => []);
const gateComment = findGateComment(issueComments);
const verdictCache = parseVerdictCache(gateComment?.body);

async function postReport(verdicts = verdictCache) {
  const body = buildGateComment(report.join("\n"), verdicts);
  try {
    if (gateComment) {
      await rest(`/issues/comments/${gateComment.id}`, {
        method: "PATCH",
        body: JSON.stringify({ body }),
      });
    } else {
      await rest(`/issues/${prNumber}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    }
  } catch (e) {
    console.error(`(could not post gate report comment: ${e.message})`);
  }
}

// --- hotfix break-glass ---------------------------------------------------

// A genuine emergency must be able to merge past every finding. The bypass is
// deliberately loud: the report names who applied the label, and merging the
// PR opens a post-hoc review issue (see posthoc-hotfix.mjs) — review is
// deferred, not skipped. gate.hotfix_allowed restricts who can pull the lever.
const hotfixLabel = conventions.gate.hotfix_label;
if (hotfixLabel && (pr.labels || []).some((l) => l.name === hotfixLabel)) {
  const applier = await lastLabelApplier(hotfixLabel);
  const allowed = conventions.gate.hotfix_allowed;
  const permitted =
    allowed.length === 0 ||
    allowed.some((l) => normalizeLogin(l) === normalizeLogin(applier));

  if (permitted) {
    say(`### ⚠️ Hotfix bypass active`);
    say("");
    say(
      `The \`${hotfixLabel}\` label${applier ? ` (applied by @${applier})` : ""} makes this ` +
        `gate pass regardless of review findings.`
    );
    say("");
    say("- Every AI finding on this PR is **non-blocking** while the label is present.");
    say("- A human reviewer is still requested, for post-hoc review.");
    say("- **Merging this PR opens a post-hoc review issue automatically.**");
    say("- Remove the label to restore normal gating.");
    await postReport();
    finish(0);
  }
  say(
    `_\`${hotfixLabel}\` was applied by @${applier ?? "unknown"}, who is not in ` +
      `\`gate.hotfix_allowed\` — bypass ignored, normal gating applies._`
  );
  say("");
}

// Who most recently applied a label — the audit trail for the bypass.
async function lastLabelApplier(labelName) {
  try {
    let applier = null;
    for (let page = 1; ; page++) {
      const events = await rest(`/issues/${prNumber}/events?per_page=100&page=${page}`);
      for (const e of events) {
        if (e.event === "labeled" && e.label?.name === labelName) {
          applier = e.actor?.login ?? applier;
        }
      }
      if (events.length < 100) break;
    }
    return applier;
  } catch {
    return null;
  }
}

// --- PR size --------------------------------------------------------------

// Fetched here rather than in the assigner because the gate needs the per-file
// patches for verification anyway.
const files = [];
for (let page = 1; ; page++) {
  const chunk = await rest(`/pulls/${prNumber}/files?per_page=100&page=${page}`);
  files.push(...chunk);
  if (chunk.length < 100) break;
}
const patchesByPath = new Map(files.map((f) => [f.filename, f.patch || ""]));

const counted = files.filter((f) => !matchesAny(f.filename, conventions.size.exclude));
const changedLines = counted.reduce((n, f) => n + (f.additions || 0) + (f.deletions || 0), 0);
const overLines =
  conventions.size.max_changed_lines > 0 && changedLines > conventions.size.max_changed_lines;
const overFiles =
  conventions.size.max_changed_files > 0 && counted.length > conventions.size.max_changed_files;

if (overLines || overFiles) {
  const limits = [
    overLines && `${changedLines} changed lines (limit ${conventions.size.max_changed_lines})`,
    overFiles && `${counted.length} changed files (limit ${conventions.size.max_changed_files})`,
  ].filter(Boolean);

  if (conventions.size.label) {
    await rest(`/issues/${prNumber}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels: [conventions.size.label] }),
    }).catch(() => {});
  }

  // Blocking here also saves the verification spend on a PR that has to be
  // split anyway.
  if (conventions.size.action === "block") {
    say(`**This PR is too large to review: ${limits.join(", ")}.**`);
    say("");
    say(
      "Review effectiveness falls off sharply with diff size — and so does AI review, " +
        "which spends its budget before reaching the risky part. Split this into " +
        "smaller pull requests."
    );
    say("");
    say(
      "_Generated and vendored paths are already excluded from the count " +
        "(`size.exclude`). Adjust `size.max_changed_lines` if the limit is wrong for this repo._"
    );
    await postReport();
    finish(1);
  }
  say(`⚠️ Large PR: ${limits.join(", ")}. Expect weaker review, from humans and AI alike.`);
  say("");
}

// --- risk labeling --------------------------------------------------------

// Applied here rather than in assignment: the label describes what the PR
// touches, and should be visible while the gate is still red — which is
// exactly when a human deciding whether to step in early wants to see it.
if (
  conventions.reviewers.risk_label &&
  files.some((f) => matchesAny(f.filename, conventions.risk_paths))
) {
  await rest(`/issues/${prNumber}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: [conventions.reviewers.risk_label] }),
  }).catch(() => {});
}

// --- collect AI review threads -------------------------------------------

async function fetchReviewThreads() {
  const threads = [];
  let cursor = null;
  do {
    const data = await graphql(
      `query ($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                isResolved
                isOutdated
                path
                comments(first: 1) {
                  nodes { author { login } body url }
                }
              }
            }
          }
        }
      }`,
      { owner, repo, pr: prNumber, cursor }
    );
    const page = data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return threads;
}

const aiThreads = (await fetchReviewThreads())
  .map((t) => {
    const first = t.comments.nodes[0];
    if (!first || !isAiReviewer(first.author?.login, conventions)) return null;
    return {
      resolved: t.isResolved,
      outdated: t.isOutdated,
      path: t.path,
      url: first.url,
      author: first.author.login,
      advisory: isAdvisoryReviewer(first.author?.login, conventions),
      severity: parseSeverity(first.body, conventions),
      fingerprint: findingFingerprint(t.path, first.body, conventions),
      body: first.body, // the verifier judges the full finding, not the excerpt
      excerpt: String(first.body).replace(/\s+/g, " ").slice(0, 120),
    };
  })
  .filter(Boolean);

// --- fail closed when no AI reviewer showed up ---------------------------

if (conventions.gate.require_ai_review && aiThreads.length === 0) {
  // A reviewer that failed silently looks exactly like a clean review. Check
  // whether any AI reviewer left *any* trace before trusting "no findings".
  // The gate's own report comment is excluded — it is posted by github-actions,
  // which is also how claude-code-action posts, and counting it would satisfy
  // this check forever after the first gate run.
  const reviews = await restAll(`/pulls/${prNumber}/reviews`);
  const sawAi =
    reviews.some((r) => isAiReviewer(r.user?.login, conventions)) ||
    issueComments.some((c) => isAiReviewer(c.user?.login, conventions) && !isGateComment(c.body));

  if (!sawAi) {
    say("**No AI reviewer has posted on this PR.**");
    say("");
    say(
      "Treating this as a failed review rather than a clean one — a reviewer that errors " +
        "out can exit successfully having posted nothing, which is indistinguishable from " +
        "finding no issues."
    );
    say("");
    say("Check the AI review workflow run, then push or re-run to retry.");
    say("_(Set `gate.require_ai_review: false` if this repo intentionally runs no AI reviewer.)_");
    await postReport();
    finish(1);
  }
}

// --- resurrection filter --------------------------------------------------

// Findings the author already dealt with, keyed by content rather than thread
// identity: a re-run posts a brand-new thread for the same finding.
const dismissed = new Set(
  aiThreads.filter((t) => t.resolved).map((t) => t.fingerprint)
);

const open = aiThreads.filter((t) => !t.resolved && !t.outdated);
const resurrected = open.filter((t) => dismissed.has(t.fingerprint));
const live = open.filter((t) => !dismissed.has(t.fingerprint));
// Advisory reviewers cannot emit a severity tag reliably, so their comments
// would otherwise all inherit severity.default — which turns them into blockers
// the moment anyone sets that to a blocking tag. They are reported, never gated.
const advisory = live.filter((t) => t.advisory);
const gated = live.filter((t) => !t.advisory);
const claimed = gated.filter((t) => isBlocking(t.severity, conventions));
const nonBlocking = gated.filter((t) => !isBlocking(t.severity, conventions));

// --- verification ---------------------------------------------------------

// A blocking tag is the reviewing model's own severity judgement. Give each
// claim an adversarial second opinion before it holds the merge; anything the
// verifier cannot refute (including anything it fails to check) still blocks.
//
// Verdicts are sticky: a finding judged on an earlier run keeps its verdict
// (via the cache in the gate's PR comment) instead of being re-judged on every
// event. Model calls are not deterministic — without this, verdicts could flip
// between runs and the gate would flap with no code change. Only settled
// verdicts are cached; "unverified" retries next run.
const cachedResults = [];
const toVerify = [];
for (const f of claimed) {
  const hit = verdictCache[f.fingerprint];
  // A cache hit from an older verifier version is discarded — when the judging
  // standard changes, old verdicts must not stick forever.
  if (
    hit &&
    hit.v === VERIFIER_VERSION &&
    (hit.status === "confirmed" || hit.status === "refuted")
  ) {
    cachedResults.push({ ...f, verdict: { ...hit, cached: true } });
  } else {
    toVerify.push(f);
  }
}
const fresh = await verifyBlockers(toVerify, {
  conventions,
  patchesByPath,
  apiKey: process.env.ANTHROPIC_API_KEY,
  prTitle: pr.title,
  prBody: pr.body,
});
const verified = [...cachedResults, ...fresh];

// Cache only what's still live, so the comment doesn't grow without bound.
const nextVerdicts = {};
for (const f of verified) {
  if (f.verdict.status === "confirmed" || f.verdict.status === "refuted") {
    const { cached, ...verdict } = f.verdict;
    nextVerdicts[f.fingerprint] = { ...verdict, v: VERIFIER_VERSION };
  }
}

const blocking = verified.filter(blocksMerge);
const refuted = verified.filter((t) => !blocksMerge(t));
const unverified = blocking.filter((t) => t.verdict.status === "unverified");

// --- report ---------------------------------------------------------------

say(
  `AI review threads: ${aiThreads.length} total, ${blocking.length} blocking, ` +
    `${nonBlocking.length} unresolved non-blocking, ${resurrected.length} re-posted after dismissal` +
    (refuted.length ? `, ${refuted.length} refuted by verification` : "") +
    (advisory.length ? `, ${advisory.length} advisory (never blocking)` : "") +
    "."
);

if (conventions.review.max_comments > 0 && live.length > conventions.review.max_comments) {
  say("");
  say(
    `_${live.length} open AI comments, over the stated budget of ` +
      `${conventions.review.max_comments}. Volume is the most common reason teams stop ` +
      `reading AI review — consider tightening \`review.suppress\`._`
  );
}

if (resurrected.length) {
  say("");
  say(
    `_Ignored ${resurrected.length} finding(s) the AI re-posted after you had already ` +
      `resolved them. Re-runs re-raise declined comments; the gate does not._`
  );
}

if (refuted.length) {
  say("");
  say("<details><summary>");
  say(`Refuted by verification (${refuted.length}) — not blocking</summary>`);
  say("");
  for (const t of refuted) {
    say(`- \`${t.path}\` — ${t.excerpt}…`);
    say(`  - _${t.verdict.reason}_ (${t.verdict.votes ?? "1/1"} votes)`);
  }
  say("");
  say("</details>");
}

if (blocking.length) {
  say("");
  say("### Blocking comments");
  say("");
  for (const t of blocking) {
    const note =
      t.verdict.status === "unverified"
        ? ` — ⚠️ not verified (${t.verdict.reason}), blocking by default`
        : t.verdict.reason
          ? ` — verified: ${t.verdict.reason}`
          : "";
    say(`- **[${t.severity}]** \`${t.path}\` — ${t.excerpt}…${note} ([thread](${t.url}))`);
  }
  say("");
  say("Fix the issue, or reply in the thread with your reasoning, then **resolve the thread**.");
  say(
    `Replying re-runs this check automatically. After a bare resolve with no reply, ` +
      `add or remove the \`${conventions.gate.recheck_label}\` label to re-run it.`
  );
  if (unverified.length) {
    say("");
    say(
      `_${unverified.length} finding(s) could not be verified, so they block by default. ` +
        `A verifier that fails should never make the gate more permissive._`
    );
  }
  await postReport(nextVerdicts);
  finish(1);
}

say("");
say("No blocking AI comments — gate passed.");
await postReport(nextVerdicts);
finish(0);
