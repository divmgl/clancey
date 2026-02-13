# Clancey

[![CI](https://github.com/divmgl/clancey/actions/workflows/ci.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/ci.yml)
[![Publish to npm](https://github.com/divmgl/clancey/actions/workflows/publish.yml/badge.svg)](https://github.com/divmgl/clancey/actions/workflows/publish.yml)

An MCP server that indexes your Claude Code and Codex conversations for semantic search. Find solutions, decisions, and context from previous coding sessions.

## Features

- **Semantic Search** - Find conversations by meaning, not just keywords
- **Auto-Indexing** - Automatically indexes new conversations as they happen
- **Local & Private** - Everything runs locally using LanceDB and a Huggingface model
- **Resumable** - Indexing saves progress incrementally, picks up where it left off
- **Fast** - Uses all-MiniLM-L6-v2 for quick, lightweight embeddings

## Installation

Use the setup for your client:

<details>
<summary>Claude Code</summary>

Add to your Claude Code MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "clancey": {
      "command": "npx",
      "args": ["-y", "clancey"]
    }
  }
}
```

Restart Claude Code.

</details>

<details>
<summary>Codex</summary>

Add to your Codex config (`~/.codex/config.toml`):

```toml
[mcp_servers.clancey]
command = "npx"
args = ["-y", "clancey"]
```

Restart Codex.

</details>

## MCP Tools

### `search_conversations`

Search through your indexed conversations semantically.

```
query: "how did I fix the auth bug"
limit: 5
project: "my-app"  # optional filter
```

### `index_conversations`

Manually trigger conversation indexing.

```
force: true  # reindex everything
```

### `index_status`

Get statistics about indexed conversations.

## How It Works

1. Scans conversation files from `~/.claude/projects/` and `~/.codex/sessions/`
2. Parses JSONL events into user/assistant messages
3. Chunks long conversations into searchable segments
4. Generates embeddings with `all-MiniLM-L6-v2`
5. Stores vectors in LanceDB at `~/.clancey/conversations.lance`
6. Watches both source directories and incrementally re-indexes changed `.jsonl` files

Data is stored in `~/.clancey/`. Logs are at `~/.clancey/clancey.log`.

## Development

```bash
git clone https://github.com/divmgl/clancey.git
cd clancey
bun install
bun run build
```

## Tech Stack

- [LanceDB](https://lancedb.com/) - Vector database
- [Huggingface Transformers.js](https://huggingface.co/docs/transformers.js) - Embedding model
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) - Claude integration
- [Chokidar](https://github.com/paulmillr/chokidar) - File watching

## License

MIT
