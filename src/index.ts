import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ConversationDB } from "./db.js";
import { ConversationWatcher } from "./watcher.js";
import { getClaudeDir } from "./parser.js";
import path from "path";
import os from "os";

const db = new ConversationDB(path.join(os.homedir(), ".clancey", "conversations.lance"));

const server = new Server(
  {
    name: "clancey",
    version: "0.1.0",
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
          "Search past Claude Code conversations using semantic search. Returns relevant conversation excerpts that may contain solutions, decisions, or context from previous sessions.",
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
              description: "Optional: filter to a specific project path",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "index_conversations",
        description:
          "Manually trigger indexing of Claude Code conversations. Usually not needed as indexing happens automatically.",
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

      if (!query) {
        return {
          content: [{ type: "text", text: "Error: query is required" }],
          isError: true,
        };
      }

      try {
        const results = await db.search(query, limit, project);

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

  // Start file watcher for auto-indexing
  const watcher = new ConversationWatcher(db);
  watcher.start();

  // Do initial index
  console.error("[clancey] Starting initial index...");
  const stats = await db.indexAll(false);
  console.error(`[clancey] Indexed ${stats.added} chunks from ${stats.processed} conversations`);

  // Connect to MCP transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[clancey] MCP server running");
}

main().catch((error) => {
  console.error("[clancey] Fatal error:", error);
  process.exit(1);
});
