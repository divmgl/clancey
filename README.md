# Clancey

[![CI](https://github.com/divmgl/clancey/actions/workflows/ci.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/ci.yml)
[![Publish to npm](https://github.com/divmgl/clancey/actions/workflows/publish.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/publish.yml)

Clancey is a memory for your AI coding sessions. As you work in Claude Code it records every file you edit and command you run — tagged to the repo and branch — and prompts the agent to write down the decisions it makes and why.

Later you just ask Claude in plain language — *"which conversation produced this PR, and why did we do it this way?"* — and it leverages Clancey to answer: mapping a branch or file back to the session that produced it (an exact, deterministic lookup), searching your past decisions by meaning, and reading back the exact turns where you made them. You don't call any of this directly; the agent does, through the MCP tools below.

## Prerequisites

- **Node 18+** — clancey runs on Node (via `npx`); `better-sqlite3` ships prebuilt binaries for it.
- **The `claude` CLI** — used by `setup` to register the MCP server (`claude mcp add`). If it's not on your `PATH`, setup prints the manual command to run.
- A first run downloads the embedding model (`all-MiniLM-L6-v2`, ~30 MB), cached afterward.

## Install and set up

```bash
npx -y clancey setup
```

This wires the hooks into your global Claude Code settings (`~/.claude/settings.json`), registers the MCP server at user scope, offers to remove any legacy v1 index, and backfills your existing conversations so history is queryable immediately. Restart Claude Code afterward.

Non-interactive (also deletes the legacy index without asking):

```bash
npx -y clancey setup --clean-legacy
```

## What it does

- **Records your work deterministically.** A `PostToolUse` hook captures every file edit and command, tagged with the repo and branch, as it happens. No re-indexing, no embeddings of raw transcripts.
- **Records your decisions.** The hook reminds the agent to log significant decisions (`record_decision`) with their rationale, anchored to the repo and branch.
- **Maps PR → session.** `recall` answers "what work happened on this branch / to this file, and where do I read it" with an indexed SQL lookup.
- **Searches decisions semantically.** `search` ranks recorded decisions and session framings by meaning — short, high-signal text, so a small local embedding model does the job well.
- **Reads the verbatim turns.** `read_turns` returns what you actually said in a session, the deep dive that recovers a PR's motivation in your own words.
- **Covers Codex too.** Existing Codex sessions (`~/.codex/sessions`) are backfilled — file edits (`apply_patch`), commands (`exec_command`/`shell`), branch, and turns. Codex has no hook, so it's backfill-only (no live capture or decision nudges).

## How it works

1. A `PostToolUse` hook runs `clancey hook` after each `Edit`/`Write`/`Bash`. It resolves the repo (git top-level, shared across worktrees) and current branch, records the event, and — throttled — nudges the agent to call `record_decision` after significant decisions.
2. A `SessionStart` hook injects the standing reminder to log decisions as you go.
3. Everything is stored in one SQLite file at `~/.clancey/clancey.db`: an `events` table (work + decisions, indexed by repo/branch/file) and an `embeddings` table (decision and framing vectors).
4. `clancey backfill` reads your existing Claude Code and Codex transcripts into the same store — every file edit becomes an event, and each session gets a framing embedding (its title + first message) so it is searchable even before any decision is recorded.

## MCP tools

The agent calls these; you reach them by asking Claude in natural language. The signatures are here for reference.

### `recall`

Deterministically find the work for a branch, file, or repo. The PR → session mapping.

```
recall({ file: "GameRepository.ts" })
recall({ branch: "feature/auth" })
```

> Tip: prefer `file` over `branch`. PR head refs often diverge from the branch recorded in the transcript (worktrees, Graphite, renames); the edited file paths are the reliable key.

### `read_turns`

Read the verbatim human turns from a session, optionally only the slice where a branch was active.

```
read_turns({ session: "aab3c4f4-…" })
```

### `search`

Semantic search over recorded decisions and session framings, ranked by similarity descending. The open case: "what did I decide about X" when you don't know the branch.

```
search({ query: "why did we move auth to the edge" })
```

### `record_decision`

Record a decision and its rationale, anchored to the current repo and branch (provided in the hook's context). Call this copiously while working.

```
record_decision({ repo, branch, decision, why })
```

## Retention — keep your transcripts

Claude Code deletes chat transcripts after `cleanupPeriodDays` (**default 30**). Once a transcript is pruned, `read_turns` can no longer recover its verbatim turns — and any session older than the window is simply gone. clancey's own store is durable: the `events` and recorded `decisions` in `clancey.db` persist independently of pruning, so your recorded work and decisions survive. But to keep the *verbatim turns* available, raise the retention window in `~/.claude/settings.json`:

```json
{
  "cleanupPeriodDays": 3650
}
```

Do this early — pruned history can't be recovered. (clancey captures live going forward regardless, but it can only backfill transcripts that still exist on disk.)

## Filling in decisions for past sessions

History is indexed immediately, but old sessions have no recorded decisions — no agent was there to record them. Fill them in with a **host-agent pass**: ask Claude to walk your history using the tools above.

```
recall({ file: "X" })            → find the sessions and files
read_turns({ session })          → read what was actually said
record_decision({ repo, branch, decision, why })  → write the synthesized decision back
```

After the pass, `recall` and `search` surface those decisions. Going forward, new sessions accrue decisions automatically via the hook.

## Commands

Clancey is an MCP server: running `clancey` bare starts the server over stdio, which is how Claude Code launches it. The binary also carries a thin operational CLI — of these, the only one you run by hand is `setup`.

```
clancey            Start the MCP server (stdio) — how Claude Code runs it
clancey setup      Run once: wire hooks + MCP globally, clean legacy index, backfill
                   --clean-legacy / --yes   delete the v1 index non-interactively
clancey hook       Invoked by Claude Code's hooks (reads the event on stdin)
clancey backfill   Maintenance: ingest existing transcripts ( --force to re-ingest all )
```

## Storage

Everything lives in `~/.clancey/`:

- `clancey.db` — the SQLite store (events, embeddings, state).
- `clancey.log` — operational log.

## Tech stack

- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — embedded SQLite store
- [Transformers.js](https://huggingface.co/docs/transformers.js) — `all-MiniLM-L6-v2` embeddings over short summaries
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) — Claude Code integration

## Development

```bash
bun install
bun run typecheck
bun run test     # runs under node + tsx (better-sqlite3 is Node-only)
bun run build
```

## License

MIT
