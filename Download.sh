#!/bin/bash
cd "$(dirname "$0")"
mkdir -p bin/linux

echo ""
echo " Speaker -- Download portable binaries"
echo " ======================================="
echo ""

ARCH=$(uname -m)
if   [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    NODE_ARCH="arm64"; CF_ARCH="linux-arm64"
elif [[ "$ARCH" == arm* ]]; then
    NODE_ARCH="armv7l"; CF_ARCH="linux-arm"
else
    NODE_ARCH="x64"; CF_ARCH="linux-amd64"
fi

echo "[1/2] Downloading Node.js ($NODE_ARCH)..."
TARBALL=$(curl -sL "https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt" \
  | grep "linux-${NODE_ARCH}.tar.gz" | awk '{print $2}' | head -1)
curl -L --progress-bar -o bin/linux/node.tar.gz \
  "https://nodejs.org/dist/latest-v20.x/${TARBALL}"
VER=$(echo "$TARBALL" | sed 's/-linux-.*//')
tar -xzf bin/linux/node.tar.gz -C bin/linux --strip-components=2 "${VER}-linux-${NODE_ARCH}/bin/node"
rm bin/linux/node.tar.gz
chmod +x bin/linux/node
echo " Done."

echo ""
echo "[2/2] Downloading cloudflared ($CF_ARCH)..."
curl -L --progress-bar -o bin/linux/cloudflared \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${CF_ARCH}"
chmod +x bin/linux/cloudflared
echo " Done."

echo ""
echo " Finished. Run ./Start.sh to launch Speaker."
echo ""
