# Clancey

An MCP server that indexes your Claude Code conversations for semantic search. Find solutions, decisions, and context from previous coding sessions.

## Features

- **Semantic Search** - Find conversations by meaning, not just keywords
- **Auto-Indexing** - Automatically indexes new conversations as they happen
- **Local & Private** - Everything runs locally using LanceDB and a Huggingface model
- **Incremental Updates** - Only processes new or modified conversations

## Installation

```bash
git clone https://github.com/divmgl/clancey.git
cd clancey
bun install
bun run build
```

## Setup

Add to your Claude Code MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "clancey": {
      "command": "node",
      "args": ["/path/to/clancey/dist/index.js"]
    }
  }
}
```

Restart Claude Code after adding the configuration.

## MCP Tools

### `search_conversations`

Search through your indexed conversations semantically.

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | What to search for |
| `limit` | number | Max results (default: 5) |
| `project` | string | Filter by project path |

### `index_conversations`

Manually trigger conversation indexing.

| Parameter | Type | Description |
|-----------|------|-------------|
| `force` | boolean | Reindex all conversations |

### `index_status`

Get statistics about indexed conversations.

## How It Works

1. Watches `~/.claude/projects/` for conversation files
2. Parses JSONL conversation history
3. Chunks conversations into searchable segments
4. Generates embeddings using `Xenova/nomic-embed-text-v1`
5. Stores vectors in LanceDB for fast similarity search

## Tech Stack

- [LanceDB](https://lancedb.com/) - Vector database
- [Huggingface Transformers](https://huggingface.co/docs/transformers.js) - Embedding model
- [MCP SDK](https://github.com/modelcontextprotocol/sdk) - Claude integration
- [Chokidar](https://github.com/paulmillr/chokidar) - File watching

## License

MIT
