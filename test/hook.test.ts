import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { detectEvent, classifyNudge } from "../src/hook.ts";
import { NudgeState } from "../src/store.ts";

describe("detectEvent", () => {
  test("recognizes commit, push, and PR commands", () => {
    assert.equal(detectEvent("git commit -m 'x'"), "commit");
    assert.equal(detectEvent("git push origin main"), "push");
    assert.equal(detectEvent("gh pr create --draft"), "pr_open");
    assert.equal(detectEvent("gh pr edit 12 --body-file b.md"), "pr_update");
  });

  test("matches inside chained / prefixed commands", () => {
    assert.equal(detectEvent("cd repo && git commit -am wip"), "commit");
    assert.equal(detectEvent("GIT_EDITOR=true git commit"), "commit");
    assert.equal(detectEvent("git add -A; git push"), "push");
  });

  test("is case-insensitive and whitespace-tolerant", () => {
    assert.equal(detectEvent("GIT   COMMIT -m y"), "commit");
    assert.equal(detectEvent("gh   pr   create"), "pr_open");
  });

  test("returns null for non-events", () => {
    assert.equal(detectEvent("git status"), null);
    assert.equal(detectEvent("ls -la"), null);
    assert.equal(detectEvent("git log --oneline"), null);
  });

  test("prefers PR over a bare git verb when both could match", () => {
    // `gh pr create` should win even though the word git/commit is absent; verifies ordering.
    assert.equal(detectEvent("gh pr create && git push"), "pr_open");
  });
});

const T0 = Date.parse("2026-01-01T00:00:00Z");
const state = (over: Partial<NudgeState> = {}): NudgeState => ({
  last_branch: "main",
  last_nudge_ts: null,
  last_event_ts: null,
  ...over,
});

describe("classifyNudge", () => {
  test("fires an event nudge for a commit with no prior event", () => {
    const d = classifyNudge("Bash", { command: "git commit -m x" }, state(), "main", T0);
    assert.deepEqual(d, { emit: true, kind: "event", event: "commit" });
  });

  test("suppresses a repeat event within the cooldown", () => {
    const prev = state({ last_event_ts: new Date(T0).toISOString() });
    const d = classifyNudge("Bash", { command: "git push" }, prev, "main", T0 + 60 * 1000);
    assert.deepEqual(d, { emit: false });
  });

  test("re-fires an event once the cooldown has elapsed", () => {
    const prev = state({ last_event_ts: new Date(T0).toISOString() });
    const d = classifyNudge("Bash", { command: "git push" }, prev, "main", T0 + 3 * 60 * 1000);
    assert.deepEqual(d, { emit: true, kind: "event", event: "push" });
  });

  test("an event command in cooldown does not drop through to a generic nudge", () => {
    // last_nudge_ts is stale (would trigger generic), but the event lane owns this command.
    const prev = state({ last_event_ts: new Date(T0).toISOString(), last_nudge_ts: null });
    const d = classifyNudge("Bash", { command: "git commit" }, prev, "main", T0 + 30 * 1000);
    assert.deepEqual(d, { emit: false });
  });

  test("emits a generic nudge for an edit when stale", () => {
    const d = classifyNudge("Edit", { file_path: "/a.ts" }, undefined, "main", T0);
    assert.deepEqual(d, { emit: true, kind: "generic" });
  });

  test("emits a generic nudge on branch change even when not stale", () => {
    const prev = state({ last_branch: "old", last_nudge_ts: new Date(T0).toISOString() });
    const d = classifyNudge("Edit", { file_path: "/a.ts" }, prev, "new", T0 + 1000);
    assert.deepEqual(d, { emit: true, kind: "generic" });
  });

  test("stays silent for a non-event tool when fresh and on the same branch", () => {
    const prev = state({ last_branch: "main", last_nudge_ts: new Date(T0).toISOString() });
    const d = classifyNudge("Bash", { command: "ls" }, prev, "main", T0 + 60 * 1000);
    assert.deepEqual(d, { emit: false });
  });
});
