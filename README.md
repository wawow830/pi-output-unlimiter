# pi-output-unlimiter

A Pi extension that automatically continues text responses cut off by a provider's output token limit. The continuation instruction is configurable.

```text
Assistant response
  ├─ normal finish → stop
  └─ output limit + non-empty text + no tool calls
       ↓
     append continuation instruction
       ↓
     next model request (up to the configured cap)
```

This does **not** raise provider limits or stitch tool-call arguments. Each continuation is a new request and a separate assistant message.

## Try it

Targets `@earendil-works/pi-coding-agent` **0.87.1** and its actionable `turn_end` API. Older Pi versions are not supported.

From this repository:

```sh
pi -e ./index.ts
```

Or install persistently:

```sh
pi install git:github.com/wawow830/pi-output-unlimiter
```

Enabled by default, with at most **3 extra continuation requests per user message**. Normal cancellation still applies.

## Configure

```text
/unlimiter                 Show current settings
/unlimiter on              Enable automatic continuation
/unlimiter off             Disable automatic continuation
/unlimiter limit 3         Set the maximum extra continuation requests
/unlimiter message Continue exactly where you stopped. Do not repeat.
/unlimiter reset-message   Restore the default continuation instruction
```

`/unlimiter status` also shows settings. A limit of `0` prevents automatic continuation. Commands save settings immediately for future sessions; they do not reset the current continuation count.

Settings live in `~/.pi/agent/output-unlimiter.json`, or under `PI_CODING_AGENT_DIR` when configured. They are global, not project-specific. The file is created on the first settings change.

```json
{
  "enabled": true,
  "maxContinuations": 3,
  "message": "Your previous response hit the output token limit. Continue exactly where you stopped, without repeating previous content. Finish the original request."
}
```

Missing fields use defaults. `message` must be non-empty; `maxContinuations` must be a non-negative safe integer. Use JSON `\n` escapes for multiline instructions. Invalid configuration disables continuation rather than guessing or overwriting the file.

After editing the file manually, run `/reload`. Other already-running Pi sessions also need `/reload` to pick up changes.

## Behavior and boundaries

- Triggers only on `stopReason: "length"`, not on guesses based on unfinished sentences.
- Requires non-empty visible text. Thinking-only responses are not continued.
- Skips every response containing tool calls; Pi keeps its own truncated-tool-call handling.
- Respects cancellation, queued user messages, and a continuation already requested by another extension.
- Adds a visible custom instruction to the transcript and requests one next turn through Pi's boundary API. It does not impersonate a newly typed user message or reset its own budget.
- A real user message, including steering/follow-up input, starts a fresh budget. Session initialization/reload also resets the count.
- Normal Pi tools remain available on subsequent turns. This is not a text-only sandbox.
- Uses no timers, nested model calls, or provider-specific APIs. No extra runtime dependencies.

Continuation happens before Pi's post-run truncated-response recovery. Pi can still compact between turns, and its own retries/recovery remain enabled when this extension declines to continue. The cap bounds **this extension's** requests, not all requests Pi might make.

Context limits, extra cost, and possible repetition still apply. Continuation is prompt-based, not guaranteed byte-exact resumption. If a provider reports truncation as a normal stop, the extension cannot detect it.

In the TUI, all answer parts remain visible. For automation that needs every part, use `--mode json` and collect assistant messages: Pi's `--print` text mode prints only the final assistant text, not a joined answer.

## Development

```sh
npm ci
npm test
npm run typecheck
```

Tests include offline Pi-session integration with scripted responses; they require no provider credentials or paid inference.

```text
index.ts             Pi entry point and settings path
src/extension.ts     Turn handling and /unlimiter command
src/config.ts        Validation and atomic settings writes
test/                Unit and offline session tests
```
