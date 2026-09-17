# Pi Switchyard

A [Pi](https://github.com/earendil-works/pi-mono) extension that uses TypeSafe AI's Jev model to select a logical conversation thread and a configured model tier before each idle user request.

## Philosophy and intended use

Switchyard makes one long-lived Pi conversation behave more like a practical workbench than a single ever-growing prompt. It preserves the **origin** thread for the work that matters, while placing bounded side work into reusable **temp** threads and selecting the least expensive configured capability tier that should complete each task reliably.

The goal is not to make every prompt invisible, nor to replace deliberate user control of Pi. The goal is to avoid paying a high-capability model—and carrying a large implementation context—for questions that do not need either.

### Mental model

- **Origin** is the primary task. Its context should hold the decisions, artifacts, code work, and unresolved questions needed to continue that task.
- **Temp threads** are focused side conversations. They are for bounded questions or operations whose detailed transcript should not distract the origin task, but whose follow-ups should still remember their own work.
- **Tiers** describe required capability, not a provider or model family. You map `genius`, `smart`, `handy`, and `cheap` to the models and thinking levels available to you.
- **Jev recommends; code decides.** Jev chooses a target thread and tier from closed options. Switchyard applies confidence policy, checks model availability/image support, performs the model switch, filters context, and executes no side effect merely because Jev returned an answer.

### When Switchyard helps

Use it for sessions that mix substantial primary work with small interruptions, especially when the origin model is expensive or the origin context is large:

```text
Origin:  implement and review a multi-file authentication system
Temp:    did we create a PR?
Temp:    what branch are we on?
Temp:    check the deployment status
Temp:    create that PR
Origin:  continue the token-replay analysis
```

The PR status request can use `cheap` in a temp thread. “Create that PR” can reuse the same thread, often with `handy`. The authentication analysis stays in origin and can retain `smart` or `genius` capability without accumulating the PR conversation.

It is less useful for a short, single-purpose conversation where every message directly advances one task. Switchyard can still route those requests, but it cannot create meaningful savings when there is no unrelated context to isolate.

### Thread selection expectations

Switchyard normally keeps a request in **origin** when it advances the primary task, depends on origin decisions, changes shared implementation work, or should inform future origin work.

It normally creates or reuses a **temp** thread when the request is an administrative/status check, a bounded research or verification aside, an unrelated question, or a follow-up to an existing temp task. Temp threads are always flat siblings rooted at origin; Switchyard never nests one temp beneath another.

While a temp is visible, Jev can choose `new_temp_from_origin` only when the request needs origin context and is independent of facts, conclusions, tool results, and unresolved work unique to the visible temp. A request that needs that temp-specific context stays in the existing temp, even if it introduces a related subtopic. New sibling temps receive a small origin snapshot and can call `get_context_from_origin` for a precise additional slice.

Thread routing is probabilistic. Low-confidence target choices deliberately stay in origin rather than silently isolating work that might matter to the primary task.

### Tier selection expectations

`cheap`, `handy`, `smart`, and `genius` are user-configured capability labels:

| Tier | Intended work |
| --- | --- |
| `cheap` | Status checks, factual lookups, confirmations, and simple commands. |
| `handy` | Routine coding, repository operations, and bounded multi-step tasks. |
| `smart` | Substantial implementation, analysis, review, and coordinated work. |
| `genius` | Novel architecture, difficult debugging, broad ambiguity, or high-cost mistakes. |

Choose the mapping that fits your account, providers, latency tolerance, and risk. For example, one user might map every tier to a different model at default thinking; another may use the same model with `xhigh`, `high`, and lower thinking configurations. When Jev has low confidence in a tier, Switchyard escalates one tier rather than taking an underpowered gamble.

### Cache-aware model switching

Jev's ideal tier is not automatically a cost-effective model switch. On an existing logical thread, changing models can turn a warm cached prefix into a cold request. Switchyard therefore compares Jev's candidate with that thread's incumbent before calling `pi.setModel()`.

The estimate combines:

- Pi's resolved per-million-token `input`, `output`, `cacheRead`, and `cacheWrite` prices
- Any request-wide long-context pricing tier that applies
- Optional `switching.economics` overrides from `switchyard.json`
- The selected logical thread's estimated context and current prompt size
- Its recent observed cache-read ratio, or a configurable conservative assumption
- Its recent average output size, or a configurable default

New threads have no incumbent cache to protect. Changing thinking on the same model does not incur a model-switch penalty. Capability upgrades switch by default because correctness takes priority. Downgrades and lateral changes require sufficient Jev confidence and immediate estimated savings above both an absolute and percentage threshold. If either model has unknown all-zero economics, Switchyard conservatively keeps the incumbent unless configured otherwise.

This policy is thread-local: origin and every temp remember their own last routed model. Returning from one logical thread to another compares against the selected thread's incumbent rather than whichever model happens to be displayed in Pi.

Configure the policy through `/switchyard switching`. Model-specific economics overrides remain JSON-only because they are precise provider data rather than interactive preferences:

```json
{
  "switching": {
    "cacheAware": true,
    "upgradesAlwaysSwitch": true,
    "downgradeConfidenceFloor": 0.7,
    "minSavingsRatio": 0.2,
    "minSavingsUsd": 0.001,
    "unknownCostPolicy": "stay",
    "assumedWarmCacheRatio": 0.75,
    "assumedCacheWriteRatio": 0.5,
    "defaultExpectedOutputTokens": 800,
    "economics": {
      "provider/model-id": {
        "input": 2.5,
        "output": 10,
        "cacheRead": 0.25,
        "cacheWrite": 3
      }
    }
  }
}
```

Overrides take precedence over Pi metadata. Switchyard does not maintain a static model-price list. Input, cache-read, and cache-write tokens are estimated as separate pricing buckets; a nonzero cache-write price is never applied to every uncached token. Observed zero cache hits remain zero rather than being replaced by the warm-cache assumption. Compaction or branch summaries invalidate the old warmth estimate until the incumbent produces a new post-summary usage observation.

### What users see and what stays isolated

The normal Pi transcript, working indicator, reasoning display, and tool calls remain native Pi UI. In regular mode the routing itself is intentionally quiet. In `debug: true`, Switchyard exposes the selected thread, tier, model, thinking level, and routing confidence in the footer/notification.

Temp turns are marked as `temp:<thread-name>` in `/tree`. The messages are stored in the same physical Pi JSONL session so Pi can display and recover them, but Switchyard filters them from origin provider requests. Conversely, a temp model sees its own thread, its initial origin snapshot, and any context it explicitly retrieved from origin—not the entire origin transcript.

## Behavior

- Routes among `genius`, `smart`, `handy`, and `cheap` tiers.
- Keeps bounded side work in provider-isolated logical temp threads while preserving Pi's native transcript, reasoning, tools, and working UI.
- Reuses relevant temp threads when a request follows an earlier aside.
- Creates only flat sibling temps from origin; temp threads never nest.
- Gives each new temp thread the last five origin user/assistant messages by default.
- Escalates a selected temp before an idle request would cross its configurable soft token or turn limit.
- Makes `get_context_from_origin` available only during temp-thread turns for bounded, filtered retrieval.
- Labels both temp user prompts and assistant answers as `temp:<thread-name>` in `/tree`.
- Sends only bounded excerpts to Jev after best-effort credential redaction.
- Applies cache-aware, per-thread hysteresis before changing models on existing threads.
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

After selecting a model, choose its thinking level and whether to save globally or for the current trusted project. The menu then reopens so several categories can be changed in one visit; press Escape in the main Switchyard menu to finish. Debug, enabled state, and temp-thread soft limits are also editable from the first menu. Limits default to 32,000 estimated tokens and 12 user turns; set either value to `0` to disable that limit.

Direct command forms:

```text
/switchyard genius
/switchyard smart
/switchyard handy
/switchyard cheap
/switchyard show
/switchyard debug
/switchyard limits
/switchyard switching
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
Switchyard model policy: requested cheap/provider/luna; selected smart/provider/sol (insufficient-savings) · warm stay $0.0120 · cold switch $0.0310
```

When `debug` is false, routing remains visually transparent except for normal Pi model/footer changes and `/tree` labels.

## Jev decisions

The extension sends one System One request containing two independent `Choice` questions:

1. **Target thread:** origin, `new_temp_from_origin`, or one of the existing temp threads
2. **Model tier:** genius, smart, handy, or cheap

Code owns model selection, thinking configuration, context filtering, confidence policy, and side effects.

Default confidence behavior:

- Target confidence below `0.15`: stay on the origin thread
- Tier confidence below `0.45`: move up one capability tier
- Missing/failed Jev response: do nothing and let Pi process the request normally

## Bounded temp-thread lifecycle

Before dispatching an idle request that Jev assigned to an existing temp, Switchyard estimates the selected thread's context after adding the pending prompt. When its configured token or turn soft limit is reached, the prompt is held and the user chooses:

- **Promote to a child session:** durably mark the promotion, retire the logical temp in the source session, create a Pi session whose `parentSession` is the source session, transfer the temp's origin seed and complete replayable history without temp-routing tags, preserve skill/template expansion, and submit the held prompt as the new session's origin work. If replacement is interrupted, reopening the source session recovers the temp and restores the pending text.
- **Summarize into origin:** summarize only the selected temp with a cancellable progress dialog, retire it, append a visibly attributed origin handoff, then reroute the held prompt through the same lifecycle checks with the handoff available. If rerouting fails, the held prompt still receives origin-only context. Navigation, session replacement, and reload invalidate an in-flight lifecycle summary before it can mutate another branch.
- **Cancel:** do not dispatch the prompt and restore its text to the editor. Pi cannot restore image attachments to the editor, so Switchyard explicitly asks the user to reattach them.

Promotion is offered only for persisted sessions. In non-interactive modes where no dialog is available, Switchyard never drops the request: it continues with the selected temp and leaves lifecycle action to a later interactive turn.

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

## Thread-aware tree summaries

When `/tree` navigation summarizes an abandoned branch:

- Navigation without a requested summary remains untouched.
- Origin-only branches delegate to Pi's default branch summarizer.
- Mixed branches generate a summary from origin entries only, including origin file tracking.
- An all-temp abandoned branch records only that no origin work was present.
- Temp messages remain on their original branch and are never copied into the origin branch summary.
- Custom and replacement summary instructions are preserved.
- If origin summarization fails, navigation is cancelled rather than falling back to a mixed summary; retry and choose no summary if you still want to navigate.
