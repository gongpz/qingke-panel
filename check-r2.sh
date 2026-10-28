#!/bin/bash
# 上传后自查：核对 R2 上的文件哈希 与 脚本内嵌哈希是否一致
# 用法： bash check-r2.sh <CDN_BASE> [PKG_PATH]
#   例： bash check-r2.sh https://sh.851109.xyz qlweb
set -e

CDN_BASE="${1:-https://sh.851109.xyz}"
PKG_PATH="${2:-qlweb}"
PKG_URL="$CDN_BASE/${PKG_PATH%/}"

FILES=(panel.py web/index.html web/style.css web/app.js)

echo "=== 校验 R2 ($PKG_URL) 上文件是否与最新脚本匹配 ==="
SCRIPT=qingliang-install.sh
if [ ! -f "$SCRIPT" ]; then
    echo "注意: 当前目录没有 $SCRIPT，将打印 R2 文件哈希供对照"
fi

fail=0
for f in "${FILES[@]}"; do
    remote=$(curl -fsSL "$PKG_URL/$f?cb=$(date +%s)" 2>/dev/null | sha256sum | awk '{print $1}')
    expected=""
    if [ -f "$SCRIPT" ]; then
        expected=$(grep -oP "PKG_HASHES\[\"$f\"\]=\"\K[0-9a-f]+" "$SCRIPT")
    fi
    echo "  $f"
    echo "    remote:   $remote"
    if [ -n "$expected" ]; then
        if [ "$remote" = "$expected" ]; then
            echo "    expected: $expected   [匹配]"
        else
            echo "    expected: $expected   [不匹配，需重新上传该文件]"
            fail=1
        fi
    fi
done

echo
if [ "$fail" = "0" ] && [ -f "$SCRIPT" ]; then
    echo "✓ R2 上所有文件都是最新版，可以执行安装"
elif [ "$fail" = "0" ]; then
    echo "（未比对脚本，仅打印哈希）"
else
    echo "✗ 有文件不是最新版，请重新上传后再安装"
fi
