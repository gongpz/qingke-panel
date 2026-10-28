#!/bin/bash
set -e

echo "== Qingke Panel installer =="

if [ "$(id -u)" != "0" ]; then
    echo "Please run as root (sudo bash install.sh)"
    exit 1
fi

if [ -z "$PANEL_PORT" ]; then
    input=""
    echo "请输入面板端口（回车使用默认 8888）："
    read -r input
    if [ -z "$input" ]; then
        PANEL_PORT=8888
    elif case "$input" in *[!0-9]*) true;; *) false;; esac; then
        echo "端口无效，使用默认 8888"
        PANEL_PORT=8888
    elif [ "$input" -ge 1 ] 2>/dev/null && [ "$input" -le 65535 ]; then
        PANEL_PORT="$input"
    else
        echo "端口超出范围 1-65535，使用默认 8888"
        PANEL_PORT=8888
    fi
fi
if [ -z "$PANEL_DIR" ]; then
    PANEL_DIR=/opt/qingliang
fi

echo "Installing to $PANEL_DIR, panel port $PANEL_PORT"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx python3 certbot python3-certbot-nginx

if ! nginx -v 2>&1 | grep -q "nginx"; then
    echo "nginx install failed"
    exit 1
fi

mkdir -p "$PANEL_DIR/web"
cp -r web/. "$PANEL_DIR/web/"
cp panel.py "$PANEL_DIR/panel.py"
chmod +x "$PANEL_DIR/panel.py"

cat > /etc/systemd/system/qingliang.service <<EOF
[Unit]
Description=Qingke Panel
After=network.target nginx.service

[Service]
Type=simple
WorkingDirectory=$PANEL_DIR
ExecStart=/usr/bin/python3 $PANEL_DIR/panel.py
Restart=always
RestartSec=3
Environment=PANEL_PORT=$PANEL_PORT
Environment=PANEL_HOST=0.0.0.0

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable qingliang
systemctl restart qingliang
sleep 1

cat > /etc/nginx/sites-available/default <<'EOF'
# Qingke Panel: reject requests for unbound hosts (no fallback page)
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}
EOF

systemctl enable nginx
systemctl start nginx

IP=$(curl -s -4 ifconfig.me 2>/dev/null || curl -s -4 ip.sb 2>/dev/null || echo "YOUR_SERVER_IP")

echo
echo "=========================================================="
echo " Install finished!"
echo
echo " Panel URL:   http://$IP:$PANEL_PORT"
echo " Username:    qingke"
echo " Password:    qingke123"
echo
echo " Login and change username/password in Settings."
echo "=========================================================="
