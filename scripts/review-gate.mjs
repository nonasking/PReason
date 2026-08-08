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
} from "./lib/conventions.mjs";

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
      severity: parseSeverity(first.body, conventions),
      fingerprint: findingFingerprint(t.path, first.body, conventions),
      excerpt: String(first.body).replace(/\s+/g, " ").slice(0, 120),
    };
  })
  .filter(Boolean);

// --- fail closed when no AI reviewer showed up ---------------------------

if (conventions.gate.require_ai_review && aiThreads.length === 0) {
  // A reviewer that failed silently looks exactly like a clean review. Check
  // whether any AI reviewer left *any* trace before trusting "no findings".
  const [reviews, issueComments] = await Promise.all([
    rest(`/pulls/${prNumber}/reviews?per_page=100`),
    rest(`/issues/${prNumber}/comments?per_page=100`),
  ]);
  const sawAi =
    reviews.some((r) => isAiReviewer(r.user?.login, conventions)) ||
    issueComments.some((c) => isAiReviewer(c.user?.login, conventions));

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
const blocking = live.filter((t) => isBlocking(t.severity, conventions));
const nonBlocking = live.filter((t) => !isBlocking(t.severity, conventions));

// --- report ---------------------------------------------------------------

say(
  `AI review threads: ${aiThreads.length} total, ${blocking.length} unresolved blocking, ` +
    `${nonBlocking.length} unresolved non-blocking, ${resurrected.length} re-posted after dismissal.`
);

if (resurrected.length) {
  say("");
  say(
    `_Ignored ${resurrected.length} finding(s) the AI re-posted after you had already ` +
      `resolved them. Re-runs re-raise declined comments; the gate does not._`
  );
}

if (blocking.length) {
  say("");
  say("### Unresolved blocking comments");
  say("");
  for (const t of blocking) {
    say(`- **[${t.severity}]** \`${t.path}\` — ${t.excerpt}… ([thread](${t.url}))`);
  }
  say("");
  say(
    "Fix the issue, or reply in the thread with your reasoning, then **resolve the thread**."
  );
  say(
    `Replying re-runs this check automatically. After a bare resolve with no reply, ` +
      `add or remove the \`${conventions.gate.recheck_label}\` label to re-run it.`
  );
  finish(1);
}

say("");
say("No unresolved blocking AI comments — gate passed.");
finish(0);
