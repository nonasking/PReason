---
applyTo: "**/migrations/**"
---

<!-- Generated from review-conventions.yml by scripts/sync-conventions.mjs — do not edit by hand. -->

# Review conventions: migrations

Severity tags ([blocker], [warn], [nit]) are mandatory as the first token of every review comment.

- [blocker] any destructive operation (DROP, DELETE, column removal, type narrowing) unless the PR description states a rollback and backfill plan.
- Check that the migration is reversible, or that irreversibility is explicitly acknowledged in the PR description.
- Flag long-running migrations on large tables (full-table rewrites, non-concurrent index builds) as [warn] with a suggested safer path.
