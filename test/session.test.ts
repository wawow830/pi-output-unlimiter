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
import { updateSettings } from "../src/config.ts";
import { registerUnlimiter } from "../src/extension.ts";

async function createSession(t: TestContext, responses: ("length" | "stop")[], limit = 3, outputTokens = 10) {
  const dir = mkdtempSync(join(tmpdir(), "pi-unlimiter-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, "output-unlimiter.json");
  updateSettings(configPath, { message: "Continue, no recap.", maxContinuations: limit });
  const settingsManager = SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false } });
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
  const requests: unknown[] = [];
  session.agent.streamFunction = (_model, context) => {
    requests.push(structuredClone(context.messages));
    const stopReason = responses[requests.length - 1];
    assert.ok(stopReason, "Unexpected additional model request");
    const message: AssistantMessage = {
      role: "assistant", content: [{ type: "text", text: `Part ${requests.length}` }],
      stopReason, model: model.id, provider: model.provider, api: model.api, timestamp: Date.now(),
      usage: { input: 10, output: outputTokens, cacheRead: 0, cacheWrite: 0, totalTokens: 10 + outputTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: stopReason, message });
    return stream;
  };
  return { session, requests, errors };
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
