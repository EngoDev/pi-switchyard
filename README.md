# Pi Jev Router

A [Pi](https://github.com/earendil-works/pi-mono) extension that uses TypeSafe AI's Jev model to select a logical conversation thread and a configured model tier before each idle user request.

## Behavior

- Routes among `genius`, `smart`, `handy`, and `cheap` tiers.
- Keeps bounded side work in provider-isolated logical temp threads while preserving Pi's native transcript, reasoning, tools, and working UI.
- Reuses relevant temp threads when a request follows an earlier aside.
- Gives each new temp thread the last five parent user/assistant messages by default.
- Makes `get_context_from_parent` available only during temp-thread turns for bounded, filtered retrieval.
- Labels temp user turns as `temp:<thread-name>` in `/tree`.
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
ln -s /absolute/path/to/pi-jev-router ~/.pi/agent/extensions/jev-router
```

Then run `/reload` in Pi.

## Interactive configuration

Run:

```text
/jev-router
```

The wizard lets you choose, without typing model IDs:

1. Global or project configuration scope
2. A Pi model for each tier
3. `default` or a thinking level supported by that model
4. `debug: false` or `debug: true`

Direct command forms:

```text
/jev-router configure
/jev-router show
/jev-router debug
/jev-router on
/jev-router off
```

Configuration is stored in:

- Global: `~/.pi/agent/jev-router.json`
- Project: `<cwd>/.pi/jev-router.json`

Project values override global values, but project configuration is ignored unless Pi considers the project trusted.

### Debug mode

When `debug` is true, the footer shows the active logical thread, tier, model, and effective thinking level. Every successful decision also emits a notification with target and tier confidence, for example:

```text
Jev route → temp:did-create-pr | cheap | openai/gpt-5.6-luna | thinking:high | confidence target:0.97 tier:0.99
```

When `debug` is false, routing remains visually transparent except for normal Pi model/footer changes and `/tree` labels.

## Jev decisions

The extension sends one System One request containing two independent `Choice` questions:

1. **Target thread:** parent, new temp, or one of the existing temp threads
2. **Model tier:** genius, smart, handy, or cheap

Code owns model selection, thinking configuration, context filtering, confidence policy, and side effects.

Default confidence behavior:

- Target confidence below `0.15`: stay on the parent thread
- Tier confidence below `0.45`: move up one capability tier
- Missing/failed Jev response: do nothing and let Pi process the request normally

## Parent context tool

`get_context_from_parent` supports:

- Case-insensitive text query
- Role filters
- Newest/oldest ordering
- Offset and limit
- Optional tool results
- Maximum 20 messages and 50KB output

Retrieved context becomes part of the current temp thread and is not sent to the parent model on later parent turns.

## Development

```bash
pnpm check
pnpm check:global-load
pnpm evaluate:live  # uses the configured TypeSafe key and consumes API usage
```

Source control is managed with Jujutsu (`jj`).

## Current limitation

Logical thread metadata lives on individual messages. Manual compaction of a mixed parent/temp transcript is not yet thread-aware and may reduce the recoverable history of older temp threads. Normal provider context growth is bounded by the router, so automatic compaction should be uncommon.
