# Cilot — bot source

This directory contains the Cilot v1.0.0 agent source: a fork of
`@grinev/opencode-telegram-bot`, packaged and built by the installer.

The source includes the image-delivery changes needed for native Telegram photo messages. The installer builds it with the checked-in `package-lock.json` and starts it in source mode through the `cilot-bot.service` user unit.

The payload intentionally excludes local credentials, build output, dependencies, logs, and test fixtures.

Roles, on-disk layout, `/access`, `/share` and the limits of the isolation model are documented
in [docs/USAGE.md](./docs/USAGE.md) (Vietnamese) and in the installer's `ARCHITECTURE.md`.
