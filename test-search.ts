import { ConversationDB } from "./src/db.js";
import path from "path";
import os from "os";

const db = new ConversationDB(path.join(os.homedir(), ".clancey", "conversations.lance"));

async function main() {
  const query = process.argv[2] || "typescript error handling";
  const dateRange = process.argv[3]; // e.g., "today", "last week"
  const sortBy = (process.argv[4] as "relevance" | "recency") || "relevance";

  await db.init();

  console.log(`Searching for: "${query}"`);
  if (dateRange) console.log(`Date range: ${dateRange}`);
  console.log(`Sort by: ${sortBy}\n`);

  const results = await db.search(query, { limit: 5, dateRange, sortBy });

  if (results.length === 0) {
    console.log("No results found.");
    return;
  }

  for (const [i, r] of results.entries()) {
    const projectName = r.project.split("/").pop() || r.project;
    const date = new Date(r.timestamp).toLocaleString();
    console.log(`--- Result ${i + 1} (${projectName}, ${date}) ---`);
    console.log(r.content.slice(0, 500) + "...\n");
  }
}

main().catch(console.error);
