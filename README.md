# Clancey

[![CI](https://github.com/divmgl/clancey/actions/workflows/ci.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/ci.yml)
[![Publish to npm](https://github.com/divmgl/clancey/actions/workflows/publish.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/publish.yml)

Clancey is a memory for your AI coding sessions. As you work it quietly records what each session did, the decisions you made, and the things you learned along the way.

Later you just ask your agent things like *"which conversation produced this PR, and why did we build it this way?"*, and it uses Clancey to find the session behind a branch or file, recall the reasoning, and read back what you actually said.

## Supported tools

| Tool | MCP | Skill | History import | Live tool events |
|------|-----|-------|----------------|------------------|
| **Claude Code** | yes | yes | yes | silent live capture |
| **Grok Build** | yes | yes | yes | silent live capture |
| **OpenCode** | yes | yes | yes | plugin |
| **Codex** | yes | yes | yes | poller while MCP runs |

Decision and learning recording is driven by the **Clancey skill** (Agent Skills `SKILL.md`) that setup installs into each tool — the agent loads it and calls `record_decision` / `record_learning` as it works. Live capture of file edits and shell commands is silent infrastructure for search and branch mapping; it does not coach the agent.

## Prerequisites

- **Node 18+**
- At least one of the supported coding tools above

## Install and set up

```bash
npx -y clancey setup
```

Setup asks which tools to enable Clancey for, then imports your existing history from each so you can ask about it right away. Restart your tools when it finishes. The first run downloads a small embedding model (~30 MB), cached afterward.

## Using it

You never call Clancey directly. Your agent does, whenever you ask it about past work. Try:

- *"Which conversation produced the `feature/auth` branch?"*
- *"Why did we move auth to the edge?"*
- *"What was I thinking the last time I changed `GameRepository.ts`?"*

As you work, the agent records the decisions it makes and the incidental things it learns about your system — gotchas, constraints, how a subsystem actually behaves — so both are searchable later, and it can revise or drop any of them when one was wrong or duplicated. You can also ask it to go back through your older sessions and fill in the decisions it finds, so even history from before you installed Clancey becomes useful.

Recall is semantic, so it finds things by meaning even when you don't remember the exact words. When something was only ever said in passing — never recorded as a decision — the agent falls back to a plain keyword search over the verbatim conversation, so an offhand remark is still findable by the words you used.

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
