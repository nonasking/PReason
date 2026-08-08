# PReason

**A convention-as-code review pipeline: define your team's review rules once,
have every AI reviewer follow them, and cut human review down to one person
spending five minutes per PR.**

*PR + reason* — every AI finding must be resolved or reasoned away before a
human is asked to look, and the human's job is to review that reasoning.

AI-assisted development multiplies PR volume until nobody can genuinely review
everything — so teams quietly fall back to rubber-stamp approvals. This repo is
a template for a different deal:

1. **AI does the first pass** (Claude, Copilot, CodeRabbit — any or all),
   all reading the *same* rules with a mandatory severity tag on every comment.
2. **A merge gate holds the PR** while any unresolved `[blocker]` comment
   exists. The author fixes it, or rebuts it in a reply — either way they must
   resolve the thread to proceed. No silently ignored AI feedback.
3. **One human reviewer is auto-assigned** only after the gate passes. Their
   job is not to re-read the diff; it is to review the *review* — the PR
   description, the AI findings and how the author handled them, and the risk
   spots. Diffs touching risk paths (payments, auth, migrations) get labeled
   and escalated to designated reviewers.

```
review-conventions.yml            ← the single source of truth
   ├─→ CLAUDE.md                  → Claude (claude-code-action)
   ├─→ .github/copilot-instructions.md
   │   .github/instructions/*.md  → GitHub Copilot code review
   └─→ .coderabbit.yaml           → CodeRabbit (optional)
              │
              ▼  AI reviews, every comment tagged [blocker]/[warn]/[nit]
   ┌─────────────────────────────┐
   │ review-gate (status check)  │  unresolved [blocker] → check fails
   └─────────────────────────────┘
              │  gate passes
              ▼
   one human reviewer assigned    risk paths → label + designated reviewer
```

The point isn't "set up AI review" — that's one workflow file. The point is
that the conventions, the gate, and the human role are **one coherent system**:
conventions force severity tags, severity tags make the gate precise, and the
gate makes the single human reviewer's five minutes actually sufficient.

## Quickstart

1. **Use this repo as a template** (or copy `review-conventions.yml`,
   `scripts/`, `.github/workflows/`, and `package.json` into an existing repo).
   PReason has no runtime of its own — it is these files plus one dependency.

2. **Edit `review-conventions.yml`** — your rules, your risk paths, your
   reviewer pool:

   ```yaml
   reviewers:
     pool: [alice, bob, carol]   # random-pick candidates
     count: 1                    # reviewers per PR (0 = AI + gate only)
     risk_count: 2               # extra eyes on risky diffs
   risk_reviewers: [tech-lead]   # gets risk-path PRs instead
   exempt_paths: ["docs/**"]     # AI-only tier: no human assigned
   ```

   Every knob — custom severity tags, gate strictness, reviewer counts, risk
   and exempt tiers, path-scoped rules — is documented in
   [docs/configuration.md](docs/configuration.md). The loader validates the
   file on every run, so a misconfiguration fails with a readable error list.

3. **Regenerate the tool configs** and commit everything:

   ```sh
   npm install
   npm run sync
   ```

4. **Add the `ANTHROPIC_API_KEY` secret** (repo → Settings → Secrets) for the
   Claude review workflow. Skip this if you only use Copilot/CodeRabbit —
   delete `.github/workflows/claude-review.yml` in that case.

5. **Enable branch protection** on your default branch:
   - Required status check: `gate` (from the *Review gate* workflow) — this is
     what makes the pipeline enforceable rather than advisory.
   - Optionally require 1 approving review, so the auto-assigned human must
     actually approve.

6. Open a PR and watch the pipeline run.

## How the gate decides

`scripts/review-gate.mjs` reads every review thread on the PR via GraphQL and
keeps only threads started by a configured AI reviewer (`ai_reviewers` in the
YAML, `[bot]` suffixes ignored). Each thread's severity is parsed from the
first token of its first comment:

| First token | Severity | Gate behavior |
|---|---|---|
| `[blocker]` | blocker | **fails** the check until the thread is resolved |
| `[warn]` | warn | reported, does not block |
| `[nit]` | nit | reported, does not block |
| *(none)* | `severity.default` (warn) | tools don't always comply — untagged comments fall back safely |

Resolving a thread (fix or rebuttal) re-triggers the workflow via the
`pull_request_review_thread` event, so the check flips green without a manual
re-run. Outdated threads (code changed underneath) don't block.

## What each file does

| Path | Role |
|---|---|
| `review-conventions.yml` | Single source: severity contract, AI reviewer logins, reviewer pool, risk paths, review rules (global + path-scoped) |
| `scripts/sync-conventions.mjs` | Compiles the YAML into every tool config; `--check` mode fails CI on drift |
| `scripts/review-gate.mjs` | The merge gate (unresolved blocking AI threads → red check) |
| `scripts/assign-reviewer.mjs` | Risk labeling + deterministic single-reviewer assignment after the gate passes |
| `.github/workflows/claude-review.yml` | Claude first-pass review via `anthropics/claude-code-action` |
| `.github/workflows/review-gate.yml` | Runs gate then assignment on PR / review / thread-resolution events |
| `.github/workflows/conventions-drift.yml` | Fails if generated configs don't match the YAML source |
| `CLAUDE.md`, `.github/copilot-instructions.md`, `.github/instructions/*`, `.coderabbit.yaml` | **Generated** — never edit by hand |

## Platform constraints this works around

These are GitHub and tooling realities that a naive version of this pipeline
gets wrong. Each is handled in code; see [docs/configuration.md](docs/configuration.md).

- **Thread resolution is not an Actions trigger.** `pull_request_review_thread`
  exists only as a webhook (open request since 2022). The gate re-runs on
  replies, comments, pushes, and a label toggle instead — and accepts a
  `repository_dispatch` if you run a webhook receiver.
- **A silent reviewer looks like a clean review.** `claude-code-action` can exit
  0 having posted nothing. `gate.require_ai_review` fails closed instead.
- **Fork PRs cannot run AI review** (read-only token, no secrets, and
  `pull_request_target` is closed off since `actions/checkout` v7). They pass the
  gate with a note and route to human review.
- **AI reviewers re-post findings you declined** on every re-run. The gate
  fingerprints resolved findings so a rebutted blocker stays rebutted.
- **Reviews are biased by prior comments, including the reviewer's own** — so
  the Claude workflow excludes bot comments from its context.
- **Copilot ignores comment-format instructions** by GitHub's own documentation,
  and its native High/Medium/Low severity is not exposed via any API. Treat
  Copilot as advisory; it is not a reliable participant in a parsed gate.

## Design notes & limitations

- **Untagged comments degrade gracefully.** Copilot's instruction files are
  advisory, so it sometimes omits the severity tag. Untagged AI comments are
  treated as `severity.default` (`warn`), which keeps the gate conservative:
  a missing tag can never silently block — or silently unblock — a merge.
  If you'd rather fail closed, set `default: blocker`.
- **The gate reads inline review threads only.** Top-level PR comments and
  review summaries aren't resolvable on GitHub, so they can't participate in
  a resolve-to-proceed loop. Configure your AI reviewers to leave inline
  comments (the bundled Claude workflow already does).
- **Reviewer pick is deterministic**, not random: `PR number % pool size`.
  Same fairness over time, zero reshuffling on re-runs. If you want GitHub's
  native load-balancing instead, use a team with *Code review → Auto
  assignment* and empty the `pool` — the gate and risk escalation still work.
- **Rebuttals are honored by design.** Resolving a thread with a reply counts
  as handling it. The human reviewer sees the rebuttal in the thread history —
  that's exactly the kind of judgment call their five minutes are for.
- **Cost:** with `claude-opus-5` a typical PR review runs a few tens of cents;
  swap the model in `claude-review.yml` (`--model claude-haiku-4-5`) for
  high-volume/low-risk repos. Your Anthropic console shows per-run token usage,
  so the template doubles as a cost-measurement rig before a team-wide rollout.

## 한국어

[docs/README.ko.md](docs/README.ko.md)

## License

[Apache-2.0](LICENSE)
