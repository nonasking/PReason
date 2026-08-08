# PReason — design and behavior

What the pipeline is, what runs when, and why each piece is shaped the way it
is. This describes the system **as currently implemented**; open work is listed
at the end.

For per-option configuration syntax see [configuration.md](configuration.md).

---

## 1. The problem being solved

AI-assisted development multiplies PR volume past the point where anyone can
genuinely review everything. Teams don't announce that they've stopped
reviewing — they keep approving, faster and with fewer comments, and the
approval stops carrying information.

This is measured, not folklore. Across 11,429 reviews of agent-authored PRs over
seven months, the same reviewers' approval rate rose 30.1% → 36.8% while their
inline comment volume fell 22%; human-authored PRs in the same repos moved the
other way, so it is habituation rather than easier code. Separately, in
telemetry across 22,000 developers, PRs merged with no review at all rose 31.3%
while median review time rose ~5×.

Bolting an AI reviewer on does not fix this by itself, and can make it worse:

- **Precision is low.** Independent benchmarks put naive LLM-on-diff review at
  roughly 15–31% precision. Production systems that reach ~75% do it by
  spending most of their engineering on *suppressing* findings, not generating
  them.
- **Noise is self-defeating.** The most-cited failure across practitioner
  reports is a threshold effect: past some comment volume, teams start clicking
  "resolve all" and then ignore the tool's *correct* findings too. Reported
  volumes cluster at 10–30 comments per PR; a well-tuned in-house reviewer runs
  at ~1.2 findings per review.
- **Reading an AI review first narrows human attention.** In a controlled
  experiment, reviewers given an AI review first inspected 371 lines versus 484
  when reviewing manually — 54% of the lines examined in the manual condition
  were never looked at — found no more high-severity issues, took *longer*, and
  kept 89% of the AI's findings.

So the design cannot be "AI finds things, human confirms." That arrangement is
where the anchoring damage happens.

## 2. The shape of the answer

PReason's position: **an AI finding must be resolved or reasoned away before a
human is asked to look, and the human's job is to review that reasoning.** Three
mechanisms carry it.

1. **One convention source.** Review rules live in a single YAML file compiled
   into each tool's config format. Rules are enforceable because every finding
   must carry a severity tag from a fixed vocabulary.
2. **A merge gate.** Unresolved AI findings tagged as blocking hold a required
   status check red. The author fixes them or rebuts them in the thread. Nothing
   is silently ignored, and the rebuttals become the artifact the human reads.
3. **Tiered single-human assignment.** Exactly one named human is requested,
   and only after the gate is green. Risk paths escalate; fully-exempt diffs
   skip the human entirely.

What this deliberately does *not* do: remove the human, auto-approve, or
auto-merge. Approval and merge stay human, which is what keeps the audit chain
and the accountability intact.

---

## 3. Components

```
review-conventions.yml ──[sync]──▶ CLAUDE.md (marked block)
   (single source)                 .github/copilot-instructions.md (marked block)
                                   .github/instructions/<scope>.review.instructions.md
                                   .coderabbit.yaml
        │
        │ (same file, read at runtime)
        ▼
   scripts/review-gate.mjs      ← severity contract, AI reviewer list, gate policy
   scripts/assign-reviewer.mjs  ← reviewer pool, counts, risk/exempt paths
```

| Path | Role |
|---|---|
| `review-conventions.yml` | Single source of truth. Read both at build time (sync) and at run time (gate, assignment). |
| `scripts/lib/conventions.mjs` | Loader + validator + shared logic: severity parsing, AI-login matching, glob matching, finding fingerprints, markdown rendering. |
| `scripts/sync-conventions.mjs` | Compiles the YAML into every tool config. `--check` mode fails CI on drift. |
| `scripts/review-gate.mjs` | The merge gate. |
| `scripts/lib/verify.mjs` | Adversarial verification of blocking findings. Fails safe. |
| `scripts/assign-reviewer.mjs` | Risk labeling and human reviewer assignment. |
| `.github/workflows/claude-review.yml` | Claude first-pass review. |
| `.github/workflows/review-gate.yml` | Gate, then assignment. |
| `scripts/conventions.test.mjs` | Unit tests for the pure logic above (`npm test`). |
| `.github/workflows/ci.yml` | Runs the unit tests and the drift check. |

Runtime dependencies: Node 20, `js-yaml`, and `@anthropic-ai/sdk` (used only by
the verifier). Nothing else.

### Generated files

`CLAUDE.md` and `.github/copilot-instructions.md` are **partially** generated —
only the region between `<!-- preason:conventions:start -->` and
`<!-- preason:conventions:end -->` is replaced, so hand-written content in those
files survives. `.github/instructions/*.review.instructions.md` and
`.coderabbit.yaml` are fully generated; scope files whose scope disappears from
the YAML are deleted on the next sync. `sync --check` reports stale scope files
as drift.

---

## 4. Runtime flow

### 4.1 On a PR from a branch in the repo

```
PR opened / pushed
   │
   ├─▶ Claude review workflow
   │      • skips drafts and forks
   │      • excludes bot comments from context
   │      • posts inline comments, each tagged [blocker] / [warn] / [nit]
   │
   └─▶ Review gate workflow
          │
          ├─ 1. preflight   draft → pass · fork → see 4.2
          ├─ 2. size        over the limit → label, and FAIL if size.action is block
          ├─ 3. collect     GraphQL reviewThreads, keep threads opened by an AI reviewer
          ├─ 4. fail-closed no AI reviewer left any trace → FAIL
          ├─ 5. dedup       drop re-posts of findings already resolved
          ├─ 6. verify      each blocking finding gets an adversarial second opinion
          ├─ 7. verdict     any surviving blocking finding → FAIL
          │
          └─ 8. assign      (only reached when the gate passed)
                 risk path      → label + risk_count reviewers from risk_reviewers
                 all exempt     → no human
                 otherwise      → count reviewers from pool
```

Both steps run in one job, so assignment only happens on a green gate.

### 4.2 Fork PRs

Fork PRs receive a read-only `GITHUB_TOKEN` and no repository secrets, so AI
review cannot run at all — and `pull_request_target` is no longer an escape
hatch, since `actions/checkout` v7 refuses to check out fork refs.

Handling: the Claude workflow skips forks outright. The gate detects the fork
and, under the default `gate.fork_policy: skip`, passes with an explanatory
summary and applies the risk label (best-effort — the label write itself may be
denied by the read-only token, which is tolerated). Assignment then exits early,
because every write it would make would 403 and fail the job.

Net effect: outside contributions route to full human review instead of becoming
permanently unmergeable behind a required check. `fork_policy: block` inverts
this if you'd rather refuse them.

---

## 5. The severity contract

Every AI review comment must begin with a severity tag as its **first token**.
The vocabulary is configurable; the default is:

| Tag | Meaning | Gate |
|---|---|---|
| `[blocker]` | Must not merge as-is: correctness, security, data loss, breaking API change, secrets | Blocks |
| `[warn]` | Fix-worthy but mergeable | Reported |
| `[nit]` | Style or preference | Reported |
| *(absent)* | Treated as `severity.default` (`warn`) | Reported |

Parsing accepts `[blocker]`, `**[blocker]**`, and `blocker:` forms, and only at
the start of the comment — a tag mentioned mid-sentence does not count.

**Untagged comments fall back rather than fail.** Instruction compliance is not
reliable: benchmarks put strict instruction-following under 30%, and GitHub
documents that Copilot code review ignores comment-format instructions
outright. Defaulting to `warn` means a dropped tag can neither silently block
nor silently unblock a merge. Set `severity.default: blocker` to fail closed
instead.

**Reviewers that cannot tag are separated out rather than trusted.** Copilot
cannot be made to emit the prefix, and its native High/Medium/Low severity is UI
metadata no API exposes — so it lives in `advisory_reviewers`. Advisory findings
count as "a review happened" and are reported in the summary, but can never
block, whatever they are tagged with. Without that split, every Copilot comment
would inherit `severity.default`, and flipping that to a blocking tag to fail
closed would turn all of them into blockers at once.

---

## 6. The gate, step by step

`scripts/review-gate.mjs`, run as the `gate` job. Make it a required status
check for it to mean anything.

**Step 2 — size.** Changed lines and files are counted with generated and
vendored paths excluded (`size.exclude`). Over the limit, the PR is labeled;
with `size.action: block` the gate fails here, which also avoids spending
verification budget on a diff that has to be split anyway. The default is
`warn`, so adopting the template never blocks an in-flight PR by surprise —
`block` is the setting the evidence supports.

**Step 3 — collect.** Review threads come from GraphQL (`isResolved` is not in
REST), paginated at 100. A thread counts as an AI thread when its *first*
comment's author matches `ai_reviewers`; `[bot]` suffixes are stripped and case
is ignored. Only inline review threads participate — top-level PR comments and
review summaries are not resolvable on GitHub, so they cannot take part in a
resolve-to-proceed loop.

**Step 4 — fail closed on a missing reviewer.** `claude-code-action` can exit 0
having posted nothing (its comment MCP server failing to initialize is a known
failure mode), and a depleted Copilot credit pool stops reviews org-wide. In
both cases "no findings" and "the reviewer died" are indistinguishable. When
`gate.require_ai_review` is on and no AI thread exists, the gate checks reviews
and PR comments for any AI trace before failing — so a genuinely clean review
still passes.

**Step 5 — dedup re-posted findings.** AI reviewers re-post findings the author
already declined: each re-run opens a *new* thread for the same comment, so a
rebutted `[blocker]` would resurrect and re-block on every push. Resolved AI
findings are fingerprinted and matching re-posts are ignored.

The fingerprint is the file path plus a normalized prefix of the comment prose,
with the severity tag, code blocks, inline code, and punctuation stripped, and
**not** the line number (which shifts on rebase). Exact and near-exact re-posts
collide; a genuinely reworded finding does not, and is treated as new. Ignored
re-posts are counted in the summary so the noise stays visible.

**Step 6 — verify.** A blocking tag is the reviewing model's own severity
judgement, and models rate findings more severe than humans do. Blocking merges
on an unfiltered first pass is exactly how a reviewer earns the "resolve all
without reading" response. So each blocking finding gets an independent call
asked to **refute** it; only survivors hold the merge.

The verifier sees the finding and the changed lines of that file — nothing
else. Diff-only context is deliberate: on published benchmarks review models get
monotonically *worse* as surrounding context is added, and it is also the
cheapest option. Refuted findings stay visible in the summary, collapsed.

**Verdicts are sticky.** The gate mirrors its report into a PR comment (authors
don't read the Actions tab; a red check whose reason takes three clicks to find
reads as flaky CI), and that comment carries a hidden per-finding verdict cache.
A finding judged once keeps its verdict until its thread is resolved. Without
this, every event would re-bill verification for still-open blockers — and since
model calls are not deterministic, a verdict could flip between runs and the
gate would flap with no code change. Only settled verdicts are cached;
`unverified` retries on the next run. The gate's own comment is excluded from
the fail-closed "did any AI post?" check, since it shares the `github-actions`
login with claude-code-action.

Everything fails safe: a missing `ANTHROPIC_API_KEY`, an API error, a safety
refusal, or unparseable output all leave the finding blocking and marked *not
verified*. A broken verifier makes the gate noisier, never more permissive.
Disable it with `verification.enabled: false` to gate on the first pass alone.

**Step 7 — verdict.** Fails if any unresolved, non-outdated, non-deduped AI
thread carries a tag in `severity.block_on` and survived verification. Outdated
threads (the diff hunk changed underneath) do not block — otherwise a force-push
strands a permanent red check.

**How the author clears it.** Fix the code, or reply in the thread with the
reasoning, then resolve the thread.

### Re-triggering — the awkward part

GitHub exposes thread resolution as a webhook (`pull_request_review_thread`) but
**not as an Actions trigger**; the request has been open since March 2022. So
resolving a thread cannot re-run the gate by itself.

| Action | Re-runs the gate |
|---|---|
| Replying in a review thread | ✅ |
| Commenting on the PR | ✅ |
| Pushing a fix | ✅ |
| The Claude review workflow finishing | ✅ (`workflow_run`) |
| An AI reviewer submitting a review via a GitHub App | ✅ |
| Toggling `gate.recheck_label` | ✅ (manual escape hatch) |
| Resolving a thread with no reply | ❌ |

The `workflow_run` trigger closes a subtle hole: **events created with the
workflow `GITHUB_TOKEN` do not trigger workflows.** When claude-code-action
posts its review with that token, the resulting comment events would never
re-run the gate — the gate would sit red on "no AI review yet" until the author
happened to push or comment. Re-running when the review workflow *completes*
covers it regardless of how the review was posted, and also settles the
ordering race between the review and the first gate run.

This lands in a defensible place: the rebuttal you actually write is what clears
the gate, which is the behavior the design wants anyway. For exact re-runs on
resolution, run a receiver subscribed to the webhook that fires
`repository_dispatch` with type `review-thread-changed` and
`client_payload.pr_number` — the workflow already accepts it.

### The gate runs trusted code, not PR code

On `pull_request` events the default checkout is the PR merge ref — which would
let any PR weaken `review-conventions.yml` or the gate script itself and then
pass its own weakened gate. The gate job therefore checks out the **default
branch** and runs the scripts and conventions from there, whatever the PR
contains. Consequence: a PR that changes the conventions is still gated under
the *old* rules; the change takes effect on subsequent PRs. (This matches how
`claude-code-action` treats `CLAUDE.md`, and turns the "two-merge rollout" for
convention changes from a caveat into the defined behavior.)

### Known limit: the author can resolve their own threads

GitHub permits the PR author to resolve any thread on their own PR, and does not
offer an author-settable "addressed" state distinct from a reviewer-settable
"resolved" one. A determined author can therefore clear a `[blocker]` with one
click and no code change.

**The gate is a nudge, not a control.** It reliably catches the accidental
forget-to-address case and does not stop deliberate bypass. Making it a control
requires something the author cannot unilaterally clear — a human approval
post-dating the last unresolved blocker, or a resolver-≠-author check (which
needs the webhook receiver, since the resolving actor only appears in the
webhook payload).

---

## 7. Reviewer assignment

`scripts/assign-reviewer.mjs`, run after the gate passes. Idempotent: exits
early if any non-AI reviewer is already requested or has already reviewed.

Three tiers, checked in order:

| Tier | Trigger | Effect |
|---|---|---|
| **Risk** | any changed file matches `risk_paths` | `risk_label` applied; `risk_count` reviewers from `risk_reviewers` (falls back to `pool`) |
| **AI-only** | *every* changed file matches `exempt_paths`, and no risk path | no human assigned |
| **Normal** | everything else | `count` reviewers from `pool` |

The risk label is applied even when a human is already involved, so the label
reliably reflects the diff. `count: 0` disables human assignment for that tier.

**Why exactly one named human.** Assigning a team diffuses responsibility and
the PR sits. At Meta, resolving team-assigned diffs to one randomly chosen named
individual cut time-in-review 11.6% with no quality cost. Broad CODEOWNERS
globs produce the opposite: 20–30 requests a day to the same tech lead.

**Selection ranks expertise first, then balances load within it**
(`reviewers.strategy: expertise`, the default):

1. Filter out candidates whose GitHub status is "busy" — unless that empties the
   pool, in which case availability is ignored rather than leaving the PR
   unassigned. Availability-blind assignment is a documented way to make PRs
   stall with nobody noticing.
2. Score expertise by commits touching the changed files (the ten largest files
   in the diff, 30 commits back each). Candidates with at least one commit form
   the expert set; if nobody qualifies, the whole pool is used.
3. Sort by open review load ascending, then expertise descending, then login for
   a stable tiebreak.

**Balancing load *within* the expert set rather than across everyone is the
load-bearing detail.** Meta found that recommending a low-workload but
inappropriate reviewer just made authors scroll down the list and pick someone
else — the balancing evaporates. Restricting it to people who know the code keeps
it effective. The PR author is always excluded, and the picks' commit counts and
queue depths are logged so a surprising choice is explainable.

`strategy: rotation` restores the older behavior — `PR number % pool size`,
deterministic and even over time, but blind to expertise and queue depth. Teams
that want GitHub's native load-balancing can empty `pool` and use a team's
auto-assignment; the gate and tiering still work.

---

## 8. Convention sync

`sync-conventions.mjs` compiles the YAML into four outputs and `--check` fails
CI when any is stale. The drift check is what makes the single source real
rather than aspirational.

**Two caveats worth knowing.**

*Instruction files are weaker than they look.* An ETH Zurich study found context
files raised inference cost by over 20% with no gain in task success, and strict
instruction-following benchmarks sit under 30%. Keep rules short and concrete;
prefer good/bad code examples over prose.

*Copilot and Claude read the convention file from different refs.* Since July
2026 Copilot code review reads instructions from the PR **head** and natively
supports `CLAUDE.md`; `claude-code-action` deliberately restores `CLAUDE.md`
from the **base** branch as prompt-injection defense. A PR that edits the
conventions is therefore reviewed by Copilot under the new rules and by Claude
under the old ones. Expect a two-merge rollout for convention changes, or exempt
convention-only PRs from the gate.

Because Copilot now reads `CLAUDE.md` directly, the Copilot-specific sync
outputs are largely redundant for new setups; they remain useful for repos that
already depend on `copilot-instructions.md` and for path-scoped `applyTo` rules.

---

## 9. Cost and latency

Measured for the open-source `claude-code-action` path: roughly **$0.73 for a
338-line PR** and **$1.34 for a 598-line PR** on an Opus-tier model — mildly
superlinear. The dominant cost is *not* the diff: that 338-line review consumed
~619k input tokens, almost all of it the agent reading the repository.

Levers, in order of effect: `--max-turns` (set to 30), a tight `--allowed-tools`
list (every extra tool invites more exploration), scoping review to changed
files, and keeping the convention file short.

The job carries `timeout-minutes: 20`. Reviews have been reported hanging to the
6-hour Actions cap around 20% of the time in some setups; an unbounded review
pinning a required check is worse than a failed one.

**Verification adds a second, much smaller bill.** It runs once per *blocking
finding* — not per PR — and sees only the finding plus that file's patch, so
each call is small. On a repo where blockers are rare, which is the intended
steady state, this is noise next to the review itself. `verification.votes`
multiplies it linearly.

For comparison: Anthropic's hosted Code Review product is a different thing at a
different price point ($15–25 per review). This pipeline uses the action.

---

## 10. Configuration surface

One file, `review-conventions.yml`, validated on every load — all errors are
reported at once rather than one per run.

| Section | Controls |
|---|---|
| `severity` | Tag vocabulary, default for untagged comments, which tags block |
| `gate` | `require_ai_review`, `recheck_label`, `fork_policy` |
| `verification` | Whether blocking findings get a second opinion, and the model/votes |
| `size` | Changed-line and file limits, warn vs block, exclusions |
| `review` | Comment budget, evidence and fix requirements, the do-not-flag list |
| `ai_reviewers` | Which GitHub logins the gate manages |
| `reviewers` | `pool`, `count`, `risk_count`, `risk_label` |
| `risk_paths` / `risk_reviewers` / `exempt_paths` | Tiering |
| `rules.global` / `rules.scoped` | The conventions themselves |

Full syntax: [configuration.md](configuration.md).

---

## 11. What is not built yet

Ordered by expected value, from the research that shaped the current design.

**Verified end to end.** Every runtime path that talks to GitHub or the Anthropic
API is exercised only by opening a real PR. The unit tests cover the pure logic
and the fail-safe branches; the API request shapes (the verifier's structured
output in particular) are unproven until the first live run. Verification failing
cannot let a merge through — it marks findings *not verified* and blocks — so the
failure mode is noise, not a hole.

**Mentorship protection.** The most-cited soft failure of AI review is juniors
who stop learning: submit, get AI feedback, apply, merge. It shows up months
late and never in a dashboard. Nothing in the current design addresses it.

---

## 12. Positioning note

Multi-tool convention sync is the most visible feature, but the evidence points
toward running **one** AI reviewer, not several: teams running several report
that the tools' findings do not fully overlap yet miss the same things, while
the noise multiplies. Sync is best understood as a consistency tool for
organizations that already have several reviewers enabled — often not by choice
— rather than as an encouragement to add more.

The parts of this design that are actually load-bearing are the gate, the
tiering, and the single named human.
