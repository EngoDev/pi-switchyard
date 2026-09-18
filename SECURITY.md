# Security policy

## Supported versions

Pi Switchyard is pre-1.0 software. Security fixes are applied to the latest release only.

## Reporting a vulnerability

Please do not disclose vulnerability details in a public issue. Use GitHub's private vulnerability reporting when it is enabled for this repository:

<https://github.com/EngoDev/pi-switchyard/security/advisories/new>

If that link is unavailable, open an issue containing no vulnerability details and ask the maintainers to enable a private reporting channel. In the private report, include the affected version, impact, reproduction steps, and any suggested mitigation. You should receive an acknowledgement within seven days.

## Security model

Pi extensions execute with the same system access as Pi. Review the source and release ref before installing this or any other extension.

Switchyard sends the current request and bounded conversation excerpts to TypeSafe AI for routing. Its credential redaction is best-effort and is not a security boundary. Do not place secrets in prompts or conversation context. API keys are read from the process environment or `~/.codex/.env`; Switchyard does not intentionally persist or log them.
