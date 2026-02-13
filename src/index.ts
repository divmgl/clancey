import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ConversationDB } from "./db.js";
import { ConversationWatcher } from "./watcher.js";
import { log, logError, LOG_FILE } from "./logger.js";
import path from "path";
import os from "os";
import fs from "fs";

const db = new ConversationDB(path.join(os.homedir(), ".clancey", "conversations.lance"));

function getServerVersion(): string {
  try {
    const packageJsonPath = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    return packageJson.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const server = new Server(
  {
    name: "clancey",
    version: getServerVersion(),
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "search_conversations",
        description:
          "Search past Claude Code and Codex conversations using semantic search. Returns relevant conversation excerpts that may contain solutions, decisions, or context from previous sessions.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Natural language query to search for in past conversations",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 5)",
            },
            project: {
              type: "string",
              description: "Filter to a specific project path",
            },
            date_range: {
              type: "string",
              description: "Filter by time period: 'today', 'yesterday', 'last week', 'last month', or 'last N days' (e.g., 'last 3 days')",
            },
            sort_by: {
              type: "string",
              enum: ["relevance", "recency"],
              description: "Sort order: 'relevance' (default, best semantic match first) or 'recency' (most recent first)",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "index_conversations",
        description:
          "Manually trigger indexing of Claude Code and Codex conversations. Usually not needed as indexing happens automatically.",
        inputSchema: {
          type: "object",
          properties: {
            force: {
              type: "boolean",
              description: "Force re-index all conversations, not just new ones",
            },
          },
        },
      },
      {
        name: "index_status",
        description: "Get the current status of the conversation index.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "search_conversations": {
      const query = args?.query as string;
      const limit = (args?.limit as number) || 5;
      const project = args?.project as string | undefined;
      const dateRange = args?.date_range as string | undefined;
      const sortBy = (args?.sort_by as "relevance" | "recency") || "relevance";

      if (!query) {
        return {
          content: [{ type: "text", text: "Error: query is required" }],
          isError: true,
        };
      }

      try {
        const results = await db.search(query, { limit, project, dateRange, sortBy });

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No relevant conversations found.",
              },
            ],
          };
        }

        const formatted = results
          .map((r, i) => {
            const projectName = r.project.split("/").pop() || r.project;
            const date = new Date(r.timestamp).toLocaleDateString();
            return `## Result ${i + 1} (${projectName}, ${date})\n\n${r.content}\n\n---`;
          })
          .join("\n\n");

        return {
          content: [{ type: "text", text: formatted }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error searching: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "index_conversations": {
      const force = (args?.force as boolean) || false;

      try {
        const stats = await db.indexAll(force);
        return {
          content: [
            {
              type: "text",
              text: `Indexing complete. Processed ${stats.processed} conversations, added ${stats.added} new chunks.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error indexing: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    case "index_status": {
      try {
        const status = await db.getStatus();
        return {
          content: [
            {
              type: "text",
              text: `Index status:\n- Total chunks: ${status.totalChunks}\n- Projects indexed: ${status.projects}\n- Last updated: ${status.lastUpdated || "Never"}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error getting status: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

async function main() {
  // Initialize database
  await db.init();

  // Connect to MCP transport FIRST (non-blocking)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server running. Logs: ${LOG_FILE}`);

  // Start file watcher for auto-indexing
  const watcher = new ConversationWatcher(db);
  watcher.start();

  // Do initial index in background (don't block the server)
  log("Starting background indexing...");
  db.indexAll(false)
    .then((stats) => {
      log(`Background indexing complete: ${stats.added} chunks from ${stats.processed} conversations`);
    })
    .catch((error) => {
      logError("Background indexing failed", error);
    });
}

main().catch((error) => {
  logError("Fatal error", error);
  process.exit(1);
});
