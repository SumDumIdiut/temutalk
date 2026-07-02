#!/bin/bash
# TemuTalk Speaker — installer + control panel.
# Safe to download standalone and run: bash install.sh
# Clones/updates the repo, installs all dependencies, then opens a TUI
# for starting/stopping the server and doing one-off setup tasks.

set -uo pipefail

REPO_URL="https://github.com/SumDumIdiut/temutalk.git"
CF_DOMAIN="codecade.co.za"
PANEL_PORT="${PANEL_PORT:-9090}"

# ─── Colour helpers ─────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
  C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  C_BOLD=''; C_DIM=''; C_RESET=''; C_GREEN=''; C_RED=''; C_YELLOW=''; C_CYAN=''
fi
ok()   { echo "  ${C_GREEN}✓${C_RESET} $1"; }
info() { echo "  ${C_CYAN}..${C_RESET} $1"; }
warn() { echo "  ${C_YELLOW}!${C_RESET} $1"; }
err()  { echo "  ${C_RED}✗${C_RESET} $1"; }

SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1 && SUDO="sudo"

# ─── Locate (or clone) the repo ─────────────────────────────────────────────
resolve_self_dir() {
  local src="${BASH_SOURCE[0]:-}"
  [ -n "$src" ] && [ -f "$src" ] && (cd "$(dirname "$src")" && pwd)
}

SELF_DIR="$(resolve_self_dir)"
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/server.js" ] && [ -d "$SELF_DIR/.git" ]; then
  DIR="$SELF_DIR"
else
  DIR="${TEMUTALK_DIR:-$HOME/temutalk}"
  echo ""
  echo "  ${C_BOLD}TemuTalk Speaker — Installer${C_RESET}"
  echo ""
  if [ -d "$DIR/.git" ]; then
    info "Existing checkout found at $DIR — pulling latest..."
    git -C "$DIR" pull --ff-only || warn "git pull failed — continuing with existing checkout"
  else
    info "Cloning into $DIR ..."
    if ! git clone "$REPO_URL" "$DIR"; then
      err "Clone failed. Check your internet connection / git installation."
      exit 1
    fi
    ok "Cloned."
  fi
fi
cd "$DIR" || exit 1

# If we're running from outside the repo (e.g. the USB copy), re-exec the
# repo's own install.sh so all functions come from the latest pulled version.
_SELF_REAL=$(readlink -f "${BASH_SOURCE[0]:-$0}" 2>/dev/null || echo "")
_REPO_SELF=$(readlink -f "$DIR/install.sh" 2>/dev/null || echo "")
if [ -n "$_REPO_SELF" ] && [ "$_SELF_REAL" != "$_REPO_SELF" ]; then
  exec bash "$_REPO_SELF" "$@"
fi
unset _SELF_REAL _REPO_SELF

mkdir -p logs .run bin/linux

# ─── System package dependencies (icecast2, ffmpeg) ─────────────────────────
install_system_deps() {
  local need=()
  command -v ffmpeg   >/dev/null 2>&1 || need+=(ffmpeg)
  command -v icecast2 >/dev/null 2>&1 || need+=(icecast2)
  if [ ${#need[@]} -eq 0 ]; then
    ok "icecast2 and ffmpeg already installed."
    return
  fi
  if ! command -v apt-get >/dev/null 2>&1; then
    warn "apt-get not found — install manually: ${need[*]}"
    return
  fi
  info "Installing ${need[*]} (requires sudo)..."
  $SUDO apt-get update -qq && $SUDO apt-get install -y "${need[@]}"
  if [ $? -eq 0 ]; then ok "Installed ${need[*]}."; else err "Package install failed — see output above."; fi
}

# ─── Portable Node.js + cloudflared (no system install required) ───────────
ensure_portable_bins() {
  local arch node_arch cf_arch
  arch=$(uname -m)
  case "$arch" in
    aarch64|arm64) node_arch=arm64;  cf_arch=linux-arm64 ;;
    arm*)          node_arch=armv7l; cf_arch=linux-arm   ;;
    *)             node_arch=x64;    cf_arch=linux-amd64 ;;
  esac

  if [ ! -f bin/linux/node ]; then
    info "Downloading portable Node.js ($node_arch)..."
    local tarball ver
    tarball=$(curl -sL "https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt" \
      | grep "linux-${node_arch}.tar.gz" | awk '{print $2}' | head -1)
    if [ -z "$tarball" ]; then
      err "Could not determine latest Node.js build."
    else
      curl -L --progress-bar -o bin/linux/node.tar.gz "https://nodejs.org/dist/latest-v20.x/${tarball}"
      ver=${tarball%-linux-*}
      tar -xzf bin/linux/node.tar.gz -C bin/linux --strip-components=2 "${ver}-linux-${node_arch}/bin/node"
      rm -f bin/linux/node.tar.gz
      chmod +x bin/linux/node
      ok "Node.js ready."
    fi
  else
    ok "Portable Node.js already present."
  fi

  if [ ! -f bin/linux/cloudflared ]; then
    info "Downloading cloudflared ($cf_arch)..."
    curl -L --progress-bar -o bin/linux/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${cf_arch}"
    chmod +x bin/linux/cloudflared
    ok "cloudflared ready."
  else
    ok "cloudflared already present."
  fi
}

find_node_bin() {
  if [ -x bin/linux/node ]; then echo "bin/linux/node"; return; fi
  command -v node 2>/dev/null
}

# ─── USB key setup ──────────────────────────────────────────────────────────
USB_LABEL="${USB_LABEL:-C98E-49E1}"
KEY_HASH_FILE=".run/panel-key-hash"

find_usb_mount() {
  local user; user=$(whoami)
  for p in "/media/$user/$USB_LABEL" "/run/media/$user/$USB_LABEL" "/mnt/$USB_LABEL" "/media/$USB_LABEL"; do
    [ -d "$p" ] && { echo "$p"; return; }
  done
}

setup_usb_key() {
  if [ -f "$KEY_HASH_FILE" ] && [ -s "$KEY_HASH_FILE" ]; then
    ok "USB key already enrolled."
    return
  fi
  local usb; usb=$(find_usb_mount)
  if [ -z "$usb" ]; then
    warn "USB drive not found — plug in the TemuTalk USB and re-run install.sh to enroll the key."
    return
  fi
  local key_file="$usb/temutalk.key"
  if [ -f "$key_file" ]; then
    info "Existing key found on USB — enrolling..."
  else
    info "Generating 1000-character key on USB..."
    tr -dc 'A-Za-z0-9+/=' < /dev/urandom 2>/dev/null | head -c 1000 > "$key_file"
    ok "Key written to $key_file"
  fi
  # Store only the SHA-256 hash server-side — raw key stays on USB only
  sha256sum < "$key_file" | cut -c1-64 > "$KEY_HASH_FILE"
  chmod 600 "$KEY_HASH_FILE"
  ok "Key hash enrolled. Panel now requires this USB to be plugged in."
}

# ─── Audio source detection ─────────────────────────────────────────────────
configure_audio_source() {
  local monitor
  monitor=$(pactl list sources short 2>/dev/null | grep '\.monitor' | grep -iv 'null\|auto_null\|virtual' | head -1 | awk '{print $2}')
  if [ -z "$monitor" ]; then
    monitor=$(pactl list sources short 2>/dev/null | grep '\.monitor' | head -1 | awk '{print $2}')
  fi
  if [ -z "$monitor" ]; then
    echo ""
    warn "Could not auto-detect an audio monitor source."
    echo "  Available sources:"
    pactl list sources short 2>/dev/null || echo "  (pactl not available)"
    echo ""
    read -rp "  Enter monitor source name: " monitor
  fi
  echo "$monitor" > audio-source.conf
  ok "Audio source set: $monitor"
}

# ─── Status helpers ──────────────────────────────────────────────────────────
server_pid() { [ -f .run/launcher.pid ] && cat .run/launcher.pid; }
server_running() { local p; p="$(server_pid)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }
panel_pid() { [ -f .run/panel.pid ] && cat .run/panel.pid; }
panel_running() { local p; p="$(panel_pid)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null; }

base_url() {
  if [ -f .env ]; then
    local u; u=$(grep -E '^BASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '\r')
    [ -n "$u" ] && { echo "$u"; return; }
  fi
  echo "https://${CF_DOMAIN}"
}

local_ip() {
  local ip
  ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") print $(i+1)}' | head -1)
  [ -z "$ip" ] && ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -z "$ip" ] && ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)
  [ -z "$ip" ] && ip="127.0.0.1"
  echo "$ip"
}

# ─── Start / stop — individual components ───────────────────────────────────
start_icecast() {
  if ! command -v icecast2 >/dev/null 2>&1 || [ ! -f icecast.xml ]; then
    warn "icecast2 not installed or icecast.xml missing — skipping."
    return
  fi
  if pgrep icecast2 >/dev/null 2>&1; then
    warn "icecast2 already running."
    return
  fi
  [ -n "$SUDO" ] && $SUDO -v
  mkdir -p /tmp/speaker-icecast
  $SUDO systemctl stop icecast2    2>/dev/null || true
  $SUDO systemctl disable icecast2 2>/dev/null || true
  $SUDO fuser -k 8000/tcp           2>/dev/null || true
  sleep 1
  icecast2 -b -c "$DIR/icecast.xml"
  sleep 1
  if pgrep icecast2 > /dev/null; then
    ok "icecast2 started → :8000/stream"
  else
    err "icecast2 failed to start — check /tmp/speaker-icecast/icecast.log"
  fi
}

stop_icecast() {
  if pgrep icecast2 >/dev/null 2>&1; then
    [ -n "$SUDO" ] && $SUDO -v
    $SUDO fuser -k 8000/tcp 2>/dev/null
    ok "icecast2 stopped."
  else
    warn "icecast2 wasn't running."
  fi
}

start_ffmpeg() {
  if [ ! -f audio-source.conf ]; then
    warn "No audio-source.conf — run 'Configure audio source' first."
    return
  fi
  if ! command -v ffmpeg >/dev/null 2>&1; then
    err "ffmpeg not installed."
    return
  fi
  local monitor; monitor=$(cat audio-source.conf)
  pkill -f "ffmpeg.*icecast" 2>/dev/null; sleep 0.5
  ffmpeg -f pulse -i "$monitor" \
    -ac 2 -ar 48000 -c:a libmp3lame -b:a 192k -f mp3 \
    -content_type audio/mpeg \
    "icecast://source:hackme@localhost:8000/stream" \
    > /tmp/speaker-ffmpeg.log 2>&1 &
  echo $! > .run/ffmpeg.pid
  ok "ffmpeg stream started."
}

stop_ffmpeg() {
  local stopped=0
  if [ -f .run/ffmpeg.pid ] && kill -0 "$(cat .run/ffmpeg.pid)" 2>/dev/null; then
    kill "$(cat .run/ffmpeg.pid)" 2>/dev/null
    stopped=1
  fi
  pkill -f "ffmpeg.*icecast" 2>/dev/null && stopped=1
  rm -f .run/ffmpeg.pid
  if [ "$stopped" -eq 1 ]; then ok "ffmpeg stream stopped."; else warn "ffmpeg wasn't running."; fi
}

start_node() {
  if server_running; then
    warn "Server already running (PID $(server_pid))."
    return
  fi
  local node_bin; node_bin="$(find_node_bin)"
  if [ -z "$node_bin" ]; then
    err "No Node.js binary available. Run dependency setup again."
    return
  fi
  nohup "$node_bin" launcher.js > logs/server.log 2>&1 &
  echo $! > .run/launcher.pid
  sleep 2
  if server_running; then
    ok "Server starting (PID $(server_pid)). Logs: logs/server.log"
    echo "  ${C_DIM}Tunnel + Spotify auth take a few seconds to come up.${C_RESET}"
  else
    err "Server exited immediately — check logs/server.log"
  fi
}

stop_node() {
  if server_running; then
    kill "$(server_pid)" 2>/dev/null
    rm -f .run/launcher.pid
    ok "Server stopped."
  else
    warn "Server wasn't running."
  fi
}

start_panel() {
  # Sync PID file with whatever process actually holds the port right now
  local port_pid
  port_pid=$(fuser "${PANEL_PORT}/tcp" 2>/dev/null | tr -d ' ')
  if [ -n "$port_pid" ]; then
    echo "$port_pid" > .run/panel.pid
  fi

  if panel_running; then
    ok "Web panel already running (PID $(panel_pid)) → https://$(local_ip):${PANEL_PORT}/"
    return
  fi

  local node_bin; node_bin="$(find_node_bin)"
  if [ -z "$node_bin" ]; then
    err "No Node.js binary available for the web panel."
    return
  fi

  PANEL_PORT="$PANEL_PORT" INSTALL_SH="$DIR/install.sh" nohup "$node_bin" control-panel.js > logs/panel.log 2>&1 &
  echo $! > .run/panel.pid
  sleep 1.5

  # Our process may have lost a port race with launcher.js — adopt whichever won
  if ! panel_running; then
    port_pid=$(fuser "${PANEL_PORT}/tcp" 2>/dev/null | tr -d ' ')
    [ -n "$port_pid" ] && echo "$port_pid" > .run/panel.pid
  fi

  if panel_running; then
    ok "Web panel → https://$(local_ip):${PANEL_PORT}/"
  else
    err "Web panel failed to start — check logs/panel.log"
  fi
}

stop_panel() {
  if panel_running; then
    kill "$(panel_pid)" 2>/dev/null
    rm -f .run/panel.pid
    ok "Web panel stopped."
  else
    warn "Web panel wasn't running."
  fi
}

# ─── Start / stop — everything ──────────────────────────────────────────────
do_start() {
  [ -n "$SUDO" ] && $SUDO -v
  start_icecast
  start_ffmpeg
  start_node
}

do_stop() {
  stop_node
  stop_ffmpeg
  stop_icecast
}

status_json() {
  local icecast_run=false ffmpeg_run=false node_run=false panel_run=false audio_conf=false audio_src=""
  pgrep icecast2 >/dev/null 2>&1 && icecast_run=true
  pgrep -f "ffmpeg.*icecast" >/dev/null 2>&1 && ffmpeg_run=true
  server_running && node_run=true
  panel_running && panel_run=true
  if [ -f audio-source.conf ]; then audio_conf=true; audio_src=$(tr -d '\r' < audio-source.conf); fi
  printf '{"icecast":%s,"ffmpeg":%s,"node":%s,"panel":%s,"audioConfigured":%s,"audioSource":"%s","url":"%s"}\n' \
    "$icecast_run" "$ffmpeg_run" "$node_run" "$panel_run" "$audio_conf" "$audio_src" "$(base_url)"
}

do_open_browser() {
  local url; url="$(base_url)"
  echo "  URL: ${C_CYAN}${url}${C_RESET}"
  if ! server_running; then
    warn "Server isn't running — start it first, then open this URL to set up Spotify."
    return
  fi
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$url" >/dev/null 2>&1 &
  elif command -v open     >/dev/null 2>&1; then open "$url" >/dev/null 2>&1 &
  else warn "No browser opener found — open the URL above manually."
  fi
}

do_check_updates() {
  info "Fetching..."
  git fetch origin main --quiet 2>/dev/null
  local local_sha remote_sha
  local_sha=$(git rev-parse HEAD 2>/dev/null)
  remote_sha=$(git rev-parse origin/main 2>/dev/null)
  if [ -z "$remote_sha" ]; then err "Could not reach the remote repository."; return; fi
  if [ "$local_sha" = "$remote_sha" ]; then
    ok "Already up to date."
    return
  fi
  warn "Update available ($( echo "$local_sha" | cut -c1-7 ) → $( echo "$remote_sha" | cut -c1-7 ))."
  read -rp "  Pull now? [y/N] " yn
  if [[ "$yn" =~ ^[Yy]$ ]]; then
    if git fetch origin main && git reset --hard origin/main; then
      ok "Updated."
      if server_running; then
        read -rp "  Restart server to apply changes? [y/N] " r
        if [[ "$r" =~ ^[Yy]$ ]]; then
          local lpid; lpid="$(server_pid)"
          if [ -n "$lpid" ] && kill -USR1 "$lpid" 2>/dev/null; then
            ok "Server restarting (tunnel stays up)..."
          else
            stop_node; start_node
          fi
        fi
      fi
    else
      err "Pull failed — resolve manually with 'git status'."
    fi
  fi
}

do_view_logs() {
  echo "  ${C_DIM}Ctrl+C to return to the menu.${C_RESET}"
  sleep 1
  touch logs/server.log
  tail -n 40 -f logs/server.log /tmp/speaker-ffmpeg.log 2>/dev/null
}

# ─── Non-interactive CLI dispatch (used by control-panel.js) ────────────────
# install.sh start|stop {icecast|ffmpeg|node|all}
# install.sh status
if [ "${1:-}" = "enroll" ]; then
  setup_usb_key
  exit 0
fi
if [ "${1:-}" = "start" ] || [ "${1:-}" = "stop" ]; then
  case "${2:-}" in
    icecast|ffmpeg|node|all) ;;
    *) err "Usage: install.sh {start|stop} {icecast|ffmpeg|node|all}"; exit 1 ;;
  esac
  case "$1-$2" in
    start-icecast) start_icecast ;;
    start-ffmpeg)  start_ffmpeg ;;
    start-node)    start_node ;;
    start-all)     do_start ;;
    stop-icecast)  stop_icecast ;;
    stop-ffmpeg)   stop_ffmpeg ;;
    stop-node)     stop_node ;;
    stop-all)      do_stop ;;
  esac
  exit 0
fi
if [ "${1:-}" = "status" ]; then
  status_json
  exit 0
fi

# ─── First-run setup (idempotent) ───────────────────────────────────────────
echo ""
echo "  ${C_BOLD}TemuTalk Speaker — Setup${C_RESET}"
echo ""
install_system_deps
ensure_portable_bins
[ -f audio-source.conf ] || configure_audio_source
setup_usb_key
echo ""
ok "Setup complete."

start_panel

# ─── TUI ─────────────────────────────────────────────────────────────────────
menu() {
  while true; do
    clear
    echo "  ${C_BOLD}╔══════════════════════════════════════╗${C_RESET}"
    echo "  ${C_BOLD}║         TemuTalk Speaker — TUI        ║${C_RESET}"
    echo "  ${C_BOLD}╚══════════════════════════════════════╝${C_RESET}"
    echo ""
    if server_running; then
      echo "  Server : ${C_GREEN}running${C_RESET} (PID $(server_pid))"
    else
      echo "  Server : ${C_DIM}stopped${C_RESET}"
    fi
    if panel_running; then
      echo "  Panel  : ${C_GREEN}running${C_RESET} → https://$(local_ip):${PANEL_PORT}/ (token: .run/panel-token)"
    else
      echo "  Panel  : ${C_DIM}stopped${C_RESET}"
    fi
    if [ -f audio-source.conf ]; then
      echo "  Audio  : $(cat audio-source.conf)"
    else
      echo "  Audio  : ${C_YELLOW}not configured${C_RESET}"
    fi
    echo "  URL    : $(base_url)"
    echo ""
    echo "   1) Start server"
    echo "   2) Stop server"
    echo "   3) Open web UI (Spotify + everything else)"
    echo "   4) Configure audio source"
    echo "   5) Check for updates"
    echo "   6) View logs"
    echo "   7) Toggle web control panel (start each piece individually)"
    echo "   8) Exit"
    echo ""
    read -rp "  Select an option: " choice
    echo ""
    case "$choice" in
      1) do_start ;;
      2) do_stop ;;
      3) do_open_browser ;;
      4) configure_audio_source ;;
      5) do_check_updates ;;
      6) do_view_logs ;;
      7) if panel_running; then stop_panel; else start_panel; fi ;;
      8)
        if server_running; then
          read -rp "  Server is still running — leave it running? [Y/n] " yn
          [[ "$yn" =~ ^[Nn]$ ]] && do_stop
        fi
        if panel_running; then
          read -rp "  Web panel is still running — leave it running? [Y/n] " yn2
          [[ "$yn2" =~ ^[Nn]$ ]] && stop_panel
        fi
        echo "  Bye."
        exit 0
        ;;
      *) warn "Invalid option." ;;
    esac
    echo ""
    read -rp "  Press Enter to continue..." _
  done
}

menu
