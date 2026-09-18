# Contributing

Thanks for helping improve Pi Switchyard.

## Development setup

Requirements:

- Node.js 22.19 or newer
- pnpm 10
- Pi 0.85.1 or newer

```bash
git clone https://github.com/EngoDev/pi-switchyard.git
cd pi-switchyard
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm check:package-load
pnpm check:packed-package
```

`pnpm evaluate:live` consumes TypeSafe API usage and is never required for ordinary changes or pull requests.

## Pull requests

- Keep changes focused and include regression tests for behavior changes.
- Run `pnpm check`, `pnpm check:package-load`, and `pnpm check:packed-package` before submitting.
- Update `README.md` and `CHANGELOG.md` when user-facing behavior changes.
- Never commit credentials, session files, local configuration, or captured conversation content.
- Explain compatibility or migration implications for persisted Switchyard session entries.

Maintainers use Jujutsu locally, but normal Git branches and pull requests are welcome.

## Reporting issues

Use a GitHub issue for reproducible bugs and feature requests. Use the private process in [SECURITY.md](SECURITY.md) for vulnerabilities.
