#!/usr/bin/env node
// Merge gate: fails while any unresolved AI review thread carries a blocking
// severity tag. Runs as a required status check — the PR author must resolve
// (fix) or reply-and-resolve (rebut) every [blocker] before a human is pulled in.
//
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo), PR_NUMBER

import fs from "node:fs";
import {
  loadConventions,
  isAiReviewer,
  parseSeverity,
  isBlocking,
} from "./lib/conventions.mjs";

const token = process.env.GITHUB_TOKEN;
const [owner, repo] = (process.env.GITHUB_REPOSITORY || "").split("/");
const prNumber = Number(process.env.PR_NUMBER);
if (!token || !owner || !repo || !prNumber) {
  console.error("Missing GITHUB_TOKEN, GITHUB_REPOSITORY, or PR_NUMBER");
  process.exit(2);
}

const conventions = loadConventions();

async function graphql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors || json)}`);
  }
  return json.data;
}

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

const threads = await fetchReviewThreads();

const aiThreads = threads
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
      excerpt: String(first.body).replace(/\s+/g, " ").slice(0, 120),
    };
  })
  .filter(Boolean);

const blocking = aiThreads.filter(
  (t) => !t.resolved && !t.outdated && isBlocking(t.severity, conventions)
);
const openNonBlocking = aiThreads.filter(
  (t) => !t.resolved && !t.outdated && !isBlocking(t.severity, conventions)
);

// --- report ---------------------------------------------------------------

const lines = [];
lines.push(`## Review gate`);
lines.push("");
lines.push(
  `AI review threads: ${aiThreads.length} total, ` +
    `${blocking.length} unresolved blocking, ${openNonBlocking.length} unresolved non-blocking.`
);
if (blocking.length) {
  lines.push("");
  lines.push(`### Unresolved blocking comments`);
  lines.push("");
  for (const t of blocking) {
    lines.push(`- **[${t.severity}]** \`${t.path}\` — ${t.excerpt}… ([thread](${t.url}))`);
  }
  lines.push("");
  lines.push(
    "Fix the issue, or reply with your reasoning, then **resolve the thread**. " +
      "The gate re-runs when a thread is resolved."
  );
} else {
  lines.push("");
  lines.push("No unresolved blocking AI comments — gate passed.");
}
const summary = lines.join("\n");
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n");
}

process.exit(blocking.length ? 1 : 0);
