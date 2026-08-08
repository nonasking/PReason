#!/usr/bin/env node
// Reviewer assignment: runs after the AI gate passes.
//
//   1. If the diff touches a risk path  → apply the risk label and request
//      `reviewers.risk_count` reviewer(s) from risk_reviewers (falling back to
//      the pool). Pair the label with a branch-protection rule to make human
//      approval mandatory on these PRs.
//   2. If every changed file matches `exempt_paths` → AI-only tier, no human
//      reviewer is assigned.
//   3. Otherwise                        → request `reviewers.count` reviewer(s)
//      picked deterministically from the pool (PR number % pool size), so
//      re-runs never reshuffle. count 0 disables assignment.
//
// Idempotent: skips if a human reviewer was already requested or has reviewed.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), PR_NUMBER

import { loadConventions, matchesAny, normalizeLogin, isAiReviewer } from "./lib/conventions.mjs";
import { rankCandidates } from "./lib/rank.mjs";

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

// Fork PRs hand this workflow a read-only token, so every write below (label,
// review request) would 403 and fail the job — turning a required gate into a
// permanent block on outside contributions. The gate already labels and
// explains fork PRs; assignment simply does not apply.
if (pr.head?.repo?.full_name !== `${owner}/${repo}`) {
  console.log("Fork PR — token is read-only, skipping reviewer assignment.");
  process.exit(0);
}

if (pr.draft) {
  console.log("Draft PR — skipping reviewer assignment.");
  process.exit(0);
}

// --- idempotency: bail if a human is already on the PR --------------------

const requested = (pr.requested_reviewers || []).map((u) => u.login);
const reviews = await gh(`/pulls/${prNumber}/reviews?per_page=100`);
const humanAlreadyInvolved =
  requested.some((l) => !isAiReviewer(l, conventions)) ||
  reviews.some(
    (r) => !isAiReviewer(r.user?.login, conventions) && normalizeLogin(r.user?.login) !== author
  );

// --- risk detection -------------------------------------------------------

// Full file objects, not just names — the expertise ranking weights by how
// much of the diff each file accounts for.
const files = [];
for (let page = 1; ; page++) {
  const chunk = await gh(`/pulls/${prNumber}/files?per_page=100&page=${page}`);
  files.push(...chunk);
  if (chunk.length < 100) break;
}
const paths = files.map((f) => f.filename);
const riskFiles = paths.filter((f) => matchesAny(f, conventions.risk_paths));

if (riskFiles.length && conventions.reviewers.risk_label) {
  // Best-effort: a label API failure must not abort reviewer assignment.
  await gh(`/issues/${prNumber}/labels`, {
    method: "POST",
    body: JSON.stringify({ labels: [conventions.reviewers.risk_label] }),
  }).catch((e) => console.log(`(could not apply risk label: ${e.message})`));
  console.log(
    `Risk paths touched (${riskFiles.length} file(s)) — label "${conventions.reviewers.risk_label}".`
  );
  for (const f of riskFiles.slice(0, 20)) console.log(`  - ${f}`);
}

if (humanAlreadyInvolved) {
  console.log("A human reviewer is already requested or has reviewed — skipping assignment.");
  process.exit(0);
}

// AI-only tier: docs, scripts, config — whatever exempt_paths says. Only when
// the *entire* diff is exempt (and touches no risk path) is the human skipped.
if (
  !riskFiles.length &&
  conventions.exempt_paths.length &&
  paths.every((f) => matchesAny(f, conventions.exempt_paths))
) {
  console.log("All changed files match exempt_paths — AI-only tier, no human reviewer assigned.");
  process.exit(0);
}

// --- pick reviewers -------------------------------------------------------

const wanted = riskFiles.length ? conventions.reviewers.risk_count : conventions.reviewers.count;
if (wanted === 0) {
  console.log("Reviewer count is 0 for this tier — human assignment disabled.");
  process.exit(0);
}

const basePool = (riskFiles.length && conventions.risk_reviewers.length
  ? conventions.risk_reviewers
  : conventions.reviewers.pool
).filter((l) => normalizeLogin(l) !== author);

if (!basePool.length) {
  console.log("Reviewer pool is empty (or only contains the PR author) — nothing to assign.");
  process.exit(0);
}

const count = Math.min(wanted, basePool.length);
const picked =
  conventions.reviewers.strategy === "rotation"
    ? rotate(basePool, count)
    : await byExpertise(basePool, count);

await gh(`/pulls/${prNumber}/requested_reviewers`, {
  method: "POST",
  body: JSON.stringify({ reviewers: picked }),
});
console.log(`Requested review from: ${picked.join(", ")}${riskFiles.length ? " (risk path)" : ""}`);

// --- strategies -----------------------------------------------------------

// Deterministic round robin. Even over time and stable across re-runs, but
// blind to both expertise and how much each person is already reviewing.
function rotate(pool, n) {
  const start = prNumber % pool.length;
  return Array.from({ length: n }, (_, i) => pool[(start + i) % pool.length]);
}

// Rank by the configured criteria (reviewers.criteria). Default: people who
// have actually touched these files, least-loaded first. Balancing across the
// whole pool backfires: an author who gets an unqualified suggestion just
// picks someone else, and the balancing is lost — so expertise gates first.
async function byExpertise(pool, n) {
  const crit = conventions.reviewers.criteria;
  const [expertise, load, busy] = await Promise.all([
    crit.rank.includes("expertise") ? commitCounts(pool, crit) : new Map(),
    crit.rank.includes("load") ? openReviewLoad(pool) : new Map(),
    crit.availability ? limitedAvailability(pool) : new Set(),
  ]);

  // Availability is a filter, not a ranking — but never let it empty the pool.
  const available = pool.filter((l) => !busy.has(normalizeLogin(l)));
  const candidates = available.length ? available : pool;
  if (!available.length && busy.size) {
    console.log("Every candidate is marked busy — ignoring availability for this PR.");
  }

  // Experts first; fall back to the whole candidate list when nobody in the
  // pool has history on these files (new area, new team member).
  let ranked = candidates;
  if (crit.rank.includes("expertise")) {
    const experts = candidates.filter((l) => (expertise.get(normalizeLogin(l)) || 0) > 0);
    ranked = experts.length ? experts : candidates;
    if (!experts.length) {
      console.log("No pool member has recent commits to the changed files — ranking by load only.");
    }
  }

  const sorted = rankCandidates(ranked, crit.rank, { expertise, load });

  for (const l of sorted.slice(0, n)) {
    console.log(
      `  ${l}: ${expertise.get(normalizeLogin(l)) || 0} recent commit(s) here, ` +
        `${load.get(normalizeLogin(l)) || 0} open review(s)`
    );
  }
  return sorted.slice(0, n);
}

// Commits touching the changed files, by author. Sampled: the largest few
// files carry most of the signal, and this is one API call each.
async function commitCounts(pool, crit) {
  const inPool = new Set(pool.map(normalizeLogin));
  const counts = new Map();

  const sampled = [...files]
    .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
    .slice(0, crit.expertise_files);

  const perFile = await Promise.all(
    sampled.map((f) =>
      gh(
        `/commits?path=${encodeURIComponent(f.filename)}&per_page=${crit.expertise_commits}&sha=${
          encodeURIComponent(pr.base.ref)
        }`
      ).catch(() => [])
    )
  );
  for (const commits of perFile) {
    for (const c of commits) {
      const login = normalizeLogin(c.author?.login);
      if (login && inPool.has(login)) counts.set(login, (counts.get(login) || 0) + 1);
    }
  }
  return counts;
}

// How many open PRs each candidate is already on the hook for. One call, not
// one per person — the search API has much tighter rate limits.
async function openReviewLoad(pool) {
  const inPool = new Set(pool.map(normalizeLogin));
  const load = new Map();
  for (let page = 1; ; page++) {
    const open = await gh(`/pulls?state=open&per_page=100&page=${page}`);
    for (const p of open) {
      if (p.number === prNumber) continue;
      for (const u of p.requested_reviewers || []) {
        const login = normalizeLogin(u.login);
        if (inPool.has(login)) load.set(login, (load.get(login) || 0) + 1);
      }
    }
    if (open.length < 100) break;
  }
  return load;
}

// GitHub's own "busy" status flag, batched into a single GraphQL call.
async function limitedAvailability(pool) {
  const fields = pool
    .map((l, i) => `u${i}: user(login: ${JSON.stringify(l)}) { login status { indicatesLimitedAvailability } }`)
    .join("\n");
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query: `query { ${fields} }` }),
    });
    const { data } = await res.json();
    const busy = new Set();
    for (const v of Object.values(data || {})) {
      if (v?.status?.indicatesLimitedAvailability) busy.add(normalizeLogin(v.login));
    }
    return busy;
  } catch {
    return new Set(); // availability is a nicety; never fail assignment over it
  }
}
