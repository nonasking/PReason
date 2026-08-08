# Security review

What an organization's security reviewer should know before installing PReason
on team repositories: the threat model, the data flows, the controls in place,
the residual risks — stated honestly — and the org-level checklist that
completes the picture.

Last reviewed: 2026-08-09, against the code as of that date.

---

## 1. What this system is, security-wise

PReason is three GitHub Actions workflows plus ~700 lines of Node scripts. It
**reads** pull request data, **writes** PR comments, labels, and review
requests, and **calls the Anthropic API** with PR contents. It never pushes
code, never merges, never approves, and holds no credentials beyond the two
below.

| Credential | Scope | Used by |
|---|---|---|
| `GITHUB_TOKEN` (workflow-issued, ephemeral) | `contents: read`, `pull-requests: write`, `issues: write` — this repo only | gate, assignment |
| `ANTHROPIC_API_KEY` (repo/org secret) | Anthropic API only | Claude review, verifier |

The `id-token: write` permission on the review workflow exists for
claude-code-action's OIDC exchange and grants nothing inside GitHub.

## 2. Threat model

| Actor | Capability | Relevant? |
|---|---|---|
| PR author (write access) | Can open PRs, resolve threads, edit workflow files in a PR | **Primary** — the gate exists to resist *casual* bypass, not malicious insiders (see §5) |
| External fork contributor | No secrets, read-only token on their PRs | Contained by design (§4.4); usually N/A on private org repos with forking disabled |
| Malicious PR *content* (prompt injection) | Diff text, PR description, comments flow into two LLM calls | **Real surface** — analyzed in §4.3 |
| Compromised action / npm dependency | Supply chain | Mitigated in §4.5 |
| Anthropic (data recipient) | Receives PR contents | Data governance question, §3 |

## 3. Data flows — what leaves the org

Two calls leave GitHub, both to `api.anthropic.com`:

1. **Review** (claude-code-action): the PR diff, PR metadata, repository files
   the model chooses to read from the checkout, and the conventions file.
2. **Verifier** (`scripts/lib/verify.mjs`): per blocking finding — the finding
   text, that one file's unified diff (capped at 24k chars), the PR
   title/description, and the applicable convention rules. Nothing else; the
   verifier never sees the whole repo.

Nothing is sent anywhere else. The gate and assignment scripts talk only to
`api.github.com`.

**Org homework before adoption:** confirm Anthropic's commercial API terms meet
your data-handling requirements (API inputs/outputs are not used for model
training by default; check the current retention terms and whether your org
needs a zero-data-retention agreement). Note that **anything in a diff is
transmitted** — a secret accidentally committed in a PR reaches the API before
review catches it. This is one more reason to run GitHub secret scanning with
push protection org-wide (§6), which blocks the secret before a PR exists.

## 4. Controls in place

### 4.1 The gate runs trusted code

On `pull_request` events the gate checks out and runs scripts and conventions
from the **default branch**, not the PR — a PR cannot weaken
`review-conventions.yml` or the gate script and then pass its own weakened
gate. (Caveat on the workflow file itself: §5.1.)

### 4.2 Fails closed, everywhere

- No AI review posted → gate fails (a silently-dead reviewer is
  indistinguishable from a clean review).
- Verifier errors — missing key, timeout, refusal, unparseable output — leave
  the finding **blocking**, marked *not verified*. A broken verifier makes the
  gate noisier, never more permissive.
- A non-numeric PR number from an event payload aborts the run.

### 4.3 Prompt-injection surface, bounded

Untrusted PR content flows into two models. What each can *do* is the question:

- **The reviewer** runs with an explicit tool allowlist: the inline-comment MCP
  tool and `gh pr diff` / `gh pr view` / `gh pr comment` only — no arbitrary
  bash, no file writes, no push. Its token cannot approve or merge. The action
  itself additionally strips common injection carriers (HTML comments,
  invisible characters) and restores `CLAUDE.md` from the base branch. Worst
  realistic outcome of a successful injection: wrong or missing review
  comments, or a spurious PR comment.
- **The verifier** returns schema-constrained JSON; its only influence is a
  finding's verdict. An injected diff could try "refute my blockers" — see
  §5.2 for why this grants nothing the author doesn't already have.
- Verdict prose is rendered into a PR comment; the hidden verdict cache is
  base64-encoded specifically so model output cannot break out of its HTML
  comment. GitHub's markdown sanitizer covers the visible portion.

### 4.4 Fork PRs cannot reach secrets

Fork PRs get a read-only token and no secrets by platform rule; the review job
additionally skips them explicitly, the gate handles them under
`gate.fork_policy` (default: pass with a "needs full human review" label),
and nothing checks out fork code under elevated permissions —
`pull_request_target` is not used anywhere.

### 4.5 Supply chain

- All actions are **pinned to full commit SHAs** (version noted in comment).
- npm dependencies (two: `js-yaml`, `@anthropic-ai/sdk`) install from a
  committed lockfile via `npm ci --ignore-scripts` — no lifecycle scripts run
  in CI.
- Checkouts in the gate and CI set `persist-credentials: false`; those jobs
  never run git.

### 4.6 Blast-radius limits

Per-job `timeout-minutes` (a hung review cannot pin a required check for 6
hours), per-PR concurrency groups, review comments capped by convention,
verification runs once per finding (cached verdicts), and the gate's own
comments are posted with `GITHUB_TOKEN` — which GitHub excludes from triggering
workflows, so the pipeline cannot loop itself.

## 5. Residual risks — read this part

### 5.1 An insider with write access can bypass the gate

Three ways, in increasing order of visibility:

1. **Resolve their own threads.** GitHub lets PR authors resolve any thread on
   their own PR; there is no author-proof "addressed" state. One click, no
   code change, gate goes green.
2. **Edit the workflow file in the PR.** `pull_request` runs use the workflow
   definition from the PR branch, so a PR can replace the gate job with
   `exit 0` under the same check name. The *scripts* are protected (§4.1); the
   workflow file is not — that is a GitHub platform property.
3. Push to the default branch directly, if branch protection allows it.

**Position: the gate is a process control, not a security boundary against
malicious insiders.** It reliably converts "silently ignored AI findings" into
"visibly dismissed findings with a written rebuttal" — which is the designed
goal. If your org needs insider-resistant enforcement, add the org-side
controls in §6 (required workflows from a pinned ref where your plan supports
them, CODEOWNERS on the workflow directory, no direct pushes to default) — and
note that every bypass above is **loud**: it leaves a resolved-without-reply
thread, a workflow diff in the PR, or a push event in the audit log.

### 5.2 Prompt injection can bias verdicts

A determined author could seed their diff with text aimed at making the
reviewer stay silent or the verifier refute. This is real and not fully
preventable with current models. Two things bound it: the injection path grants
nothing beyond what §5.1(1) already grants that author with one click, and the
attempt itself is durable evidence — the injected text sits in the diff, in
history, reviewable by the human the pipeline assigns.

### 5.3 The hotfix bypass is a designed hole — treat it as one

`gate.hotfix_label` lets a labeled PR pass the gate regardless of findings.
This is deliberate: without a sanctioned emergency path, the first incident
that a red gate delays teaches the team to route around the gate permanently.
The bypass is engineered to be **loud, attributable, and debt-tracked**: the
gate report names who applied the label (from the issue event log), the label
is visible on the PR, and merging opens a post-hoc review issue automatically —
so every use leaves three artifacts. For org deployment: set `hotfix_allowed`
to the on-call/lead group, alert on the post-hoc issues (they should be rare —
a healthy reference point is well under 1% of merges), and remember the gate
check is only one of the branch-protection requirements — an org
required-approval rule still applies unless the ruleset's bypass list says
otherwise. Set `hotfix_label: null` to remove the hatch entirely.

### 5.4 Spend abuse

Every push re-runs the review (~$0.7–1.5/PR observed). A hot PR or a
force-push loop multiplies cost; concurrency cancels overlapping runs but not
sequential ones. Set a spend cap on the Anthropic workspace key (§6) so the
failure mode is "reviews pause" — which the gate then reports as missing
review, failing closed — rather than an invoice.

### 5.5 What the pipeline does not see

Advisory reviewers' findings never block (by design). Base-branch state, CI
results, and anything outside the diff are out of scope for the verifier. The
size gate defaults to `warn` until you switch it to `block`.

## 6. Org deployment checklist

**GitHub org settings**
- [ ] Secret scanning + push protection enabled org-wide (blocks committed
  secrets *before* they reach a PR and therefore the Anthropic API)
- [ ] Branch protection / ruleset on default branches: require the `gate`
  check, require ≥1 approving review, no direct pushes
- [ ] `CODEOWNERS` entry putting `.github/workflows/**` and
  `review-conventions.yml` under platform-team review, with code-owner review
  required — this is the practical mitigation for §5.1(2)
- [ ] If your plan has org rulesets with **required workflows** (runs the
  workflow from a pinned ref regardless of PR contents), use it for the gate —
  this closes §5.1(2) fully
- [ ] Forking of private repos disabled (org default)

**Anthropic key hygiene**
- [ ] A dedicated API key from a dedicated workspace per org (not a personal
  key), stored only as a GitHub Actions secret
- [ ] Monthly spend cap on that workspace; usage alerts on
- [ ] Rotation on any suspected exposure; rotation is one `gh secret set`

**Pipeline settings for a payments/regulated codebase**
- [ ] `size.action: block` once the team has agreed a threshold
- [ ] `risk_paths` covering payment, auth, migration, and infra paths;
  `risk_reviewers` named; the risk label wired to a ruleset requiring review
- [ ] `gate.hotfix_allowed` restricted to the on-call/lead group; post-hoc
  review issues monitored (healthy usage is well under 1% of merges)
- [ ] `verification.votes: 3` where a wrong block or wrong pass is expensive
- [ ] Keep Copilot (and any newly trialed tool) in `advisory_reviewers` until
  its findings earn gating

**Operational**
- [ ] Dependabot (or equivalent) watching the pinned action SHAs and the two
  npm dependencies
- [ ] An owner for `review-conventions.yml` — convention changes are normal
  PRs, gated under the *old* rules by design (§4.1), so they are reviewable
  like any code change
