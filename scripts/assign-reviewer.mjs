#!/usr/bin/env node
// Reviewer assignment: runs after the AI gate passes.
//
//   1. If the diff touches a risk path  → apply the risk label and request
//      risk_reviewers (falling back to the pool). Pair the label with a
//      branch-protection rule to make human approval mandatory on these PRs.
//   2. Otherwise                        → request `reviewers.count` reviewer(s)
//      picked deterministically from the pool (PR number % pool size), so
//      re-runs never reshuffle.
//
// Idempotent: skips if a human reviewer was already requested or has reviewed.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), PR_NUMBER

import { loadConventions, matchesAny, normalizeLogin, isAiReviewer } from "./lib/conventions.mjs";

const token = process.env.GITHUB_TOKEN;
const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
const prNumber = Number(process.env.PR_NUMBER);
if (!token || !owner || !repo || !prNumber) {
  console.error("Missing GITHUB_TOKEN, GITHUB_REPOSITORY, or PR_NUMBER");
  process.exit(2);
}

const conventions = loadConventions();
const api = `https://api.github.com/repos/${owner}/${repo}`;

async function gh(pathname, options = {}) {
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

const pr = await gh(`/pulls/${prNumber}`);
const author = normalizeLogin(pr.user.login);

// --- idempotency: bail if a human is already on the PR --------------------

const requested = (pr.requested_reviewers || []).map((u) => u.login);
const reviews = await gh(`/pulls/${prNumber}/reviews?per_page=100`);
const humanAlreadyInvolved =
  requested.some((l) => !isAiReviewer(l, conventions)) ||
  reviews.some(
    (r) => !isAiReviewer(r.user?.login, conventions) && normalizeLogin(r.user?.login) !== author
  );

// --- risk detection -------------------------------------------------------

const files = [];
for (let page = 1; ; page++) {
  const chunk = await gh(`/pulls/${prNumber}/files?per_page=100&page=${page}`);
  files.push(...chunk.map((f) => f.filename));
  if (chunk.length < 100) break;
}
const riskFiles = files.filter((f) => matchesAny(f, conventions.risk_paths));

if (riskFiles.length && conventions.reviewers.risk_label) {
  await gh(`/issues/${prNumber}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: [conventions.reviewers.risk_label] }),
  });
  console.log(
    `Risk paths touched (${riskFiles.length} file(s)) — applied label "${conventions.reviewers.risk_label}".`
  );
  for (const f of riskFiles.slice(0, 20)) console.log(`  - ${f}`);
}

if (humanAlreadyInvolved) {
  console.log("A human reviewer is already requested or has reviewed — skipping assignment.");
  process.exit(0);
}

// --- pick reviewers -------------------------------------------------------

const basePool = (riskFiles.length && conventions.risk_reviewers.length
  ? conventions.risk_reviewers
  : conventions.reviewers.pool
).filter((l) => normalizeLogin(l) !== author);

if (!basePool.length) {
  console.log("Reviewer pool is empty (or only contains the PR author) — nothing to assign.");
  process.exit(0);
}

const count = Math.min(conventions.reviewers.count, basePool.length);
const start = prNumber % basePool.length;
const picked = Array.from({ length: count }, (_, i) => basePool[(start + i) % basePool.length]);

await gh(`/pulls/${prNumber}/requested_reviewers`, {
  method: "POST",
  body: JSON.stringify({ reviewers: picked }),
});
console.log(`Requested review from: ${picked.join(", ")}${riskFiles.length ? " (risk path)" : ""}`);
