#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "  Speaker Setup"
echo ""

# Install dependencies
echo "  Installing icecast2 and ffmpeg..."
sudo apt-get update -qq
sudo apt-get install -y icecast2 ffmpeg

# Auto-detect PulseAudio monitor source (prefer real hardware, skip null/virtual)
MONITOR=$(pactl list sources short 2>/dev/null | grep '\.monitor' | grep -iv 'null\|auto_null\|virtual' | head -1 | awk '{print $2}')
if [ -z "$MONITOR" ]; then
    MONITOR=$(pactl list sources short 2>/dev/null | grep '\.monitor' | head -1 | awk '{print $2}')
fi
if [ -z "$MONITOR" ]; then
    echo ""
    echo "  Could not auto-detect audio monitor source."
    echo "  Available sources:"
    pactl list sources short 2>/dev/null || echo "  (pactl not available)"
    echo ""
    read -rp "  Enter monitor source name: " MONITOR
fi

echo "  Using audio source: $MONITOR"
echo "$MONITOR" > audio-source.conf

echo ""
echo "  Done. Run ./Start.sh to start everything."
echo "  Stream will be available at http://$(hostname -I | awk '{print $1}'):8000/stream"
echo ""
