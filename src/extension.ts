import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SETTINGS, readSettings, updateSettings, type Settings } from "./config.ts";

const HELP = "Usage: /unlimiter [on | off | terminated on|off | limit <number> | message <text> | reset-message]";
// Deliberately narrow: do not turn quota/auth/safety errors mentioning a
// terminated request into continuations. User cancellation is checked separately.
const TERMINATED = /^(?:(?:TypeError|Error):\s*)?terminated$/i;

export function registerUnlimiter(pi: ExtensionAPI, configPath: string) {
  let settings: Settings = { ...DEFAULT_SETTINGS, enabled: false };
  let continuations = 0;
  let interrupted = new WeakSet<object>();

  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

  pi.on("session_start", (_event, ctx) => {
    continuations = 0;
    interrupted = new WeakSet<object>();
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

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (
      !settings.enabled ||
      !settings.recoverTerminated ||
      ctx.signal?.aborted ||
      message.role !== "assistant" ||
      message.stopReason !== "error" ||
      !TERMINATED.test(message.errorMessage?.trim() ?? "") ||
      message.content.some((part) => part.type === "toolCall") ||
      !message.content.some((part) => part.type === "text" && part.text.trim())
    ) return;

    // Archive before replacing: Pi mutates the finalized message object in place.
    // Custom entries stay out of model context and do not add usage a second time.
    pi.appendEntry("output-unlimiter-interruption", { originalMessage: structuredClone(message) });
    const {
      content, errorMessage: _error, responseId: _responseId, deferred: _deferred,
      rawStopReason: _rawStop, endTurn: _endTurn, ...retained
    } = message;
    const recovered = {
      ...retained,
      // Error messages are dropped by provider adapters; treat ONLY the usable
      // text as an accepted chunk. Do not claim a provider length stop, which
      // would incorrectly select Pi's context-overflow recovery.
      stopReason: "stop" as const,
      content: content.filter((part) => part.type === "text").map((part) => ({
        type: "text" as const, text: part.text,
      })),
    };
    // Track both identities: Pi currently mutates the original object in place.
    interrupted.add(message);
    interrupted.add(recovered);
    notify(ctx, "Output unlimiter: preserved partial text after a terminated stream.", "warning");
    return { message: recovered };
  });

  pi.on("turn_end", (event, ctx) => {
    const message = event.message;
    const wasInterrupted = interrupted.delete(message);
    if (
      !settings.enabled ||
      ctx.signal?.aborted ||
      event.outcome !== "completed" ||
      event.continue ||
      ctx.hasPendingMessages() ||
      event.context.pendingMessages.length > 0 ||
      message.role !== "assistant" ||
      !(message.stopReason === "length" || (wasInterrupted && message.stopReason === "stop")) ||
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
      entries: [...event.entries, {
        type: "custom_message" as const,
        customType: "output-unlimiter",
        content: settings.message,
        display: true,
        details: {
          continuation: continuations, maxContinuations: settings.maxContinuations,
          ...(wasInterrupted ? { reason: "terminated" } : {}),
        },
      }],
      continue: true,
    };
  });

  pi.registerCommand("unlimiter", {
    description: "Configure text continuation: on, off, terminated on|off, limit, message, reset-message",
    handler: async (args, ctx) => {
      const input = args.trim();
      if (!input || input === "status") {
        notify(ctx, `Output unlimiter: ${settings.enabled ? "on" : "off"}\nTerminated-stream recovery: ${settings.recoverTerminated ? "on" : "off"}\nContinuation limit: ${settings.maxContinuations}\nMessage: ${settings.message}\nSettings: ${configPath}`);
        return;
      }

      const [, command, value = ""] = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input)!;
      let patch: Partial<Settings>;
      if ((command === "on" || command === "off") && !value) {
        patch = { enabled: command === "on" };
      } else if (command === "terminated" && (value === "on" || value === "off")) {
        patch = { recoverTerminated: value === "on" };
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
