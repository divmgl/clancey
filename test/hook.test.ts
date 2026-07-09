import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHookPayload } from "../src/hook.ts";

describe("normalizeHookPayload", () => {
  test("passes through Claude snake_case PostToolUse payloads", () => {
    const p = normalizeHookPayload({
      hook_event_name: "PostToolUse",
      session_id: "s1",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    assert.deepEqual(p, {
      hook_event_name: "PostToolUse",
      session_id: "s1",
      cwd: "/repo",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
  });

  test("normalizes Grok camelCase + snake event names and tool aliases", () => {
    const p = normalizeHookPayload({
      hookEventName: "post_tool_use",
      sessionId: "019f-abc",
      cwd: "/Users/me/proj",
      toolName: "run_terminal_command",
      toolInput: { command: "git status", description: "check" },
    });
    assert.equal(p.hook_event_name, "PostToolUse");
    assert.equal(p.session_id, "019f-abc");
    assert.equal(p.cwd, "/Users/me/proj");
    assert.equal(p.tool_name, "Bash");
    assert.equal(p.tool_input?.command, "git status");
  });

  test("maps search_replace and write to Edit/Write with file_path", () => {
    const edit = normalizeHookPayload({
      hookEventName: "PostToolUse",
      toolName: "search_replace",
      toolInput: { file_path: "/repo/a.ts", old_string: "x", new_string: "y" },
    });
    assert.equal(edit.tool_name, "Edit");
    assert.equal(edit.tool_input?.file_path, "/repo/a.ts");

    const write = normalizeHookPayload({
      hook_event_name: "PostToolUse",
      tool_name: "write",
      tool_input: { path: "/repo/b.ts", content: "hi" },
    });
    assert.equal(write.tool_name, "Write");
    assert.equal(write.tool_input?.file_path, "/repo/b.ts");
  });

  test("normalizes session_start to SessionStart", () => {
    const p = normalizeHookPayload({ hookEventName: "session_start", sessionId: "s" });
    assert.equal(p.hook_event_name, "SessionStart");
    assert.equal(p.session_id, "s");
  });

  test("falls back to workspaceRoot for cwd", () => {
    const p = normalizeHookPayload({
      hookEventName: "PostToolUse",
      workspaceRoot: "/ws",
      toolName: "Bash",
      toolInput: { command: "true" },
    });
    assert.equal(p.cwd, "/ws");
  });
});
