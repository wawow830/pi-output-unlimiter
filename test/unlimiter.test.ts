import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type {
  BoundaryResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext,
  MessageEndEventResult, RegisteredCommand, TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, readSettings, updateSettings, validateSettings } from "../src/config.ts";
import { registerUnlimiter } from "../src/extension.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-output-unlimiter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "config", "output-unlimiter.json") };
}

function harness(t: TestContext, initial: unknown = {}) {
  const { dir, path } = fixture(t);
  mkdirSync(join(dir, "config"));
  writeFileSync(path, JSON.stringify(initial));
  const handlers = new Map<string, (event: never, ctx: ExtensionContext) => unknown>();
  let command: RegisteredCommand;
  const notices: { message: string; level: string }[] = [];
  const archives: { customType: string; data: unknown }[] = [];
  const controller = new AbortController();
  let pending = false;
  const ctx = {
    hasUI: true,
    signal: controller.signal,
    hasPendingMessages: () => pending,
    ui: { notify: (message: string, level: string) => notices.push({ message, level }) },
  } as unknown as ExtensionCommandContext;
  const pi = {
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    appendEntry: (customType: string, data: unknown) => archives.push({ customType, data }),
    registerCommand: (name: string, registered: RegisteredCommand) => {
      assert.equal(name, "unlimiter");
      command = registered;
    },
  } as unknown as ExtensionAPI;
  registerUnlimiter(pi, path);
  const emit = (name: string, event: unknown = {}) => handlers.get(name)?.(event as never, ctx);
  emit("session_start");
  return {
    path, ctx, controller, notices, archives, emit,
    end: (message: TurnEndEvent["message"]) => {
      const result = emit("message_end", { type: "message_end", message }) as MessageEndEventResult | undefined;
      return result?.message ?? message;
    },
    setPending: (value: boolean) => { pending = value; },
    command: (args: string) => command.handler(args, ctx),
    turn: (overrides: Partial<TurnEndEvent> = {}) => emit("turn_end", turn(overrides)) as BoundaryResult | undefined,
  };
}

function turn(overrides: Partial<TurnEndEvent> = {}): TurnEndEvent {
  return {
    type: "turn_end", turnIndex: 0,
    messageEntryId: "assistant-1", toolResultEntryIds: [], toolResults: [],
    entries: [], continue: false, outcome: "completed",
    context: { contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: false },
    message: {
      role: "assistant", content: [{ type: "text", text: "An unfinished answer..." }],
      stopReason: "length", api: "openai-completions", provider: "test", model: "test",
      timestamp: 1,
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
    ...overrides,
  };
}

function assistant(overrides: Record<string, unknown>): TurnEndEvent["message"] {
  return { ...turn().message, ...overrides } as TurnEndEvent["message"];
}

test("missing settings use defaults without writing a file", (t) => {
  const { path } = fixture(t);
  assert.deepEqual(readSettings(path), DEFAULT_SETTINGS);
});

test("validates partial settings and preserves multiline message", () => {
  assert.deepEqual(validateSettings({ message: "Continue.\nNo recap." }), {
    ...DEFAULT_SETTINGS, message: "Continue.\nNo recap.",
  });
  assert.equal(validateSettings({ maxContinuations: 0 }).maxContinuations, 0);
  for (const value of [null, [], "x", { enabled: "false" }, { recoverTerminated: "true" }, { message: " " }, { message: 1 },
    { maxContinuations: -1 }, { maxContinuations: 1.5 }, { maxContinuations: Infinity },
    { maxContinuations: Number.MAX_SAFE_INTEGER + 1 }, { maxContinuation: 3 }]) {
    assert.throws(() => validateSettings(value));
  }
});

test("updates settings atomically, preserving unrelated changes", (t) => {
  const { dir, path } = fixture(t);
  updateSettings(path, { message: "Keep going." });
  updateSettings(path, { maxContinuations: 5 });
  assert.deepEqual(readSettings(path), { ...DEFAULT_SETTINGS, message: "Keep going.", maxContinuations: 5 });
  assert.deepEqual(readdirSync(join(dir, "config")), ["output-unlimiter.json"]);
  assert.throws(() => updateSettings(path, { message: "" }));
  assert.equal(readSettings(path).message, "Keep going.");
});

test("length-truncated text appends configured instruction and requests one turn", (t) => {
  const h = harness(t, { message: "Continue from here." });
  assert.deepEqual(h.turn(), {
    continue: true,
    entries: [{ type: "custom_message", customType: "output-unlimiter", content: "Continue from here.",
      display: true, details: { continuation: 1, maxContinuations: 3 } }],
  });
});

test("budget survives custom messages and agent restarts; a real user resets it", (t) => {
  const h = harness(t, { maxContinuations: 2 });
  assert.equal(h.turn()?.continue, true);
  h.emit("message_start", { message: { role: "custom", customType: "output-unlimiter" } });
  h.emit("agent_start");
  assert.equal(h.turn()?.continue, true);
  assert.equal(h.turn(), undefined);
  assert.match(h.notices.at(-1)!.message, /limit reached/);
  h.emit("message_start", { message: { role: "user" } });
  assert.equal(h.turn()?.continue, true);
});

test("session initialization resets budget", (t) => {
  const h = harness(t, { maxContinuations: 1 });
  h.turn();
  assert.equal(h.turn(), undefined);
  h.emit("session_start");
  assert.equal(h.turn()?.continue, true);
});

test("normal stops, errors, aborts, and tool responses never trigger continuation", (t) => {
  const h = harness(t);
  for (const stopReason of ["stop", "error", "aborted", "toolUse"]) {
    assert.equal(h.turn({ message: assistant({ stopReason }) }), undefined);
  }
  assert.equal(h.turn({ message: assistant({ content: [
    { type: "text", text: "partial" },
    { type: "toolCall", id: "1", name: "write", arguments: { path: "test" } },
  ] }) }), undefined);
  assert.equal(h.turn({ message: { role: "user", content: "hello", timestamp: 1 } }), undefined);
  // Skipped turns do not consume the budget.
  assert.equal(h.turn()?.continue, true);
});

test("empty, whitespace, and thinking-only responses do not trigger continuation", (t) => {
  const h = harness(t);
  for (const content of [[], [{ type: "text", text: "\n " }], [{ type: "thinking", thinking: "hmm" }]]) {
    assert.equal(h.turn({ message: assistant({ content }) }), undefined);
  }
});

test("honors cancellation and failed activity outcome", (t) => {
  const h = harness(t);
  assert.equal(h.turn({ outcome: "error" }), undefined);
  assert.equal(h.turn({ outcome: "aborted" }), undefined);
  h.controller.abort();
  assert.equal(h.turn(), undefined);
});

test("does not compete with queued messages or another extension's continuation", (t) => {
  const h = harness(t);
  h.setPending(true);
  assert.equal(h.turn(), undefined);
  h.setPending(false);
  assert.equal(h.turn({ continue: true }), undefined);
  assert.equal(h.turn({ context: { ...turn().context, pendingMessages: [
    { role: "user", content: "Do this instead", timestamp: 1 },
  ] } }), undefined);
});

test("disabled and zero-budget configurations do not continue", (t) => {
  assert.equal(harness(t, { enabled: false }).turn(), undefined);
  assert.equal(harness(t, { maxContinuations: 0 }).turn(), undefined);
});

test("works without a UI, including when the limit is reached", (t) => {
  const h = harness(t, { maxContinuations: 1 });
  h.ctx.hasUI = false;
  h.ctx.ui.notify = () => { throw new Error("UI must not be called"); };
  assert.equal(h.turn()?.continue, true);
  assert.equal(h.turn(), undefined);
});

test("commands persist message, limit, and enabled state", async (t) => {
  const h = harness(t);
  await h.command("message Continue where you stopped.\nDo not repeat.");
  await h.command("limit 1");
  const result = h.turn();
  assert.equal(result?.entries?.[0].type, "custom_message");
  if (result?.entries?.[0].type === "custom_message") {
    assert.equal(result.entries[0].content, "Continue where you stopped.\nDo not repeat.");
  }
  assert.equal(h.turn(), undefined);
  await h.command("off");
  h.emit("message_start", { message: { role: "user" } });
  assert.equal(h.turn(), undefined);
  await h.command("on");
  assert.equal(h.turn()?.continue, true);
  assert.deepEqual(readSettings(h.path), {
    enabled: true, recoverTerminated: true, maxContinuations: 1, message: "Continue where you stopped.\nDo not repeat.",
  });
  await h.command("reset-message");
  assert.equal(readSettings(h.path).message, DEFAULT_SETTINGS.message);
  await h.command("");
  assert.match(h.notices.at(-1)!.message, /Continuation limit: 1/);
});

test("invalid commands do not alter settings", async (t) => {
  const h = harness(t);
  const before = readFileSync(h.path, "utf8");
  for (const command of ["message", "message   ", "limit -1", "limit 1.5", "limit Infinity", "limit 9007199254740992", "on extra", "terminated", "terminated maybe", "terminated off extra", "reset-message extra", "oops"]) {
    await h.command(command);
    assert.equal(h.notices.at(-1)!.level, "warning");
    assert.equal(readFileSync(h.path, "utf8"), before);
  }
});

test("malformed configuration fails closed and is not overwritten by a command", async (t) => {
  const h = harness(t);
  writeFileSync(h.path, "{broken");
  h.emit("session_start");
  assert.equal(h.turn(), undefined);
  assert.equal(h.notices.at(-1)!.level, "error");
  await h.command("on");
  assert.equal(h.turn(), undefined);
  assert.equal(readFileSync(h.path, "utf8"), "{broken");
});

test("terminated text is archived and made replayable without unsafe provider metadata", (t) => {
  const h = harness(t);
  const original = assistant({
    stopReason: "error", errorMessage: "terminated", responseId: "partial-response",
    rawStopReason: "error", endTurn: false,
    content: [
      { type: "thinking", thinking: "unfinished reasoning", thinkingSignature: "incomplete" },
      { type: "text", text: "paid partial text", textSignature: "partial-id" },
    ],
  });
  const saved = structuredClone(original);
  const recovered = h.end(original);
  assert.equal(recovered.role, "assistant");
  if (recovered.role !== "assistant") return;
  assert.equal(recovered.stopReason, "stop");
  assert.equal(recovered.errorMessage, undefined);
  assert.equal(recovered.responseId, undefined);
  assert.equal(recovered.rawStopReason, undefined);
  assert.equal(recovered.endTurn, undefined);
  assert.deepEqual(recovered.usage, original.role === "assistant" ? original.usage : undefined);
  assert.deepEqual(recovered.content, [{ type: "text", text: "paid partial text" }]);
  assert.deepEqual(h.archives, [{ customType: "output-unlimiter-interruption", data: { originalMessage: saved } }]);
  const result = h.turn({ message: recovered });
  assert.equal(result?.continue, true);
  const instruction = result?.entries?.at(-1);
  assert.equal(instruction?.type, "custom_message");
  if (instruction?.type === "custom_message") {
    assert.deepEqual(instruction.details, { continuation: 1, maxContinuations: 3, reason: "terminated" });
  }
  // Never continue an already-consumed recovery marker twice.
  assert.equal(h.turn({ message: recovered }), undefined);
});

test("only exact terminated transport errors are recovered", (t) => {
  const h = harness(t);
  for (const errorMessage of ["terminated", "Error: terminated", "TypeError: terminated", " TERMINATED "]) {
    const original = assistant({ stopReason: "error", errorMessage });
    assert.notEqual(h.end(original), original);
  }
  for (const errorMessage of [undefined, "", "401 unauthorized", "429 rate limit", "terminated: quota exceeded", "request terminated by safety policy", "fetch failed"]) {
    const original = assistant({ stopReason: "error", errorMessage });
    assert.equal(h.end(original), original);
  }
});

test("terminated recovery excludes tools, empty text, and user cancellation", (t) => {
  const h = harness(t);
  for (const content of [[], [{ type: "text", text: " " }], [{ type: "thinking", thinking: "paid thinking" }], [
    { type: "text", text: "partial" }, { type: "toolCall", id: "1", name: "write", arguments: {} },
  ]]) {
    const original = assistant({ stopReason: "error", errorMessage: "terminated", content });
    assert.equal(h.end(original), original);
  }
  const cancelled = assistant({ stopReason: "aborted", errorMessage: "terminated" });
  assert.equal(h.end(cancelled), cancelled);
  h.controller.abort();
  const original = assistant({ stopReason: "error", errorMessage: "terminated" });
  assert.equal(h.end(original), original);
  assert.deepEqual(h.archives, []);
});

test("terminated recovery shares the length budget and preserves text at the cap", (t) => {
  const h = harness(t, { maxContinuations: 1 });
  assert.equal(h.turn()?.continue, true);
  const original = assistant({ stopReason: "error", errorMessage: "terminated" });
  const recovered = h.end(original);
  assert.notEqual(recovered, original);
  assert.equal(h.turn({ message: recovered }), undefined);
  assert.match(h.notices.at(-1)!.message, /limit reached/);
  assert.equal(h.archives.length, 1);
});

test("terminated recovery can be disabled independently", async (t) => {
  const h = harness(t);
  const original = assistant({ stopReason: "error", errorMessage: "terminated" });
  await h.command("terminated off");
  assert.equal(readSettings(h.path).recoverTerminated, false);
  assert.equal(h.end(original), original);
  assert.equal(h.turn()?.continue, true); // Length handling stays enabled.
  await h.command("terminated on");
  assert.equal(readSettings(h.path).recoverTerminated, true);
  assert.notEqual(h.end(original), original);
  await h.command("off");
  assert.equal(h.end(original), original);
});

test("queued user input takes precedence without discarding recovered text", (t) => {
  const h = harness(t);
  h.setPending(true);
  const recovered = h.end(assistant({ stopReason: "error", errorMessage: "terminated" }));
  assert.equal(h.turn({ message: recovered }), undefined);
  assert.equal(recovered.role === "assistant" && recovered.stopReason, "stop");
  assert.equal(h.archives.length, 1);
});

test("terminated recovery also works without UI", (t) => {
  const h = harness(t);
  h.ctx.hasUI = false;
  h.ctx.ui.notify = () => { throw new Error("UI must not be called"); };
  const recovered = h.end(assistant({ stopReason: "error", errorMessage: "terminated" }));
  assert.equal(h.turn({ message: recovered })?.continue, true);
});

test("boundary entries from earlier extensions are preserved", (t) => {
  const h = harness(t);
  const earlier = { type: "custom" as const, customType: "other-extension", data: { keep: true } };
  assert.deepEqual(h.turn({ entries: [earlier] })?.entries?.[0], earlier);
});

test("save failure leaves runtime settings unchanged", async (t) => {
  const h = harness(t, { enabled: false });
  rmSync(h.path);
  mkdirSync(h.path);
  await h.command("on");
  assert.equal(h.notices.at(-1)!.level, "error");
  assert.equal(h.turn(), undefined);
});
