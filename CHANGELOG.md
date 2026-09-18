# Changelog

All notable changes to Pi Switchyard are documented here. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-18

Initial experimental release.

### Added

- Jev-based routing between origin and bounded, reusable temp threads.
- Configurable `genius`, `smart`, `handy`, and `cheap` model tiers.
- Thread-isolated provider context, origin context retrieval, thread-aware compaction, and branch summaries.
- Cache-aware model-transition economics with deterministic downgrade evidence and post-compaction switch windows.
- Temp lifecycle controls for summarizing into origin and promoting into durable child sessions.
- `/switchyard inspect`, `/switchyard usage`, manual routing overrides, and `/switchyard threads` management.
- Persistent route, transition, usage, override, and lifecycle recovery metadata.

[Unreleased]: https://github.com/EngoDev/pi-switchyard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/EngoDev/pi-switchyard/releases/tag/v0.1.0
