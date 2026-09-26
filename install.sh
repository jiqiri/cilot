#!/usr/bin/env bash
set -Eeuo pipefail

# Replace the placeholders below before running this script, or export the same
# names in the shell. Do not commit real credentials.
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-REPLACE_WITH_TELEGRAM_BOT_TOKEN}"
TELEGRAM_ALLOWED_USER_ID="${TELEGRAM_ALLOWED_USER_ID:-REPLACE_WITH_TELEGRAM_ALLOWED_USER_ID}"
CF_WORKERS_AI_ACCOUNT="${CF_WORKERS_AI_ACCOUNT:-REPLACE_WITH_CLOUDFLARE_ACCOUNT_ID}"
CF_WORKERS_AI_TOKEN="${CF_WORKERS_AI_TOKEN:-REPLACE_WITH_CLOUDFLARE_API_TOKEN}"
POSTIZ_MCP_URL="${POSTIZ_MCP_URL:-REPLACE_WITH_POSTIZ_MCP_URL}"
POSTIZ_MCP_TOKEN="${POSTIZ_MCP_TOKEN:-REPLACE_WITH_POSTIZ_BEARER_TOKEN}"
if [[ "$POSTIZ_MCP_URL" == *REPLACE_WITH* ]]; then
  POSTIZ_MCP_URL=""
fi
if [[ "$POSTIZ_MCP_TOKEN" == *REPLACE_WITH* ]]; then
  POSTIZ_MCP_TOKEN=""
fi
OPENCODE_MODEL_PROVIDER="${OPENCODE_MODEL_PROVIDER:-opencode}"
OPENCODE_MODEL_ID="${OPENCODE_MODEL_ID:-space-bunny-free}"

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
PAYLOAD_DIR="$SCRIPT_DIR/payload"
PAYLOAD_ARCHIVE_URL="${PAYLOAD_ARCHIVE_URL:-https://github.com/jiqiri/opencode-telegram-installer/archive/refs/heads/main.tar.gz}"
INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.local/share/opencode-telegram-installer}"
OPENCODE_MAIN_BIN_DIR="${OPENCODE_MAIN_BIN_DIR:-$HOME/.opencode/bin}"
OPENCODE_TELEGRAM_BIN_DIR="${OPENCODE_TELEGRAM_BIN_DIR:-$HOME/.opencode-telegram/bin}"
OPENCODE_MAIN_CONFIG_DIR="${OPENCODE_MAIN_CONFIG_DIR:-$HOME/.config/opencode}"
OPENCODE_TELEGRAM_CONFIG_DIR="${OPENCODE_TELEGRAM_CONFIG_DIR:-$HOME/.config/opencode-telegram-server}"
OPENCODE_MAIN_DATA_DIR="${OPENCODE_MAIN_DATA_DIR:-$HOME/.local/share/opencode}"
OPENCODE_TELEGRAM_DATA_DIR="${OPENCODE_TELEGRAM_DATA_DIR:-$HOME/.local/share/opencode-telegram-server}"
OPENCODE_MAIN_STATE_DIR="${OPENCODE_MAIN_STATE_DIR:-$HOME/.local/state/opencode}"
OPENCODE_TELEGRAM_STATE_DIR="${OPENCODE_TELEGRAM_STATE_DIR:-$HOME/.local/state/opencode-telegram-server}"
OPENCODE_MAIN_CACHE_DIR="${OPENCODE_MAIN_CACHE_DIR:-$HOME/.cache/opencode}"
OPENCODE_TELEGRAM_CACHE_DIR="${OPENCODE_TELEGRAM_CACHE_DIR:-$HOME/.cache/opencode-telegram-server}"
USER_SYSTEMD_DIR="${USER_SYSTEMD_DIR:-$HOME/.config/systemd/user}"
BOT_SOURCE_DIR="${BOT_SOURCE_DIR:-$INSTALL_ROOT/opencode-telegram-bot}"
OPENCODE_MAIN_URL="${OPENCODE_MAIN_URL:-http://127.0.0.1:5100}"
OPENCODE_TELEGRAM_URL="${OPENCODE_TELEGRAM_URL:-http://127.0.0.1:4096}"
OPENCODE_MAIN_VERSION="2.0.11"
OPENCODE_TELEGRAM_VERSION="1.18.32"

log() { printf '[installer] %s\n' "$*"; }
die() { printf '[installer] ERROR: %s\n' "$*" >&2; exit 1; }

require_command() { command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"; }
validate_placeholders() {
  local name value
  for name in TELEGRAM_BOT_TOKEN TELEGRAM_ALLOWED_USER_ID CF_WORKERS_AI_ACCOUNT CF_WORKERS_AI_TOKEN; do
    value="${!name}"
    [[ "$value" != REPLACE_WITH_* ]] || die "Replace $name in install.sh before running."
    [[ -n "$value" ]] || die "$name cannot be empty."
  done
  [[ "$TELEGRAM_ALLOWED_USER_ID" =~ ^[0-9]+$ ]] || die "TELEGRAM_ALLOWED_USER_ID must contain only digits."
  if [[ -n "$POSTIZ_MCP_URL" || -n "$POSTIZ_MCP_TOKEN" ]]; then
    [[ -n "$POSTIZ_MCP_URL" && -n "$POSTIZ_MCP_TOKEN" ]] || die "Set both POSTIZ_MCP_URL and POSTIZ_MCP_TOKEN, or leave both as placeholders."
    [[ "$POSTIZ_MCP_URL" =~ ^https?:// ]] || die "POSTIZ_MCP_URL must be an absolute http(s) URL."
  fi
}

check_platform() {
  [[ "$(uname -s)" == "Linux" ]] || die "This installer currently supports Linux user services only."
  [[ "$(uname -m)" == "aarch64" || "$(uname -m)" == "x86_64" || "$(uname -m)" == "arm64" ]] || die "Unsupported CPU architecture: $(uname -m)"
  command -v systemctl >/dev/null 2>&1 || die "systemctl is required."
  systemctl --user show-environment >/dev/null 2>&1 || die "A user systemd session is required. Log in and enable lingering for your user first."
}

install_opencode_binary() {
  local version="$1" destination="$2" url tmp asset_arch asset_suffix=""
  mkdir -p "$(dirname "$destination")"
  if [[ -x "$destination" ]] && "$destination" --version 2>/dev/null | grep -q "$version"; then
    log "OpenCode $version already installed at $destination"
    return
  fi
  tmp="$(mktemp -d)"
  asset_arch="$(uname -m)"
  [[ "$asset_arch" == "aarch64" ]] && asset_arch="arm64"
  [[ "$asset_arch" == "x86_64" ]] && asset_arch="x64"
  if [[ "$asset_arch" == "x64" ]] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
    asset_suffix="-baseline"
  fi
  if [[ "$asset_arch" == "x64" ]] && ldd --version 2>&1 | grep -qi musl; then
    asset_suffix="-musl"
  fi
  if [[ "$asset_arch" == "arm64" ]] && ldd --version 2>&1 | grep -qi musl; then
    asset_suffix="-musl"
  fi
  if [[ "$version" == "2.0.11" ]]; then
    url="https://opencode.ai/files/bin/$version/opencode-linux-$asset_arch$asset_suffix.tar.gz"
  else
    url="https://github.com/anomalyco/opencode/releases/download/v$version/opencode-linux-$asset_arch$asset_suffix.tar.gz"
  fi
  log "Downloading OpenCode $version"
  curl -fsSL "$url" -o "$tmp/opencode.tar.gz"
  tar -xzf "$tmp/opencode.tar.gz" -C "$tmp"
  install -m 0755 "$tmp/opencode" "$destination"
  rm -rf "$tmp"
  "$destination" --version | grep -q "$version" || die "Downloaded OpenCode version check failed."
}

copy_payload() {
  if [[ ! -d "$PAYLOAD_DIR/opencode-telegram-bot" ]]; then
    require_command curl
    require_command tar
    local archive_dir extracted_dir
    archive_dir="$(mktemp -d)"
    curl -fsSL "$PAYLOAD_ARCHIVE_URL" -o "$archive_dir/installer.tar.gz"
    tar -xzf "$archive_dir/installer.tar.gz" -C "$archive_dir"
    extracted_dir="$(find "$archive_dir" -mindepth 1 -maxdepth 1 -type d -name 'opencode-telegram-installer-*' -print -quit)"
    [[ -n "$extracted_dir" ]] || die "Could not locate the downloaded installer payload."
    PAYLOAD_DIR="$extracted_dir/payload"
    rm -rf "$archive_dir"
  fi
  [[ -d "$PAYLOAD_DIR/opencode-telegram-bot" ]] || die "Installer payload is missing: $PAYLOAD_DIR/opencode-telegram-bot"
  mkdir -p "$INSTALL_ROOT"
  log "Installing Telegram bot source"
  rm -rf "$BOT_SOURCE_DIR"
  mkdir -p "$BOT_SOURCE_DIR"
  cp -a "$PAYLOAD_DIR/opencode-telegram-bot/." "$BOT_SOURCE_DIR/"
  rm -rf "$BOT_SOURCE_DIR/node_modules" "$BOT_SOURCE_DIR/dist" "$BOT_SOURCE_DIR/logs" "$BOT_SOURCE_DIR/.env" "$BOT_SOURCE_DIR/settings.json" "$BOT_SOURCE_DIR/settings.json.bak"
  (cd "$BOT_SOURCE_DIR" && npm ci --no-audit --no-fund && npm run build)
}

write_runtime_files() {
  local telegram_env main_env cloudflare_env telegram_server_env
  telegram_env="$BOT_SOURCE_DIR/.env"
  main_env="$INSTALL_ROOT/opencode-main.env"
  cloudflare_env="$INSTALL_ROOT/opencode-cloudflare.env"
  telegram_server_env="$INSTALL_ROOT/opencode-telegram-server.env"

  umask 077
  cat >"$telegram_env" <<EOF
TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN
TELEGRAM_ALLOWED_USER_ID=$TELEGRAM_ALLOWED_USER_ID
OPENCODE_API_URL=$OPENCODE_TELEGRAM_URL
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=$(awk -F= '$1==\"OPENCODE_SERVER_PASSWORD\" {print $2}' \"$INSTALL_ROOT/opencode-main.env\" 2>/dev/null || true)
OPENCODE_MODEL_PROVIDER=$OPENCODE_MODEL_PROVIDER
OPENCODE_MODEL_ID=$OPENCODE_MODEL_ID
BOT_LOCALE=en
LOG_LEVEL=info
EOF
  cat >"$main_env" <<EOF
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=$(openssl rand -hex 32)
EOF
  cat >"$cloudflare_env" <<EOF
CF_WORKERS_AI_ACCOUNT=$CF_WORKERS_AI_ACCOUNT
CF_WORKERS_AI_TOKEN=$CF_WORKERS_AI_TOKEN
EOF
  if [[ -n "${POSTIZ_MCP_TOKEN:-}" && -n "${POSTIZ_MCP_URL:-}" ]]; then
    printf 'POSTIZ_MCP_TOKEN=%s\n' "$POSTIZ_MCP_TOKEN" >"$INSTALL_ROOT/opencode-postiz.env"
  else
    : >"$INSTALL_ROOT/opencode-postiz.env"
  fi
  chmod 600 "$INSTALL_ROOT/opencode-postiz.env"
  cat >"$telegram_server_env" <<EOF
OPENCODE_SERVER_USERNAME=opencode
OPENCODE_SERVER_PASSWORD=$(awk -F= '$1=="OPENCODE_SERVER_PASSWORD" {print $2}' "$main_env")
EOF
  chmod 600 "$telegram_env" "$main_env" "$cloudflare_env" "$telegram_server_env"
  unset OPENCODE_SERVER_PASSWORD
}

install_image_plugin() {
  local plugin_dir="$OPENCODE_MAIN_CONFIG_DIR/plugins/cloudflare-image"
  local telegram_plugin_dir="$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/tools"
  local skill_dir="$OPENCODE_MAIN_CONFIG_DIR/skills/cf-image-guidance"
  local telegram_skill_dir="$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/skills/cf-image-guidance"
  mkdir -p "$plugin_dir" "$telegram_plugin_dir" "$skill_dir" "$telegram_skill_dir" "$OPENCODE_MAIN_CONFIG_DIR"
  cp "$PAYLOAD_DIR/opencode-image-plugin/v2-plugin.js" "$plugin_dir/index.js"
  cp "$PAYLOAD_DIR/opencode-image-plugin/v1-tool.ts" "$telegram_plugin_dir/image_generate.ts"
  cp "$PAYLOAD_DIR/opencode-image-plugin/SKILL.md" "$skill_dir/SKILL.md"
  cp "$PAYLOAD_DIR/opencode-image-plugin/SKILL.md" "$telegram_skill_dir/SKILL.md"
  chmod 644 "$plugin_dir/index.js" "$telegram_plugin_dir/image_generate.ts" "$skill_dir/SKILL.md" "$telegram_skill_dir/SKILL.md"
  mkdir -p "$OPENCODE_MAIN_CONFIG_DIR" "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode"
  if [[ ! -f "$OPENCODE_MAIN_CONFIG_DIR/package.json" ]]; then
    printf '%s\n' '{"private":true,"type":"module"}' >"$OPENCODE_MAIN_CONFIG_DIR/package.json"
  fi
  if [[ ! -f "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/package.json" ]]; then
    printf '%s\n' '{"private":true,"type":"module"}' >"$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/package.json"
  fi
  npm install --prefix "$OPENCODE_MAIN_CONFIG_DIR" --no-audit --no-fund --save-exact @opencode/plugin@2.0.11 >/dev/null
  npm install --prefix "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode" --no-audit --no-fund --save-exact @opencode-ai/plugin@1.18.32 >/dev/null
  if [[ ! -f "$OPENCODE_MAIN_CONFIG_DIR/opencode.jsonc" && ! -f "$OPENCODE_MAIN_CONFIG_DIR/opencode.json" ]]; then
    cat >"$OPENCODE_MAIN_CONFIG_DIR/opencode.jsonc" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
EOF
  fi
  if [[ ! -f "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/opencode.jsonc" && ! -f "$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/opencode.json" ]]; then
    cat >"$OPENCODE_TELEGRAM_CONFIG_DIR/opencode/opencode.jsonc" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json"
}
EOF
  fi
  # Add the optional Postiz MCP server without overwriting unrelated config.
  if [[ -n "${POSTIZ_MCP_TOKEN:-}" && -n "${POSTIZ_MCP_URL:-}" ]]; then
    local postiz_url="${POSTIZ_MCP_URL:-}"
    # Use the OpenCode CLI so existing JSONC settings and MCP entries are preserved.
    HOME="$HOME" OPENCODE_CONFIG_DIR="$OPENCODE_MAIN_CONFIG_DIR" "$OPENCODE_MAIN_BIN_DIR/opencode" mcp add postiz --url "$postiz_url" --header 'Authorization=Bearer {env:POSTIZ_MCP_TOKEN}' --global >/dev/null
    HOME="$HOME" XDG_CONFIG_HOME="$OPENCODE_TELEGRAM_CONFIG_DIR" OPENCODE_CONFIG_DIR="$OPENCODE_TELEGRAM_CONFIG_DIR/opencode" "$OPENCODE_TELEGRAM_BIN_DIR/opencode" mcp add postiz --url "$postiz_url" --header 'Authorization=Bearer {env:POSTIZ_MCP_TOKEN}' >/dev/null
  fi
}

write_systemd_units() {
  mkdir -p "$USER_SYSTEMD_DIR"
  cat >"$USER_SYSTEMD_DIR/opencode.service" <<EOF
[Unit]
Description=OpenCode V2 server
After=network-online.target
Wants=network-online.target

[Service]
Environment=HOME=$HOME
Environment=OPENCODE_CONFIG_DIR=$OPENCODE_MAIN_CONFIG_DIR
EnvironmentFile=$INSTALL_ROOT/opencode-main.env
EnvironmentFile=$INSTALL_ROOT/opencode-cloudflare.env
EnvironmentFile=$INSTALL_ROOT/opencode-postiz.env
ExecStart=$OPENCODE_MAIN_BIN_DIR/opencode serve --hostname=127.0.0.1 --port=5100
Restart=always
RestartSec=3
UMask=0077

[Install]
WantedBy=default.target
EOF
  cat >"$USER_SYSTEMD_DIR/opencode-telegram-server.service" <<EOF
[Unit]
Description=OpenCode server for Telegram bot
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$HOME
Environment=HOME=$HOME
Environment=OPENCODE_CONFIG_DIR=$OPENCODE_TELEGRAM_CONFIG_DIR/opencode
Environment=XDG_CONFIG_HOME=$OPENCODE_TELEGRAM_CONFIG_DIR
Environment=XDG_DATA_HOME=$OPENCODE_TELEGRAM_DATA_DIR
Environment=XDG_STATE_HOME=$OPENCODE_TELEGRAM_STATE_DIR
Environment=XDG_CACHE_HOME=$OPENCODE_TELEGRAM_CACHE_DIR
EnvironmentFile=$INSTALL_ROOT/opencode-telegram-server.env
EnvironmentFile=$INSTALL_ROOT/opencode-cloudflare.env
EnvironmentFile=$INSTALL_ROOT/opencode-postiz.env
ExecStart=$OPENCODE_TELEGRAM_BIN_DIR/opencode serve --hostname=127.0.0.1 --port=4096
Restart=always
RestartSec=3
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=default.target
EOF
  cat >"$USER_SYSTEMD_DIR/opencode-telegram-bot.service" <<EOF
[Unit]
Description=OpenCode Telegram Bot
Wants=network-online.target opencode-telegram-server.service
After=network-online.target opencode-telegram-server.service

[Service]
Type=simple
WorkingDirectory=$BOT_SOURCE_DIR
Environment=HOME=$HOME
Environment=OPENCODE_CONFIG_DIR=$OPENCODE_TELEGRAM_CONFIG_DIR/opencode
Environment=XDG_CONFIG_HOME=$HOME/.config
Environment=NODE_ENV=production
EnvironmentFile=$BOT_SOURCE_DIR/.env
EnvironmentFile=$INSTALL_ROOT/opencode-telegram-server.env
ExecStart=$(command -v node) $BOT_SOURCE_DIR/dist/cli.js start --mode sources
Restart=always
RestartSec=5
TimeoutStopSec=20
UMask=0077

[Install]
WantedBy=default.target
EOF
  chmod 644 "$USER_SYSTEMD_DIR/opencode.service" "$USER_SYSTEMD_DIR/opencode-telegram-server.service" "$USER_SYSTEMD_DIR/opencode-telegram-bot.service"
}

start_services() {
  systemctl --user daemon-reload
  systemctl --user enable opencode.service opencode-telegram-server.service opencode-telegram-bot.service
  systemctl --user restart opencode.service opencode-telegram-server.service opencode-telegram-bot.service
  sleep 3
  systemctl --user is-active --quiet opencode.service || die "opencode.service did not start."
  systemctl --user is-active --quiet opencode-telegram-server.service || die "opencode-telegram-server.service did not start."
  systemctl --user is-active --quiet opencode-telegram-bot.service || die "opencode-telegram-bot.service did not start."
}

main() {
  require_command curl
  require_command tar
  require_command npm
  require_command node
  require_command openssl
  validate_placeholders
  check_platform
  install_opencode_binary "$OPENCODE_MAIN_VERSION" "$OPENCODE_MAIN_BIN_DIR/opencode"
  install_opencode_binary "$OPENCODE_TELEGRAM_VERSION" "$OPENCODE_TELEGRAM_BIN_DIR/opencode"
  copy_payload
  write_runtime_files
  install_image_plugin
  write_systemd_units
  start_services
  log "Installed OpenCode, the Telegram bot, the Cloudflare image tool, and user services."
  log "Main OpenCode: $OPENCODE_MAIN_URL"
  log "Telegram OpenCode: $OPENCODE_TELEGRAM_URL"
  log "Edit $SCRIPT_DIR/install.sh placeholders for future installs; never commit real credentials."
}

main "$@"
