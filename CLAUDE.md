# CLAUDE.md

This repository is a convention-as-code review pipeline. The review rules live
in `review-conventions.yml`; everything below the marker line is generated from
it — edit the YAML and run `npm run sync`, never the generated block.

When reviewing pull requests in this repository (or any repository that adopts
this template), follow the conventions in the generated section exactly.

<!-- preason:conventions:start -->
<!-- Generated from review-conventions.yml by scripts/sync-conventions.mjs — do not edit by hand. -->

## Code review conventions

Severity contract: every review comment starts with one of `[blocker]`, `[warn]`, `[nit]`. Untagged comments are treated as `[warn]`. Unresolved `[blocker]` comments block the merge gate.

Write all review comment prose in Korean. The severity tag itself must remain exactly as written above — it is machine-parsed by the merge gate.

### How much to say

- Leave at most 10 comments on a pull request. If more than that seem warranted, report only the 10 most consequential. A reviewer that comments on everything gets ignored on everything.
- Finding nothing is a correct and expected outcome. Do not manufacture a finding to demonstrate that you reviewed the code; say you found nothing.
- Every comment must point at a specific line that this diff changed, and quote the offending code. If you cannot quote the line, drop the finding.
- A [blocker] comment must include a concrete fix — a code suggestion where one applies. A finding that only describes a problem is far less likely to be acted on; if you cannot propose a fix, say what you would need to know to propose one.

### Do not flag

- Style, formatting, naming taste, or import ordering — a linter or formatter owns those, not a reviewer.
- Theoretical risks that need preconditions the surrounding code makes unlikely or impossible.
- Defense-in-depth suggestions where the primary defense is already present and adequate.
- Restating what the code does, summarizing the diff, or praising it.
- Speculative performance concerns with no measurement and no concrete input size.
- Requests for tests, docs, or error handling on code paths this diff does not change.
- Anything you cannot point at a specific changed line for.

### All files

- Start every review comment with a severity tag as the first token: [blocker], [warn], or [nit]. Comments without a tag are treated as [warn].
- [blocker] means the PR must not merge as-is: correctness bugs, security holes, data loss or corruption, breaking API changes, secrets in code.
- [warn] means fix-worthy but mergeable: missing error handling on likely failure paths, misleading names, missing tests for changed behavior.
- [nit] means style or preference. Never mark formatting, naming taste, or micro-optimizations higher than [nit].
- Review the diff against the PR description. If the code does something the description does not mention (scope creep, drive-by changes), point it out as [warn].
- When you suspect an N+1 query or unbounded loop over external data, ask for query logs or measurements rather than asserting.

### migrations (`**/migrations/**`)

- [blocker] any destructive operation (DROP, DELETE, column removal, type narrowing) unless the PR description states a rollback and backfill plan.
- Check that the migration is reversible, or that irreversibility is explicitly acknowledged in the PR description.
- Flag long-running migrations on large tables (full-table rewrites, non-concurrent index builds) as [warn] with a suggested safer path.

### payments (`**/payments/**`)

- [blocker] any retryable payment operation that is not idempotent (missing idempotency key, non-transactional state change).
- [blocker] amounts handled as floating point. Money must be integer minor units or a decimal type.
- Verify failure paths: what happens when the PG call times out after the charge succeeded? Ask if the reconciliation path is unclear.

### auth (`**/auth/**`)

- [blocker] tokens, passwords, or secrets logged, stored in plain text, or returned in API responses.
- Check authorization, not just authentication: does every new endpoint verify the caller may act on the target resource?

<!-- preason:conventions:end -->
