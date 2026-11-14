# Cilot

Cilot v1.1.1 is the Telegram agent built on this source, a fork of
`@grinev/opencode-telegram-bot`, packaged by the Cilot installer.

## Image delivery

When the model calls `image_generate`, the bot extracts the returned JPEG attachment and sends it to Telegram as a native photo. Image delivery is independent of diff-file attachment settings and compact-mode suppression.

The packaged source is built by the installer before the bot service is started.
