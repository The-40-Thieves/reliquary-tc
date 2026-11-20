# AGENTS.md

Instructions for AI coding agents working in this repository.

## Agent skills

### Issue tracker

Issues live in Linear on the **The 13th Letter** team (`THE-` prefix), accessed via the Linear MCP
server; pull requests live on GitHub and are a delivery surface, not a request surface. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name — `needs-triage`, `needs-info`,
`ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` and one `docs/adr/` at the repo root, covering all four
workspaces. See `docs/agents/domain.md`.

## Every change: the working rules

These hold for every pull request. `CLAUDE.md` at the repo root has the full notes behind each
rule (toolchain pins, generated files, migrations, adding a tool); read the section that matches
your change before you start.

- **Check the ticket first.** Tickets here go stale fast. Before implementing, confirm in the
  current source that the defect or gap still exists and that every cited file and line still
  matches. The procedure is `.claude/skills/verify-ticket-premise/SKILL.md` (plain markdown, any
  agent can follow it). If the premise no longer holds, stop and report that instead of coding.
- **Public repo.** Put no private tracker ids or links (a `THE-` id followed by a number, a
  Linear URL) in commits, pull request text, code, comments or `changes/` fragments. A GitHub
  issue number (`Refs #123`) is fine. `bun run check:public-text` covers only part of this: it
  refuses an id in tracked Markdown, the two manifests and the CLI's printed text, and it fails
  when the count of ids in code comments rises. It does not read commit messages, pull request
  text or `changes/` fragments, so check those yourself before you push.
- **One pull request per task**, on its own branch from `origin/main`. Sign off every commit
  (`git commit -s`); the DCO check rejects unsigned commits.
- **Add a release-note fragment**: `changes/<slug>.md`, format in `changes/README.md`. Do not
  write the pull request number in it and do not edit `CHANGELOG.md`.
- **Tests first.** Write the new or changed test, run it and see it fail for the right reason,
  then fix. Put that failing output in the pull request body.
- **`bun run lint` is only biome.** CI's `lint` job runs about twenty more gates as separate
  steps. Read the list from `.github/workflows/ci-server.yml` (or follow
  `.claude/skills/gates/SKILL.md`) and run the ones your change can affect. Two that catch most
  changes: `check:comment-style` counts files with 120 or more comment lines, and biome refuses
  a file over 700 lines.
- **Generated files are regenerated, not edited.** The list and each file's regenerate command
  are in `.claude/generated-paths.txt`. If a generated file looks wrong, fix its source and
  rerun that command.
- **Local tests are the diff; the full suite is CI.** Run the test files you touched plus
  `bun run test:related` in `packages/server`. Do not run the whole suite locally.
- **Run each gate unpiped.** A pipe through `tail` or `head` makes the exit code report the
  pipe, not the gate. Redirect the output to a log file and check the exit code separately.
- **Before pushing**, merge `origin/main` into your branch and resolve conflicts by hand. If the
  `ledger` tool is on your `PATH`, run `ledger replay` as its own command after the merge, then
  push as a separate command; a cloud VM without it skips that step.
- **Three habits to avoid.** Use a temporary commit instead of `git stash` (the stash is shared
  across worktrees). Stop a process by its id instead of by name pattern (a pattern hits other
  runs). If a push is rejected, merge again instead of force-pushing. If one of these seems
  unavoidable, stop and ask the user.
- **Report back** with the pull request number, the head SHA, what was done and how each part
  was proven, test counts, the failing-first output, and anything done differently from the
  task brief.

## Cloud agent environment setup

Cloud agent VMs (Google Jules, Codex cloud and similar) do not preinstall Bun. Install the pinned
version first; the pin lives in `mise.toml` and `packageManager` in `package.json`, which must
agree (currently `1.4.4`):

```bash
export BUN_INSTALL="$HOME/.bun"   # some VMs can't write the installer's default location
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version   # must print 1.4.4
bun install --frozen-lockfile --ignore-scripts   # a plain install fails on the better-sqlite3 build script
bun run prepare   # --ignore-scripts skipped it: registers the regen merge driver and the DCO sign-off hook
```

Run these before proposing a change:

```bash
bun run lint        # biome only
bun run typecheck   # all four packages plus the bun-smoke project
cd packages/server && bunx vitest run test/<touched-area>.test.ts   # targeted tests, not the full suite
```

The Rust toolchain and the native addon are needed only when a change touches `packages/native`; the
server falls back to JavaScript implementations without the addon. Build it with `bun run build` in
that package. The Rust version is pinned in `packages/native/rust-toolchain.toml`.

<!-- entire-agent:begin -->
Read .entire/agent-guide.md for this repository's workflow, source inspection, and verification guidance.
@.entire/agent-guide.md
<!-- entire-agent:end -->
