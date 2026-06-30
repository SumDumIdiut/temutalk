#!/bin/bash
# TemuTalk Speaker — installer + control panel.
# Safe to download standalone and run: bash install.sh
# Clones/updates the repo, installs all dependencies, then opens a TUI
# for starting/stopping the server and doing one-off setup tasks.

set -uo pipefail

REPO_URL="https://github.com/SumDumIdiut/temutalk.git"
CF_DOMAIN="codecade.co.za"

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

base_url() {
  if [ -f .env ]; then
    local u; u=$(grep -E '^BASE_URL=' .env | head -1 | cut -d= -f2-)
    [ -n "$u" ] && { echo "$u"; return; }
  fi
  echo "https://${CF_DOMAIN}"
}

# ─── Start / stop ────────────────────────────────────────────────────────────
do_start() {
  if server_running; then
    warn "Already running (PID $(server_pid))."
    return
  fi
  [ -n "$SUDO" ] && $SUDO -v

  if command -v icecast2 >/dev/null 2>&1 && [ -f icecast.xml ]; then
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
  else
    warn "icecast2 not installed or icecast.xml missing — skipping audio cast."
  fi

  if [ -f audio-source.conf ] && command -v ffmpeg >/dev/null 2>&1; then
    local monitor; monitor=$(cat audio-source.conf)
    pkill -f "ffmpeg.*icecast" 2>/dev/null; sleep 0.5
    ffmpeg -f pulse -i "$monitor" \
      -ac 2 -ar 48000 -c:a libmp3lame -b:a 192k -f mp3 \
      -content_type audio/mpeg \
      "icecast://source:hackme@localhost:8000/stream" \
      > /tmp/speaker-ffmpeg.log 2>&1 &
    echo $! > .run/ffmpeg.pid
    ok "ffmpeg stream started."
  else
    warn "No audio-source.conf — run 'Configure audio source' first."
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

do_stop() {
  local stopped=0
  if server_running; then
    kill "$(server_pid)" 2>/dev/null
    stopped=1
  fi
  rm -f .run/launcher.pid

  if [ -f .run/ffmpeg.pid ] && kill -0 "$(cat .run/ffmpeg.pid)" 2>/dev/null; then
    kill "$(cat .run/ffmpeg.pid)" 2>/dev/null
    stopped=1
  fi
  pkill -f "ffmpeg.*icecast" 2>/dev/null && stopped=1
  rm -f .run/ffmpeg.pid

  if pgrep icecast2 >/dev/null 2>&1; then
    $SUDO fuser -k 8000/tcp 2>/dev/null
    stopped=1
  fi

  if [ "$stopped" -eq 1 ]; then ok "Stopped."; else warn "Nothing was running."; fi
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
    if git pull --ff-only; then
      ok "Updated."
      if server_running; then
        read -rp "  Restart server to apply changes? [y/N] " r
        [[ "$r" =~ ^[Yy]$ ]] && { do_stop; do_start; }
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

# ─── First-run setup (idempotent) ───────────────────────────────────────────
echo ""
echo "  ${C_BOLD}TemuTalk Speaker — Setup${C_RESET}"
echo ""
install_system_deps
ensure_portable_bins
[ -f audio-source.conf ] || configure_audio_source
echo ""
ok "Setup complete."

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
    echo "   7) Exit"
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
      7)
        if server_running; then
          read -rp "  Server is still running — leave it running? [Y/n] " yn
          [[ "$yn" =~ ^[Nn]$ ]] && do_stop
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
