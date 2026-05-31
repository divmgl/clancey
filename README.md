# Clancey

[![CI](https://github.com/divmgl/clancey/actions/workflows/ci.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/ci.yml)
[![Publish to npm](https://github.com/divmgl/clancey/actions/workflows/publish.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/publish.yml)

Clancey is a memory for your AI coding sessions. As you work in Claude Code it quietly records what each session did and the decisions you made along the way.

Later you just ask Claude things like *"which conversation produced this PR, and why did we build it this way?"*, and it uses Clancey to find the session behind a branch or file, recall the reasoning, and read back what you actually said.

## Prerequisites

- **Node 18+**
- **The `claude` CLI** on your `PATH` (used to register Clancey with Claude Code)

## Install and set up

```bash
npx -y clancey setup
```

Setup asks which tools to enable Clancey for (Claude Code and Codex), then imports your existing history from both so you can ask about it right away. Restart your tools when it finishes. The first run downloads a small embedding model (~30 MB), cached afterward.

## Using it

You never call Clancey directly. Claude does, whenever you ask it about past work. Try:

- *"Which conversation produced the `feature/auth` branch?"*
- *"Why did we move auth to the edge?"*
- *"What was I thinking the last time I changed `GameRepository.ts`?"*

As you work, Claude records the decisions it makes so they're searchable later, and can revise or drop one when it was wrong or duplicated. You can also ask it to go back through your older sessions and fill in the decisions it finds, so even history from before you installed Clancey becomes useful.

Codex works too, with one difference: Clancey imports your Codex history and answers from inside Codex, but it only records live as you work in Claude Code.

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
