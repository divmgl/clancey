import { afterAll, describe, expect, mock, test } from "bun:test";
import { buildMetadataFileDeleteFilter, buildSessionDeleteFilter, ConversationDB, parseDateRange } from "../src/db.ts";
import fs from "fs";
import os from "os";
import path from "path";
import * as lancedb from "@lancedb/lancedb";

describe("buildSessionDeleteFilter", () => {
  test("builds a filter for plain session ids", () => {
    expect(buildSessionDeleteFilter("session-123")).toBe(`"sessionId" = 'session-123'`);
  });

  test("escapes single quotes in session ids", () => {
    expect(buildSessionDeleteFilter("abc'def")).toBe(`"sessionId" = 'abc''def'`);
  });

  test("escapes multiple single quotes in session ids", () => {
    expect(buildSessionDeleteFilter("a'b''c")).toBe(`"sessionId" = 'a''b''''c'`);
  });
});

describe("getStatus", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-test-"));
  const dbPath = path.join(tmpDir, "test.lance");

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns zeros when table does not exist", async () => {
    const db = new ConversationDB(dbPath);
    await db.init();
    const status = await db.getStatus();
    expect(status).toEqual({
      totalChunks: 0,
      projects: 0,
      lastUpdated: null,
    });
  });

  test("returns correct counts and latest timestamp", async () => {
    const conn = await lancedb.connect(dbPath);
    const dim = 384;
    const records = [
      { id: "1", sessionId: "s1", project: "proj-a", content: "hello", timestamp: "2026-01-01T00:00:00Z", chunkIndex: 0, vector: new Array(dim).fill(0) },
      { id: "2", sessionId: "s2", project: "proj-a", content: "world", timestamp: "2026-02-01T00:00:00Z", chunkIndex: 0, vector: new Array(dim).fill(0) },
      { id: "3", sessionId: "s3", project: "proj-b", content: "test", timestamp: "2026-03-01T00:00:00Z", chunkIndex: 0, vector: new Array(dim).fill(0) },
    ];
    await conn.createTable("conversations", records, { mode: "overwrite" });

    const db = new ConversationDB(dbPath);
    await db.init();
    const status = await db.getStatus();

    expect(status.totalChunks).toBe(3);
    expect(status.projects).toBe(2);
    expect(status.lastUpdated).toBe("2026-03-01T00:00:00Z");
  });
});

describe("indexAll single-flight", () => {
  test("rejects concurrent indexAll() call", async () => {
    // Access private field to simulate an in-progress indexAll
    const db = new ConversationDB("/tmp/clancey-single-flight.lance") as unknown as {
      db: object;
      indexAllInProgress: boolean;
      indexAll: (force: boolean) => Promise<{ processed: number; added: number }>;
    };
    db.db = {}; // non-null so the "not initialized" check passes
    db.indexAllInProgress = true;

    await expect(db.indexAll(false)).rejects.toThrow(/already in progress/i);
  });
});

describe("search", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-search-test-"));
  const dbPath = path.join(tmpDir, "search.lance");
  const dim = 384;

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("project filter returns results even when they are not in the top vector matches", async () => {
    const conn = await lancedb.connect(dbPath);

    // Create 30 records for "common-project" with vectors near the origin,
    // and 5 records for "rare-project" with vectors far from origin.
    // A vector search for a near-origin query will rank common-project first.
    const records = [];
    for (let i = 0; i < 30; i++) {
      const vec = new Array(dim).fill(0);
      vec[0] = 0.01 * i; // close to origin
      records.push({
        id: `common-${i}`,
        sessionId: `s-common-${i}`,
        project: "common-project",
        content: `common content ${i}`,
        timestamp: "2026-01-01T00:00:00Z",
        chunkIndex: 0,
        vector: vec,
      });
    }
    for (let i = 0; i < 5; i++) {
      const vec = new Array(dim).fill(0);
      vec[0] = 100 + i; // far from origin
      records.push({
        id: `rare-${i}`,
        sessionId: `s-rare-${i}`,
        project: "rare-project",
        content: `rare content ${i}`,
        timestamp: "2026-01-01T00:00:00Z",
        chunkIndex: 0,
        vector: vec,
      });
    }

    await conn.createTable("conversations", records, { mode: "overwrite" });

    const db = new ConversationDB(dbPath);
    await db.init();

    // Search with limit=5 filtering for "rare-project".
    // With post-filter on limit*4=20, all 20 nearest are from common-project,
    // so rare-project results would be lost. With pre-filter via where(), they should appear.
    const results = await db.search("test query", {
      limit: 5,
      project: "rare-project",
    });

    expect(results.length).toBe(5);
    for (const r of results) {
      expect(r.project).toBe("rare-project");
    }
  });
});

describe("late table discovery", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clancey-late-table-"));
  const dbPath = path.join(tmpDir, "late.lance");
  const dim = 384;

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("getStatus finds table created after init()", async () => {
    // Init with no table — this.table will be null
    const db = new ConversationDB(dbPath);
    await db.init();

    const before = await db.getStatus();
    expect(before.totalChunks).toBe(0);

    // Another "instance" creates the table
    const conn = await lancedb.connect(dbPath);
    await conn.createTable("conversations", [
      { id: "1", sessionId: "s1", project: "p1", content: "hi", timestamp: "2026-01-01T00:00:00Z", chunkIndex: 0, vector: new Array(dim).fill(0) },
    ], { mode: "overwrite" });

    // getStatus should now discover the table
    const after = await db.getStatus();
    expect(after.totalChunks).toBe(1);
  });
});

describe("buildMetadataFileDeleteFilter", () => {
  test("escapes single quotes in file paths", () => {
    expect(buildMetadataFileDeleteFilter("/tmp/a'b.jsonl")).toBe(`"filePath" = '/tmp/a''b.jsonl'`);
  });
});

describe("saveIndexedFile", () => {
  test("updates metadata for one file without clearing the whole table", async () => {
    const deleteMock = mock(async (_filter: string) => {});
    const addMock = mock(async (_records: unknown[]) => {});
    const tableNamesMock = mock(async () => ["metadata"]);
    const openTableMock = mock(async (_tableName: string) => ({
      delete: deleteMock,
      add: addMock,
    }));

    const db = new ConversationDB("/tmp/clancey-test.lance") as unknown as {
      db: { tableNames: typeof tableNamesMock; openTable: typeof openTableMock };
      saveIndexedFile: (filePath: string, lastModified: number) => Promise<void>;
    };

    db.db = {
      tableNames: tableNamesMock,
      openTable: openTableMock,
    };

    await db.saveIndexedFile("/tmp/a'b.jsonl", 123);

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteMock).toHaveBeenCalledWith(`"filePath" = '/tmp/a''b.jsonl'`);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith([{ filePath: "/tmp/a'b.jsonl", lastModified: 123 }]);
  });
});

describe("parseDateRange", () => {
  test("parses 'today' to start and end of current day", () => {
    const result = parseDateRange("today");
    expect(result).not.toBeNull();
    const now = new Date();
    expect(result!.start.getFullYear()).toBe(now.getFullYear());
    expect(result!.start.getMonth()).toBe(now.getMonth());
    expect(result!.start.getDate()).toBe(now.getDate());
    expect(result!.start.getHours()).toBe(0);
    expect(result!.end.getHours()).toBe(23);
    expect(result!.end.getMinutes()).toBe(59);
  });

  test("parses 'yesterday'", () => {
    const result = parseDateRange("yesterday");
    expect(result).not.toBeNull();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(result!.start.getDate()).toBe(yesterday.getDate());
    expect(result!.end.getDate()).toBe(yesterday.getDate());
  });

  test("parses 'last_week', 'last week', and 'week'", () => {
    for (const input of ["last_week", "last week", "week"]) {
      const result = parseDateRange(input);
      expect(result).not.toBeNull();
      const diff = result!.end.getTime() - result!.start.getTime();
      const days = diff / (1000 * 60 * 60 * 24);
      expect(days).toBeGreaterThanOrEqual(6);
      expect(days).toBeLessThanOrEqual(8);
    }
  });

  test("parses 'last_month', 'last month', and 'month'", () => {
    for (const input of ["last_month", "last month", "month"]) {
      const result = parseDateRange(input);
      expect(result).not.toBeNull();
      const diff = result!.end.getTime() - result!.start.getTime();
      const days = diff / (1000 * 60 * 60 * 24);
      expect(days).toBeGreaterThanOrEqual(27);
      expect(days).toBeLessThanOrEqual(32);
    }
  });

  test("parses 'last N days' pattern", () => {
    const result = parseDateRange("last 3 days");
    expect(result).not.toBeNull();
    const diff = result!.end.getTime() - result!.start.getTime();
    const days = diff / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThanOrEqual(2);
    expect(days).toBeLessThanOrEqual(4);
  });

  test("parses 'last 30 days'", () => {
    const result = parseDateRange("last 30 days");
    expect(result).not.toBeNull();
    const diff = result!.end.getTime() - result!.start.getTime();
    const days = diff / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThanOrEqual(29);
    expect(days).toBeLessThanOrEqual(31);
  });

  test("is case insensitive", () => {
    expect(parseDateRange("TODAY")).not.toBeNull();
    expect(parseDateRange("Yesterday")).not.toBeNull();
    expect(parseDateRange("LAST WEEK")).not.toBeNull();
  });

  test("returns null for unrecognized input", () => {
    expect(parseDateRange("gibberish")).toBeNull();
    expect(parseDateRange("next week")).toBeNull();
    expect(parseDateRange("")).toBeNull();
  });
});
