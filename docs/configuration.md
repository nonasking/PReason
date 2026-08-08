# Configuration reference

Everything is customized in one file: **`review-conventions.yml`**. After any
edit, run `npm run sync` and commit the regenerated files — CI fails on drift,
and the same loader validates the file on every run, so a typo surfaces as a
readable error list instead of silent misbehavior.

```sh
npm run sync    # recompile tool configs from the YAML
npm run check   # validate + verify generated files are in sync (what CI runs)
```

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

## `ai_reviewers` — who counts as an AI

GitHub logins whose review threads the gate manages. `[bot]` suffixes are
stripped and case is ignored, so `Copilot`, `copilot[bot]`, `copilot` all
match. Add the login of any other review bot you run; remove entries to make
the gate ignore that tool.

## `reviewers` — how many humans, and who

```yaml
reviewers:
  pool: [alice, bob, carol]   # candidates for assignment
  count: 1                    # reviewers per normal PR (0 = no human assignment)
  risk_count: 2               # reviewers per risk-path PR (defaults to count)
  risk_label: needs-human-review
```

- **Adjust reviewer count** with `count`; `risk_count` lets risky diffs demand
  more eyes than routine ones.
- **`count: 0`** turns off human assignment entirely (AI + gate only) — e.g.
  for a personal or prototype repo.
- The pick is deterministic — `PR number % pool size`, walking forward for
  multi-reviewer counts — so re-running the workflow never reshuffles, and
  assignment stays evenly distributed over time. The PR author is excluded
  automatically.
- Prefer GitHub's native team load-balancing? Leave `pool` empty and enable
  *Team → Code review → Auto assignment*; the gate, labels, and tiering still
  work.

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
