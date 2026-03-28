import { describe, expect, test } from "bun:test";
import {
  decodeClaudeProject,
  extractTextContent,
  parseConversation,
  parseCodexConversation,
  chunkConversation,
  type Conversation,
} from "../src/parser.ts";
import fs from "fs";
import path from "path";

describe("decodeClaudeProject", () => {
  test("decodes a leading dash into / and replaces dashes with /", () => {
    expect(decodeClaudeProject("-Users-dimiguel-dev-clancey")).toBe("/Users/dimiguel/dev/clancey");
  });

  test("handles single-segment path", () => {
    expect(decodeClaudeProject("-Users")).toBe("/Users");
  });

  test("returns as-is when no leading dash", () => {
    expect(decodeClaudeProject("some-project")).toBe("some-project");
  });
});

describe("extractTextContent", () => {
  test("extracts from a plain string", () => {
    expect(extractTextContent("  hello world  ")).toBe("hello world");
  });

  test("extracts from array of text blocks", () => {
    expect(extractTextContent([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ])).toBe("first\nsecond");
  });

  test("extracts input_text and output_text block types", () => {
    expect(extractTextContent([
      { type: "input_text", text: "input" },
      { type: "output_text", text: "output" },
    ])).toBe("input\noutput");
  });

  test("ignores non-text block types", () => {
    expect(extractTextContent([
      { type: "text", text: "keep" },
      { type: "tool_use", text: "ignore" },
      { type: "image", text: "also ignore" },
    ])).toBe("keep");
  });

  test("ignores blocks without text property", () => {
    expect(extractTextContent([
      { type: "text" },
      { type: "text", text: "valid" },
    ])).toBe("valid");
  });

  test("returns empty string for null/undefined", () => {
    expect(extractTextContent(null)).toBe("");
    expect(extractTextContent(undefined)).toBe("");
  });

  test("returns empty string for number", () => {
    expect(extractTextContent(42)).toBe("");
  });

  test("returns empty string for empty array", () => {
    expect(extractTextContent([])).toBe("");
  });
});

const fixturesDir = path.join(import.meta.dir, "fixtures");

describe("parseConversation (Claude format)", () => {
  const fixturePath = path.join(fixturesDir, "claude-conversation.jsonl");

  test("parses valid user and assistant messages", async () => {
    const conv = await parseConversation(fixturePath);
    expect(conv).not.toBeNull();
    expect(conv!.messages.length).toBe(4);
  });

  test("derives sessionId from filename", async () => {
    const conv = await parseConversation(fixturePath);
    expect(conv!.sessionId).toBe("claude-conversation");
  });

  test("derives project from parent directory name", async () => {
    const conv = await parseConversation(fixturePath);
    expect(conv!.project).toBe("fixtures");
  });

  test("preserves message roles and timestamps", async () => {
    const conv = await parseConversation(fixturePath);
    expect(conv!.messages[0].role).toBe("user");
    expect(conv!.messages[0].timestamp).toBe("2026-01-01T10:00:00Z");
    expect(conv!.messages[1].role).toBe("assistant");
    expect(conv!.messages[1].timestamp).toBe("2026-01-01T10:01:00Z");
  });

  test("filters out meta, summary, file-history-snapshot entries", async () => {
    const conv = await parseConversation(fixturePath);
    const contents = conv!.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("ignored"))).toBe(false);
  });

  test("filters out short messages (< 20 chars)", async () => {
    const conv = await parseConversation(fixturePath);
    const contents = conv!.messages.map((m) => m.content);
    expect(contents.some((c) => c === "short")).toBe(false);
  });

  test("filters out command-name and local-command messages", async () => {
    const conv = await parseConversation(fixturePath);
    const contents = conv!.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("command-name"))).toBe(false);
    expect(contents.some((c) => c.includes("local-command"))).toBe(false);
  });

  test("handles array-of-blocks content", async () => {
    const conv = await parseConversation(fixturePath);
    // The 3rd message (index 2) has array content with type "text"
    expect(conv!.messages[2].content).toBe("Can you also look at the rate limiting logic?");
  });

  test("ignores tool_use blocks within array content", async () => {
    const conv = await parseConversation(fixturePath);
    // The 4th message (index 3) has text + tool_use blocks
    expect(conv!.messages[3].content).toBe("Sure, the rate limiter needs adjustment.");
    expect(conv!.messages[3].content).not.toContain("should be ignored");
  });

  test("returns null for empty conversation", async () => {
    const emptyFixture = path.join(fixturesDir, "claude-empty.jsonl");
    await Bun.write(emptyFixture, '{"isMeta":true,"title":"Empty"}\n');
    const conv = await parseConversation(emptyFixture);
    expect(conv).toBeNull();
  });
});

describe("parseConversation (Codex format)", () => {
  const fixturePath = path.join(fixturesDir, "codex-conversation.jsonl");

  async function parse() {
    const stat = await fs.promises.stat(fixturePath);
    return parseCodexConversation(fixturePath, stat);
  }

  test("parses valid user and assistant messages", async () => {
    const conv = await parse();
    expect(conv).not.toBeNull();
    expect(conv!.messages.length).toBe(3);
  });

  test("extracts project from session_meta cwd", async () => {
    const conv = await parse();
    expect(conv!.project).toBe("/Users/dimiguel/dev/my-app");
  });

  test("preserves message roles and timestamps", async () => {
    const conv = await parse();
    expect(conv!.messages[0].role).toBe("user");
    expect(conv!.messages[0].timestamp).toBe("2026-02-01T10:00:00Z");
    expect(conv!.messages[1].role).toBe("assistant");
    expect(conv!.messages[1].timestamp).toBe("2026-02-01T10:01:00Z");
  });

  test("filters out boilerplate messages (AGENTS.md, environment_context)", async () => {
    const conv = await parse();
    const contents = conv!.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("AGENTS.md"))).toBe(false);
    expect(contents.some((c) => c.includes("environment_context"))).toBe(false);
  });

  test("filters out short messages (< 20 chars)", async () => {
    const conv = await parse();
    const contents = conv!.messages.map((m) => m.content);
    expect(contents.some((c) => c === "short")).toBe(false);
  });

  test("ignores non-message payload types (function_call)", async () => {
    const conv = await parse();
    const contents = conv!.messages.map((m) => m.content);
    expect(contents.some((c) => c.includes("tool call"))).toBe(false);
  });

  test("handles input_text and output_text block types", async () => {
    const conv = await parse();
    expect(conv!.messages[0].content).toBe("How do I set up the database migration?");
    expect(conv!.messages[1].content).toBe("You can use the migrate command to set up your database schema.");
  });

  test("defaults project to 'codex' when no session_meta", async () => {
    const noMetaFixture = path.join(fixturesDir, "codex-no-meta.jsonl");
    await Bun.write(noMetaFixture, '{"type":"response_item","timestamp":"2026-01-01T00:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"A sufficiently long message for testing"}]}}\n');
    const stat = await fs.promises.stat(noMetaFixture);
    const conv = await parseCodexConversation(noMetaFixture, stat);
    expect(conv!.project).toBe("codex");
  });

  test("returns null for empty codex conversation", async () => {
    const emptyFixture = path.join(fixturesDir, "codex-empty.jsonl");
    await Bun.write(emptyFixture, '{"type":"session_meta","payload":{"cwd":"/tmp"}}\n');
    const stat = await fs.promises.stat(emptyFixture);
    const conv = await parseCodexConversation(emptyFixture, stat);
    expect(conv).toBeNull();
  });
});

describe("chunkConversation", () => {
  function makeConversation(messages: Array<{ role: "user" | "assistant"; content: string; timestamp: string }>): Conversation {
    return {
      sessionId: "test-session",
      project: "/test/project",
      messages,
      filePath: "/tmp/test.jsonl",
      lastModified: Date.now(),
    };
  }

  test("produces a single chunk for short conversations", () => {
    const conv = makeConversation([
      { role: "user", content: "Hello there", timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: "Hi!", timestamp: "2026-01-01T00:01:00Z" },
    ]);
    const chunks = chunkConversation(conv);
    expect(chunks.length).toBe(1);
    expect(chunks[0].id).toBe("test-session-0");
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].sessionId).toBe("test-session");
    expect(chunks[0].project).toBe("/test/project");
    expect(chunks[0].content).toContain("User: Hello there");
    expect(chunks[0].content).toContain("Assistant: Hi!");
  });

  test("splits long conversations into multiple chunks", () => {
    const longMessage = "x".repeat(1500);
    const conv = makeConversation([
      { role: "user", content: longMessage, timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: longMessage, timestamp: "2026-01-01T00:01:00Z" },
      { role: "user", content: "short follow-up message", timestamp: "2026-01-01T00:02:00Z" },
    ]);
    const chunks = chunkConversation(conv, 2000);
    expect(chunks.length).toBeGreaterThan(1);
  });

  test("assigns sequential chunk IDs", () => {
    const longMessage = "x".repeat(1500);
    const conv = makeConversation([
      { role: "user", content: longMessage, timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: longMessage, timestamp: "2026-01-01T00:01:00Z" },
    ]);
    const chunks = chunkConversation(conv, 2000);
    chunks.forEach((chunk, i) => {
      expect(chunk.id).toBe(`test-session-${i}`);
      expect(chunk.chunkIndex).toBe(i);
    });
  });

  test("uses first message timestamp for first chunk", () => {
    const conv = makeConversation([
      { role: "user", content: "Hello there friend", timestamp: "2026-01-01T00:00:00Z" },
    ]);
    const chunks = chunkConversation(conv);
    expect(chunks[0].timestamp).toBe("2026-01-01T00:00:00Z");
  });

  test("uses boundary message timestamp for subsequent chunks", () => {
    const longMessage = "x".repeat(1500);
    const conv = makeConversation([
      { role: "user", content: longMessage, timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: longMessage, timestamp: "2026-01-01T01:00:00Z" },
    ]);
    const chunks = chunkConversation(conv, 2000);
    expect(chunks.length).toBe(2);
    expect(chunks[0].timestamp).toBe("2026-01-01T00:00:00Z");
    expect(chunks[1].timestamp).toBe("2026-01-01T01:00:00Z");
  });

  test("returns empty array for conversation with no messages", () => {
    const conv = makeConversation([]);
    const chunks = chunkConversation(conv);
    expect(chunks).toEqual([]);
  });

  test("respects custom maxChunkSize", () => {
    const conv = makeConversation([
      { role: "user", content: "a".repeat(100), timestamp: "2026-01-01T00:00:00Z" },
      { role: "assistant", content: "b".repeat(100), timestamp: "2026-01-01T00:01:00Z" },
    ]);
    // With a tiny chunk size, each message should get its own chunk
    const chunks = chunkConversation(conv, 150);
    expect(chunks.length).toBe(2);
  });
});
