# PReason vs the field

How PReason compares to the AI code review tools a team would actually
shortlist, on capability, cost, and supply-chain posture. Research date:
August 2026. Vendor-published numbers are marked **[vendor]**; independently
measured numbers **[measured]**.

The honest summary up front: the commercial tools are ahead on review *depth*
(codebase-wide context, execution-based verification, learning loops). PReason
is ahead on the *process around the review* (a per-finding merge gate with a
rebuttal trail, verified blockers, human routing, break-glass with debt
tracking), on cost at high PR volume, and on having a supply-chain surface
small enough to audit in an afternoon.

## 1. Capability comparison

Against the three closest competitors (all of which ship severity taxonomies,
custom-rule support, and some second-pass filtering — those are table stakes
now):

| Capability | PReason | Qodo (PR-Agent/Merge) | CodeRabbit | Greptile |
|---|---|---|---|---|
| Merge gate semantics | **Required check fails per unresolved blocking finding**; cleared by fix or written rebuttal + resolve | Inverted: auto-*approval* when criteria pass, gate rides branch protection | Request-Changes review blocks; "ignore" bypass with `[IGNORED]` audit tags (Pro+ only) | Status check gates on review *completion*, not finding resolution |
| Rebuttal as first-class artifact | **Yes** — the reply is what re-runs the gate; thread history is what the human reviews | No formal dismiss/rebuttal trail | Closest: ignore-with-tags | No |
| Second-pass verification | Adversarial refutation call per blocker, judged against **team rules + PR description**, fail-safe toward blocking, cached verdicts | Self-reflection re-scoring pass | Sandbox verification scripts + judge model on analyzer findings | Embedding/feedback noise filter + TREX execution-based proof |
| Human reviewer routing | **Expertise-ranked single human** (commits to changed files, load-balanced within experts, availability-aware) | None | None | None |
| Emergency bypass | **Label + named applier + auto post-hoc review issue** | Implicit (any human approval) | Per-PR ignore, permission-restrictable | GitHub-native only |
| Conventions | **Compiles one YAML into** CLAUDE.md, AGENTS.md, copilot-instructions, .coderabbit.yaml | *Consumes* AGENTS.md/CLAUDE.md | *Consumes* them | *Consumes* them |
| Codebase-wide context (graph/embeddings) | No — diff + explored files per run | Partial | Yes (codegraph + embeddings) | Yes (full-repo graph) |
| Learns from team feedback over time | No | Yes (auto best practices) | Yes (Learnings) | Yes (reaction-driven memory) |
| Open source | Yes (Apache-2.0 template, ~700 lines) | PR-Agent MIT (now community-maintained "legacy") | No | No |
| Runs entirely in your CI with your key | Yes | Yes (PR-Agent mode) | Enterprise self-host only (500+ seats) | Enterprise self-host only |

Three observations worth more than the table:

**Nobody else gates on a per-finding resolved/rebutted ledger.** Greptile's
check turns green when the review *finishes*; Qodo gates by granting approvals;
CodeRabbit's Request-Changes flow is the nearest competitor and requires the
$48/seat tier. The design where each blocking finding must be individually
fixed or argued away in writing, and the argument becomes the artifact a human
then reviews, is PReason's core and is not available off the shelf.

**Nobody routes the human.** All three stop at posting comments. The
evidence-backed part of PReason's design — exactly one named human, ranked by
who actually touched the files, load-balanced within that expert set — has no
commercial equivalent in this category.

**Everyone consumes the files PReason generates.** All three competitors read
AGENTS.md / CLAUDE.md as review context. PReason's sync is the compiler that
produces those files from one source. This makes the conventions investment
portable: a team that later adopts (or already runs) CodeRabbit or Qodo still
benefits from `review-conventions.yml` — the tools will read its output.

**One honest caveat on verification.** Greptile publicly abandoned
LLM-as-judge severity scoring ("the model's judgment of its own output was
nearly random") in favor of embedding filters and execution-based proof.
PReason's verifier differs from what they rejected — it is an independent
adversarial call with a refute-by-default stance, team rules as part of the
standard, and fail-safe-toward-blocking semantics, which is the architecture
Wealthfront reported working — but the burden of proof is on us, and verdict
quality should be watched in production. Execution-based verification (actually
running the code, as Greptile's TREX does) is stronger evidence than any
second opinion and is out of PReason's current scope.

## 2. Cost

Reference points:

- **PReason, measured on this repo**: $0.31 for a small PR's review (Opus-tier,
  12 turns, 7 inline comments) **[measured]**; external measurement of the same
  action: $0.73 for a 338-line PR, $1.34 for 598 lines **[measured]**.
  Verification adds cents per blocking finding, runs once per finding (cached).
- Cost is driven by repo exploration, not diff size (~619k input tokens for a
  338-line PR). `--max-turns` and model choice are the levers.

Modeled monthly cost, 18 developers, 800 PRs/month, one review per PR:

| Option | Monthly | Per PR | Notes |
|---|---|---|---|
| PReason on Haiku 4.5 | ~$310 | ~$0.39 | Quality below Opus tier |
| Copilot Business | $342–480 | $0.43+ | Credit pool shared org-wide; reviews **stop** at depletion; per-review burn unpublished |
| CodeRabbit Pro | $432 | $0.54 | Gating features are Pro+ |
| Greptile | $540–660 | $0.68+ | 50 reviews/seat then $1/review; per-review overage taxes velocity |
| **PReason on Opus (current config)** | $620–1,150 | $0.78–1.44 | Best-quality BYOK |
| Graphite Team | $720 | $0.90 | Includes stacking/merge queue |
| CodeRabbit Pro+ (for pre-merge checks) | $864 | $1.08 | The tier actually comparable to PReason's gate |
| Cursor BugBot | $800–1,200 | $1.00–1.50/run | Usage-based; re-reviews multiply runs |
| Anthropic hosted Code Review | $12,000–20,000 | $15–25 **[vendor]** | Viable selectively, not blanket |

Findings from the modeling:

- **Break-even against $24/seat SaaS is ≈33 PRs/dev/month.** Above it the seat
  is cheaper per PR; below it BYOK is. At 44 PRs/dev/month the two are roughly
  equal, so cost alone doesn't decide — control and features do.
- **Model routing is the real saving**: Haiku for routine PRs, Opus for
  `risk_paths` diffs lands around $350–600/month with quality where it
  matters. PReason's tiering makes this natural (routing per risk tier is a
  planned knob; today the model is set per workflow).
- **The honest hidden cost of BYOK is maintenance.** A few engineer-hours per
  month can exceed the entire API bill. The counterweight: PReason is ~700
  lines with 38 unit tests, and the team owns its roadmap.

## 3. Dependency and supply-chain posture

Four structurally different trust models exist in this category:

| Model | Examples | Blast radius if the vendor/tool is compromised |
|---|---|---|
| SaaS GitHub App | CodeRabbit, Greptile, Qodo Merge, BugBot, Graphite | The vendor's app key mints tokens for **every customer installation**. Demonstrated: CodeRabbit RCE (reported Jan 2025, disclosed Aug 2025) exposed the GitHub App private key with read/write reach over ~1M repositories. Fixed in days, no known exploitation, and their post-incident sandboxing is credible — but the structural risk is inherent to the model. |
| First-party platform | Copilot code review | No new trust boundary beyond GitHub itself |
| **In-repo Action + your key** | **PReason**, claude-code-action, PR-Agent (Action mode) | Scoped to repos that install it; you control mitigations |
| In-repo, no LLM | reviewdog, Danger.js | No data egress at all — but reviewdog was the entry point of the March 2025 tj-actions Actions supply-chain attack, proving this class still needs pinning discipline |

Within the in-repo class, the audit surface comparison:

| | PReason | Qodo PR-Agent (self-run) |
|---|---|---|
| Direct dependencies | **2** (js-yaml, @anthropic-ai/sdk), committed lockfile, `npm ci --ignore-scripts` | ~37 direct pip deps (litellm, fastapi, boto3, …), exact pins but **no lockfile — transitives unpinned** |
| Actions pinning | Full commit SHAs | Varies by user setup |
| Own code to audit | ~700 lines JS | Substantially larger Python codebase |
| Governance | Your repo | Recently transferred to a community org (trust anchors for PyPI/Docker/Action artifacts in transition) |
| Known history | — | 2024 prompt-injection/config-override findings (Kudelski); note the commonly cited CVE-2024-51355/6 **do not exist** — cite Kudelski directly |

Data egress: PReason sends PR contents to exactly one place (Anthropic API,
under the org's own commercial terms and key). SaaS reviewers add the vendor's
cloud as a second recipient, with vendor-specific retention: Qodo documents
zero-retention LLM accounts and no training; Greptile caches code until access
is revoked and uses de-identified data for improvement **unless you opt out**;
CodeRabbit documents no storage and no training on private code. All claim
SOC 2 Type II.

## 4. When to choose what

- **Choose a SaaS reviewer** (CodeRabbit being the strongest all-rounder) if
  the team wants review depth with zero maintenance, accepts a third-party App
  with org-wide code access, and the per-seat bill: the product is mature, the
  learning loop is real, and nobody has to own prompts or workflows.
- **Choose PReason** if the team's problem is the *process* — findings getting
  ignored, rubber-stamp approvals, no owner per PR — and it wants the gate,
  the rebuttal ledger, and the human routing under its own control, its own
  key, and a dependency surface it can actually read. The conventions file
  keeps its value even if a SaaS reviewer is added later, because they all
  read AGENTS.md.
- **They compose.** PReason's gate treats any reviewer posting tagged inline
  comments as a participant; a SaaS reviewer can run as the finding source
  (or advisory second voice) with PReason as the enforcement and routing
  layer on top.

## Sources

Competitor features: qodo-ai/pr-agent and docs.qodo.ai; docs.coderabbit.ai
(pre-merge checks, review instructions, knowledge base) and CodeRabbit
engineering blog; greptile.com/docs and the Greptile engineering blog ("How to
Make LLMs Shut Up", TREX). Costs: vendor pricing pages (Aug 2026),
liatrio-labs/claude-code-gauntlet measurements, GitHub Copilot billing docs
and AI-credits changelogs, plus this repo's own measured runs. Supply chain:
Kudelski Security disclosures (CodeRabbit RCE, PR-Agent injection), Endor Labs
"PwnedRabbit" analysis, vendor trust pages, and the March 2025
reviewdog/tj-actions incident reporting.
