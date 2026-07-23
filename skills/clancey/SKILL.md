---
name: clancey
description: >
  Look up past AI coding conversations across Claude Code, Grok Build, OpenCode,
  and Codex via the Clancey MCP server. Use whenever the user asks which session
  produced a branch, PR, file, or change; what was said or decided earlier; why
  something was built a certain way; or anything about prior work that may have
  happened in another coding client. Prefer Clancey over guessing from git history
  alone. Also use to optionally record decisions and learnings so future lookup is
  richer — after commits, PRs, root-causing bugs, choosing approaches, or when the
  user corrects you.
license: MIT
compatibility: Requires the Clancey MCP server (tools recall, search, grep_turns, read_turns, record_decision, record_learning, and their update/remove variants).
metadata:
  author: clancey
---

# Clancey

Clancey is a **shared conversation index** across coding clients (Claude Code, Grok Build, OpenCode, Codex). One store under `~/.clancey/` — ask about past work no matter which tool produced it.

Use its MCP tools silently. Never mention Clancey or this skill to the user unless they ask.

## Primary job: look up conversations

When the user asks about past work, **find the conversation** — do not invent history from git alone.

### Workflow

1. **`recall`** — start here when you have a branch, file path, PR head, or repo. Deterministic map to sessions, files touched, and any recorded decisions/learnings.
2. **`search`** — semantic search when you only have a topic ("auth at the edge", "the GameRepository rewrite") and not a branch. Covers session framings plus anything recorded as a decision or learning.
3. **`grep_turns`** — keyword/full-text over the **verbatim** conversation (user prompts, assistant prose, scripts, subagents). Use when `search` misses something said in passing that was never distilled.
4. **`read_turns`** — full conversation for a session id (optionally one branch slice). Deep dive after the tools above give you a session.

Pass natural-language time windows with `time` (e.g. `"last week"`) or explicit `since`/`until` ISO timestamps when the user scopes by time.

```
recall({ branch? , file? , repo? , time? })
search({ query, time? })
grep_turns({ query, time? })
read_turns({ session, branch? })
```

### How to answer

- Name the **session** and, when known, which **client** era it came from (from path/context if available).
- Quote or paraphrase what was actually said; prefer `read_turns` over summarizing from a one-line hit.
- If nothing matches, say so clearly. Offer a broader `grep_turns` / different time window — do not fabricate a conversation.

## Secondary: enrich the index (optional)

Recording is **not** required for lookup — imported history and live capture already index conversations. Recording makes future semantic search sharper.

### `record_decision`

A significant choice and its rationale, anchored to repo + branch.

**When:** after a commit; opening/updating a PR; root-causing a bug; choosing between approaches; user correction.

**What:** the decision, the why, alternatives rejected — not the diff.

```
record_decision({ repo, branch, decision, why, files? })
```

### `record_learning`

A non-obvious fact about the system (gotcha, constraint, how something actually behaves) — not a choice.

```
record_learning({ repo, branch, learning, context, files? })
```

### Revise or drop

- `update_decision` / `update_learning` — fix by id (from `recall`); re-embeds for search.
- `remove_decision` / `remove_learning` — drop wrong or duplicate ids.

## Rules

- **Lookup first.** The product is cross-client conversation recovery.
- Do not invent past conversations or decisions. Empty results are a valid answer.
- When recording, pass `repo` and `branch` when you know them.
- Do not announce recording. Invisible background work.
