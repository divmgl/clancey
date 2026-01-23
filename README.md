# Clancey

An MCP server that indexes your Claude Code conversations for semantic search. Find solutions, decisions, and context from previous coding sessions.

## Features

- **Semantic Search** - Find conversations by meaning, not just keywords
- **Auto-Indexing** - Automatically indexes new conversations as they happen
- **Local & Private** - Everything runs locally using LanceDB and a Huggingface model
- **Resumable** - Indexing saves progress incrementally, picks up where it left off
- **Fast** - Uses all-MiniLM-L6-v2 for quick, lightweight embeddings

## Installation

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

Restart Claude Code. That's it.

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

1. Watches `~/.claude/projects/` for conversation files
2. Parses JSONL conversation history
3. Chunks conversations into searchable segments
4. Generates embeddings using `all-MiniLM-L6-v2`
5. Stores vectors in LanceDB for fast similarity search

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
