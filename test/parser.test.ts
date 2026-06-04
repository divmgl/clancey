import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  decodeClaudeProject,
  extractTextContent,
  parseTranscript,
  parseCodexTranscript,
  listSubagents,
  parseSubagent,
} from "../src/parser.ts";
import path from "path";

describe("decodeClaudeProject", () => {
  test("decodes a leading dash into / and replaces dashes with /", () => {
    assert.equal(decodeClaudeProject("-Users-dimiguel-dev-clancey"), "/Users/dimiguel/dev/clancey");
  });

  test("returns as-is when no leading dash", () => {
    assert.equal(decodeClaudeProject("some-project"), "some-project");
  });
});

describe("extractTextContent", () => {
  test("extracts from a plain string", () => {
    assert.equal(extractTextContent("  hello world  "), "hello world");
  });

  test("extracts and joins text blocks", () => {
    assert.equal(
      extractTextContent([
        { type: "text", text: "first" },
        { type: "input_text", text: "second" },
      ]),
      "first\nsecond",
    );
  });

  test("ignores tool_use / tool_result and non-text blocks", () => {
    assert.equal(
      extractTextContent([
        { type: "text", text: "keep" },
        { type: "tool_use", name: "Edit" },
        { type: "tool_result", content: "x" },
      ]),
      "keep",
    );
  });

  test("returns empty string for null / number / empty array", () => {
    assert.equal(extractTextContent(null), "");
    assert.equal(extractTextContent(42), "");
    assert.equal(extractTextContent([]), "");
  });
});

describe("parseTranscript", () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "transcript.jsonl");

  test("captures the aiTitle", async () => {
    const t = await parseTranscript(fixture);
    assert.equal(t.title, "My feature work");
    assert.equal(t.sessionId, "transcript");
  });

  test("extracts file edits and bash commands, ignores reads", async () => {
    const t = await parseTranscript(fixture);
    assert.deepEqual(t.toolEvents, [
      { tool: "Edit", file: "/repo/src/auth.ts", command: null, branch: "feature/x", cwd: "/repo", timestamp: "2026-01-01T10:00:02Z" },
      { tool: "Bash", file: null, command: "bun test", branch: "feature/x", cwd: "/repo", timestamp: "2026-01-01T10:00:03Z" },
    ]);
  });

  test("keeps human turns; drops meta, short, command, and tool_result entries", async () => {
    const t = await parseTranscript(fixture);
    assert.deepEqual(
      t.userTurns.map((u) => u.text),
      [
        "We need to refactor the auth module because it is tangled and hard to test.",
        "Let's also add a test for the token refresh path.",
      ],
    );
  });

  test("framing is the first human turn and carries its branch", async () => {
    const t = await parseTranscript(fixture);
    assert.equal(t.framing, "We need to refactor the auth module because it is tangled and hard to test.");
    assert.equal(t.userTurns[0].branch, "feature/x");
  });
});

describe("full conversation messages", () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "conversation.jsonl");

  test("captures user prompts, assistant prose, and the verbatim scripts it wrote", async () => {
    const t = await parseTranscript(fixture);
    const texts = t.messages.map((m) => m.text);
    assert.ok(texts.includes("Write a cohort script that runs six game generations as a real user."));
    // assistant prose + the Write body are rendered into one message, headed by the file label
    assert.ok(
      texts.some((x) => x.includes("「Write /repo/run-cohort.ts」") && x.includes("await runHeadlessAgent();")),
    );
    // the Bash command (the "script body") is searchable
    assert.ok(texts.some((x) => x.includes("「Bash」") && x.includes("node run-cohort.ts")));
  });

  test("drops thinking, tool_result output, and binary/base64 blobs — but keeps surrounding prose", async () => {
    const t = await parseTranscript(fixture);
    const all = t.messages.map((m) => m.text).join("\n");
    assert.ok(!all.includes("internal reasoning"), "thinking must be dropped");
    assert.ok(!all.includes("should be dropped from messages"), "tool_result must be dropped");
    assert.ok(!all.includes("AAAA"), "binary blob must be dropped");
    assert.ok(all.includes("Done — six games generated."), "prose alongside a dropped blob is kept");
  });

  test("main-session messages carry no agent attribution", async () => {
    const t = await parseTranscript(fixture);
    assert.ok(t.messages.length > 0);
    assert.ok(t.messages.every((m) => m.agent === null && m.agentId === null));
  });
});

describe("subagents", () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "conversation.jsonl");

  test("discovers a session's subagent transcripts and reads the agent type from meta", async () => {
    const subs = await listSubagents(fixture);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].agentType, "Explore");
    assert.equal(subs[0].agentId, "explore1");
    assert.equal(subs[0].parentSessionId, "conversation");
  });

  test("folds subagent turns under the parent session with agent attribution", async () => {
    const [ref] = await listSubagents(fixture);
    const t = await parseSubagent(ref);
    assert.equal(t.sessionId, "conversation");
    assert.ok(t.messages.length > 0);
    assert.ok(t.messages.every((m) => m.agent === "Explore" && m.agentId === "explore1"));
    assert.ok(t.messages.some((m) => m.text.includes("run-headless-agent.ts")));
    assert.ok(t.messages.some((m) => m.text.includes("「Bash」") && m.text.includes("rg -n runHeadlessAgent")));
  });

  test("returns no subagents for a session without a subagents dir", async () => {
    const plain = path.join(import.meta.dirname, "fixtures", "transcript.jsonl");
    assert.deepEqual(await listSubagents(plain), []);
  });
});

describe("parseCodexTranscript", () => {
  const fixture = path.join(import.meta.dirname, "fixtures", "codex.jsonl");

  test("takes branch from session_meta git and uses workdir as event cwd", async () => {
    const t = await parseCodexTranscript(fixture);
    const exec = t.toolEvents.find((e) => e.tool === "exec_command");
    assert.equal(exec?.command, "rg -n useState packages");
    assert.equal(exec?.branch, "feature/codex");
    assert.equal(exec?.cwd, "/repo/packages/web");
  });

  test("extracts apply_patch files from custom_tool_call, and shell commands", async () => {
    const t = await parseCodexTranscript(fixture);
    const patch = t.toolEvents.find((e) => e.tool === "apply_patch");
    assert.equal(patch?.file, "packages/web/src/state.ts");
    const shell = t.toolEvents.find((e) => e.tool === "shell");
    assert.equal(shell?.command, "bun test");
  });

  test("drops AGENTS.md/boilerplate user messages; framing is the real turn", async () => {
    const t = await parseCodexTranscript(fixture);
    assert.deepEqual(t.userTurns.map((u) => u.text), ["Refactor the state management API to drop all casting."]);
    assert.equal(t.framing, "Refactor the state management API to drop all casting.");
  });
});
