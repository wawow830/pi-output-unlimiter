# pi-output-unlimiter

A Pi extension that continues text cut off by an output token limit or a `terminated` stream, keeping usable partial output instead of regenerating it. The continuation instruction is configurable.

```text
Assistant response
  ├─ normal finish → stop
  ├─ output limit + usable text → continue
  └─ terminated + usable text
       └─ archive failure → retain text → continue

continue = configured instruction + next request, within the shared cap
```

This does **not** raise provider limits or stitch tool-call arguments. Each continuation is a new request and a separate assistant message.

## Try it

Targets `@earendil-works/pi-coding-agent` **0.87.1**, including finalized `message_end` replacement and actionable `turn_end` hooks. Older Pi versions are not supported.

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
/unlimiter off             Disable continuation and partial-text recovery
/unlimiter terminated on   Enable terminated-stream recovery (default)
/unlimiter terminated off  Leave all transport errors to Pi
/unlimiter limit 3         Set the maximum extra continuation requests
/unlimiter message Continue exactly where you stopped. Do not repeat.
/unlimiter reset-message   Restore the default continuation instruction
```

`/unlimiter status` also shows settings. A limit of `0` prevents automatic continuation. Commands save settings immediately for future sessions; they do not reset the current continuation count.

Settings live in `~/.pi/agent/output-unlimiter.json`, or under `PI_CODING_AGENT_DIR` when configured. They are global, not project-specific. The file is created on the first settings change.

```json
{
  "enabled": true,
  "recoverTerminated": true,
  "maxContinuations": 3,
  "message": "Your previous response was interrupted. Continue exactly where you stopped, without repeating previous content. Finish the original request."
}
```

Missing fields use defaults. `message` must be non-empty; `maxContinuations` must be a non-negative safe integer. Use JSON `\n` escapes for multiline instructions. Invalid configuration disables continuation rather than guessing or overwriting the file.

After editing the file manually, run `/reload`. Other already-running Pi sessions also need `/reload` to pick up changes. Existing saved messages are kept verbatim; `/unlimiter reset-message` switches to the new default wording, which covers both interruption types.

## Behavior and boundaries

- Triggers on `stopReason: "length"` or an exact `terminated` error (also `Error: terminated` / `TypeError: terminated`), not guesses based on unfinished sentences.
- Other errors keep Pi's normal handling. Aborted responses are never recovered.
- Requires non-empty visible text. Thinking-only responses are not continued.
- Skips every response containing tool calls; Pi keeps its own truncated-tool-call handling.
- Respects cancellation, queued user messages, and a continuation already requested by another extension.
- Adds a visible custom instruction to the transcript and requests one next turn through Pi's boundary API. It does not impersonate a newly typed user message or reset its own budget.
- A real user message, including steering/follow-up input, starts a fresh budget. Session initialization/reload also resets the count.
- Normal Pi tools remain available on subsequent turns. This is not a text-only sandbox.
- Uses no timers, nested model calls, or provider-specific APIs. No extra runtime dependencies.

Continuation happens before Pi's post-run recovery. Pi can still compact between turns, and its own retries/recovery remain enabled for unhandled responses. The cap bounds **this extension's** requests, not all requests Pi might make.

### Preserving terminated output

Pi's provider adapters exclude errored assistant messages even if the UI shows no `context: omit` marker. Merely appending “continue” would lose the partial answer. For eligible terminated responses this extension:

1. Archives the original failed message in a session-only `output-unlimiter-interruption` entry, outside model context.
2. Replaces the failed message with its visible text as an accepted assistant chunk (`stopReason: "stop"`). It removes unfinished reasoning, text signatures, and response IDs, retaining any reported usage. This prevents Pi's omit-and-retry recovery from regenerating that chunk.
3. Adds the configured instruction and requests another turn, using the same budget as length continuations.

At the cap (including `0`), the text is still preserved, but **no additional recovery request is made**. Queued user input or another extension's continuation also takes precedence without discarding the recovered text. `/unlimiter terminated off` restores Pi's native error handling.

This applies to new responses while the extension is active; it does not restore previously omitted messages. Only received visible text can be saved: providers may bill for undelivered output or omit final usage counters after a disconnect.

Context limits, extra cost, and possible repetition still apply. Continuation is prompt-based, not guaranteed byte-exact resumption. If a provider reports truncation as a normal stop, the extension cannot detect it.

In the TUI, all answer parts remain visible. For automation that needs every part, use `--mode json` and collect assistant messages: Pi's `--print` text mode prints only the final assistant text, not a joined answer.

## Development

```sh
npm ci
npm test
npm run typecheck
```

Tests include offline Pi-session integration with scripted responses and native retries enabled; they require no provider credentials or paid inference. Interactive Herdr checks also exercised actual mid-SSE socket disconnects through a local OpenAI-compatible endpoint, verifying preserved text in the next HTTP request, the shared cap, native retry for empty output, and the recovery toggle. Real-provider truncation/disconnect behavior remains unverified.

```text
index.ts             Pi entry point and settings path
src/extension.ts     Turn handling and /unlimiter command
src/config.ts        Validation and atomic settings writes
test/                Unit and offline session tests
```
