---
name: clancey
description: >
  Find past AI coding conversations via the Clancey MCP server — which session
  produced a branch, PR, file, or change; what was said or decided earlier; why
  something was built a certain way; prior work that may have happened in another
  coding agent. Prefer Clancey over guessing from git history alone. Also record
  decisions and learnings when something important is settled so later search is
  richer.
license: MIT
compatibility: Requires the Clancey MCP server.
metadata:
  author: clancey
---

# Clancey

Clancey indexes coding-agent conversations into one place. Use it to recover what
was said and decided in past sessions, including work done in a different agent
than the one you are in now.

Use the MCP tools silently. Do not mention Clancey or this skill unless the user asks.

## Find conversations

When the user asks about past work, **retrieve the conversation**. Do not invent history from git alone.

| Need | Tool | Notes |
|------|------|--------|
| Branch, file, PR, or repo → sessions | `recall` | Deterministic map to sessions, files, hosts, and stored decisions/learnings. Start here when you have a concrete anchor. |
| Recent sessions (browse) | `list_sessions` | By last activity; filter by repo/branch/host/time. Then `read_turns`. |
| Topic without a branch | `search` | Semantic search over framings + decisions/learnings. Scope with repo/branch/host/time. |
| Exact words / offhand remarks | `grep_turns` | Keyword search over the full verbatim transcript, **including subagent turns** (speaker `assistant·AgentType`). |
| Full session text | `read_turns` | Entire conversation for a session id. Optional **branch slice**. If the live transcript was pruned, Clancey serves the **stored snapshot**. |
| Stale / empty index | `refresh_index` | Re-ingest changed transcripts so recent work is findable. |

Shared scope knobs (where supported): `repo`, `branch`, `host` (`claude` \| `codex` \| `opencode` \| `grok` \| `hermes`), `time` / `since` / `until`, `limit`, `exclude_session` / `exclude_sessions`.

**Repo keys.** `repo` accepts an absolute checkout path **or** a short `owner/name` from the git remote — both match the same work when that remote is known. Prefer whichever form you have; do not conclude the index is empty just because one form returned nothing without trying the other (or dropping `repo`).

### Time windows (plain English)

Put the window in `time` on `recall` / `search` / `grep_turns` / `list_sessions`. Keep date words out of `query`.

| User says | `time` value | Meaning |
|-----------|--------------|---------|
| "yesterday" | `"yesterday"` | Previous calendar day |
| "last week" | `"last week"` | Previous calendar week |
| "a week ago" / "one week ago" | `"a week ago"` | That day, one week back |
| "the last 7 days" / "past 7 days" | `"last 7 days"` | Rolling window ending now |
| "last month", "this year", … | as said | Calendar periods |
| "between June 1 and June 3" | as said | Inclusive range |
| "Sep 12-13" | as said | Explicit dates |

Explicit `since` / `until` (ISO) override `time`.

### How to answer

- Ground the answer in retrieved turns. Prefer `read_turns` over summarizing a single hit line.
- Cite the session id (and host when shown). Subagent lines look like `[assistant·Plan]`.
- If the live file is gone, trust snapshot text from `read_turns` (`transcript pruned; served from snapshot`).
- **Prior sessions, not this one.** If the top hit is the current conversation (it restates the user’s question or matches your session id), that is not “index empty.” Call `list_sessions` for the repo/branch, then `read_turns` on **earlier** sessions — or pass `exclude_session: "<current id>"` on `search` / `grep_turns` / `list_sessions`. Only after that fails should you treat results as missing.
- If nothing matches after that, say so. Call `refresh_index` when work should exist but still looks empty, then retry. Never fabricate a conversation. Never invent freshness metrics Clancey did not return.

### Examples

**"Which conversation produced `feature/auth`?"**

```
recall({ branch: "feature/auth" })
read_turns({ session: "<id from recall>" })
```

**"What did we do in this repo recently?"**

```
recall({ repo: "owner/name" })
// path form also works: repo: "/absolute/checkout"
list_sessions({ repo: "owner/name", limit: 10 })
read_turns({ session: "<id>" })
```

**"Where did we leave off on X?" (avoid ranking the current chat first)**

```
list_sessions({ repo: "owner/name", limit: 10 })
// or: grep_turns({ query: "X", repo: "owner/name", exclude_session: "<current session id>" })
read_turns({ session: "<prior id, not current>" })
```

**"Only what Codex did on `feat` last week"**

```
list_sessions({ host: "codex", branch: "feat", time: "last week" })
grep_turns({ query: "auth", host: "codex", branch: "feat", time: "last week" })
```

**"What did we say about moving auth to the edge?"**

```
search({ query: "move auth to the edge" })
// if thin:
grep_turns({ query: "auth edge" })
read_turns({ session: "<id from hits>" })
```

**"Last time we touched GameRepository on main?"**

```
recall({ file: "GameRepository", branch: "main" })
read_turns({ session: "<id>", branch: "main" })
```

**"Anything about auth from last week / a week ago / the last 7 days?"**

```
search({ query: "auth", time: "last week" })
search({ query: "auth", time: "a week ago" })
grep_turns({ query: "auth edge", time: "last 7 days" })
```

**Thin or empty results** — broaden in order: `refresh_index` if work was recent → drop/loosen `time` or `host` → try `grep_turns` if you used `search` → shorter keyword or file stem → say you found nothing.

## Record for later search

Lookup works without this. Recording makes semantic search sharper when something durable was settled. Prefer a clear, useful entry over volume — one good decision beats several vague ones.

**`record_decision`** — choice + rationale (why, alternatives rejected), not the diff.  
Pass `session` (and `host` when known) so the note links back to the conversation.  
Typical moments: commit, PR open/update, root cause, approach choice, user correction.

**`record_learning`** — non-obvious system fact (gotcha, constraint), not a choice. Same `session` / `host` guidance.

Use `update_*` / `remove_*` with ids from `recall` to fix or drop bad entries.

### Mine a session for decisions (optional)

After a long session (or when the user asks to capture history):

1. `read_turns({ session })` (or branch slice).
2. Extract settled choices and non-obvious facts.
3. `record_decision` / `record_learning` with that `session`, plus `repo` / `branch` / `host`.

### Examples

**After choosing approach A over B and committing**

```
record_decision({
  repo: "owner/name",
  branch: "feature/auth",
  session: "<current session id>",
  host: "claude",
  decision: "Terminate sessions at the edge, not in the app server",
  why: "Rejected in-process middleware — multi-region sticky sessions were already a problem",
  files: ["src/auth/edge.ts"]
})
```

**After discovering a subsystem constraint**

```
record_learning({
  repo: "owner/name",
  branch: "feature/auth",
  session: "<current session id>",
  learning: "GameRepository.getActive() excludes soft-deleted rows unless includeDeleted is set",
  context: "Easy to miss when writing admin tools; default matches player-facing queries"
})
```

## Rules

- Lookup before speculation.
- **MCP only.** Use Clancey tools for conversation history. If they are not available yet (server still connecting / `partial`), wait and retry — do not open Clancey’s on-disk database, host session directories, or other SQLite/transcript stores as a workaround.
- Empty results are valid; do not invent past conversations or decisions.
- Do not announce recording.
