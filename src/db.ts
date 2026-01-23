import * as lancedb from "@lancedb/lancedb";
import { embed, embedOne, EMBEDDING_DIMENSIONS } from "./embeddings.js";
import {
  listConversationFiles,
  parseConversation,
  chunkConversation,
  ConversationChunk,
} from "./parser.js";
import fs from "fs";
import path from "path";

type ChunkRecord = {
  id: string;
  sessionId: string;
  project: string;
  content: string;
  timestamp: string;
  chunkIndex: number;
  vector: number[];
  [key: string]: unknown;
};

interface SearchResult {
  content: string;
  project: string;
  sessionId: string;
  timestamp: string;
  score: number;
}

interface IndexStatus {
  totalChunks: number;
  projects: number;
  lastUpdated: string | null;
}

interface IndexStats {
  processed: number;
  added: number;
}

const TABLE_NAME = "conversations";
const METADATA_TABLE = "metadata";

export class ConversationDB {
  private dbPath: string;
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private indexedFiles: Map<string, number> = new Map(); // filePath -> lastModified

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    // Ensure directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = await lancedb.connect(this.dbPath);

    // Try to open existing table or create new one
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
      await this.loadIndexedFiles();
    }

    console.error(`[clancey] Database initialized at ${this.dbPath}`);
  }

  private async loadIndexedFiles(): Promise<void> {
    if (!this.db) return;

    const tables = await this.db.tableNames();
    if (tables.includes(METADATA_TABLE)) {
      const metaTable = await this.db.openTable(METADATA_TABLE);
      const rows = await metaTable.query().toArray();
      for (const row of rows) {
        this.indexedFiles.set(row.filePath as string, row.lastModified as number);
      }
    }
  }

  private async saveIndexedFiles(): Promise<void> {
    if (!this.db) return;

    const records = Array.from(this.indexedFiles.entries()).map(([filePath, lastModified]) => ({
      filePath,
      lastModified,
    }));

    const tables = await this.db.tableNames();
    if (tables.includes(METADATA_TABLE)) {
      const metaTable = await this.db.openTable(METADATA_TABLE);
      await metaTable.delete("true"); // Clear and rewrite
      if (records.length > 0) {
        await metaTable.add(records);
      }
    } else if (records.length > 0) {
      await this.db.createTable(METADATA_TABLE, records);
    }
  }

  async indexAll(force: boolean = false): Promise<IndexStats> {
    if (!this.db) throw new Error("Database not initialized");

    const files = await listConversationFiles();
    let processed = 0;
    let added = 0;

    const allChunks: ConversationChunk[] = [];
    const filesToIndex: string[] = [];

    for (const filePath of files) {
      const stat = await fs.promises.stat(filePath);
      const lastIndexed = this.indexedFiles.get(filePath);

      // Skip if already indexed and not modified (unless force)
      if (!force && lastIndexed && lastIndexed >= stat.mtimeMs) {
        continue;
      }

      filesToIndex.push(filePath);
    }

    if (filesToIndex.length === 0) {
      return { processed: 0, added: 0 };
    }

    console.error(`[clancey] Indexing ${filesToIndex.length} conversations...`);

    for (const filePath of filesToIndex) {
      try {
        const conversation = await parseConversation(filePath);
        if (conversation) {
          const chunks = chunkConversation(conversation);
          allChunks.push(...chunks);
          this.indexedFiles.set(filePath, conversation.lastModified);
        }
        processed++;
      } catch (error) {
        console.error(`[clancey] Error parsing ${filePath}:`, error);
      }
    }

    if (allChunks.length > 0) {
      // Generate embeddings in batches
      console.error(`[clancey] Generating embeddings for ${allChunks.length} chunks...`);

      const texts = allChunks.map((c) => c.content);
      const embeddings = await embed(texts);

      const records: ChunkRecord[] = allChunks.map((chunk, i) => ({
        ...chunk,
        vector: embeddings[i],
      }));

      // Create or add to table
      const tables = await this.db.tableNames();
      if (tables.includes(TABLE_NAME)) {
        // Delete existing chunks from re-indexed files
        const sessionIds = [...new Set(allChunks.map((c) => c.sessionId))];
        for (const sessionId of sessionIds) {
          await this.table!.delete(`sessionId = '${sessionId}'`);
        }
        await this.table!.add(records);
      } else {
        this.table = await this.db.createTable(TABLE_NAME, records);
      }

      added = records.length;
    }

    await this.saveIndexedFiles();

    return { processed, added };
  }

  async indexFile(filePath: string): Promise<IndexStats> {
    if (!this.db) throw new Error("Database not initialized");

    try {
      const conversation = await parseConversation(filePath);
      if (!conversation) {
        return { processed: 1, added: 0 };
      }

      const chunks = chunkConversation(conversation);
      if (chunks.length === 0) {
        return { processed: 1, added: 0 };
      }

      const texts = chunks.map((c) => c.content);
      const embeddings = await embed(texts);

      const records: ChunkRecord[] = chunks.map((chunk, i) => ({
        ...chunk,
        vector: embeddings[i],
      }));

      const tables = await this.db.tableNames();
      if (tables.includes(TABLE_NAME)) {
        // Delete existing chunks from this session
        await this.table!.delete(`sessionId = '${conversation.sessionId}'`);
        await this.table!.add(records);
      } else {
        this.table = await this.db.createTable(TABLE_NAME, records);
      }

      this.indexedFiles.set(filePath, conversation.lastModified);
      await this.saveIndexedFiles();

      return { processed: 1, added: records.length };
    } catch (error) {
      console.error(`[clancey] Error indexing ${filePath}:`, error);
      return { processed: 1, added: 0 };
    }
  }

  async search(query: string, limit: number = 5, project?: string): Promise<SearchResult[]> {
    if (!this.table) {
      return [];
    }

    const queryVector = await embedOne(query);

    let searchQuery = this.table.vectorSearch(queryVector).limit(limit * 2); // Get extra for filtering

    const results = await searchQuery.toArray();

    let filtered = results;
    if (project) {
      filtered = results.filter((r) => (r.project as string).includes(project));
    }

    return filtered.slice(0, limit).map((r) => ({
      content: r.content as string,
      project: r.project as string,
      sessionId: r.sessionId as string,
      timestamp: r.timestamp as string,
      score: r._distance as number,
    }));
  }

  async getStatus(): Promise<IndexStatus> {
    if (!this.table) {
      return {
        totalChunks: 0,
        projects: 0,
        lastUpdated: null,
      };
    }

    const rows = await this.table.query().toArray();
    const projects = new Set(rows.map((r) => r.project as string));

    let lastUpdated: string | null = null;
    for (const row of rows) {
      const ts = row.timestamp as string;
      if (!lastUpdated || ts > lastUpdated) {
        lastUpdated = ts;
      }
    }

    return {
      totalChunks: rows.length,
      projects: projects.size,
      lastUpdated,
    };
  }
}
