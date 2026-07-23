# Clancey

[![CI](https://github.com/divmgl/clancey/actions/workflows/ci.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/ci.yml)
[![Publish to npm](https://github.com/divmgl/clancey/actions/workflows/publish.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/publish.yml)

Clancey is a **shared conversation index** for AI coding tools. It imports what you already did in Claude Code, Grok Build, OpenCode, Codex, and Hermes into one place, so any of those agents can answer:

- *"Which conversation produced the `feature/auth` branch?"*
- *"What did we say the last time we touched `GameRepository.ts`?"*
- *"Why did we move auth to the edge — and in which client was that decided?"*

You ask your current agent; it looks up the session across every client Clancey knows about, then reads back what was actually said.

## Supported tools

| Tool | History import | Live capture | MCP + skill |
|------|----------------|--------------|-------------|
| **Claude Code** | yes | yes | yes |
| **Grok Build** | yes | yes | yes |
| **OpenCode** | yes | yes | yes |
| **Codex** | yes | yes (while MCP runs) | yes |
| **Hermes Agent** | yes | — (state.db) | yes |

One store (`~/.clancey/`). Setup wires each tool’s MCP server and installs the **Clancey skill** so agents know how to look things up. Live capture of file edits and shell commands is silent infrastructure for branch/file mapping — it does not coach the agent.

Optional: as you work, the skill can also have the agent record decisions and learnings so semantic search is richer later. Lookup works without that; imported transcripts are enough.

## Prerequisites

- **Node 18+**
- At least one of the supported coding tools above

## Install and set up

```bash
npx -y clancey setup
```

Setup asks which tools to enable, imports existing history from each so you can ask about it immediately, and installs the Clancey skill. Restart your tools when it finishes. The first run downloads a small embedding model (~30 MB), cached afterward.

## Using it

You never call Clancey directly. Your agent does, whenever you ask about past work — including work that happened in a *different* coding client than the one you’re in now.

**Things you can ask:**

- *"Which conversation produced this PR?"* / *"…the `feature/auth` branch?"*
- *"What was I thinking the last time I changed `GameRepository.ts`?"*
- *"What did we do in this repo recently?"*
- *"What did Codex do on `feat` last week?"* (or Claude, Grok, OpenCode, Hermes)
- *"Search everything we said about edge auth a week ago."* / *"…yesterday."* / *"…in the last 7 days."*

Clancey can scope by **repo**, **branch**, **which coding tool**, and **plain-English time** (“last week”, “a week ago”, “yesterday”). It can list recent sessions, open the full transcript (including subagent turns), and fall back to a snapshot if the original chat file was pruned.

If something you just finished doesn’t show up yet, ask the agent to refresh the index (or run `npx clancey backfill` yourself).

**Optional enrichment:** as you work, the agent may record decisions and learnings (commits, PRs, root causes, approach choices) so later search is sharper. You can also ask it to mine older sessions for decisions after the fact. Lookup works without that — imported history is enough.

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

You only ever run `setup` by hand; your agent runs everything else for you. Setup pins the MCP server, skill, and live capture to this install, so a later release won't change your setup until you re-run it.

```
npx clancey setup       Set up Clancey and import history (run once)
npx clancey backfill    Re-import / refresh the conversation index
```

Your agent can also refresh the index from inside a session when results look stale. Run `npx clancey --help` for the full list. Everything Clancey stores lives in `~/.clancey/`.

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build
```

## License

MIT
