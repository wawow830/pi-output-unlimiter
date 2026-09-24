import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, readSettings, updateSettings, type Settings } from "./config.ts";

const HELP = "Usage: /unlimiter [on | off | limit <number> | message <text> | reset-message]";

export function registerUnlimiter(pi: ExtensionAPI, configPath: string) {
  let settings: Settings = { ...DEFAULT_SETTINGS, enabled: false };
  let continuations = 0;

  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

  pi.on("session_start", (_event, ctx) => {
    continuations = 0;
    try {
      settings = readSettings(configPath);
    } catch (error) {
      settings = { ...DEFAULT_SETTINGS, enabled: false };
      notify(ctx, `Output unlimiter disabled: cannot load ${configPath}: ${String(error)}`, "error");
    }
  });

  // Custom continuation messages do not reset the budget. Real user messages do,
  // including steering/follow-up messages consumed during an existing run.
  pi.on("message_start", (event) => {
    if (event.message.role === "user") continuations = 0;
  });

  pi.on("turn_end", (event, ctx) => {
    const message = event.message;
    if (
      !settings.enabled ||
      ctx.signal?.aborted ||
      event.outcome !== "completed" ||
      event.continue ||
      ctx.hasPendingMessages() ||
      event.context.pendingMessages.length > 0 ||
      message.role !== "assistant" ||
      message.stopReason !== "length" ||
      message.content.some((part) => part.type === "toolCall") ||
      !message.content.some((part) => part.type === "text" && part.text.trim())
    ) return;

    if (continuations >= settings.maxContinuations) {
      notify(ctx, `Output unlimiter: continuation limit reached (${settings.maxContinuations}).`, "warning");
      return;
    }

    continuations++;
    // Appending model-visible input makes this boundary continuable even though
    // event.context.canContinue is normally false after an assistant response.
    // Pi commits the instruction and schedules one turn, with no detached work.
    return {
      entries: [{
        type: "custom_message" as const,
        customType: "output-unlimiter",
        content: settings.message,
        display: true,
        details: { continuation: continuations, maxContinuations: settings.maxContinuations },
      }],
      continue: true,
    };
  });

  pi.registerCommand("unlimiter", {
    description: "Configure automatic text continuation: on, off, limit, message, reset-message",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input || input === "status") {
        notify(ctx, `Output unlimiter: ${settings.enabled ? "on" : "off"}\nContinuation limit: ${settings.maxContinuations}\nMessage: ${settings.message}\nSettings: ${configPath}`);
        return;
      }

      const [, command, value = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input)!;
      let patch: Partial<Settings>;
      if ((command === "on" || command === "off") && !value) {
        patch = { enabled: command === "on" };
      } else if (command === "limit" && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))) {
        patch = { maxContinuations: Number(value) };
      } else if (command === "message" && value.trim()) {
        patch = { message: value };
      } else if (command === "reset-message" && !value) {
        patch = { message: DEFAULT_SETTINGS.message };
      } else {
        notify(ctx, HELP, "warning");
        return;
      }

      try {
        settings = updateSettings(configPath, patch);
        notify(ctx, `Output unlimiter settings saved to ${configPath}.`);
      } catch (error) {
        notify(ctx, `Output unlimiter settings not saved: ${String(error)}`, "error");
      }
    },
  });
}
