# Pi Switchyard

Switchyard is a [Pi](https://github.com/earendil-works/pi-mono) extension that keeps one long-running conversation useful while routing each request to an appropriate model.

It is designed for sessions where important work is mixed with small interruptions. Switchyard keeps the main task in **origin**, moves bounded side work into isolated **temp threads**, and chooses between model tiers such as `cheap`, `handy`, `smart`, and `genius`.

The aim is simple: **use expensive models and large contexts only when they are worth paying for—without creating false savings through bad model switches, lost cache, or underpowered answers.**

> **Experimental:** v0.1 is pre-1.0 software. Configuration and persisted session metadata may evolve between releases.

## When it helps

Switchyard is most useful when a Pi session looks like this:

```text
Origin: Implement and review the authentication system
Temp:   What branch are we on?
Temp:   Did we create a PR?
Temp:   Check the deployment status
Origin: Continue the token-replay analysis
```

Without isolation, every small question can carry the full authentication conversation into another model request. With Switchyard, the primary work keeps its context while each aside gets a small, focused context and can use a less expensive model.

It is less useful for short, single-purpose sessions where every prompt needs the same context and capability.

## How it works

Before an idle user request is sent, Switchyard asks TypeSafe AI's Jev model two questions:

1. **Where does this request belong?** The main origin thread, an existing temp thread, or a new temp thread.
2. **How much model capability does it need?** `cheap`, `handy`, `smart`, or `genius`.

Switchyard then applies deterministic safety and cost rules before selecting a configured model.

### Origin and temp threads

- **Origin** holds the primary task, decisions, implementation work, and anything future work should remember.
- **Temp threads** hold focused side conversations such as status checks, administrative work, or unrelated research.
- Temp threads are reusable. A follow-up such as “create that PR” can return to the earlier PR thread.
- A temp sees a small origin snapshot and its own history—not every other conversation.
- Temp threads remain visible and recoverable in Pi's session tree.

A temp can request a bounded slice of origin context through `get_context_from_origin` when it needs one specific fact.

### Model tiers

You choose the actual model and thinking level for each tier:

| Tier | Good fit |
| --- | --- |
| `cheap` | Lookups, confirmations, status checks, and simple commands |
| `handy` | Routine coding and bounded multi-step work |
| `smart` | Substantial implementation, analysis, and review |
| `genius` | Difficult debugging, architecture, ambiguity, or costly mistakes |

The tiers describe capability, not a particular provider. They can use different models or the same model with different thinking levels.

## How Switchyard tries to save money safely

A cheaper model is not automatically a cheaper request. Changing models can lose a warm prompt cache, pay to ingest the context again, and then pay once more when returning to the original model.

Switchyard accounts for this before downgrading an existing thread:

- It estimates the cost of staying on the incumbent model versus switching.
- It includes input, output, cache-read, cache-write, and long-context pricing when available.
- It reserves for the likely cost of returning to the incumbent model.
- It requires repeated evidence that lower capability is appropriate instead of reacting to one easy prompt.
- It applies minimum confidence and savings thresholds.
- It stays put when pricing is unknown unless you explicitly choose another policy.
- A request that needs more capability is upgraded even when staying would be cheaper.

This reduces cache-thrashing patterns such as `smart → cheap → smart`, where the apparent saving can cost more overall.

The numbers are forecasts, not guarantees of provider-side caching or future behavior. `/switchyard usage` reports actual provider usage beside the original estimates so you can see whether the setup is working for your workload. Jev routing also has a small API cost, which the report includes when TypeSafe provides it.

## Installation

Requirements:

- Pi 0.85.1 or newer
- Node.js 20 or newer
- A TypeSafe API key

Install an exact release:

```bash
pi install npm:pi-switchyard@0.1.0
```

Set `TYPESAFE_API_KEY` in the process environment or in `~/.codex/.env`, then start Pi and run:

```text
/switchyard
```

Use the menu to assign a model and thinking level to each tier. You can also configure debug output, temp-thread limits, and model-switching policy there.

## Recommended workflow

1. **Map tiers honestly.** Use `cheap` for simple work and reserve `smart` or `genius` for tasks where mistakes or retries would erase the saving.
2. **Keep the primary task in origin.** Let status checks, administration, and unrelated questions become temps.
3. **Leave cache-aware switching enabled.** It prevents many switches that look cheap per token but are expensive across several turns.
4. **Use manual overrides when you know more than the router.** Pin a thread or force the next request rather than changing the global tier mapping.
5. **Review `/switchyard usage`.** Compare observed spend with forecasts and watch for rapid return switches.
6. **Manage old temps with `/switchyard threads`.** Inspect, rename, summarize, promote, or archive them without deleting their history.

If Jev is unavailable, times out, or the TypeSafe key is missing, Switchyard does not guess: Pi handles the request normally without automatic routing or context filtering.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `/switchyard` | Open configuration |
| `/switchyard show` | Show the current configuration |
| `/switchyard on` / `off` | Enable or disable automatic routing |
| `/switchyard inspect` | Inspect threads, routes, models, cache state, and recent decisions |
| `/switchyard usage` | Compare observed usage and cost with switching forecasts |
| `/switchyard threads` | Inspect and manage active temp threads |
| `/switchyard pin <tier>` | Keep the current logical thread on a tier |
| `/switchyard pin-next <tier>` | Force the next provider request to a tier once |
| `/switchyard route origin` | Force the next request into origin |
| `/switchyard unpin` | Remove the current thread's pin |
| `/switchyard debug` | Choose `off`, `minimal`, or `verbose` diagnostics |
| `/switchyard limits` | Configure temp token and turn limits |
| `/switchyard switching` | Configure cache-aware switching policy |

You can also open a tier directly with `/switchyard cheap`, `/switchyard handy`, `/switchyard smart`, or `/switchyard genius`.

## Managing temp threads

`/switchyard threads` opens a searchable list showing each temp's incumbent model, estimated context size, and turn count. From there you can:

- **Inspect** its routing and context state.
- **Rename** future labels without rewriting history.
- **Retire** it from active routing while preserving its session history.
- **Summarize into origin** and archive it only after the handoff is safely stored.
- **Promote to a child session** with its relevant history and continue it as independent work.

When a temp reaches its configured soft token or turn limit, Switchyard offers the same summarize-or-promote lifecycle before dispatching more work. It does not silently discard the pending request.

## Visibility and diagnostics

Switchyard uses Pi's normal transcript, reasoning display, tools, and session tree. Temp messages are labeled `temp:<name>` in `/tree`.

Debug modes control routing notifications:

- `off` — quiet operation
- `minimal` — one compact decision line
- `verbose` — full confidence, evidence, cache, and cost reasoning

Use `/switchyard inspect` when you want detailed diagnostics without leaving verbose mode enabled.

## Privacy and security

Pi extensions execute with the same system access as Pi. Review third-party packages before installing them and pin exact versions for reproducible installs.

Switchyard sends the current request and bounded conversation excerpts to TypeSafe AI for routing. Credential redaction is best-effort and is **not** a security boundary; do not place secrets in prompts or conversation context. The TypeSafe key is read without intentionally being logged or copied into Switchyard configuration.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Development

```bash
git clone https://github.com/EngoDev/pi-switchyard.git
cd pi-switchyard
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm check:package-load
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [CHANGELOG.md](CHANGELOG.md) for release notes.

## License

[MIT](LICENSE)
