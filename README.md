# Pi Jev Router

A Pi extension that uses TypeSafe AI's Jev model to select both a logical conversation thread and a configured model tier for each idle user request.

## Intended behavior

- Routes among `genius`, `smart`, `handy`, and `cheap` model tiers.
- Keeps side work in provider-isolated logical temp threads while preserving Pi's native transcript and tool UI.
- Reuses relevant temp threads and exposes bounded parent context through a temp-only tool.
- Becomes a complete no-op when TypeSafe/Jev is unavailable.
- Shows route/thread/model diagnostics only when `debug` is enabled.

Configuration and installation instructions will be added with the implementation.
