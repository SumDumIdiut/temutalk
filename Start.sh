#!/bin/bash
cd "$(dirname "$0")"
DIR="$(pwd)"

# Ensure this script and Download.sh are executable
chmod +x Start.sh Download.sh Check-Update.sh 2>/dev/null || true

# Pull latest changes if git is available
command -v git &>/dev/null && git pull

# Run setup if audio-source.conf doesn't exist yet
if [ ! -f "$DIR/audio-source.conf" ]; then
    bash "$DIR/Setup.sh"
fi

# Download binaries if missing
if [ ! -f "bin/linux/node" ]; then
    echo " node not found — running Download.sh first..."
    echo ""
    bash Download.sh
fi

# Copy bundled binaries to /tmp to bypass noexec mounts
if [ -f "bin/linux/node" ]; then
    cp -f bin/linux/node /tmp/speaker-node 2>/dev/null && chmod +x /tmp/speaker-node
    NODE_BIN=/tmp/speaker-node
else
    NODE_BIN=node
fi

if [ -f "bin/linux/cloudflared" ]; then
    cp -f bin/linux/cloudflared /tmp/speaker-cloudflared 2>/dev/null && chmod +x /tmp/speaker-cloudflared
fi

# Check Node.js
if ! "$NODE_BIN" --version &>/dev/null; then
    if ! command -v node &>/dev/null; then
        echo ""
        echo " Node.js not found and Download.sh failed."
        echo " Install manually from https://nodejs.org/"
        echo ""
        exit 1
    fi
    NODE_BIN=node
fi

# Start icecast if installed and config exists
if command -v icecast2 &>/dev/null && [ -f "$DIR/icecast.xml" ]; then
    mkdir -p /tmp/speaker-icecast
    sudo systemctl stop icecast2 2>/dev/null || true
    sudo systemctl disable icecast2 2>/dev/null || true
    sudo fuser -k 8000/tcp 2>/dev/null || true
    sleep 1
    icecast2 -b -c "$DIR/icecast.xml"
    sleep 1
    if pgrep icecast2 > /dev/null; then
        echo " icecast started  → http://$(hostname -I | awk '{print $1}'):8000/stream"
    else
        echo " icecast failed to start — check /tmp/speaker-icecast/icecast.log"
    fi
fi

# Start ffmpeg stream if audio source is configured
if [ -f "$DIR/audio-source.conf" ] && command -v ffmpeg &>/dev/null; then
    MONITOR=$(cat "$DIR/audio-source.conf")
    pkill -f "ffmpeg.*icecast" 2>/dev/null; sleep 0.5
    ffmpeg -f pulse -i "$MONITOR" \
        -ac 2 -ar 48000 -c:a libmp3lame -b:a 192k -f mp3 \
        -content_type audio/mpeg \
        "icecast://source:hackme@localhost:8000/stream" \
        > /tmp/speaker-ffmpeg.log 2>&1 &
    echo " ffmpeg stream started"
fi

"$NODE_BIN" "$DIR/launcher.js"
