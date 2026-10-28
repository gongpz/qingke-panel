#!/bin/bash
set -e

echo "== Qingke Panel remote installer (R2/CDN) =="

usage() {
    echo "Usage:"
    echo "  bash pull-install.sh -u <URL> [-s <SHA256>] [-p <PORT>] [-d <DIR>]"
    echo
    echo "  -u  下载地址 (tar.gz)，如 https://cdn.example.com/qingliang.tar.gz"
    echo "  -s  (可选) 期望的 sha256 校验和，用于防篡改校验"
    echo "  -p  (可选) 面板端口，默认 8888"
    echo "  -d  (可选) 安装目录，默认 /opt/qingliang"
    echo
    echo "示例:"
    echo "  bash pull-install.sh -u https://cdn.example.com/qingliang.tar.gz \\"
    echo "       -s 4f8a2b1c9d3e5f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1"
    exit 1
}

URL=""
EXPECTED_SHA=""
PANEL_PORT=""
PANEL_DIR=""

while getopts "u:s:p:d:h" opt; do
    case $opt in
        u) URL="$OPTARG" ;;
        s) EXPECTED_SHA="$OPTARG" ;;
        p) PANEL_PORT="$OPTARG" ;;
        d) PANEL_DIR="$OPTARG" ;;
        h) usage ;;
        *) usage ;;
    esac
done

if [ -z "$URL" ]; then
    echo "ERROR: missing -u URL"
    usage
fi

if [ -z "$PANEL_PORT" ]; then
    PANEL_PORT=8888
fi
if [ -z "$PANEL_DIR" ]; then
    PANEL_DIR=/opt/qingliang
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
TARBALL="$WORK/qingliang.tar.gz"

echo "[1/4] Downloading $URL"
if ! command -v curl >/dev/null 2>&1; then
    apt-get update -y >/dev/null 2>&1 || true
    apt-get install -y curl tar >/dev/null 2>&1
fi
curl -fsSL --retry 3 -o "$TARBALL" "$URL" || {
    echo "ERROR: download failed"
    exit 1
}

echo "[2/4] Verifying checksum"
if [ -n "$EXPECTED_SHA" ]; then
    ACTUAL_SHA=$(sha256sum "$TARBALL" | awk '{print $1}')
    if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
        echo "ERROR: checksum mismatch!"
        echo "  expected: $EXPECTED_SHA"
        echo "  actual:   $ACTUAL_SHA"
        exit 1
    fi
    echo "  checksum OK"
else
    echo "  warning: no -s provided, skipping integrity check"
    echo "  actual sha256: $(sha256sum "$TARBALL" | awk '{print $1}')"
fi

echo "[3/4] Extracting"
mkdir -p "$WORK/src"
tar xzf "$TARBALL" -C "$WORK/src"
if [ ! -f "$WORK/src/install.sh" ] || [ ! -f "$WORK/src/panel.py" ]; then
    echo "ERROR: archive is missing install.sh / panel.py, not a valid panel package"
    exit 1
fi
chmod +x "$WORK/src/install.sh"

echo "[4/4] Running installer"
export PANEL_PORT
export PANEL_DIR
bash "$WORK/src/install.sh"
