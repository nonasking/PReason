---
applyTo: "**/payments/**"
---

<!-- Generated from review-conventions.yml by scripts/sync-conventions.mjs — do not edit by hand. -->

# Review conventions: payments

Severity tags ([blocker], [warn], [nit]) are mandatory as the first token of every review comment.

- [blocker] any retryable payment operation that is not idempotent (missing idempotency key, non-transactional state change).
- [blocker] amounts handled as floating point. Money must be integer minor units or a decimal type.
- Verify failure paths: what happens when the PG call times out after the charge succeeded? Ask if the reconciliation path is unclear.
