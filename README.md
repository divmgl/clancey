# Clancey

[![CI](https://github.com/divmgl/clancey/actions/workflows/ci.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/ci.yml)
[![Publish to npm](https://github.com/divmgl/clancey/actions/workflows/publish.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/publish.yml)

Clancey is a memory for your AI coding sessions. As you work in Claude Code it quietly records what each session did, the decisions you made, and the things you learned along the way.

Later you just ask Claude things like *"which conversation produced this PR, and why did we build it this way?"*, and it uses Clancey to find the session behind a branch or file, recall the reasoning, and read back what you actually said.

## Prerequisites

- **Node 18+**
- **The `claude` CLI** on your `PATH` (used to register Clancey with Claude Code)

## Install and set up

```bash
npx -y clancey setup
```

Setup asks which tools to enable Clancey for (Claude Code, Codex, and OpenCode), then imports your existing history from each so you can ask about it right away. Restart your tools when it finishes. The first run downloads a small embedding model (~30 MB), cached afterward.

## Using it

You never call Clancey directly. Claude does, whenever you ask it about past work. Try:

- *"Which conversation produced the `feature/auth` branch?"*
- *"Why did we move auth to the edge?"*
- *"What was I thinking the last time I changed `GameRepository.ts`?"*

As you work, Claude records the decisions it makes and the incidental things it learns about your system — gotchas, constraints, how a subsystem actually behaves — so both are searchable later, and it can revise or drop any of them when one was wrong or duplicated. You can also ask it to go back through your older sessions and fill in the decisions it finds, so even history from before you installed Clancey becomes useful.

Recall is semantic, so it finds things by meaning even when you don't remember the exact words. When something was only ever said in passing — never recorded as a decision — Claude falls back to a plain keyword search over the verbatim conversation, so an offhand remark is still findable by the words you used.

OpenCode has full parity with Claude Code: Clancey imports its history, answers from inside it, and records live as you work (via a plugin setup installs into `~/.config/opencode/plugins/`). Codex is read-only for now — Clancey imports its history and answers from inside it, but only Claude Code and OpenCode record live.

## Keep your history

> [!IMPORTANT]
> Claude Code deletes chat transcripts after 30 days by default, so do this early. Clancey snapshots the conversations it imports, so anything it has already seen survives pruning, but raising the window keeps conversations around long enough to be imported in the first place:
>
> ```json
> {
>   "cleanupPeriodDays": 3650
> }
> ```

## Commands

You only ever run `setup` by hand; Claude Code runs everything else for you. Setup pins the hooks and MCP server to the version that installed them, so a later release won't change your setup until you re-run it.

```
npx clancey setup       Set up Clancey in Claude Code and import history (run once)
npx clancey backfill    Re-import existing conversations
```

Run `npx clancey --help` for the full list. Everything Clancey stores lives in `~/.clancey/`.

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build
```

## License

MIT
