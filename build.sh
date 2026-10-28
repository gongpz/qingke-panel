#!/bin/bash
set -e

echo "== qingliang Panel build tool =="
echo "Generates: qingliang-install.sh (one-line installer) + qingliang.tar.gz (manual)"

usage() {
    echo "Usage: bash build.sh -u <CDN_BASE_URL> [-p <PATH_PREFIX>]"
    echo
    echo "  -u   R2 public bucket CDN 根地址（不带结尾斜杠），如 https://cdn.example.com"
    echo "  -p   (可选) 桶内子目录前缀，如 qingliang，则文件放在 /qingliang/ 下"
    echo
    echo "步骤："
    echo "  1. 本机运行  bash build.sh -u https://cdn.example.com -p qingliang"
    echo "  2. 把 qingliang-install.sh、panel.py、web/ 上传到 R2 桶 /qingliang/ 目录"
    echo "  3. 在 VPS 执行  curl -fsSL https://cdn.example.com/qingliang-install.sh | sudo bash"
    exit 1
}

CDN_BASE=""
PKG_PATH=""
while getopts "u:p:h" opt; do
    case $opt in
        u) CDN_BASE="$OPTARG" ;;
        p) PKG_PATH="$OPTARG" ;;
        *) usage ;;
    esac
done

if [ -z "$CDN_BASE" ]; then
    echo "ERROR: missing -u CDN_BASE_URL"
    usage
fi

CDN_BASE="${CDN_BASE%/}"
PKG_PATH="${PKG_PATH#/}"
PKG_PATH="${PKG_PATH%/}"
VERSION=$(date +%Y%m%d%H%M%S)

for f in panel.py web/index.html web/style.css web/app.js; do
    if [ ! -f "$f" ]; then
        echo "ERROR: $f not found"
        exit 1
    fi
done

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "[1/3] Computing sha256 checksums"
HASH_LINES=""
for f in panel.py web/index.html web/style.css web/app.js; do
    h=$(sha256sum "$f" | awk '{print $1}')
    HASH_LINES="${HASH_LINES}PKG_HASHES[\"$f\"]=\"$h\"
"
    echo "  $f  $h"
done

echo "[2/3] Generating qingliang-install.sh"
OUT_SCRIPT="qingliang-install.sh"
awk -v cdn="$CDN_BASE" -v path="$PKG_PATH" -v ver="$VERSION" -v hashes="$HASH_LINES" '
    {
        gsub(/\{\{CDN_BASE\}\}/, cdn)
        gsub(/\{\{PKG_PATH\}\}/, path)
        gsub(/\{\{PKG_VERSION\}\}/, ver)
        gsub(/\{\{CHECKSUM_TABLE\}\}/, hashes)
        print
    }
' install-r2.template.sh > "$OUT_SCRIPT"
chmod +x "$OUT_SCRIPT"

echo "[3/3] Building qingliang.tar.gz"
TARBALL="$TMP/web"
mkdir -p "$TMP/pkg/web"
cp panel.py install.sh pull-install.sh "$TMP/pkg/"
cp -r web/. "$TMP/pkg/web/"
tar czf qingliang.tar.gz -C "$TMP/pkg" .
sha256sum qingliang.tar.gz | awk '{print $1}' > qingliang.tar.gz.sha256

echo
echo "=========================================================="
echo " Build finished!"
echo
if [ -n "$PKG_PATH" ]; then
    echo " Upload to R2 bucket  /$PKG_PATH/  directory (public):"
else
    echo " Upload to R2 bucket root directory (public):"
fi
echo "   qingliang-install.sh"
echo "   panel.py"
echo "   web/           (整个目录)"
echo
echo " Then on the VPS, one-line install:"
echo "   curl -fsSL $CDN_BASE/qingliang-install.sh | sudo bash"
echo
echo " Optional env:"
echo "   PANEL_PORT=9000 curl -fsSL $CDN_BASE/qingliang-install.sh | sudo bash"
echo "=========================================================="
