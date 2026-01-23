import * as lancedb from "@lancedb/lancedb";
import { embed, embedOne, EMBEDDING_DIMENSIONS } from "./embeddings.js";
import {
  listConversationFiles,
  parseConversation,
  chunkConversation,
  ConversationChunk,
} from "./parser.js";
import { log, logError } from "./logger.js";
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

interface SearchOptions {
  limit?: number;
  project?: string;
  dateRange?: string;
  sortBy?: "relevance" | "recency";
}

function parseDateRange(dateRange: string): { start: Date; end: Date } | null {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  switch (dateRange.toLowerCase()) {
    case "today":
      return { start: startOfDay(now), end: endOfDay(now) };
    case "yesterday": {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      return { start: startOfDay(yesterday), end: endOfDay(yesterday) };
    }
    case "last_week":
    case "last week":
    case "week": {
      const weekAgo = new Date(now);
      weekAgo.setDate(weekAgo.getDate() - 7);
      return { start: startOfDay(weekAgo), end: endOfDay(now) };
    }
    case "last_month":
    case "last month":
    case "month": {
      const monthAgo = new Date(now);
      monthAgo.setMonth(monthAgo.getMonth() - 1);
      return { start: startOfDay(monthAgo), end: endOfDay(now) };
    }
    default: {
      // Try to parse as "last N days" pattern
      const daysMatch = dateRange.match(/last\s*(\d+)\s*days?/i);
      if (daysMatch) {
        const days = parseInt(daysMatch[1], 10);
        const daysAgo = new Date(now);
        daysAgo.setDate(daysAgo.getDate() - days);
        return { start: startOfDay(daysAgo), end: endOfDay(now) };
      }
      return null;
    }
  }
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

    log(`Database initialized at ${this.dbPath}`);
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

    const filesToIndex: Array<{ filePath: string; mtime: number }> = [];

    for (const filePath of files) {
      const stat = await fs.promises.stat(filePath);
      const lastIndexed = this.indexedFiles.get(filePath);

      // Skip if already indexed and not modified (unless force)
      if (!force && lastIndexed && lastIndexed >= stat.mtimeMs) {
        continue;
      }

      filesToIndex.push({ filePath, mtime: stat.mtimeMs });
    }

    if (filesToIndex.length === 0) {
      log("No new conversations to index");
      return { processed: 0, added: 0 };
    }

    log(`Indexing ${filesToIndex.length} conversations incrementally...`);

    // Process one file at a time and save progress after each
    for (let i = 0; i < filesToIndex.length; i++) {
      const { filePath, mtime } = filesToIndex[i];

      try {
        const conversation = await parseConversation(filePath);
        if (!conversation) {
          processed++;
          continue;
        }

        const chunks = chunkConversation(conversation);
        if (chunks.length === 0) {
          processed++;
          continue;
        }

        log(`[${i + 1}/${filesToIndex.length}] Embedding ${chunks.length} chunks from ${path.basename(filePath)}...`);

        // Generate embeddings for this file's chunks
        const texts = chunks.map((c) => c.content);
        const embeddings = await embed(texts);

        const records: ChunkRecord[] = chunks.map((chunk, j) => ({
          ...chunk,
          vector: embeddings[j],
        }));

        // Save to database immediately
        const tables = await this.db.tableNames();
        if (tables.includes(TABLE_NAME)) {
          // Delete existing chunks from this session before adding new ones
          await this.table!.delete(`"sessionId" = '${conversation.sessionId}'`);
          await this.table!.add(records);
        } else {
          this.table = await this.db.createTable(TABLE_NAME, records);
        }

        // Update metadata immediately so we can resume if interrupted
        this.indexedFiles.set(filePath, mtime);
        await this.saveIndexedFiles();

        processed++;
        added += records.length;

        log(`[${i + 1}/${filesToIndex.length}] Saved ${records.length} chunks`);
      } catch (error) {
        logError(`Error indexing ${filePath}`, error);
        processed++;
      }
    }

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
        await this.table!.delete(`"sessionId" = '${conversation.sessionId}'`);
        await this.table!.add(records);
      } else {
        this.table = await this.db.createTable(TABLE_NAME, records);
      }

      this.indexedFiles.set(filePath, conversation.lastModified);
      await this.saveIndexedFiles();

      return { processed: 1, added: records.length };
    } catch (error) {
      logError(`Error indexing ${filePath}`, error);
      return { processed: 1, added: 0 };
    }
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.table) {
      return [];
    }

    const { limit = 5, project, dateRange, sortBy = "relevance" } = options;

    const queryVector = await embedOne(query);

    // Get more results for filtering
    let searchQuery = this.table.vectorSearch(queryVector).limit(limit * 4);

    const results = await searchQuery.toArray();

    let filtered = results;

    // Filter by project
    if (project) {
      filtered = filtered.filter((r) => (r.project as string).includes(project));
    }

    // Filter by date range
    if (dateRange) {
      const range = parseDateRange(dateRange);
      if (range) {
        filtered = filtered.filter((r) => {
          const ts = new Date(r.timestamp as string);
          return ts >= range.start && ts <= range.end;
        });
      }
    }

    // Sort by recency if requested
    if (sortBy === "recency") {
      filtered.sort((a, b) => {
        const tsA = new Date(a.timestamp as string).getTime();
        const tsB = new Date(b.timestamp as string).getTime();
        return tsB - tsA; // Most recent first
      });
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
