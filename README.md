# Pi Switchyard

A [Pi](https://github.com/earendil-works/pi-mono) extension that uses TypeSafe AI's Jev model to select a logical conversation thread and a configured model tier before each idle user request.

## Behavior

- Routes among `genius`, `smart`, `handy`, and `cheap` tiers.
- Keeps bounded side work in provider-isolated logical temp threads while preserving Pi's native transcript, reasoning, tools, and working UI.
- Reuses relevant temp threads when a request follows an earlier aside.
- Gives each new temp thread the last five origin user/assistant messages by default.
- Makes `get_context_from_origin` available only during temp-thread turns for bounded, filtered retrieval.
- Labels both temp user prompts and assistant answers as `temp:<thread-name>` in `/tree`.
- Sends only bounded excerpts to Jev after best-effort credential redaction.
- Performs no automatic routing, model switching, or context filtering when the TypeSafe key is absent or a Jev request fails or times out.

## Requirements

- Pi 0.85.1 or newer
- Node.js 20 or newer
- pnpm
- `TYPESAFE_API_KEY` in the process environment or in `~/.codex/.env`

The key is read without being printed, logged, or copied into extension configuration. Conversation redaction is best-effort rather than a security boundary; the current request and bounded context excerpts are transmitted to TypeSafe for routing.

## Install dependencies

```bash
pnpm install
```

For local development, link the package root as a global Pi extension directory. Linking only `src/` breaks dependency resolution because Pi resolves packages from the extension's logical path:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s /absolute/path/to/pi-switchyard ~/.pi/agent/extensions/switchyard
```

Then run `/reload` in Pi.

## Interactive configuration

Run:

```text
/switchyard
```

The first menu lists `genius`, `smart`, `handy`, and `cheap` with each tier's current model and thinking level. Select only the category you want to change. Its model picker:

- Shows at most 10 rows and scrolls through longer lists
- Filters by model ID, provider, or model name as you type
- Marks the category's current model

After selecting a model, choose its thinking level and whether to save globally or for the current trusted project. The menu then reopens so several categories can be changed in one visit; press Escape in the main Switchyard menu to finish. Debug and enabled state are also editable from the first menu.

Direct command forms:

```text
/switchyard genius
/switchyard smart
/switchyard handy
/switchyard cheap
/switchyard show
/switchyard debug
/switchyard on
/switchyard off
```

Configuration is stored in:

- Global: `~/.pi/agent/switchyard.json`
- Project: `<cwd>/.pi/switchyard.json`

Legacy `jev-router.json` files are still read for migration compatibility; new changes are written to `switchyard.json`. Project values override global values, but project configuration is ignored unless Pi considers the project trusted.

### Debug mode

When `debug` is true, the footer shows the active logical thread, tier, model, and effective thinking level. Every successful decision also emits a notification with target and tier confidence, for example:

```text
Switchyard route → temp:did-create-pr | cheap | openai/gpt-5.6-luna | thinking:high | confidence target:0.97 tier:0.99
```

When `debug` is false, routing remains visually transparent except for normal Pi model/footer changes and `/tree` labels.

## Jev decisions

The extension sends one System One request containing two independent `Choice` questions:

1. **Target thread:** origin, new temp, or one of the existing temp threads
2. **Model tier:** genius, smart, handy, or cheap

Code owns model selection, thinking configuration, context filtering, confidence policy, and side effects.

Default confidence behavior:

- Target confidence below `0.15`: stay on the origin thread
- Tier confidence below `0.45`: move up one capability tier
- Missing/failed Jev response: do nothing and let Pi process the request normally

## Origin context tool

`get_context_from_origin` supports:

- Case-insensitive text query
- Role filters
- Newest/oldest ordering
- Offset and limit
- Optional tool results
- Maximum 20 messages and 50KB output

Retrieved context becomes part of the current temp thread and is not sent to the origin model on later origin turns.

## Development

```bash
pnpm check
pnpm check:global-load
pnpm evaluate:live  # uses the configured TypeSafe key and consumes API usage
```

Source control is managed with Jujutsu (`jj`).

## Thread-aware compaction

The extension intercepts manual and automatic compaction when the summarized span contains temp-thread messages:

- Origin-only sessions delegate to Pi's default compaction unchanged.
- Mixed spans generate an origin summary from origin messages only, including split-turn prefixes.
- Active temp threads receive a separate summary stored in compaction metadata; it is used only when that temp thread resumes.
- Retained temp messages after the compaction boundary remain available to their temp thread.
- Origin file tracking is preserved deterministically without including temp-only file operations.
- If origin or active-temp summarization fails, compaction is cancelled rather than falling back to a mixed summary.

Compaction remains logical: old temp entries stay in the session JSONL for recovery and `/tree`, but they are not included in the origin summary or origin provider context.

`/tree` branch summaries are not yet thread-aware; avoid requesting a branch summary when navigating away from a branch containing mixed origin/temp work.
