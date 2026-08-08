#!/usr/bin/env node
// When a PR carrying the hotfix label is merged, open a post-hoc review issue.
//
// The break-glass contract is "review deferred, not skipped": the bypass gets
// an emergency out the door, and this script makes sure the skipped review
// actually happens afterwards — as a tracked issue, not a memory.
//
// Idempotent: a marker in the issue body prevents duplicates on re-runs.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), PR_NUMBER

import { loadConventions, normalizeLogin } from "./lib/conventions.mjs";

const token = process.env.GITHUB_TOKEN;
const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
const prNumber = Number(process.env.PR_NUMBER);
if (!token || !owner || !repo || !prNumber) {
  console.error("Missing GITHUB_TOKEN, GITHUB_REPOSITORY, or PR_NUMBER");
  process.exit(2);
}

const conventions = loadConventions();
const label = conventions.gate.hotfix_label;
if (!label) {
  console.log("gate.hotfix_label is disabled — nothing to do.");
  process.exit(0);
}

const api = "https://api.github.com";

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
  return res.json();
}

const pr = await gh(`/repos/${owner}/${repo}/pulls/${prNumber}`);

if (!pr.merged_at) {
  console.log("PR is closed but not merged — no post-hoc review needed.");
  process.exit(0);
}
if (!(pr.labels || []).some((l) => l.name === label)) {
  console.log(`PR was merged without the "${label}" label — normal gating applied.`);
  process.exit(0);
}

// Idempotency: one issue per PR, keyed by a marker in the body.
const marker = `<!-- preason:posthoc:PR-${prNumber} -->`;
const existing = await gh(
  `/search/issues?q=${encodeURIComponent(`repo:${owner}/${repo} in:body "${marker}"`)}`
).catch(() => null);
if (existing?.total_count > 0) {
  console.log(`Post-hoc issue already exists: ${existing.items[0].html_url}`);
  process.exit(0);
}

const reviewers = [
  ...new Set(
    [...conventions.risk_reviewers, ...conventions.reviewers.pool]
      .filter((l) => normalizeLogin(l) !== normalizeLogin(pr.user?.login))
  ),
];

const body = [
  marker,
  `PR #${prNumber} (**${pr.title}**) merged with the \`${label}\` bypass — the review gate`,
  `was intentionally skipped, so the review is owed after the fact.`,
  "",
  `- PR: ${pr.html_url}`,
  `- Author: @${pr.user?.login}`,
  `- Merged by: @${pr.merged_by?.login ?? "unknown"} at ${pr.merged_at}`,
  reviewers.length ? `- Suggested reviewers: ${reviewers.map((r) => `@${r}`).join(", ")}` : "",
  "",
  "### Post-hoc checklist",
  "",
  "- [ ] Review the merged diff as you would have pre-merge",
  "- [ ] Confirm the emergency fix actually addresses the incident",
  "- [ ] File follow-up issues for anything that would have been a `[blocker]`",
  "- [ ] Backfill tests the hotfix skipped",
  "",
  "_Opened automatically by PReason (scripts/posthoc-hotfix.mjs)._",
]
  .filter((line) => line !== null)
  .join("\n");

const issue = await gh(`/repos/${owner}/${repo}/issues`, {
  method: "POST",
  body: JSON.stringify({
    title: `Post-hoc review: hotfix PR #${prNumber} — ${pr.title}`,
    body,
    assignees: pr.user?.login ? [pr.user.login] : [],
    labels: conventions.reviewers.risk_label ? [conventions.reviewers.risk_label] : [],
  }),
});
console.log(`Opened post-hoc review issue: ${issue.html_url}`);
