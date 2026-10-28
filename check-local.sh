#!/bin/bash
# 上传前自查：核对本机文件哈希与脚本内嵌哈希是否一致
# 用法： bash check-local.sh
set -e
cd "$(dirname "$0")"

SCRIPT=qingliang-install.sh
FILES=(panel.py web/index.html web/style.css web/app.js)

echo "=== 校验本机文件 与 $SCRIPT 内嵌哈希是否一致 ==="
if [ ! -f "$SCRIPT" ]; then
    echo "ERROR: $SCRIPT 不存在，请先运行 bash build.sh -u <CDN> -p <PATH>"
    exit 1
fi

fail=0
for f in "${FILES[@]}"; do
    expected=$(grep -oP "PKG_HASHES\[\"$f\"\]=\"\K[0-9a-f]+" "$SCRIPT")
    if [ -z "$expected" ]; then
        echo "WARN  $f 未在脚本中找到哈希（文件不在安装清单中？）"
        continue
    fi
    actual=$(sha256sum "$f" | awk '{print $1}')
    if [ "$expected" = "$actual" ]; then
        echo "MATCH    $f"
    else
        echo "MISMATCH $f"
        echo "  script: $expected"
        echo "  local:  $actual"
        fail=1
    fi
done

echo
if [ "$fail" = "0" ]; then
    echo "✓ 全部一致，可以上传这 5 个文件到 R2"
else
    echo "✗ 存在不一致！不要上传，请重新运行 build.sh 确保脚本与文件配套"
fi
exit "$fail"
