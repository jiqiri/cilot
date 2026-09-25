# OpenCode Telegram Bot

The installer packages the current source of `@grinev/opencode-telegram-bot` v0.25.3.

## Image delivery

When the model calls `image_generate`, the bot extracts the returned JPEG attachment and sends it to Telegram as a native photo. Image delivery is independent of diff-file attachment settings and compact-mode suppression.

The packaged source is built by the installer before the bot service is started.
