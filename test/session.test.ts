import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { updateSettings, type Settings } from "../src/config.ts";
import { registerUnlimiter } from "../src/extension.ts";

type ScriptedResponse = "length" | "stop" | Pick<AssistantMessage, "stopReason"> & Partial<Pick<AssistantMessage, "content" | "errorMessage">>;

async function createSession(t: TestContext, responses: ScriptedResponse[], limit = 3, outputTokens = 10, config: Partial<Settings> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-unlimiter-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "output-unlimiter.json");
  updateSettings(configPath, { message: "Continue, no recap.", maxContinuations: limit, ...config });
  const settingsManager = SettingsManager.inMemory({
    cacheWarming: "off", retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
  });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => registerUnlimiter(pi, configPath)],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"), modelsPath: null,
    modelsStorePath: join(dir, "models-cache"), refreshOnCreate: false, allowModelNetwork: false,
  });
  await modelRuntime.setRuntimeApiKey("openai", "offline-test-not-a-real-key");
  const model: Model<"openai-completions"> = {
    id: "offline-test", name: "Offline test", provider: "openai", api: "openai-completions",
    baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
    contextWindow: 1000000, maxTokens: 10,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, modelRuntime, model, thinkingLevel: "off", tools: [],
    settingsManager, sessionManager: SessionManager.inMemory(dir), resourceLoader: loader,
  });
  t.after(() => session.dispose());
  const errors: unknown[] = [];
  await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
  const events: string[] = [];
  session.subscribe((event) => { events.push(event.type); });
  const requests: unknown[] = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(structuredClone(context.messages));
    const response = responses[requests.length - 1];
    assert.ok(response, "Unexpected additional model request");
    const spec = typeof response === "string" ? { stopReason: response } : response;
    const message: AssistantMessage = {
      role: "assistant", content: spec.content ?? [{ type: "text", text: `Part ${requests.length}` }],
      stopReason: spec.stopReason, errorMessage: spec.errorMessage,
      model: model.id, provider: model.provider, api: model.api, timestamp: Date.now(),
      usage: { input: 10, output: outputTokens, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + outputTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      assert.ok(message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse");
      stream.push({ type: "done", reason: message.stopReason, message });
    }
    return stream;
  };
  return { session, requests, errors, events };
}

test("Pi loads the packaged TypeScript entry point", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-unlimiter-loader-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  assert.equal(loader.getExtensions().extensions.length, 1);
});

test("real Pi session continues partial text with the configured message", { timeout: 15000 }, async (t) => {
  // Below model.maxTokens: the extension should continue before Pi's post-run
  // compact-and-retry heuristic removes the partial answer.
  const { session, requests, errors } = await createSession(t, ["length", "stop"], 3, 5);
  await session.prompt("Write a long answer.");
  assert.equal(requests.length, 2);
  assert.deepEqual(errors, []);
  assert.match(JSON.stringify(requests[1]), /Part 1/);
  assert.match(JSON.stringify(requests[1]), /Continue, no recap\./);
  assert.deepEqual(session.messages.filter((m) => m.role === "assistant").map((m) => m.content), [
    [{ type: "text", text: "Part 1" }], [{ type: "text", text: "Part 2" }],
  ]);
  assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "compaction"), false);
});

test("real Pi session settles at the cap and resets on the next user prompt", { timeout: 15000 }, async (t) => {
  const { session, requests, errors } = await createSession(t, ["length", "length", "length", "stop"], 1);
  await session.prompt("First request");
  assert.equal(requests.length, 2);
  assert.equal(session.isStreaming, false);
  await session.prompt("Second request");
  assert.equal(requests.length, 4);
  assert.deepEqual(errors, []);
});

const terminated = { stopReason: "error", errorMessage: "terminated" } as const;

test("terminated text is continued before native retries can omit or regenerate it", async (t) => {
  const { session, requests, errors, events } = await createSession(t, [terminated, "stop"]);
  await session.prompt("Write a long answer.");
  assert.equal(requests.length, 2);
  assert.deepEqual(errors, []);
  assert.match(JSON.stringify(requests[1]), /Part 1/);
  assert.match(JSON.stringify(requests[1]), /Continue, no recap\./);
  const branch = session.sessionManager.getBranch();
  assert.equal(branch.some((entry) => entry.type === "context_edit"), false);
  assert.equal(events.includes("auto_retry_start"), false);
  const archive = branch.find((entry) => entry.type === "custom" && entry.customType === "output-unlimiter-interruption");
  assert.ok(archive?.type === "custom");
  const original = (archive.data as { originalMessage: AssistantMessage }).originalMessage;
  assert.equal(original.stopReason, "error");
  assert.equal(original.errorMessage, "terminated");
  assert.deepEqual(original.content, [{ type: "text", text: "Part 1" }]);
  const answers = session.messages.filter((message) => message.role === "assistant");
  assert.equal(answers.length, 2);
  assert.equal(answers[0].stopReason, "stop");
  assert.deepEqual(answers[0].usage, original.usage);
  assert.equal(session.getSessionStats().tokens.output, 20); // Archive is not billed twice.
});

test("repeated terminations stop at the shared cap without falling back to paid retries", async (t) => {
  const { session, requests, errors, events } = await createSession(t, [terminated, terminated], 1);
  await session.prompt("Write a long answer.");
  assert.equal(requests.length, 2);
  assert.deepEqual(errors, []);
  assert.equal(events.includes("auto_retry_start"), false);
  assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "context_edit"), false);
  assert.equal(session.messages.filter((message) => message.role === "assistant").length, 2);
  assert.equal(session.isStreaming, false);
});

test("a zero continuation cap preserves terminated text without making another request", async (t) => {
  const { session, requests, errors, events } = await createSession(t, [terminated], 0);
  await session.prompt("Write a long answer.");
  assert.equal(requests.length, 1);
  assert.deepEqual(errors, []);
  assert.equal(events.includes("auto_retry_start"), false);
  assert.equal(session.getLastAssistantText(), "Part 1");
});

test("length and terminated responses share one continuation budget", async (t) => {
  const { session, requests, errors, events } = await createSession(t, ["length", terminated], 1);
  await session.prompt("Write a long answer.");
  assert.equal(requests.length, 2);
  assert.deepEqual(errors, []);
  assert.equal(events.includes("auto_retry_start"), false);
  assert.equal(session.messages.filter((message) => message.role === "assistant").length, 2);
});

test("empty terminated responses still use native retries", async (t) => {
  const { session, requests, errors, events } = await createSession(t, [{ ...terminated, content: [] }, "stop"]);
  await session.prompt("Write a long answer.");
  assert.equal(requests.length, 2);
  assert.deepEqual(errors, []);
  assert.equal(events.includes("auto_retry_start"), true);
  assert.doesNotMatch(JSON.stringify(requests[1]), /Continue, no recap/);
  assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "context_edit"), true);
});

test("turning terminated recovery off restores native omit-and-retry", async (t) => {
  const { session, requests, errors, events } = await createSession(t, [terminated, "stop"], 3, 10, { recoverTerminated: false });
  await session.prompt("Write a long answer.");
  assert.equal(requests.length, 2);
  assert.deepEqual(errors, []);
  assert.equal(events.includes("auto_retry_start"), true);
  assert.doesNotMatch(JSON.stringify(requests[1]), /Part 1|Continue, no recap/);
  assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "context_edit"), true);
});

test("an aborted response is never recovered or retried", async (t) => {
  const { session, requests, errors, events } = await createSession(t, [{ stopReason: "aborted", errorMessage: "terminated" }]);
  await session.prompt("Write a long answer.");
  assert.equal(requests.length, 1);
  assert.deepEqual(errors, []);
  assert.equal(events.includes("auto_retry_start"), false);
  assert.equal(session.sessionManager.getBranch().some((entry) => entry.type === "custom"), false);
});
