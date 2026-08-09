# Configuration reference

Everything is customized in one file: **`review-conventions.yml`**. After any
edit, run `npm run sync` and commit the regenerated files — CI fails on drift,
and the same loader validates the file on every run, so a typo surfaces as a
readable error list instead of silent misbehavior.

```sh
npm run sync    # recompile tool configs from the YAML
npm run check   # validate + verify generated files are in sync (what CI runs)
```

## `sync` — which tool configs are generated

```yaml
sync:
  targets: [claude, agents, copilot, coderabbit]
```

| Target | Generates | Read by |
|---|---|---|
| `claude` | `CLAUDE.md` (marked block) | claude-code-action, Claude Code |
| `agents` | `AGENTS.md` (marked block) | most other AI tools — Codex, Cursor, Gemini CLI, Copilot (since 2026-07) |
| `copilot` | `.github/copilot-instructions.md` + `.github/instructions/*` | GitHub Copilot code review |
| `coderabbit` | `.coderabbit.yaml` | CodeRabbit |

Remove targets you don't use. Fully-generated files of a removed target
(`.coderabbit.yaml`, the instructions directory) are deleted on the next sync;
marked-block files are left alone since they may carry your own content.

`AGENTS.md` is how you reach reviewers PReason has no dedicated target for —
see *Adding another AI reviewer* below.

## Adding another AI reviewer

The pipeline is reviewer-agnostic: the gate reads GitHub review threads and
does not care what posted them. Any reviewer participates by meeting a
three-part contract:

1. **It reads the conventions.** Most tools read `AGENTS.md` (keep the `agents`
   sync target). Tools with their own config format can get a dedicated sync
   target — that is the only PReason code a new tool might need.
2. **It posts inline review comments** under a stable bot login, and posts
   *something* (a summary comment) when it finds nothing — otherwise the
   fail-closed check cannot tell a clean review from a dead reviewer.
3. **Its login is listed** in `ai_reviewers` — or in `advisory_reviewers` if it
   cannot reliably emit the severity tag (that is Copilot's home, and the right
   first home for any tool you're still evaluating).

A workflow skeleton for a hypothetical reviewer:

```yaml
name: Acme review
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
jobs:
  review:
    if: >-
      !github.event.pull_request.draft
      && github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
      - uses: acme/review-action@v1        # must post inline comments
        with:
          api_key: ${{ secrets.ACME_API_KEY }}
          instructions_file: AGENTS.md     # the synced conventions
```

To have the gate re-run when this workflow finishes, add its name to the
`workflow_run.workflows` list in `.github/workflows/review-gate.yml`.

One honest note: the evidence favors running **one** gated reviewer, not
several — teams running many report the tools miss the same things while the
noise multiplies. Add a second reviewer as `advisory_reviewers` first, and
promote it only if its findings earn it.

## `severity` — the tag contract

```yaml
severity:
  tags: [blocker, warn, nit]   # your tag vocabulary, in your order
  default: warn                # what an untagged AI comment counts as
  block_on: [blocker]          # which tags make the gate fail while unresolved
```

- **Custom vocabulary is fully supported.** `tags: [critical, major, minor]`
  with `block_on: [critical]` works end-to-end: the generated instructions tell
  every AI reviewer to use those tags, and the gate parses exactly that list.
  Tags may contain letters, digits, `_`, `-`.
- **Stricter gate:** `block_on: [blocker, warn]` holds the PR on warnings too.
- **Fail-closed:** `default: blocker` treats untagged AI comments as blocking —
  useful if your AI reviewers reliably tag and you want to catch the ones that
  slip.

## `gate` — merge-gate behavior

```yaml
gate:
  require_ai_review: true      # fail when no AI reviewer posted anything
  recheck_label: recheck-gate  # toggle this label to force a re-run
  fork_policy: skip            # skip | block
  hotfix_label: hotfix         # break-glass label; null disables it
  hotfix_allowed: []           # who may apply it; empty = anyone who can label
```

**`hotfix_label` is the break-glass.** A genuine emergency must be able to merge
past every finding, or people route around the gate permanently the first time
it stands between them and an incident fix. Applying the label makes the gate
pass immediately — and loudly: the gate report names who applied it, a human
reviewer is still requested, and **merging the PR opens a post-hoc review issue
automatically** (assigned to the author, with a checklist). Review is deferred,
never erased. Removing the label restores normal gating on the spot.

**The default trusts every engineer** (`hotfix_allowed: []`), and that is the
recommended setting, not an oversight. In an incident, speed beats review, and
the person holding the pager is the one who knows it's an incident — a
permission check in that moment only delays the fix or teaches people to bypass
the system entirely. Autonomy works here because usage is fully visible: the
named applier, the label on the PR, and the post-hoc issue. Set
`hotfix_allowed` to a named group only if your compliance posture demands it;
a label applied by anyone outside the list is called out in the report and
ignored. Note the gate check going green does not bypass an org-level
required-approval rule — handle true emergencies there with a ruleset bypass
list.

**`require_ai_review` closes a fail-open hole.** `claude-code-action` can exit
successfully having posted nothing at all (its comment MCP server failing to
initialize is a known failure mode), and a depleted Copilot credit pool stops
reviews org-wide. In both cases "no blockers found" and "the reviewer died" look
identical. With this on, the gate fails when no configured AI reviewer left any
trace on the PR. Set it to `false` only if the repo intentionally runs no AI
reviewer.

**`fork_policy`.** Fork PRs receive a read-only `GITHUB_TOKEN` and no secrets,
so AI review cannot run on them — and `pull_request_target` is no longer an
escape hatch (`actions/checkout` v7 blocks fork-ref checkout). `skip` passes the
gate with an explanatory note and applies `reviewers.risk_label`, so fork
contributions route to full human review instead of becoming unmergeable behind
a required check. `block` fails them instead.

### Re-triggering the gate

GitHub exposes thread resolution as a webhook (`pull_request_review_thread`) but
**not as an Actions trigger** — the request has been open since March 2022. So
resolving a thread cannot re-run the gate by itself. What does re-run it:

| Action | Re-runs the gate |
|---|---|
| Replying in a review thread | ✅ automatically |
| Commenting on the PR | ✅ automatically |
| Pushing a fix | ✅ automatically |
| An AI reviewer submitting a review | ✅ automatically |
| Adding/removing `gate.recheck_label` | ✅ manual escape hatch |
| Resolving a thread with no reply | ❌ |

This lines the incentive up with the intent: a rebuttal you actually write is
what clears the gate. For an exact re-run on resolution, run a receiver
subscribed to the `pull_request_review_thread` webhook that fires
`repository_dispatch` with type `review-thread-changed` and
`client_payload.pr_number` — the workflow already accepts it.

### Dismissed findings do not resurrect

AI reviewers re-post findings the author already declined: each re-run creates a
brand-new thread for the same comment. The gate fingerprints resolved AI
findings (path + normalized prose, ignoring line numbers, severity tags, and
code blocks) and does not block on a re-post that matches one. Re-posts are
counted in the gate summary so the noise stays visible.

## `verification` — a second opinion before anything blocks

```yaml
verification:
  enabled: true
  model: claude-opus-5
  votes: 1
```

A blocking tag is the reviewing model's own severity judgement, and models rate
findings more severe than humans do. When enabled, every blocking finding gets
an independent call that is asked to **refute** it, with the changed lines as
its only context; only survivors hold the merge. Refuted findings are still
listed in the gate summary (collapsed), so nothing disappears silently.

Requires the `ANTHROPIC_API_KEY` secret. Cost scales with the number of
*blocking* findings, not PRs — on a healthy repo that is a handful a week. And
each finding is judged **once**: the verdict is cached in the gate's PR comment
and reused on every later run until the thread is resolved, so re-runs neither
re-bill nor flip verdicts.

**It fails safe in every direction.** A missing key, an API error, a safety
refusal, or malformed output all leave the finding blocking, and the summary
marks it `not verified`. A broken verifier makes the gate noisier, never more
permissive.

`votes` runs that many independent attempts and refutes only on a majority of
the ones that succeeded. More votes measurably improves accuracy and costs
linearly more; 3 is a reasonable step up for a repo where a wrong block is
expensive.

Set `enabled: false` to gate on the first pass alone.

## `size` — mechanical PR size limit

```yaml
size:
  max_changed_lines: 800
  max_changed_files: 0     # 0 disables this check
  action: warn             # warn | block
  label: oversized-pr
  exclude: ["**/*.lock", "**/generated/**"]
```

Review effectiveness runs 80–90% under ~200 changed lines and falls below 50%
past ~1,000 — and large diffs degrade AI review too, since the reviewer's budget
is spent before it reaches the risky part. Teams that report a working AI-review
process enforce a limit mechanically.

`action: warn` (the default) labels the PR and notes it in the summary, so
adopting this template never blocks an in-flight PR by surprise. **`block` is
what the evidence actually supports** — switch to it once your team has agreed
on a threshold. Blocking also short-circuits verification spend on a PR that has
to be split anyway.

`exclude` keeps lockfiles, snapshots, and generated code out of the count.

## `review` — how much the reviewer should say

```yaml
review:
  max_comments: 10
  require_evidence: true
  allow_no_findings: true
  blocker_requires_fix: true
  suppress:
    - Style, formatting, naming taste, or import ordering — a linter owns those.
    - Theoretical risks that need preconditions the surrounding code makes unlikely.
```

These are compiled into every AI reviewer's instructions as two sections, *How
much to say* and *Do not flag*.

Comment volume is the most-cited reason teams abandon AI review: past some
threshold people start resolving without reading, and then the tool's *correct*
findings get ignored too. Hosted tools commonly land at 10–30 comments per PR; a
well-tuned reviewer runs at 1–2 findings per review.

| Option | Why it's there |
|---|---|
| `max_comments` | A stated budget. The gate reports when open comments exceed it — a signal that `suppress` needs tightening. |
| `suppress` | Negative prompting. Naming what *not* to flag works far better than asking for "high-signal comments". |
| `allow_no_findings` | Asked to find problems, a model will invent them. This makes an empty review an explicitly correct answer. |
| `require_evidence` | "Quote the offending line or drop the finding" — cheap, and it kills findings about code the diff never touched. |
| `blocker_requires_fix` | Attaching a concrete fix is the strongest known predictor of a review comment being acted on; explanation without a fix makes action *less* likely. |

Set any flag to `false`, or `max_comments: 0` / `suppress: []`, to drop that
section from the generated instructions.

## `ai_reviewers` / `advisory_reviewers` — who counts as an AI

```yaml
ai_reviewers: [claude, github-actions, coderabbitai]
advisory_reviewers: [copilot, copilot-pull-request-reviewer]
```

Both lists match with `[bot]` suffixes stripped and case ignored, so `Copilot`,
`copilot[bot]`, and `copilot` are the same login. A login may appear in only one
of the two lists.

| List | Satisfies `require_ai_review` | Can block the merge |
|---|:-:|:-:|
| `ai_reviewers` | ✅ | ✅ |
| `advisory_reviewers` | ✅ | ❌ never |

**Copilot belongs in `advisory_reviewers`.** GitHub documents that Copilot code
review ignores instructions that change comment format, so it cannot be made to
emit a severity tag — and its native High/Medium/Low severity is UI metadata that
no API exposes. Gated, every Copilot comment would inherit `severity.default`,
which silently turns them all into blockers the moment you set that to a blocking
tag. Advisory keeps its findings visible and counted without that trap.

Put a reviewer here whenever you want its output surfaced but not enforced —
a new tool you're evaluating, for instance.

## `reviewers` — how many humans, and who

```yaml
reviewers:
  pool: [alice, bob, carol]   # candidates for assignment
  count: 1                    # reviewers per normal PR (0 = no human assignment)
  risk_count: 2               # reviewers per risk-path PR (defaults to count)
  risk_label: needs-human-review
  strategy: expertise         # expertise | rotation
  criteria:                   # tunes the expertise strategy; defaults shown
    rank: [load, expertise]   # sort keys, in priority order
    availability: true        # skip reviewers whose GitHub status is "busy"
    expertise_files: 10       # sample the N largest changed files
    expertise_commits: 30     # look back N commits per sampled file
```

- **Adjust reviewer count** with `count`; `risk_count` lets risky diffs demand
  more eyes than routine ones.
- **`count: 0`** turns off human assignment entirely (AI + gate only) — e.g.
  for a personal or prototype repo.
- The PR author is always excluded, and assignment is skipped entirely if a human
  reviewer is already requested or has already reviewed.
- Prefer GitHub's native team load-balancing? Leave `pool` empty and enable
  *Team → Code review → Auto assignment*; the gate, labels, and tiering still
  work.

### `strategy: expertise` (default)

Ranks candidates by the criteria you configure. With the defaults: people who
have actually touched the changed files, **least-loaded first within that
group**:

1. Drop anyone whose GitHub status is "busy" (`criteria.availability`). If that
   would empty the pool, the filter is dropped rather than leaving the PR
   unassigned — availability-blind assignment is a documented way to make PRs
   stall silently.
2. Count commits touching the changed files, from the `expertise_files` largest
   files in the diff, looking back `expertise_commits` commits each. Pool
   members with at least one commit form the expert set; if nobody qualifies
   (new area, new hire) the whole pool is used and a note is logged.
3. Sort by `criteria.rank`, in order, then login — so re-runs pick the same
   person. `rank: [load, expertise]` (default) prefers the idle expert;
   `rank: [expertise, load]` prefers the deepest expert even when busy. A key
   left out of `rank` is neither scored nor fetched.

The chosen reviewers' commit counts and open review load are printed in the job
log, so a surprising pick is explainable.

**Why balance load *within* the expert set rather than across everyone:** an
author who receives an unqualified suggestion scrolls past it and picks someone
else, and the balancing is lost. Restricting the balancing to people who know the
code keeps it effective.

Costs: one API call per sampled file (≤10) plus one page of open PRs plus one
batched GraphQL call for availability.

### `strategy: rotation`

Deterministic round robin — `PR number % pool size`, walking forward for
multi-reviewer counts. Even over time and stable across re-runs, but blind to
both expertise and queue depth. Reasonable when the pool is small and genuinely
interchangeable; otherwise prefer `expertise`.

## Risk tiering — `risk_paths`, `risk_reviewers`, `exempt_paths`

Three tiers, checked in this order:

| Tier | Trigger | Effect |
|---|---|---|
| **Risk** | any changed file matches `risk_paths` | `risk_label` applied, `risk_count` reviewers requested from `risk_reviewers` (falls back to `pool`) |
| **AI-only** | *every* changed file matches `exempt_paths` (and none is risky) | no human reviewer assigned |
| **Normal** | everything else | `count` reviewers from `pool` |

```yaml
risk_paths: ["**/migrations/**", "**/payments/**", "**/auth/**"]
risk_reviewers: [tech-lead]
exempt_paths: ["docs/**", "**/*.md", ".github/**"]
```

Globs support `**` (any depth), `*` (within a segment), `?` (one char), and are
matched against repo-relative paths. To make the risk tier *enforce* human
approval (not just request it), add a branch-protection ruleset that requires
1 approving review when the `needs-human-review` label is present.

The gate itself (`[blocker]` blocking) applies to every tier — `exempt_paths`
skips the human, not the AI.

## `rules` — the conventions themselves

```yaml
rules:
  global:
    - Start every review comment with a severity tag...
  scoped:
    - name: frontend          # filename-safe, unique
      applyTo: "web/src/**"   # glob this scope applies to
      rules:
        - Flag any useEffect without a cleanup for subscriptions as [warn].
```

- `global` rules go to every tool for every file.
- Each `scoped` entry becomes a Copilot
  `.github/instructions/<name>.review.instructions.md` (with `applyTo`
  frontmatter), a section of the CLAUDE.md block, and a CodeRabbit
  `path_instructions` entry. Add, rename, or delete scopes freely — `sync`
  creates and prunes the generated files to match.
- Write rules as instructions to a reviewer, and reference your severity tags
  explicitly (`... as [blocker]`) where a rule implies a specific severity.

## Things customized outside the YAML

| What | Where |
|---|---|
| Which AI reviewers run at all | Keep/delete workflow files; enable Copilot review in repo settings |
| Claude model / cost | `--model` in `.github/workflows/claude-review.yml` |
| Making the gate mandatory | Branch protection → required status check `gate` |
| Requiring the assigned human to approve | Branch protection → required approving reviews |
