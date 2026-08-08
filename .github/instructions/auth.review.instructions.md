---
applyTo: "**/auth/**"
---

<!-- Generated from review-conventions.yml by scripts/sync-conventions.mjs — do not edit by hand. -->

# Review conventions: auth

Severity tags ([blocker], [warn], [nit]) are mandatory as the first token of every review comment.

- [blocker] tokens, passwords, or secrets logged, stored in plain text, or returned in API responses.
- Check authorization, not just authentication: does every new endpoint verify the caller may act on the target resource?
