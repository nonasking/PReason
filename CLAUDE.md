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

### All files

- Start every review comment with a severity tag as the first token: [blocker], [warn], or [nit]. Comments without a tag are treated as [warn].
- [blocker] means the PR must not merge as-is: correctness bugs, security holes, data loss or corruption, breaking API changes, secrets in code.
- [warn] means fix-worthy but mergeable: missing error handling on likely failure paths, misleading names, missing tests for changed behavior.
- [nit] means style or preference. Never mark formatting, naming taste, or micro-optimizations higher than [nit].
- Review the diff against the PR description. If the code does something the description does not mention (scope creep, drive-by changes), point it out as [warn].
- Prefer few high-signal comments over many shallow ones. Do not restate what the code does; only comment where something should change or a genuine question exists.
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
