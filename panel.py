#!/usr/bin/env python3
import json, os, re, sys, time, hashlib, hmac, secrets, subprocess, urllib.parse, socket, shutil, base64, threading, glob, zipfile, datetime, html, posixpath
from collections import deque
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

BASE = Path(__file__).resolve().parent
CONFIG_PATH = BASE / "panel.conf"
META_PATH = BASE / "sites_meta.json"
ACTION_LOG = BASE / "actions.log"
SSL_DIR = Path("/etc/nginx/ssl")
FRONT_DIR = BASE / "web"
HOST = os.environ.get("PANEL_HOST", "0.0.0.0")
PORT = int(os.environ.get("PANEL_PORT", "8888"))
ALLOWED_ROOTS = ["/var/www", "/etc/nginx", "/var/log/nginx"]
READ_LIMIT = 4 * 1024 * 1024
UPLOAD_LIMIT = 300 * 1024 * 1024
TOKEN_TTL = 7 * 24 * 3600
SITE_ROOT = "/var/www"
SSL_DOMAINS = SSL_DIR

tokens = {}
failures = {}
_config = None
_meta = None

DEFAULT_USER = "qingke"
DEFAULT_PASS = "qingke123"

MONITOR_MAX = 60
monitor = {"t": deque(maxlen=MONITOR_MAX), "cpu": deque(maxlen=MONITOR_MAX),
           "mem": deque(maxlen=MONITOR_MAX), "disk": deque(maxlen=MONITOR_MAX),
           "rx": deque(maxlen=MONITOR_MAX), "tx": deque(maxlen=MONITOR_MAX)}
_net_last = None

ERROR_PAGE_DIR = BASE / "error_pages"
ERROR_INFO = {
    "400": ("Bad Request", "请求错误", "服务器无法理解您的请求，可能存在语法错误或参数缺失。"),
    "401": ("Unauthorized", "未授权", "访问该资源需要身份验证，请先登录或检查您的凭证。"),
    "403": ("Forbidden", "禁止访问", "您没有权限访问该资源，如有疑问请联系管理员。"),
    "404": ("Not Found", "页面不存在", "您访问的页面不存在，可能已被移动或删除。"),
    "405": ("Method Not Allowed", "方法不允许", "当前请求方式不受支持，请使用正确的请求方法。"),
    "408": ("Request Timeout", "请求超时", "服务器等待请求时超时，请稍后重试。"),
    "500": ("Internal Server Error", "服务器错误", "服务器遇到意外错误，无法完成您的请求，请稍后重试。"),
    "501": ("Not Implemented", "未实现", "服务器不支持当前请求所需的功能。"),
    "502": ("Bad Gateway", "网关错误", "上游服务器返回了无效响应，请稍后重试。"),
    "503": ("Service Unavailable", "服务不可用", "服务器暂时无法处理请求，请稍后再试。"),
    "504": ("Gateway Timeout", "网关超时", "上游服务器响应超时，请稍后重试。"),
}

_ERROR_TMPL = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>__CODE__ __ZH__</title>
<style>
:root{
  --bg:#F2F4F9;
  --tint-a:rgba(108,123,255,.16);
  --tint-b:rgba(162,89,255,.11);
  --tint-c:rgba(34,211,238,.12);
  --card:rgba(255,255,255,.78);
  --line:rgba(16,24,40,.085);
  --t1:#0E1322;
  --t2:#4A536B;
  --t3:#8A92A8;
  --grad:linear-gradient(115deg,#6C7BFF 0%,#A259FF 52%,#22D3EE 100%);
}
@media(prefers-color-scheme:dark){
  :root{
    --bg:#06070B;
    --tint-a:rgba(91,108,255,.30);
    --tint-b:rgba(162,89,255,.20);
    --tint-c:rgba(34,211,238,.16);
    --card:rgba(22,27,39,.78);
    --line:rgba(255,255,255,.075);
    --t1:#EDF0F8;
    --t2:#A3ABC2;
    --t3:#6B7488;
  }
}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  background:var(--bg);color:var(--t2);
  display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;
  -webkit-font-smoothing:antialiased;
}
.aurora{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;opacity:.6}
.aurora i{position:absolute;display:block;border-radius:50%;filter:blur(90px)}
.aurora i:nth-child(1){
  width:46vw;height:46vw;min-width:420px;min-height:420px;top:-14vw;left:-8vw;
  background:var(--tint-a);animation:da 26s cubic-bezier(.4,0,.2,1) infinite alternate;
}
.aurora i:nth-child(2){
  width:38vw;height:38vw;min-width:340px;min-height:340px;top:12vh;right:-10vw;
  background:var(--tint-b);animation:db 32s cubic-bezier(.4,0,.2,1) infinite alternate;
}
.aurora i:nth-child(3){
  width:42vw;height:42vw;min-width:380px;min-height:380px;bottom:-18vw;left:26vw;
  background:var(--tint-c);animation:dc 38s cubic-bezier(.4,0,.2,1) infinite alternate;
}
@keyframes da{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(8vw,6vh,0) scale(1.14)}100%{transform:translate3d(-4vw,12vh,0) scale(1.05)}}
@keyframes db{0%{transform:translate3d(0,0,0) scale(1.08)}50%{transform:translate3d(-10vw,10vh,0) scale(1)}100%{transform:translate3d(-3vw,-6vh,0) scale(1.18)}}
@keyframes dc{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(-8vw,-10vh,0) scale(1.2)}100%{transform:translate3d(6vw,-4vh,0) scale(1.06)}}
.card{
  position:relative;z-index:1;
  background:var(--card);border:1px solid var(--line);border-radius:22px;
  box-shadow:0 4px 8px -2px rgba(16,24,40,.08),0 28px 56px -16px rgba(16,24,40,.18);
  backdrop-filter:blur(28px) saturate(160%);-webkit-backdrop-filter:blur(28px) saturate(160%);
  max-width:560px;width:100%;padding:52px 40px;text-align:center;overflow:hidden;
  animation:cin .62s cubic-bezier(.22,1,.36,1) both;
}
.card::before{
  content:"";position:absolute;top:0;left:14%;right:14%;height:1px;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.6),transparent);
}
@keyframes cin{from{opacity:0;transform:translateY(18px) scale(.97)}to{opacity:1;transform:none}}}
.code{
  font-size:96px;font-weight:800;line-height:1;
  background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;
  letter-spacing:4px;
  animation:float 5s ease-in-out infinite;
}
@keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
.zh{font-size:22px;font-weight:650;margin-top:16px;color:var(--t1);letter-spacing:.5px}
.en{
  font-size:11.5px;color:var(--t3);margin-top:7px;
  letter-spacing:2px;text-transform:uppercase;
}
.desc{font-size:14.5px;color:var(--t2);margin-top:24px;line-height:1.75}
.btn{
  position:relative;overflow:hidden;
  margin-top:32px;display:inline-block;padding:11px 30px;border-radius:12px;
  background:var(--grad);background-size:180% 180%;background-position:0% 50%;
  color:#fff;text-decoration:none;font-size:14px;font-weight:500;
  box-shadow:0 4px 14px -4px rgba(108,123,255,.6);
  transition:background-position .5s cubic-bezier(.22,1,.36,1),transform .18s cubic-bezier(.22,1,.36,1),box-shadow .3s;
}
.btn:hover{
  background-position:100% 50%;transform:translateY(-1px);
  box-shadow:0 6px 20px -4px rgba(108,123,255,.8);
}
.foot{margin-top:40px;padding-top:20px;border-top:1px solid var(--line);font-size:11.5px;color:var(--t3);letter-spacing:.3px}
@media(max-width:520px){
  .card{padding:40px 24px}
  .code{font-size:72px}
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none !important;transition:none !important}
  .aurora{display:none}
}
</style>
</head>
<body>
<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
<div class="card">
  <div class="code">__CODE__</div>
  <div class="zh">__ZH__</div>
  <div class="en">__EN__</div>
  <div class="desc">__DESC__</div>
  <a class="btn" href="/">返回首页</a>
  <div class="foot">Powered by 轻壳面板 Qingke Panel</div>
</div>
</body>
</html>
"""


def builtin_error_page(code):
    en, zh, desc = ERROR_INFO.get(code, ("Error", "错误", "服务器遇到问题，请稍后重试。"))
    return (_ERROR_TMPL.replace("__CODE__", code).replace("__ZH__", zh)
            .replace("__EN__", en).replace("__DESC__", desc))


def ensure_error_pages():
    try:
        ERROR_PAGE_DIR.mkdir(parents=True, exist_ok=True)
        for code in ERROR_CODES:
            fp = ERROR_PAGE_DIR / ("%s.html" % code)
            if not fp.is_file():
                fp.write_text(builtin_error_page(code), encoding="utf-8")
    except OSError:
        pass


# ---------------------------------------------------------------- app store
APP_LOG_DIR = BASE / "apps"
APP_BUSY = {}

APPS = {
    "php82": {
        "name": "PHP 8.2",
        "icon": "🐘",
        "desc": "PHP 8.2 + php-fpm，含 SQLite3 / MySQL / curl / mbstring / XML / zip / gd 扩展",
        "pkgs": "php8.2-fpm php8.2-cli php8.2-sqlite3 php8.2-mysql php8.2-curl php8.2-mbstring php8.2-xml php8.2-zip php8.2-gd",
        "after": "systemctl enable --now php8.2-fpm",
        "uninstall": "php8.2-fpm php8.2-cli php8.2-sqlite3 php8.2-mysql php8.2-curl php8.2-mbstring php8.2-xml php8.2-zip php8.2-gd",
        "fpm_socket": "/run/php/php8.2-fpm.sock",
    },
    "nodejs": {
        "name": "Node.js",
        "icon": "🟩",
        "desc": "Node.js + npm（Debian 官方源，Debian 12 为 v18）",
        "pkgs": "nodejs npm",
        "uninstall": "nodejs npm",
    },
    "python3": {
        "name": "Python 3",
        "icon": "🐍",
        "desc": "Python 3 + pip + venv（系统自带解释器，安装配套工具）",
        "pkgs": "python3 python3-pip python3-venv",
        "uninstall": "python3-pip python3-venv",
    },
    "sqlite3": {
        "name": "SQLite 3",
        "icon": "🗄️",
        "desc": "SQLite 3 数据库命令行工具（PHP/Python 内置模块免装）",
        "pkgs": "sqlite3",
        "uninstall": "sqlite3",
    },
}


def app_version(aid):
    try:
        if aid == "php82":
            r = run(["php", "-v"], timeout=10)
            v = r["out"].splitlines()[0] if r["out"] else ""
            sock = os.path.exists(APPS["php82"]["fpm_socket"])
            if not v:
                return {"installed": False, "version": "-", "extra": "未安装"}
            if sock:
                return {"installed": True, "version": v, "extra": "php-fpm 运行中"}
            return {"installed": True, "version": v, "extra": "php-fpm 未运行"}
        if aid == "nodejs":
            r = run(["node", "-v"], timeout=10)
            v = r["out"].splitlines()[-1] if r["out"].strip() else ""
            return {"installed": bool(r["out"].strip()), "version": v or "-", "extra": ""}
        if aid == "python3":
            r = run(["python3", "--version"], timeout=10)
            v = r["out"].strip() or r["err"].strip()
            return {"installed": bool(v), "version": v or "-", "extra": ""}
        if aid == "sqlite3":
            r = run(["sqlite3", "--version"], timeout=10)
            v = r["out"].strip().split()[0] if r["out"] else ""
            return {"installed": bool(v), "version": v or "-", "extra": ""}
    except Exception:
        pass
    return {"installed": False, "version": "-", "extra": ""}


def api_apps():
    out = []
    for aid, meta in APPS.items():
        st = app_version(aid)
        out.append({
            "id": aid, "name": meta["name"], "icon": meta.get("icon", ""), "desc": meta["desc"],
            "pkgs": meta["pkgs"], "installed": st["installed"], "version": st["version"],
            "extra": st["extra"], "busy": bool(APP_BUSY.get(aid)),
        })
    return {"ok": True, "apps": out}


def _app_log_file(aid):
    try:
        APP_LOG_DIR.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    return APP_LOG_DIR / ("%s.log" % aid)


def _app_log_emit(aid, msg):
    try:
        with open(_app_log_file(aid), "a", encoding="utf-8") as f:
            f.write("[%s] %s\n" % (datetime.datetime.now().strftime("%H:%M:%S"), msg))
    except OSError:
        pass


def _app_worker(aid, meta, mode):
    emit = lambda s: _app_log_emit(aid, s)
    pkgs = meta.get("uninstall" if mode == "uninstall" else "pkgs", "")
    try:
        if mode == "install":
            emit("== 开始安装 %s ==" % meta["name"])
            for cmd in (["apt-get", "update"],
                        ["apt-get", "install", "-y"] + pkgs.split()):
                emit("$ " + " ".join(cmd))
                r = run(cmd, timeout=3600)
                if r["out"]:
                    emit(r["out"].rstrip())
                if r["err"]:
                    emit(r["err"].rstrip())
                if r["code"] != 0:
                    emit("== 安装失败（exit %s）==" % r["code"])
                    return
            if meta.get("after"):
                emit("$ " + meta["after"])
                r = run(meta["after"].split(), timeout=60)
                if r["err"]:
                    emit(r["err"].rstrip())
            emit("== %s 安装完成 ==" % meta["name"])
        else:
            emit("== 开始卸载 %s ==" % meta["name"])
            emit("$ apt-get remove -y " + pkgs)
            r = run(["apt-get", "remove", "-y"] + pkgs.split(), timeout=3600)
            if r["out"]:
                emit(r["out"].rstrip())
            if r["err"]:
                emit(r["err"].rstrip())
            if r["code"] == 0:
                emit("== %s 卸载完成 ==" % meta["name"])
            else:
                emit("== 卸载失败（exit %s）==" % r["code"])
    except Exception as e:
        emit("== 异常: %s ==" % e)
    finally:
        APP_BUSY.pop(aid, None)


def app_install(aid):
    meta = APPS.get(aid)
    if not meta:
        return {"ok": False, "msg": "应用不存在"}
    if APP_BUSY.get(aid):
        return {"ok": False, "msg": "该应用正在安装/卸载中"}
    if app_version(aid)["installed"]:
        return {"ok": False, "msg": "该应用已安装"}
    APP_BUSY[aid] = threading.Thread(target=_app_worker, args=(aid, meta, "install"), daemon=True)
    APP_BUSY[aid].start()
    log_action("安装应用", meta["name"])
    return {"ok": True, "msg": "开始安装 %s，可在应用市场查看进度日志" % meta["name"]}


def app_uninstall(aid):
    meta = APPS.get(aid)
    if not meta:
        return {"ok": False, "msg": "应用不存在"}
    if APP_BUSY.get(aid):
        return {"ok": False, "msg": "该应用正在安装/卸载中"}
    if not app_version(aid)["installed"]:
        return {"ok": False, "msg": "该应用未安装"}
    APP_BUSY[aid] = threading.Thread(target=_app_worker, args=(aid, meta, "uninstall"), daemon=True)
    APP_BUSY[aid].start()
    log_action("卸载应用", meta["name"])
    return {"ok": True, "msg": "开始卸载 %s，可在应用市场查看进度日志" % meta["name"]}


def app_log(aid, tail=1500):
    p = _app_log_file(aid)
    if not p.exists():
        return {"lines": []}
    try:
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()[-tail:]
    except OSError:
        lines = []
    return {"lines": lines}


def feature_enabled(name):
    return bool((load_config().get("features") or {}).get(name))


def set_features(data):
    cfg = load_config()
    feats = dict(cfg.get("features") or {})
    changed = []
    for k in ("php",):
        if k in data:
            feats[k] = bool(data[k])
            changed.append("%s:%s" % (k, "开" if feats[k] else "关"))
    cfg["features"] = feats
    save_config(cfg)
    if changed:
        log_action("修改功能", "、".join(changed))
    return {"ok": True, "msg": "功能设置已保存"}


# ---------------------------------------------------------------- config
def load_config():
    global _config
    if _config is None:
        if CONFIG_PATH.exists():
            _config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        else:
            _config = {}
    return _config


MODULE_LIST = ["ftp", "cron", "monitor", "logs"]
MODULE_NAMES = {"ftp": "FTP 管理", "cron": "计划任务", "monitor": "监控看板", "logs": "操作日志"}
MODULE_DESC = {
    "ftp": "内置 FTP 服务端（端口 21）与账号管理，占用少量系统资源",
    "cron": "计划任务调度器（Shell 命令 / 访问 URL），默认不消耗资源",
    "monitor": "监控数据采样线程 + 监控图表 + 概览页实时流量",
    "logs": "关键操作日志记录（建站、删站、文件增删改、FTP 等）",
}


def module_enabled(name):
    cfg = load_config()
    return bool((cfg.get("modules") or {}).get(name))


def api_modules():
    return {m: module_enabled(m) for m in MODULE_LIST}


def set_modules(data):
    mods = data or {}
    cfg = load_config()
    cur = dict(cfg.get("modules") or {})
    for m in MODULE_LIST:
        if m in mods:
            cur[m] = bool(mods[m])
    cfg["modules"] = cur
    save_config(cfg)
    log_action("修改模块", ", ".join("%s:%s" % (m, "开" if module_enabled(m) else "关") for m in MODULE_LIST))
    if os.path.exists(SERVICE_FILE):
        def _delayed_restart():
            time.sleep(1.5)
            run(["systemctl", "restart", "qingliang"], timeout=30)
        threading.Thread(target=_delayed_restart, daemon=True).start()
        return {"ok": True, "restart": True, "msg": "模块配置已保存，面板即将重启（约 2 秒），请稍候重新登录"}
    return {"ok": True, "restart": False, "msg": "模块配置已保存（手动重启后生效）"}


def save_config(cfg):
    global _config
    _config = cfg
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass


def load_meta():
    global _meta
    if _meta is None:
        if META_PATH.exists():
            try:
                _meta = json.loads(META_PATH.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                _meta = {}
        else:
            _meta = {}
    return _meta


def save_meta(m):
    global _meta
    _meta = m
    try:
        META_PATH.write_text(json.dumps(m, indent=2, ensure_ascii=False), encoding="utf-8")
        os.chmod(META_PATH, 0o600)
    except OSError:
        pass


def ensure_init():
    cfg = load_config()
    if not cfg.get("username"):
        cfg["username"] = DEFAULT_USER
        cfg["password"] = DEFAULT_PASS
        cfg["password_hash"] = hash_password(DEFAULT_PASS)
        cfg["token_secret"] = secrets.token_hex(32)
        save_config(cfg)
        print("=" * 60)
        print("PANEL FIRST RUN: username = %s, password = %s" % (DEFAULT_USER, DEFAULT_PASS))
        print("Please login and change the password immediately.")
        print("=" * 60)
    cfg.setdefault("modules", {})
    cfg.setdefault("features", {})
    save_config(cfg)
    ensure_error_pages()


def hash_password(pw):
    return hashlib.sha256(("panel::" + pw).encode()).hexdigest()


def verify_login(user, pw):
    cfg = load_config()
    return user == cfg.get("username", "") and hmac.compare_digest(hash_password(pw), cfg.get("password_hash", ""))


def make_token():
    tok = secrets.token_urlsafe(32)
    tokens[tok] = time.time() + TOKEN_TTL
    return tok


def check_token(tok):
    exp = tokens.get(tok)
    if not exp:
        return False
    if time.time() > exp:
        tokens.pop(tok, None)
        return False
    return True


def rate_limited(ip):
    f = failures.get(ip, 0)
    if f >= 5 and time.time() - failures.get(ip + "_t", 0) < 900:
        return True
    return False


def record_failure(ip):
    failures[ip] = failures.get(ip, 0) + 1
    failures[ip + "_t"] = time.time()


def clear_failures(ip):
    failures.pop(ip, None)
    failures.pop(ip + "_t", None)


def safe_path(raw):
    p = urllib.parse.unquote(raw)
    path = os.path.realpath(p)
    for root in ALLOWED_ROOTS:
        r = os.path.realpath(root)
        if path == r or path.startswith(r + os.sep):
            return path
    return None


def run(cmd, timeout=180, input_data=None):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, input=input_data)
        return {"code": p.returncode, "out": p.stdout[-6000:], "err": p.stderr[-6000:]}
    except subprocess.TimeoutExpired:
        return {"code": -1, "out": "", "err": "command timed out"}
    except FileNotFoundError:
        return {"code": -1, "out": "", "err": "command not found: " + str(cmd[0])}
    except Exception as e:
        return {"code": -1, "out": "", "err": str(e)}


def fmt_bytes(n):
    units = ["B", "KB", "MB", "GB", "TB"]
    n = float(n or 0)
    i = 0
    while n >= 1024 and i < len(units) - 1:
        n /= 1024
        i += 1
    return ("%.1f" % n if i else "%d" % n) + units[i]


# ---------------------------------------------------------------- nginx
def nginx_dirs():
    avail = "/etc/nginx/sites-available"
    enabled = "/etc/nginx/sites-enabled"
    if os.path.isdir(avail) and os.path.isdir(enabled):
        return avail, enabled
    confd = "/etc/nginx/conf.d"
    if os.path.isdir(confd):
        return confd, confd
    os.makedirs(avail, exist_ok=True)
    os.makedirs(enabled, exist_ok=True)
    return avail, enabled


def conf_path(name):
    avail, _ = nginx_dirs()
    return os.path.join(avail, name + ".conf")


def _parse_conf(conf):
    m = {}
    doms = []
    for d in re.findall(r"(?:ssl_)?server_name\s+([^;]+);", conf):
        doms.extend(d.replace(",", " ").split())
    seen = set()
    dedup = []
    for d in doms:
        if d not in ("_", "localhost") and d not in seen:
            seen.add(d)
            dedup.append(d)
    m["domains"] = dedup
    ports = [int(p) for p in re.findall(r"listen\s+(\d+)", conf)]
    m["port"] = 443 if 443 in ports else (ports[0] if ports else 80)
    root_m = re.search(r"root\s+([^;]+);", conf)
    m["root"] = root_m.group(1).strip() if root_m else ""
    idx_m = re.search(r"index\s+([^;]+);", conf)
    m["default_doc"] = idx_m.group(1).strip() if idx_m else "index.html index.htm index.php"
    m["ssl"] = {
        "enabled": bool(re.search(r"(ssl_certificate|listen\s+443|ssl\s+on)", conf)),
        "cert_path": "",
        "key_path": "",
    }
    cm = re.search(r"ssl_certificate\s+([^;]+);", conf)
    km = re.search(r"ssl_certificate_key\s+([^;]+);", conf)
    if cm:
        m["ssl"]["cert_path"] = cm.group(1).strip()
    if km:
        m["ssl"]["key_path"] = km.group(1).strip()
    co = re.search(r"add_header\s+Access-Control-Allow-Origin\s+([^;]+);", conf)
    origin = co.group(1).strip() if co else "*"
    if origin.endswith(" always"):
        origin = origin[:-7].strip()
    m["cors"] = {"enabled": bool(co), "origin": origin}
    vr = re.search(r"valid_referers\s+[^;]*server_names\s+([^;]+);", conf)
    m["hotlink"] = {"enabled": bool(vr), "referers": vr.group(1).split() if vr else []}
    m["error_pages"] = {}
    for ep in re.findall(r"error_page\s+(\d{3})\s+([^;]+);", conf):
        code, target = ep
        m["error_pages"][code] = target.strip()
    m["redirects"] = []
    for loc in re.findall(r"location\s*=\s*(\S+)\s*\{\s*return\s+(\d+)\s+(\S+);", conf):
        m["redirects"].append({"path": loc[0].lstrip("/"), "target": loc[2], "code": int(loc[1])})
    m["protect"] = []
    for loc in re.findall(r"location\s*\^\~\s*(\S+)\s*\{\s*deny all;", conf):
        m["protect"].append(loc.lstrip("/"))
    m["runtime"] = "php" if re.search(r"fastcgi_pass\s+[^;]*fpm", conf) else "static"
    m["enabled"] = True
    return m


def _safe_domain_list(domains):
    out = []
    for d in domains or []:
        d = d.strip().lower()
        if re.fullmatch(r"[a-z0-9.*\-]+(?:\.[a-z0-9*.\-]+)+", d) or d == "_":
            out.append(d)
    return out


def render_site_conf(name, m):
    domains = _safe_domain_list(m.get("domains"))
    srv = " ".join(domains) if domains else "_"
    root = (m.get("root") or (SITE_ROOT + "/" + name)).rstrip("/")
    index = m.get("default_doc") or "index.html index.htm index.php"
    ssl = m.get("ssl") or {}
    ssl_on = bool(ssl.get("enabled") and ssl.get("cert_path"))
    zone = re.sub(r"[^a-zA-Z0-9_]", "_", name) or "ql"
    access = "/var/log/nginx/%s.access.log" % name
    error = "/var/log/nginx/%s.error.log" % name
    cors = m.get("cors") or {}
    hotlink = m.get("hotlink") or {}
    error_pages = m.get("error_pages") or {}
    redirects = m.get("redirects") or []
    protect = m.get("protect") or []

    def build_server(tls):
        port = int(m.get("port") or 80)
        lines = ["server {"]
        def_listen = " default_server" if (not domains and port in (80, 443)) else ""
        if tls:
            lines.append("    listen %d ssl%s;" % (port, def_listen))
            lines.append("    listen [::]:%d ssl%s;" % (port, def_listen))
            lines.append("    ssl_certificate %s;" % ssl["cert_path"])
            lines.append("    ssl_certificate_key %s;" % ssl["key_path"])
            lines.append("    ssl_protocols TLSv1.2 TLSv1.3;")
            lines.append("    ssl_ciphers HIGH:!aNULL:!MD5;")
            lines.append("    ssl_session_cache shared:%s:10m;" % zone)
        else:
            lines.append("    listen %d%s;" % (port, def_listen))
            lines.append("    listen [::]:%d%s;" % (port, def_listen))
        lines.append("    server_name %s;" % srv)
        if not tls and ssl_on:
            lines.append("    return 301 https://$host:$server_port$request_uri;")
            lines.append("}")
            return "\n".join(lines)
        if cors.get("enabled"):
            lines.append("    add_header Access-Control-Allow-Origin %s always;" % (cors.get("origin") or "*"))
            lines.append("    add_header Access-Control-Allow-Methods \"GET, POST, PUT, DELETE, OPTIONS\" always;")
            lines.append("    add_header Access-Control-Allow-Headers \"Content-Type, Authorization\" always;")
        if hotlink.get("enabled"):
            refs = " ".join(hotlink.get("referers") or [])
            lines.append("    valid_referers none blocked server_names %s;" % refs)
            lines.append("    if ($invalid_referer) { return 403; }")
        for code in ERROR_CODES:
            target = error_pages.get(code)
            if target and str(target).startswith("/") and not str(target).startswith("/panel-err/"):
                if os.path.isfile(os.path.join(root, code + ".html")):
                    lines.append("    error_page %s /%s.html;" % (code, code))
                else:
                    lines.append("    error_page %s /panel-err/%s.html;" % (code, code))
            elif target:
                lines.append("    error_page %s %s;" % (code, target))
            else:
                lines.append("    error_page %s /panel-err/%s.html;" % (code, code))
        lines.append("    location ^~ /panel-err/ {")
        lines.append("        alias %s/;" % ERROR_PAGE_DIR)
        lines.append("    }")
        lines.append("    root %s;" % root)
        lines.append("    index %s;" % index)
        for r in redirects:
            rpath = r.get("path", "").lstrip("/")
            lines.append("    location = /%s { return %s %s; }" % (rpath, r.get("code", 301), r.get("target", "/")))
        for p in protect:
            pp = p.strip().lstrip("/")
            lines.append("    location ^~ /%s { deny all; return 403; }" % pp)
        if m.get("runtime") == "php":
            lines.append("    location ~ \\.php$ {")
            lines.append("        include snippets/fastcgi-php.conf;")
            lines.append("        fastcgi_pass unix:%s;" % APPS["php82"]["fpm_socket"])
            lines.append("    }")
        lines.append("    location / {")
        lines.append("        try_files $uri $uri/ =404;")
        lines.append("    }")
        lines.append("    access_log %s;" % access)
        lines.append("    error_log %s;" % error)
        lines.append("}")
        return "\n".join(lines)

    if ssl_on:
        return build_server(False) + "\n" + build_server(True)
    return build_server(False)


def list_sites():
    avail, enabled = nginx_dirs()
    sites = []
    meta = load_meta()
    try:
        entries = os.listdir(avail)
    except OSError:
        return sites
    for fn in sorted(entries):
        if not fn.endswith(".conf"):
            continue
        name = fn[:-5]
        p = conf_path(name)
        try:
            conf = open(p, encoding="utf-8").read()
        except OSError:
            continue
        m = _parse_conf(conf)
        m["name"] = name
        m["note"] = (meta.get(name) or {}).get("note", "")
        enabled_path = os.path.join(enabled, fn) if enabled != avail else p
        m["enabled"] = os.path.exists(enabled_path)
        m["ssl"] = ssl_info(m["ssl"])
        root = m.get("root", "")
        if root and os.path.isdir(root):
            r = run(["du", "-sh", root], timeout=10)
            m["disk_usage"] = r["out"].split()[0] if r["out"] else "-"
        else:
            m["disk_usage"] = "-"
        m["daily_traffic"] = daily_traffic(name)
        sites.append(m)
    return sites


def get_site(name):
    p = conf_path(name)
    if not os.path.exists(p):
        return None
    m = _parse_conf(open(p, encoding="utf-8").read())
    m["name"] = name
    m["note"] = (load_meta().get(name) or {}).get("note", "")
    m["ssl"] = ssl_info(m["ssl"])
    return m


def _write_site_conf(name, m):
    p = conf_path(name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(render_site_conf(name, m))
    if not _safe_domain_list(m.get("domains")):
        _strip_other_default_servers(name, _valid_port(m.get("port")) or 80)
    avail, enabled = nginx_dirs()
    if enabled != avail:
        link = os.path.join(enabled, name + ".conf")
        if not os.path.exists(link):
            os.symlink(p, link)


def regen_all_site_confs():
    """Rebuild site nginx confs from meta on startup so template changes
    (e.g. global error pages) apply to existing sites."""
    try:
        avail, enabled = nginx_dirs()
    except OSError:
        return
    for s in list_sites():
        try:
            _write_site_conf(s["name"], s)
            if enabled != avail:
                link = os.path.join(enabled, s["name"] + ".conf")
                if s.get("enabled"):
                    if not os.path.exists(link):
                        os.symlink(conf_path(s["name"]), link)
                elif os.path.lexists(link):
                    os.remove(link)
        except OSError:
            continue


def nginx_test_reload():
    r = run(["nginx", "-t"])
    if r["code"] != 0:
        return {"ok": False, "msg": "nginx 配置测试失败", "detail": r["err"] or r["out"]}
    r2 = run(["systemctl", "reload", "nginx"])
    if r2["code"] != 0:
        return {"ok": False, "msg": "nginx 重载失败", "detail": r2["err"] or r2["out"]}
    return {"ok": True, "msg": "nginx reloaded"}


def default_index(name, domain=""):
    return (
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n"
        "<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        "<title>__SITE__ - 轻壳面板</title>\n"
        "<style>\n"
        "* { margin:0; padding:0; box-sizing:border-box; }\n"
        "body { font-family:-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif; "
        "min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; "
        "background:linear-gradient(160deg,#eaf6ff 0%,#f0fbf8 50%,#e8f7f0 100%); }\n"
        ".card { width:100%; max-width:520px; background:rgba(255,255,255,.85); "
        "backdrop-filter:blur(14px); border:1px solid rgba(45,162,213,.15); border-radius:20px; "
        "padding:48px 36px; text-align:center; "
        "box-shadow:0 20px 50px -20px rgba(37,150,190,.25); }\n"
        ".logo { width:72px; height:72px; margin:0 auto 20px; border-radius:22px; color:#fff; "
        "font-size:34px; font-weight:700; display:flex; align-items:center; justify-content:center; "
        "background:linear-gradient(135deg,#34d0c9,#22b8cf); box-shadow:0 12px 24px -8px rgba(34,184,207,.5); }\n"
        "h1 { font-size:28px; color:#0f3b4d; font-weight:600; word-break:break-all; }\n"
        ".domain { margin-top:8px; font-size:15px; color:#2ba8c4; font-weight:500; word-break:break-all; }\n"
        ".line { width:56px; height:3px; border-radius:2px; margin:22px auto; "
        "background:linear-gradient(90deg,#34d0c9,#22b8cf); }\n"
        "p { color:#5b7a88; font-size:14px; line-height:1.9; }\n"
        ".badge { display:inline-block; margin-top:22px; padding:7px 18px; border-radius:999px; "
        "background:rgba(34,184,207,.12); color:#177e96; font-size:12px; font-weight:600; }\n"
        "@media (max-width:480px) { .card { padding:36px 22px; } h1 { font-size:22px; } }\n"
        "</style>\n</head>\n<body>\n"
        "<div class=\"card\">\n"
        "<div class=\"logo\">轻</div>\n"
        "<h1>__SITE__</h1>\n"
        "<div class=\"domain\">__DOMAIN__</div>\n"
        "<div class=\"line\"></div>\n"
        "<p>网站已创建成功，由轻壳面板托管。<br>通过轻壳面板即可管理网站、文件、域名与 SSL 证书。</p>\n"
        "<span class=\"badge\">由轻壳面板 Qingke Panel 提供支持</span>\n"
        "</div>\n</body>\n</html>\n"
    ).replace("__SITE__", html.escape(name)).replace("__DOMAIN__", html.escape(domain or "未绑定域名"))


def default_error_page(code, name):
    title = {"403": "Forbidden", "404": "Not Found", "500": "Internal Server Error",
             "502": "Bad Gateway", "503": "Service Unavailable", "504": "Gateway Timeout"}.get(code, "Error")
    return (
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
        "<title>%s %s</title>\n<style>body{font-family:sans-serif;text-align:center;padding:60px 20px;color:#333} "
        "h1{font-size:72px;margin:0;color:#2563eb}h2{font-weight:400;color:#666}</style>\n</head>\n<body>\n"
        "<h1>%s</h1>\n<h2>%s · %s</h2>\n</body>\n</html>\n" % (code, title, code, title, name)
    )


def _valid_port(p):
    try:
        p = int(p)
    except (TypeError, ValueError):
        return None
    if 1 <= p <= 65535:
        return p
    return None


def _strip_other_default_servers(keep_name, port):
    avail, enabled = nginx_dirs()
    try:
        entries = os.listdir(enabled)
    except OSError:
        return
    for fn in entries:
        if fn == keep_name + ".conf" or fn == keep_name:
            continue
        fp = os.path.join(enabled, fn)
        try:
            content = open(fp, encoding="utf-8").read()
        except OSError:
            continue
        if "default_server" not in content:
            continue
        pat = r"listen\s+\[[^\]]*\]?\s*:%d[^;]*\bdefault_server\b|listen\s+%d[^;]*\bdefault_server\b" % (port, port)
        if not re.search(pat, content):
            continue
        new = re.sub(r"\s*default_server", "", content)
        try:
            open(fp, "w", encoding="utf-8").write(new)
        except OSError:
            pass


def _port_conflict(name, port, domains):
    if _safe_domain_list(domains):
        return ""
    for s in list_sites():
        if s["name"] == name:
            continue
        if s.get("port") == port and not s["domains"]:
            return "端口 %d 已被无域名站点 %s 占用，请换一个端口" % (port, s["name"])
    return ""


def create_site(name, domains, root, note="", port=80, runtime="static"):
    if not re.fullmatch(r"[a-zA-Z0-9_\u4e00-\u9fff.\-]{1,64}", name or ""):
        return {"ok": False, "msg": "invalid site name"}
    if conf_path(name) and os.path.exists(conf_path(name)):
        return {"ok": False, "msg": "site already exists"}
    port = _valid_port(port) or 80
    conflict = _port_conflict(name, port, domains)
    if conflict:
        return {"ok": False, "msg": conflict}
    runtime = runtime if runtime in ("static", "php") else "static"
    if runtime == "php":
        if not feature_enabled("php"):
            return {"ok": False, "msg": "PHP 支持未开启，请在 设置 → 功能开关 中开启"}
        if not os.path.exists(APPS["php82"]["fpm_socket"]):
            return {"ok": False, "msg": "PHP 8.2 未安装或 php-fpm 未运行，请先在应用市场安装 PHP 8.2"}
    if root and (root.startswith("/") or re.match(r"^[A-Za-z]:[\\/]", root)):
        rp = root
    elif root:
        rp = SITE_ROOT + "/" + root
    else:
        dl = _safe_domain_list(domains)
        if dl:
            rp = SITE_ROOT + "/" + re.sub(r"[^a-zA-Z0-9_\-]", "", dl[0]).replace(".", "")
        else:
            rp = SITE_ROOT + "/DK%d" % port
    rp = posixpath.normpath(rp).rstrip("/")
    if not rp.startswith(SITE_ROOT):
        return {"ok": False, "msg": "root must be under %s" % SITE_ROOT}
    root = rp
    os.makedirs(root, exist_ok=True)
    index = os.path.join(root, "index.html")
    if not os.path.exists(index):
        with open(index, "w", encoding="utf-8") as f:
            f.write(default_index(name, _safe_domain_list(domains)[0] if _safe_domain_list(domains) else ""))
    m = {
        "name": name, "domains": _safe_domain_list(domains), "root": root,
        "port": port, "runtime": runtime,
        "default_doc": "index.html index.htm index.php",
        "ssl": {"enabled": False, "cert_path": "", "key_path": ""},
        "cors": {"enabled": False, "origin": "*"},
        "hotlink": {"enabled": False, "referers": []},
        "error_pages": {}, "redirects": [], "protect": [], "enabled": True,
    }
    _write_site_conf(name, m)
    if note:
        meta = load_meta()
        meta.setdefault(name, {})["note"] = note
        save_meta(meta)
    log_action("创建网站", "%s 端口:%s 域名:%s" % (name, port, ",".join(_safe_domain_list(domains)) or "-"))
    return nginx_test_reload()


def delete_site(name, keep_files):
    avail, enabled = nginx_dirs()
    p = conf_path(name)
    root = ""
    if os.path.exists(p):
        try:
            m = _parse_conf(open(p, encoding="utf-8").read())
            root = (m.get("root") or (SITE_ROOT + "/" + name)).rstrip("/")
        except Exception:
            root = (SITE_ROOT + "/" + name).rstrip("/")
    if enabled != avail:
        link = os.path.join(enabled, name + ".conf")
        if os.path.exists(link):
            os.remove(link)
    if os.path.exists(p):
        os.remove(p)
    meta = load_meta()
    if name in meta:
        del meta[name]
        save_meta(meta)
    res = nginx_test_reload()
    if not keep_files:
        if root and os.path.isdir(root) and root.startswith(SITE_ROOT + "/") and os.path.realpath(root) != os.path.realpath(SITE_ROOT):
            shutil.rmtree(root, ignore_errors=True)
    log_action("删除网站", name + ("" if keep_files else "（含目录）"))
    return res


def update_site(name, data):
    p = conf_path(name)
    if not os.path.exists(p):
        return {"ok": False, "msg": "site config not found"}
    old_conf = open(p, encoding="utf-8").read()
    m = _parse_conf(open(p, encoding="utf-8").read())
    if "port" in data:
        port = _valid_port(data["port"])
        if not port:
            return {"ok": False, "msg": "invalid port"}
        m["port"] = port
    if "domains" in data:
        m["domains"] = _safe_domain_list(data["domains"])
    conflict = _port_conflict(name, m["port"], m["domains"])
    if conflict:
        return {"ok": False, "msg": conflict}
    if "default_doc" in data and data["default_doc"]:
        m["default_doc"] = data["default_doc"].strip()
    if "cors" in data:
        c = data["cors"]
        m["cors"] = {"enabled": bool(c.get("enabled")), "origin": c.get("origin") or "*"}
    if "hotlink" in data:
        h = data["hotlink"]
        m["hotlink"] = {"enabled": bool(h.get("enabled")),
                        "referers": _safe_domain_list(h.get("referers"))}
    if "error_pages" in data:
        eps = {}
        for code, on in (data["error_pages"] or {}).items():
            if on:
                eps[code] = "/%s.html" % code
        m["error_pages"] = eps
    if "redirects" in data:
        rds = []
        for r in data["redirects"] or []:
            if r.get("path") and r.get("target"):
                rds.append({"path": str(r["path"]).strip(),
                            "target": str(r["target"]).strip(),
                            "code": int(r.get("code", 301) or 301)})
        m["redirects"] = rds
    if "protect" in data:
        m["protect"] = [x.strip() for x in (data["protect"] or []) if x.strip()]
    if "runtime" in data:
        rt = data["runtime"]
        if rt not in ("static", "php"):
            return {"ok": False, "msg": "invalid runtime"}
        if rt == "php":
            if not feature_enabled("php"):
                return {"ok": False, "msg": "PHP 支持未开启，请在 设置 → 功能开关 中开启"}
            if not os.path.exists(APPS["php82"]["fpm_socket"]):
                return {"ok": False, "msg": "PHP 8.2 未安装或 php-fpm 未运行，请先在应用市场安装 PHP 8.2"}
        m["runtime"] = rt
    if "note" in data:
        meta = load_meta()
        meta.setdefault(name, {})["note"] = data["note"]
        save_meta(meta)
    _write_site_conf(name, m)

    if m["error_pages"]:
        root = m.get("root") or (SITE_ROOT + "/" + name)
        os.makedirs(root, exist_ok=True)
        for code in m["error_pages"]:
            fp = os.path.join(root, "%s.html" % code)
            if not os.path.exists(fp):
                with open(fp, "w", encoding="utf-8") as f:
                    f.write(default_error_page(code, name))
    res = nginx_test_reload()
    if not res["ok"]:
        try:
            open(p, "w", encoding="utf-8").write(old_conf)
        except OSError:
            pass
        res["msg"] = "配置保存失败（已回滚）：" + res["msg"]
        return res
    if res["ok"]:
        res["site"] = get_site(name)
    return res


def bind_domains(name, domains):
    return update_site(name, {"domains": domains})


# ---------------------------------------------------------------- ssl
def ssl_info(s):
    s = dict(s or {})
    s["enabled"] = bool(s.get("enabled") and s.get("cert_path"))
    s["expiry"] = None
    s["days_left"] = None
    if s.get("cert_path") and os.path.exists(s["cert_path"]):
        r = run(["openssl", "x509", "-enddate", "-noout", "-in", s["cert_path"]], timeout=10)
        mm = re.search(r"notAfter=(\w{3})\s+(\d+)\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})", r["out"])
        if mm:
            mon = {"Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
                   "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12}
            try:
                exp = datetime.datetime(int(mm.group(6)), mon[mm.group(1)], int(mm.group(2)),
                                        int(mm.group(3)), int(mm.group(4)), int(mm.group(5)))
                s["expiry"] = exp.strftime("%Y-%m-%d %H:%M")
                s["days_left"] = (exp - datetime.datetime.now()).days
            except (ValueError, KeyError):
                pass
    return s


def issue_ssl(name, domain, email):
    p = conf_path(name)
    if not os.path.exists(p):
        return {"ok": False, "msg": "site config not found"}
    cmd = ["certbot", "--nginx", "-d", domain, "--redirect", "--non-interactive",
           "--agree-tos", "-m", email, "--no-eff-email", "--nginx-server-root", "/etc/nginx"]
    r = run(cmd, timeout=300)
    ok = r["code"] == 0
    if not ok:
        return {"ok": False, "msg": "证书申请失败", "detail": (r["err"] or r["out"])[-3000:]}
    res = nginx_test_reload()
    res["msg"] = "SSL issued and nginx reloaded"
    res["detail"] = r["out"][-2000:]
    return res


def upload_ssl(name, cert, key):
    if not name or not cert or not key:
        return {"ok": False, "msg": "证书和私钥内容不能为空"}
    os.makedirs(SSL_DIR, exist_ok=True)
    cert_path = str(SSL_DIR / (name + ".crt"))
    key_path = str(SSL_DIR / (name + ".key"))
    with open(cert_path, "w", encoding="utf-8") as f:
        f.write(cert)
    with open(key_path, "w", encoding="utf-8") as f:
        f.write(key)
    try:
        os.chmod(key_path, 0o600)
    except OSError:
        pass
    p = conf_path(name)
    if not os.path.exists(p):
        return {"ok": True, "msg": "证书文件已保存（未找到站点配置）"}
    old_conf = open(p, encoding="utf-8").read()
    m = _parse_conf(old_conf)
    m["ssl"]["enabled"] = True
    m["ssl"]["cert_path"] = cert_path
    m["ssl"]["key_path"] = key_path
    _write_site_conf(name, m)
    res = nginx_test_reload()
    if not res["ok"]:
        try:
            open(p, "w", encoding="utf-8").write(old_conf)
        except OSError:
            pass
        res["msg"] = "证书应用失败（配置已回滚，SSL 未启用）：" + res["msg"]
        return res
    res["site"] = get_site(name)
    return res


def ssl_files(name):
    cert = key = ""
    try:
        cp = str(SSL_DIR / (name + ".crt"))
        kp = str(SSL_DIR / (name + ".key"))
        if os.path.exists(cp):
            cert = open(cp, encoding="utf-8").read()
        if os.path.exists(kp):
            key = open(kp, encoding="utf-8").read()
    except OSError:
        pass
    return {"ok": True, "cert": cert, "key": key}


def renew_ssl():
    r = run(["certbot", "renew", "--nginx", "--non-interactive"], timeout=600)
    return {"ok": r["code"] == 0, "msg": "renew finished", "detail": (r["err"] or r["out"])[-3000:]}


# ---------------------------------------------------------------- file ops
def log_action(action, detail=""):
    if not module_enabled("logs"):
        return
    try:
        with open(ACTION_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "time": int(time.time()),
                "action": action,
                "detail": detail,
            }, ensure_ascii=False) + "\n")
    except OSError:
        pass


def list_actions(limit=200):
    out = []
    try:
        with open(ACTION_LOG, "r", encoding="utf-8") as f:
            lines = f.readlines()
        for ln in lines[-limit:]:
            try:
                out.append(json.loads(ln))
            except (ValueError, TypeError):
                continue
    except OSError:
        pass
    out.reverse()
    return out


def fs_list(path):
    path = safe_path(path or SITE_ROOT)
    if not path:
        return None
    if not os.path.isdir(path):
        return {"error": "not a directory"}
    out = []
    for name in sorted(os.listdir(path)):
        full = os.path.join(path, name)
        try:
            st = os.stat(full)
            out.append({
                "name": name,
                "type": "dir" if os.path.isdir(full) else "file",
                "size": st.st_size if os.path.isfile(full) else None,
                "mtime": int(st.st_mtime),
            })
        except OSError:
            continue
    return {"path": path, "entries": out}


def fs_read(path):
    path = safe_path(path)
    if not path:
        return None
    if not os.path.isfile(path):
        return {"error": "not a file"}
    size = os.path.getsize(path)
    if size > READ_LIMIT:
        return {"error": "file too large (%d bytes)" % size}
    with open(path, encoding="utf-8", errors="replace") as f:
        return {"path": path, "size": size, "content": f.read()}


def fs_write(path, content):
    path = safe_path(path)
    if not path:
        return None
    if os.path.isdir(path):
        return {"error": "path is a directory"}
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    log_action("创建文件", path)
    return {"ok": True, "path": path}


def fs_related(path):
    p = str(path or "").strip().rstrip("/")
    if not p or not p.startswith(SITE_ROOT):
        return {"ok": False, "msg": "invalid path"}
    ftp_hits = []
    for a in list_ftp():
        r = (a.get("root") or a.get("home") or "").rstrip("/")
        if r and (r == p or r.startswith(p + "/")):
            ftp_hits.append(a["user"])
    site_hits = []
    try:
        avail, _ = nginx_dirs()
        for fn in sorted(os.listdir(avail)):
            if not fn.endswith(".conf"):
                continue
            try:
                conf = open(os.path.join(avail, fn), encoding="utf-8").read()
            except OSError:
                continue
            m = _parse_conf(conf)
            r = str(m.get("root") or "").rstrip("/")
            if r and (r == p or r.startswith(p + "/")):
                site_hits.append(fn[:-5])
    except OSError:
        pass
    return {"ok": True, "path": p, "ftp": ftp_hits, "sites": site_hits}


def fs_delete(paths, recursive):
    deleted = []
    for raw in paths or []:
        path = safe_path(raw)
        if not path:
            continue
        if path in ALLOWED_ROOTS or os.path.realpath(path) == os.path.realpath(SITE_ROOT):
            continue
        if os.path.isdir(path):
            if not recursive:
                continue
            shutil.rmtree(path, ignore_errors=True)
        elif os.path.isfile(path):
            os.remove(path)
        deleted.append(path)
    if deleted:
        log_action("删除文件", ", ".join(deleted))
    return {"ok": True, "deleted": deleted}


def fs_mkdir(path):
    path = safe_path(path)
    if not path:
        return None
    os.makedirs(path, exist_ok=True)
    log_action("创建目录", path)
    return {"ok": True}


def fs_rename(path, new_name):
    path = safe_path(path)
    if not path:
        return None
    new_name = os.path.basename(new_name or "")
    if not new_name:
        return {"error": "invalid name"}
    npath = os.path.join(os.path.dirname(path), new_name)
    npath = safe_path(npath)
    if not npath:
        return None
    if os.path.exists(npath):
        return {"error": "target already exists"}
    os.rename(path, npath)
    log_action("重命名", "%s → %s" % (path, npath))
    return {"ok": True, "path": npath}


def fs_copy(src_paths, dest):
    dest = safe_path(dest)
    if not dest:
        return None
    if not os.path.isdir(dest):
        return {"error": "dest not a directory"}
    for raw in src_paths or []:
        path = safe_path(raw)
        if not path:
            continue
        target = os.path.join(dest, os.path.basename(path))
        if os.path.isdir(path):
            shutil.copytree(path, target, dirs_exist_ok=True)
        elif os.path.isfile(path):
            shutil.copy2(path, target)
    if src_paths:
        log_action("复制文件", ", ".join(src_paths) + " → " + dest)
    return {"ok": True}


def fs_move(src_paths, dest):
    dest = safe_path(dest)
    if not dest:
        return None
    if not os.path.isdir(dest):
        return {"error": "dest not a directory"}
    for raw in src_paths or []:
        path = safe_path(raw)
        if not path:
            continue
        if os.path.realpath(os.path.dirname(path)) == os.path.realpath(dest):
            continue
        target = os.path.join(dest, os.path.basename(path))
        shutil.move(path, target)
    if src_paths:
        log_action("移动文件", ", ".join(src_paths) + " → " + dest)
    return {"ok": True}


def fs_zip(paths, target):
    target = safe_path(target)
    if not target:
        return None
    if os.path.exists(target):
        return {"error": "target zip already exists"}
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as zf:
        for raw in paths or []:
            path = safe_path(raw)
            if not path:
                continue
            base = os.path.basename(path)
            if os.path.isdir(path):
                for root, dirs, files in os.walk(path):
                    for fn in files:
                        full = os.path.join(root, fn)
                        arc = os.path.join(base, os.path.relpath(full, path))
                        zf.write(full, arc)
            elif os.path.isfile(path):
                zf.write(path, base)
    log_action("压缩文件", " → " + target)
    return {"ok": True, "path": target}


def fs_unzip(path, target):
    path = safe_path(path)
    target = safe_path(target)
    if not path or not target:
        return None
    if not os.path.isfile(path) or not path.endswith(".zip"):
        return {"error": "not a zip file"}
    os.makedirs(target, exist_ok=True)
    with zipfile.ZipFile(path) as zf:
        for info in zf.infolist():
            dest = os.path.realpath(os.path.join(target, info.filename))
            if not dest.startswith(os.path.realpath(target) + os.sep) and dest != os.path.realpath(target):
                continue
            if info.is_dir():
                os.makedirs(dest, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(info) as src, open(dest, "wb") as dst:
                    dst.write(src.read())
    log_action("解压文件", path + " → " + target)
    return {"ok": True}


def fs_download(path):
    path = safe_path(path)
    if not path or not os.path.isfile(path):
        return None
    return path


def release_resources():
    msgs = []
    try:
        if os.path.exists("/proc/sys/vm/drop_caches"):
            run(["sync"], timeout=20)
            run(["sh", "-c", "echo 3 > /proc/sys/vm/drop_caches"], timeout=10)
            msgs.append("内存缓存已释放")
        else:
            msgs.append("当前环境不支持 drop_caches")
    except OSError:
        msgs.append("内存缓存清理失败")
    try:
        r = run(["find", "/var/log/nginx", "-name", "*.log", "-size", "+100M"], timeout=10)
        big = [ln for ln in r["out"].splitlines() if ln.strip()]
        if big:
            run(["sh", "-c", " > ".join(big[:1])], timeout=10)
            msgs.append("已清空超大日志 1 个")
    except OSError:
        pass
    return {"ok": True, "msg": "资源释放完成", "detail": msgs}


def fs_chmod(path, mode):
    path = safe_path(path)
    if not path or not os.path.exists(path):
        return None
    try:
        m = int(mode, 8) if isinstance(mode, str) else int(mode)
    except (ValueError, TypeError):
        return {"error": "invalid mode"}
    if m < 0 or m > 0o7777:
        return {"error": "invalid mode"}
    os.chmod(path, m)
    return {"ok": True, "path": path, "mode": oct(m & 0o7777)}


# ---------------------------------------------------------------- stats
def stats():
    out = {}
    try:
        with open("/proc/stat") as f:
            parts = f.readline().split()
        vals = list(map(int, parts[1:8]))
        idle = vals[3] + vals[4]
        total = sum(vals) or 1
        out["cpu"] = round((1 - idle / total) * 100, 1)
    except (OSError, ValueError, IndexError):
        out["cpu"] = 0

    mem = {}
    try:
        for line in open("/proc/meminfo", encoding="utf-8"):
            k, v = line.split(":", 1)
            mem[k] = int(v.split()[0])
        out["mem_total"] = mem.get("MemTotal", 0) * 1024
        out["mem_avail"] = mem.get("MemAvailable", 0) * 1024
    except (OSError, ValueError):
        out["mem_total"] = out["mem_avail"] = 0

    try:
        if hasattr(os, "statvfs"):
            d = os.statvfs("/")
            out["disk_total"] = d.f_blocks * d.f_frsize
            out["disk_free"] = d.f_bavail * d.f_frsize
        else:
            out["disk_total"] = out["disk_free"] = 0
    except OSError:
        out["disk_total"] = out["disk_free"] = 0

    try:
        out["load"] = [float(x) for x in open("/proc/loadavg").read().split()[:3]]
    except OSError:
        out["load"] = [0, 0, 0]

    try:
        out["uptime"] = float(open("/proc/uptime").read().split()[0])
    except OSError:
        out["uptime"] = 0

    try:
        out["procs"] = sum(1 for e in os.listdir("/proc") if e.isdigit())
    except OSError:
        out["procs"] = 0

    rx = tx = 0
    try:
        for line in open("/proc/net/dev", encoding="utf-8"):
            if ":" in line:
                iface, data = line.split(":")
                if iface.strip() == "lo":
                    continue
                f = data.split()
                rx += int(f[0])
                tx += int(f[8])
    except (OSError, ValueError):
        pass
    out["net_rx"] = rx
    out["net_tx"] = tx

    out["nginx"] = run(["systemctl", "is-active", "nginx"], timeout=5)["out"].strip() == "active"
    out["hostname"] = socket.gethostname()
    out["cpus"] = os.cpu_count() or 1
    try:
        out["uname"] = os.uname().release
    except AttributeError:
        out["uname"] = os.sys.platform
    try:
        sites = list_sites()
        out["site_count"] = len(sites)
        all_domains = []
        used_ports = []
        for s in sites:
            all_domains.extend(s.get("domains", []))
            used_ports.append(str(s.get("port", 80)))
        out["domain_count"] = len(all_domains)
        out["used_ports"] = ",".join(used_ports) if used_ports else "-"
    except Exception:
        out["site_count"] = 0
        out["domain_count"] = 0
        out["used_ports"] = "-"
    return out


def api_stats():
    out = stats()
    if not module_enabled("monitor"):
        return out
    try:
        rxq = monitor["rx"]
        txq = monitor["tx"]
        out["net_rx_rate"] = int(rxq[-1]) if rxq else 0
        out["net_tx_rate"] = int(txq[-1]) if txq else 0
    except Exception:
        out["net_rx_rate"] = 0
        out["net_tx_rate"] = 0
    return out


def monitor_loop():
    global _net_last
    while True:
        try:
            s = stats()
            now = time.time()
            rx, tx = s["net_rx"], s["net_tx"]
            if _net_last:
                dt = now - _net_last[0]
                if dt > 0:
                    monitor["rx"].append(max(0, (rx - _net_last[1]) / dt))
                    monitor["tx"].append(max(0, (tx - _net_last[2]) / dt))
            _net_last = (now, rx, tx)
            mem_used = s["mem_total"] - s["mem_avail"]
            mem_pct = round(mem_used / s["mem_total"] * 100, 1) if s["mem_total"] else 0
            disk_used = s["disk_total"] - s["disk_free"]
            disk_pct = round(disk_used / s["disk_total"] * 100, 1) if s["disk_total"] else 0
            monitor["t"].append(now)
            monitor["cpu"].append(s["cpu"])
            monitor["mem"].append(mem_pct)
            monitor["disk"].append(disk_pct)
        except Exception:
            pass
        time.sleep(5)


def api_monitor():
    return {
        "t": list(monitor["t"]),
        "cpu": list(monitor["cpu"]),
        "mem": list(monitor["mem"]),
        "disk": list(monitor["disk"]),
        "rx": list(monitor["rx"]),
        "tx": list(monitor["tx"]),
        "interval": 5,
    }


# ---------------------------------------------------------------- logs
ACCESS_LOG_RE = re.compile(
    r'^(\S+) - (\S+) \[([^\]]+)\] "(\S+) (\S+) ([^"]*)" (\d{3}) (\d+|-)(?: "([^"]*)" "([^"]*)")?'
)


def daily_traffic(site_name):
    path = "/var/log/nginx/%s.access.log" % site_name
    if not os.path.isfile(path):
        return "-"
    today = datetime.datetime.now().date()
    total = 0
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block = 8192
            data = b""
            while size > 0 and len(data) < 4 * 1024 * 1024:
                size = max(0, size - block)
                f.seek(size)
                data = f.read(block) + data
        for ln in reversed(data.decode("utf-8", errors="replace").splitlines()):
            m = ACCESS_LOG_RE.match(ln)
            if not m:
                continue
            try:
                dt = datetime.datetime.strptime(m.group(3), "%d/%b/%Y:%H:%M:%S %z").date()
            except ValueError:
                continue
            if dt < today:
                break
            if dt == today and m.group(8) != "-":
                total += int(m.group(8))
    except (OSError, ValueError):
        return "-"
    return fmt_bytes(total)


def list_logs():
    files = []
    for f in sorted(glob.glob("/var/log/nginx/*.log")):
        try:
            st = os.stat(f)
            files.append({"path": f, "name": os.path.basename(f), "size": st.st_size, "mtime": int(st.st_mtime)})
        except OSError:
            continue
    return files


def tail_log(path, lines=200):
    path = safe_path(path)
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            block = 8192
            data = b""
            while size > 0 and len(data) < 2 * 1024 * 1024:
                size = max(0, size - block)
                f.seek(size)
                chunk = f.read(block)
                data = chunk + data
            text = data.decode("utf-8", errors="replace")
    except OSError:
        return None
    text_lines = text.splitlines()[-int(lines):] if lines else text.splitlines()
    entries = []
    for ln in text_lines:
        m = ACCESS_LOG_RE.match(ln)
        if m:
            entries.append({
                "ip": m.group(1), "user": m.group(2), "time": m.group(3),
                "method": m.group(4), "path": m.group(5), "proto": m.group(6),
                "status": int(m.group(7)), "size": m.group(8),
                "referer": m.group(9) or "", "ua": m.group(10) or "",
            })
        else:
            entries.append({"raw": ln})
    return {"path": path, "entries": entries}


# ---------------------------------------------------------------- auth / credentials / port
def change_credentials(old_user, old_pw, new_user, new_pw):
    cfg = load_config()
    if not verify_login(old_user, old_pw):
        return {"ok": False, "msg": "wrong current username or password"}
    if not new_user or len(new_user) < 1:
        return {"ok": False, "msg": "username cannot be empty"}
    if len(new_pw) < 6:
        return {"ok": False, "msg": "password too short"}
    cfg["username"] = new_user
    cfg["password"] = new_pw
    cfg["password_hash"] = hash_password(new_pw)
    save_config(cfg)
    return {"ok": True, "msg": "username and password changed"}


def get_credentials_info():
    cfg = load_config()
    return {
        "username": cfg.get("username", DEFAULT_USER),
        "password": cfg.get("password", DEFAULT_PASS),
        "configured": bool(cfg.get("username")),
    }


SERVICE_FILE = "/etc/systemd/system/qingliang.service"


def current_port():
    try:
        return int(os.environ.get("PANEL_PORT", "8888"))
    except ValueError:
        return 8888


def get_port_info():
    info = {"running_port": current_port(), "service": os.path.exists(SERVICE_FILE)}
    if info["service"]:
        try:
            conf = open(SERVICE_FILE, encoding="utf-8").read()
            m = re.search(r"Environment=PANEL_PORT=(\d+)", conf)
            info["configured_port"] = int(m.group(1)) if m else current_port()
        except (OSError, ValueError):
            info["configured_port"] = current_port()
    else:
        info["configured_port"] = current_port()
    return info


def set_panel_port(port):
    if not (1 <= port <= 65535):
        return {"ok": False, "msg": "port must be 1-65535"}
    if not os.path.exists(SERVICE_FILE):
        return {"ok": False, "msg": "service file not found (not installed via systemd?)"}
    try:
        conf = open(SERVICE_FILE, encoding="utf-8").read()
    except OSError:
        return {"ok": False, "msg": "cannot read service file"}
    new_conf = re.sub(r"Environment=PANEL_PORT=\d+", "Environment=PANEL_PORT=%d" % port, conf)
    if new_conf == conf:
        new_conf = conf.replace(
            "ExecStart=",
            "Environment=PANEL_PORT=%d\nExecStart=" % port,
            1,
        )
    try:
        with open(SERVICE_FILE, "w", encoding="utf-8") as f:
            f.write(new_conf)
    except OSError:
        return {"ok": False, "msg": "cannot write service file (need root)"}
    r = run(["systemctl", "daemon-reload"])
    if r["code"] != 0:
        return {"ok": False, "msg": "daemon-reload failed", "detail": r["err"]}
    r = run(["systemctl", "restart", "qingliang"], timeout=30)
    if r["code"] != 0:
        return {"ok": False, "msg": "restart failed", "detail": r["err"] or r["out"]}
    return {"ok": True, "msg": "panel restarted on port %d" % port}


# ---------------------------------------------------------------- http
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8",
}


# ---------- error page management ----------

ERROR_CODES = ["400", "401", "403", "404", "405", "408", "500", "501", "502", "503", "504"]


# ---------- minimal FTP server (stdlib only) ----------

FTP_PORT = int(os.environ.get("PANEL_FTP_PORT", "21"))


def _ftp_accounts():
    accs = []
    if os.path.exists(FTP_USERS):
        for ln in open(FTP_USERS, encoding="utf-8"):
            ln = ln.strip()
            if not ln or ln.startswith("#"):
                continue
            parts = ln.split(":", 3)
            if len(parts) >= 2:
                home = parts[2] if len(parts) >= 3 else "/var/www"
                root = parts[3] if len(parts) >= 4 else home
                accs.append({"user": parts[0], "pass": parts[1], "home": home, "root": root})
    return accs


class _FTPClient(threading.Thread):
    def __init__(self, sock, addr):
        super().__init__(daemon=True)
        self.sock = sock
        self.addr = addr
        self.user = None
        self.home = "/var/www"
        self.cwd = "/"
        self.ctype = "I"
        self.data_port = None
        self.data_host = None
        self.pasv = None
        self.rnfr = None

    def _send(self, msg):
        try:
            self.sock.sendall((msg + "\r\n").encode("utf-8", "replace"))
        except OSError:
            pass

    def _resolve(self, path):
        if not path:
            path = "/"
        if path.startswith("/"):
            virt = path
        else:
            virt = os.path.normpath(os.path.join(self.cwd, path))
        full = os.path.realpath(os.path.join(self.home, virt.lstrip("/")))
        home_r = os.path.realpath(self.home)
        if full != home_r and not full.startswith(home_r + os.sep):
            return None
        return full

    def _data(self):
        if self.pasv:
            try:
                c, _ = self.pasv.accept()
                self.pasv.close()
                self.pasv = None
                return c
            except OSError:
                return None
        if self.data_host and self.data_port:
            try:
                c = socket.create_connection((self.data_host, self.data_port), timeout=15)
                return c
            except OSError:
                return None
        return None

    def _list_dir(self, path):
        lines = []
        try:
            with os.scandir(path) as it:
                for e in it:
                    try:
                        st = e.stat()
                    except OSError:
                        continue
                    isdir = e.is_dir()
                    mode = "drwxr-xr-x" if isdir else "-rw-r--r--"
                    nlink = 2 if isdir else 1
                    size = st.st_size
                    mtime = datetime.datetime.fromtimestamp(st.st_mtime)
                    lines.append("%s %3d %-8s %-8s %10d %s %s" % (
                        mode, nlink, "ftp", "ftp", size,
                        mtime.strftime("%b %d %H:%M"), e.name))
        except OSError:
            pass
        return lines

    def run(self):
        try:
            self.sock.settimeout(600)
            self._send("220 Welcome to Qingke Panel FTP")
            buf = b""
            while True:
                try:
                    chunk = self.sock.recv(8192)
                except socket.timeout:
                    break
                except OSError:
                    break
                if not chunk:
                    break
                buf += chunk
                while b"\r\n" in buf or b"\n" in buf:
                    idx = buf.find(b"\n")
                    line = buf[:idx].rstrip(b"\r").decode("utf-8", "replace").strip()
                    buf = buf[idx + 1:]
                    if line:
                        if not self._cmd(line):
                            return
        finally:
            try:
                self.sock.close()
            except OSError:
                pass
            if self.pasv:
                try:
                    self.pasv.close()
                except OSError:
                    pass

    def _cmd(self, line):
        parts = line.split(" ", 1)
        verb = parts[0].upper()
        arg = parts[1].strip() if len(parts) > 1 else ""
        if verb in ("USER", "PASS", "SYST", "FEAT", "TYPE", "PWD", "XPWD", "CWD", "CDUP",
                    "PASV", "EPSV", "PORT", "EPRT", "LIST", "NLST", "RETR", "STOR",
                    "DELE", "MKD", "RMD", "RNFR", "RNTO", "SIZE", "MDTM", "QUIT", "NOOP", "OPTS"):
            try:
                return getattr(self, "_c_" + verb.lower())(arg)
            except Exception:
                self._send("500 command error")
                return True
        self._send("502 command not implemented")
        return True

    def _c_user(self, arg):
        self.user = arg
        self._send("331 password required")
        return True

    def _c_pass(self, arg):
        for a in _ftp_accounts():
            if a["user"] == self.user and a["pass"] == arg:
                self.home = a["home"]
                self.cwd = "/"
                self._send("230 login ok")
                return True
        self._send("530 login incorrect")
        return True

    def _c_syst(self, arg):
        self._send("215 UNIX Type: L8")
        return True

    def _c_feat(self, arg):
        self._send("211-Features:")
        self._send(" EPSV")
        self._send(" PASV")
        self._send(" SIZE")
        self._send(" MDTM")
        self._send("211 End")
        return True

    def _c_type(self, arg):
        if arg.upper().startswith("I") or arg.upper().startswith("A"):
            self.ctype = "I" if arg.upper().startswith("I") else "A"
            self._send("200 type set")
        else:
            self._send("504 not supported")
        return True

    def _c_pwd(self, arg):
        self._send("257 \"%s\"" % self.cwd)
        return True

    def _c_cwd(self, arg):
        full = self._resolve(arg)
        if full and os.path.isdir(full):
            rel = os.path.relpath(full, os.path.realpath(self.home))
            self.cwd = "/" + rel if rel != "." else "/"
            self._send("250 ok")
        else:
            self._send("550 no such directory")
        return True

    def _c_cdup(self, arg):
        return self._c_cwd("..")

    def _c_pasv(self, arg):
        try:
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind(("0.0.0.0", 0))
            srv.listen(1)
            srv.settimeout(30)
            port = srv.getsockname()[1]
            self.pasv = srv
            self.data_host = None
            self.data_port = None
            host = self.sock.getsockname()[0]
            self._send("227 Entering Passive Mode (%s,%d,%d)" % (
                ",".join(host.split(".")), port >> 8, port & 255))
        except OSError:
            self._send("425 cannot open passive connection")
        return True

    def _c_epsv(self, arg):
        try:
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            srv.bind(("0.0.0.0", 0))
            srv.listen(1)
            srv.settimeout(30)
            port = srv.getsockname()[1]
            self.pasv = srv
            self.data_host = None
            self.data_port = None
            self._send("229 Entering Extended Passive Mode (|||%d|)" % port)
        except OSError:
            self._send("425 cannot open passive connection")
        return True

    def _c_port(self, arg):
        parts = arg.split(",")
        if len(parts) == 6:
            try:
                self.data_host = ".".join(parts[:4])
                self.data_port = int(parts[4]) * 256 + int(parts[5])
                self.pasv = None
                self._send("200 port set")
            except ValueError:
                self._send("501 bad port")
        else:
            self._send("501 bad port")
        return True

    def _c_eprt(self, arg):
        parts = arg.split("|")
        if len(parts) >= 5:
            try:
                self.data_host = parts[2]
                self.data_port = int(parts[4])
                self.pasv = None
                self._send("200 eprt set")
            except ValueError:
                self._send("501 bad eprt")
        else:
            self._send("501 bad eprt")
        return True

    def _c_list(self, arg):
        full = self._resolve(arg or self.cwd)
        if not full or not os.path.isdir(full):
            self._send("550 no such directory")
            return True
        c = self._data()
        if not c:
            self._send("425 data connection failed")
            return True
        self._send("150 opening data connection")
        try:
            data = ("\r\n".join(self._list_dir(full)) + "\r\n").encode("utf-8", "replace")
            c.sendall(data)
            c.close()
            self._send("226 transfer complete")
        except OSError:
            self._send("426 transfer failed")
        return True

    def _c_nlst(self, arg):
        full = self._resolve(arg or self.cwd)
        if not full or not os.path.isdir(full):
            self._send("550 no such directory")
            return True
        c = self._data()
        if not c:
            self._send("425 data connection failed")
            return True
        self._send("150 opening data connection")
        try:
            names = "\r\n".join(e.name for e in os.scandir(full))
            c.sendall((names + "\r\n").encode("utf-8", "replace"))
            c.close()
            self._send("226 transfer complete")
        except OSError:
            self._send("426 transfer failed")
        return True

    def _c_retr(self, arg):
        full = self._resolve(arg)
        if not full or not os.path.isfile(full):
            self._send("550 no such file")
            return True
        c = self._data()
        if not c:
            self._send("425 data connection failed")
            return True
        self._send("150 opening data connection")
        try:
            with open(full, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    c.sendall(chunk)
            c.close()
            self._send("226 transfer complete")
        except OSError:
            self._send("426 transfer failed")
        return True

    def _c_stor(self, arg):
        full = self._resolve(arg)
        if not full:
            self._send("550 path not allowed")
            return True
        c = self._data()
        if not c:
            self._send("425 data connection failed")
            return True
        self._send("150 opening data connection")
        try:
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as f:
                while True:
                    chunk = c.recv(65536)
                    if not chunk:
                        break
                    f.write(chunk)
            c.close()
            log_action("FTP上传", full)
            self._send("226 transfer complete")
        except OSError:
            self._send("426 transfer failed")
        return True

    def _c_dele(self, arg):
        full = self._resolve(arg)
        if full and os.path.isfile(full):
            try:
                os.remove(full)
                log_action("FTP删除", full)
                self._send("250 deleted")
            except OSError:
                self._send("550 cannot delete")
        else:
            self._send("550 no such file")
        return True

    def _c_mkd(self, arg):
        full = self._resolve(arg)
        if not full:
            self._send("550 path not allowed")
            return True
        try:
            os.makedirs(full, exist_ok=True)
            self._send("257 created")
        except OSError:
            self._send("550 cannot create")
        return True

    def _c_rmd(self, arg):
        full = self._resolve(arg)
        if full and os.path.isdir(full):
            try:
                os.rmdir(full)
                self._send("250 removed")
            except OSError:
                self._send("550 cannot remove")
        else:
            self._send("550 no such directory")
        return True

    def _c_rnfr(self, arg):
        full = self._resolve(arg)
        if full and os.path.exists(full):
            self.rnfr = full
            self._send("350 ready for rnto")
        else:
            self._send("550 no such file")
        return True

    def _c_rnto(self, arg):
        if not self.rnfr:
            self._send("503 rnfr required")
            return True
        full = self._resolve(arg)
        if not full:
            self._send("550 path not allowed")
            return True
        try:
            os.rename(self.rnfr, full)
            self.rnfr = None
            self._send("250 renamed")
        except OSError:
            self._send("550 cannot rename")
        return True

    def _c_size(self, arg):
        full = self._resolve(arg)
        if full and os.path.isfile(full):
            self._send("213 %d" % os.path.getsize(full))
        else:
            self._send("550 no such file")
        return True

    def _c_mdtm(self, arg):
        full = self._resolve(arg)
        if full and os.path.isfile(full):
            self._send("213 %s" % datetime.datetime.fromtimestamp(os.path.getmtime(full)).strftime("%Y%m%d%H%M%S"))
        else:
            self._send("550 no such file")
        return True

    def _c_opts(self, arg):
        self._send("200 ok")
        return True

    def _c_noop(self, arg):
        self._send("200 ok")
        return True

    def _c_quit(self, arg):
        self._send("221 goodbye")
        return False


def ftp_server_loop():
    try:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("0.0.0.0", FTP_PORT))
        srv.listen(16)
        print("FTP server listening on port %d" % FTP_PORT)
        while True:
            c, a = srv.accept()
            _FTPClient(c, a).start()
    except OSError as e:
        print("FTP server failed: %s" % e, file=sys.stderr)


def error_defaults_list():
    out = []
    for code in ERROR_CODES:
        fp = ERROR_PAGE_DIR / ("%s.html" % code)
        has_file = fp.is_file()
        out.append({
            "code": code,
            "name_en": ERROR_INFO.get(code, ("", "", ""))[0],
            "name_zh": ERROR_INFO.get(code, ("", "", ""))[1],
            "desc": ERROR_INFO.get(code, ("", "", ""))[2],
            "has_file": has_file,
            "size": fp.stat().st_size if has_file else 0,
            "mtime": int(fp.stat().st_mtime) if has_file else 0,
        })
    return {"ok": True, "pages": out}


def error_default_content(code):
    if code not in ERROR_CODES:
        return {"ok": False, "msg": "invalid code"}
    fp = ERROR_PAGE_DIR / ("%s.html" % code)
    if not fp.is_file():
        fp.write_text(builtin_error_page(code), encoding="utf-8")
    try:
        return {"ok": True, "code": code, "content": fp.read_text(encoding="utf-8")}
    except OSError:
        return {"ok": False, "msg": "read failed"}


def error_default_save(code, content):
    if code not in ERROR_CODES:
        return {"ok": False, "msg": "invalid code"}
    fp = ERROR_PAGE_DIR / ("%s.html" % code)
    try:
        ERROR_PAGE_DIR.mkdir(parents=True, exist_ok=True)
        fp.write_text(content or "", encoding="utf-8")
    except OSError:
        return {"ok": False, "msg": "write failed"}
    log_action("修改全局错误页", code)
    return {"ok": True, "msg": "默认错误页已保存，所有站点立即生效"}


def error_default_delete(code):
    if code not in ERROR_CODES:
        return {"ok": False, "msg": "invalid code"}
    fp = ERROR_PAGE_DIR / ("%s.html" % code)
    try:
        if fp.is_file():
            fp.unlink()
        fp.write_text(builtin_error_page(code), encoding="utf-8")
    except OSError:
        return {"ok": False, "msg": "write failed"}
    log_action("重置全局错误页", code)
    return {"ok": True, "msg": "已恢复内置默认错误页"}


def error_pages_list(name):
    p = conf_path(name)
    if not os.path.exists(p):
        return {"error": "site not found"}
    m = _parse_conf(open(p, encoding="utf-8").read())
    root = m.get("root") or (SITE_ROOT + "/" + name)
    enabled = m.get("error_pages") or {}
    out = []
    for code in ERROR_CODES:
        fp = os.path.join(root, "%s.html" % code)
        has_file = os.path.isfile(fp)
        out.append({
            "code": code,
            "enabled": code in enabled,
            "has_file": has_file,
            "size": os.path.getsize(fp) if has_file else 0,
            "mtime": int(os.stat(fp).st_mtime) if has_file else 0,
        })
    return {"ok": True, "site": name, "root": root, "pages": out}


def error_page_save(name, code, content, enable=True):
    if not re.fullmatch(r"\d{3}", code or ""):
        return {"ok": False, "msg": "invalid code"}
    p = conf_path(name)
    if not os.path.exists(p):
        return None
    m = _parse_conf(open(p, encoding="utf-8").read())
    root = m.get("root") or (SITE_ROOT + "/" + name)
    if not str(root).startswith(SITE_ROOT):
        return {"ok": False, "msg": "invalid root"}
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, "%s.html" % code), "w", encoding="utf-8") as f:
        f.write(content or "")
    eps = dict(m.get("error_pages") or {})
    if enable:
        eps[code] = "/%s.html" % code
    else:
        eps.pop(code, None)
    m["error_pages"] = eps
    _write_site_conf(name, m)
    log_action("修改错误页", "%s %s.html" % (name, code))
    res = nginx_test_reload()
    if res["ok"]:
        res["site"] = get_site(name)
    return res


def error_page_delete(name, code):
    if not re.fullmatch(r"\d{3}", code or ""):
        return {"ok": False, "msg": "invalid code"}
    p = conf_path(name)
    if not os.path.exists(p):
        return {"ok": False, "msg": "site not found"}
    m = _parse_conf(open(p, encoding="utf-8").read())
    root = m.get("root") or (SITE_ROOT + "/" + name)
    eps = dict(m.get("error_pages") or {})
    eps.pop(code, None)
    m["error_pages"] = eps
    fp = os.path.join(root, "%s.html" % code)
    if os.path.isfile(fp):
        try:
            os.remove(fp)
        except OSError:
            pass
    _write_site_conf(name, m)
    log_action("删除错误页", "%s %s.html" % (name, code))
    res = nginx_test_reload()
    if res["ok"]:
        res["site"] = get_site(name)
    return res


# ---------- FTP accounts ----------

FTP_USERS = BASE / "ftp_users.conf"


def list_ftp():
    out = []
    if not os.path.exists(FTP_USERS):
        return out
    try:
        for ln in open(FTP_USERS, encoding="utf-8"):
            ln = ln.strip()
            if not ln or ln.startswith("#"):
                continue
            parts = ln.split(":", 3)
            if len(parts) >= 2:
                home = parts[2] if len(parts) >= 3 else "/var/www"
                root = parts[3] if len(parts) >= 4 else home
                out.append({"user": parts[0], "pass": parts[1], "home": home, "root": root})
    except OSError:
        pass
    return out


def save_ftp(accounts):
    try:
        with open(FTP_USERS, "w", encoding="utf-8") as f:
            f.write("# user:pass:home:root\n")
            for a in accounts:
                f.write("%s:%s:%s:%s\n" % (a["user"], a["pass"], a["home"], a["root"]))
        return True
    except OSError:
        return False


def ftp_add(user, password, root):
    if not re.fullmatch(r"[a-zA-Z0-9_.\-]{2,32}", user or ""):
        return {"ok": False, "msg": "invalid username"}
    if not password or len(password) < 6:
        return {"ok": False, "msg": "password must be at least 6 chars"}
    if not root or not root.startswith(SITE_ROOT):
        return {"ok": False, "msg": "root must be under %s" % SITE_ROOT}
    os.makedirs(root, exist_ok=True)
    accs = list_ftp()
    if any(a["user"] == user for a in accs):
        return {"ok": False, "msg": "user already exists"}
    accs.append({"user": user, "pass": password, "home": root, "root": root})
    if not save_ftp(accs):
        return {"ok": False, "msg": "write failed"}
    log_action("创建FTP账号", user + " → " + root)
    return ftp_apply()


def ftp_delete(user):
    accs = [a for a in list_ftp() if a["user"] != user]
    if len(accs) == len(list_ftp()):
        return {"ok": False, "msg": "user not found"}
    if not save_ftp(accs):
        return {"ok": False, "msg": "write failed"}
    log_action("删除FTP账号", user)
    return ftp_apply()


def ftp_apply():
    return {"ok": True}


def ftp_dirs(path=""):
    base = str(path or SITE_ROOT).strip().rstrip("/") or SITE_ROOT
    if not base.startswith(SITE_ROOT):
        return {"ok": False, "msg": "path must be under %s" % SITE_ROOT}
    out = []
    try:
        for e in sorted(os.scandir(base), key=lambda x: x.name.lower()):
            if e.is_dir() and not e.name.startswith("."):
                out.append(e.path)
    except OSError:
        return {"ok": False, "msg": "path not found"}
    return {"ok": True, "path": base, "dirs": out}


def ftp_update(user, data):
    accs = list_ftp()
    found = None
    for a in accs:
        if a["user"] == user:
            found = a
            break
    if not found:
        return {"ok": False, "msg": "user not found"}
    new_user = str(data.get("user") or user).strip()
    if not re.fullmatch(r"[a-zA-Z0-9_.\-]{2,32}", new_user or ""):
        return {"ok": False, "msg": "invalid username"}
    if new_user != user and any(a["user"] == new_user for a in accs):
        return {"ok": False, "msg": "user already exists"}
    new_pass = str(data.get("password") or found["pass"]).strip()
    if len(new_pass) < 6:
        return {"ok": False, "msg": "password must be at least 6 chars"}
    new_root = str(data.get("root") or found["root"]).strip().rstrip("/")
    if not new_root or not new_root.startswith(SITE_ROOT):
        return {"ok": False, "msg": "root must be under %s" % SITE_ROOT}
    os.makedirs(new_root, exist_ok=True)
    found["user"] = new_user
    found["pass"] = new_pass
    found["home"] = new_root
    found["root"] = new_root
    if not save_ftp(accs):
        return {"ok": False, "msg": "write failed"}
    log_action("修改FTP账号", "%s → %s (%s)" % (user, new_user, new_root))
    return {"ok": True, "msg": "FTP 账号已更新"}


# ---------- cron jobs ----------

CRON_PATH = BASE / "cron.json"


def load_cron():
    try:
        return json.loads(open(CRON_PATH, encoding="utf-8").read() or "[]")
    except (OSError, ValueError):
        return []


def save_cron(jobs):
    try:
        with open(CRON_PATH, "w", encoding="utf-8") as f:
            f.write(json.dumps(jobs, ensure_ascii=False, indent=1))
        return True
    except OSError:
        return False


def list_cron():
    jobs = load_cron()
    for j in jobs:
        if j.get("type") == "url":
            j["last_run"] = j.get("last_run")
            j["last_result"] = j.get("last_result")
    return jobs


def cron_add(data):
    name = str(data.get("name") or "").strip()
    if not name:
        return {"ok": False, "msg": "name required"}
    spec = str(data.get("spec") or "").strip()
    if not spec or len(spec.split()) != 5:
        return {"ok": False, "msg": "spec must be 5 fields (min hour day month weekday)"}
    ctype = data.get("type", "shell")
    if ctype == "shell":
        cmd = str(data.get("cmd") or "").strip()
        if not cmd:
            return {"ok": False, "msg": "command required"}
        payload = cmd
    elif ctype == "url":
        payload = str(data.get("url") or "").strip()
        if not payload.startswith(("http://", "https://")):
            return {"ok": False, "msg": "invalid url"}
    else:
        return {"ok": False, "msg": "invalid type"}
    jobs = load_cron()
    job = {"name": name, "spec": spec, "type": ctype, "payload": payload, "enabled": bool(data.get("enabled", True))}
    jobs.append(job)
    if not save_cron(jobs):
        return {"ok": False, "msg": "write failed"}
    log_action("创建计划任务", name)
    return {"ok": True, "job": job}


def cron_delete(name):
    jobs = load_cron()
    n = len(jobs)
    jobs = [j for j in jobs if j.get("name") != name]
    if len(jobs) == n:
        return {"ok": False, "msg": "job not found"}
    if not save_cron(jobs):
        return {"ok": False, "msg": "write failed"}
    log_action("删除计划任务", name)
    return {"ok": True}


def cron_toggle(name, enabled):
    jobs = load_cron()
    for j in jobs:
        if j.get("name") == name:
            j["enabled"] = bool(enabled)
    if not save_cron(jobs):
        return {"ok": False, "msg": "write failed"}
    return {"ok": True}


def _cron_match(spec, now):
    try:
        f = spec.split()
        if len(f) != 5:
            return False
        for field, val in zip(f, [now.minute, now.hour, now.day, now.month, now.isoweekday()]):
            if field == "*":
                continue
            parts = field.split(",")
            ok = False
            for p in parts:
                if p == "*":
                    ok = True
                    continue
                if "-" in p:
                    a, b = p.split("-", 1)
                    if int(a) <= val <= int(b):
                        ok = True
                elif "/" in p:
                    st, step = p.split("/", 1)
                    base = 0 if st == "*" else int(st)
                    if (val - base) % int(step) == 0 and val >= base:
                        ok = True
                elif int(p) == val:
                    ok = True
            if not ok:
                return False
        return True
    except (ValueError, IndexError):
        return False


def cron_loop():
    last = {}
    while True:
        try:
            now = datetime.datetime.now()
            jobs = load_cron()
            for j in jobs:
                if not j.get("enabled"):
                    continue
                name = j.get("name")
                key = (name, now.minute, now.hour, now.day, now.month)
                if last.get(key):
                    continue
                if not _cron_match(j.get("spec", ""), now):
                    continue
                last[key] = True
                t0 = time.time()
                try:
                    if j.get("type") == "url":
                        try:
                            import urllib.request
                            urllib.request.urlopen(j["payload"], timeout=30).read(1024)
                            res = "OK"
                        except Exception as e:
                            res = "ERR: %s" % e
                    else:
                        r = run(["bash", "-c", j["payload"]], timeout=600)
                        res = "OK" if r["code"] == 0 else "ERR(exit %s)" % r["code"]
                    status = "成功" if res.startswith("OK") else "失败"
                    log_action("计划任务", "%s → %s" % (name, status))
                    jobs = load_cron()
                    for jj in jobs:
                        if jj.get("name") == name:
                            jj["last_run"] = int(t0)
                            jj["last_result"] = status + ("" if status == "成功" else ": " + res[:80])
                    save_cron(jobs)
                except Exception:
                    pass
        except Exception:
            pass
        time.sleep(20)


class Handler(BaseHTTPRequestHandler):
    server_version = "Panel/1.0"

    def log_message(self, fmt, *args):
        return

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        if extra:
            for k, v in extra.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _client_ip(self):
        fwd = self.headers.get("X-Forwarded-For")
        if fwd:
            return fwd.split(",")[0].strip()
        return self.client_address[0]

    def _auth_ok(self, token=None):
        if token:
            return check_token(token)
        hdr = self.headers.get("Authorization", "")
        if hdr.startswith("Bearer "):
            return check_token(hdr[7:].strip())
        return False

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        if path.startswith("/api/"):
            token = qs.get("token", [""])[0]
            if token:
                if not check_token(token):
                    self._json(401, {"error": "unauthorized"})
                    return
            elif not self._auth_ok():
                self._json(401, {"error": "unauthorized"})
                return
            try:
                self.handle_api_get(path, qs)
            except Exception as e:
                self._json(500, {"error": str(e)})
            return
        if path == "/" or path == "":
            path = "/index.html"
        if path.startswith("/panel-err/"):
            code = path[len("/panel-err/"):].removesuffix(".html")
            if re.fullmatch(r"\d{3}", code or ""):
                fp = ERROR_PAGE_DIR / ("%s.html" % code)
                if fp.is_file():
                    self._send(200, fp.read_bytes(), "text/html; charset=utf-8",
                               extra={"Cache-Control": "no-cache"})
                    return
        self.serve_static(path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        if path == "/api/login":
            self.handle_login()
            return
        if not self._auth_ok():
            self._json(401, {"error": "unauthorized"})
            return
        try:
            self.handle_api_post(path, qs)
        except Exception as e:
            self._json(500, {"error": str(e)})

    def do_PUT(self):
        if not self._auth_ok():
            self._json(401, {"error": "unauthorized"})
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        if path == "/api/fs/upload":
            try:
                self.handle_upload(qs)
            except Exception as e:
                self._json(500, {"error": str(e)})
        else:
            self._json(404, {"error": "not found"})

    def do_DELETE(self):
        if not self._auth_ok():
            self._json(401, {"error": "unauthorized"})
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/api/cron":
                if not module_enabled("cron"):
                    self._json(403, {"error": "module not enabled"})
                    return
                self.handle_cron_delete(qs)
            elif path == "/api/sites":
                self.handle_site_delete(qs)
            elif path == "/api/fs":
                self.handle_fs_delete(qs)
            elif path.startswith("/api/sites/"):
                parts = path.split("/")
                if len(parts) == 6 and parts[4] == "errorpage":
                    name = urllib.parse.unquote(parts[3])
                    code = urllib.parse.unquote(parts[5])
                    res = error_page_delete(name, code)
                    self._json(200 if (res and res.get("ok")) else 400, res or {"error": "delete failed"})
                else:
                    self._json(404, {"error": "not found"})
            else:
                self._json(404, {"error": "not found"})
        except Exception as e:
            self._json(500, {"error": str(e)})

    def serve_static(self, path):
        full = (FRONT_DIR / path.lstrip("/")).resolve()
        try:
            full.relative_to(FRONT_DIR.resolve())
        except ValueError:
            self._json(403, {"error": "forbidden"})
            return
        if full.is_dir():
            full = full / "index.html"
        if not full.is_file():
            self._send(404, "Not Found", "text/plain; charset=utf-8")
            return
        ctype = CONTENT_TYPES.get(full.suffix.lower(), "application/octet-stream")
        data = full.read_bytes()
        if full.suffix in (".html", ".css", ".js"):
            self._send(200, data, ctype, extra={"Cache-Control": "no-cache"})
        else:
            self._send(200, data, ctype, extra={"Cache-Control": "max-age=3600"})

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length <= 0 or length > UPLOAD_LIMIT:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    def handle_login(self):
        ip = self._client_ip()
        if rate_limited(ip):
            self._json(429, {"error": "too many attempts, try later"})
            return
        data = self._read_json()
        if verify_login(data.get("username", ""), data.get("password", "")):
            clear_failures(ip)
            self._json(200, {"token": make_token()})
        else:
            record_failure(ip)
            self._json(401, {"error": "wrong username or password"})

    def handle_api_get(self, path, qs):
        mod_req = {
            "/api/monitor": "monitor",
            "/api/actions": "logs",
            "/api/cron": "cron",
            "/api/ftp": "ftp",
            "/api/ftp/dirs": "ftp",
        }
        if path in mod_req and not module_enabled(mod_req[path]):
            self._json(403, {"error": "module not enabled"})
            return
        if path == "/api/ftp/dirs":
            self._json(200, ftp_dirs(qs.get("path", [""])[0]))
            return
        routes = {
            "/api/stats": lambda: api_stats(),
            "/api/monitor": lambda: api_monitor(),
            "/api/sites": lambda: {"sites": list_sites()},
            "/api/fs": lambda: fs_list(qs.get("path", [""])[0]),
            "/api/fs/read": lambda: fs_read(qs.get("path", [""])[0]),
            "/api/info": lambda: {"version": "2.0.0", "host": socket.gethostname(), "modules": api_modules(),
                                      "features": (load_config().get("features") or {}),
                                      "apps": {aid: app_version(aid) for aid in APPS}},
            "/api/config": lambda: get_port_info(),
            "/api/credentials": lambda: get_credentials_info(),
            "/api/logs": lambda: tail_log(qs.get("path", [""])[0], int(qs.get("lines", ["200"])[0] or 200)),
            "/api/logs/list": lambda: {"logs": list_logs()},
            "/api/actions": lambda: {"actions": list_actions(int(qs.get("limit", ["200"])[0] or 200))},
            "/api/cron": lambda: {"jobs": list_cron()},
            "/api/ftp": lambda: {"accounts": list_ftp()},
        }
        if path in routes:
            res = routes[path]()
            if res is None:
                self._json(403, {"error": "path not allowed"})
            else:
                self._json(200, res)
            return
        if path == "/api/error-defaults":
            self._json(200, error_defaults_list())
            return
        if path == "/api/apps":
            self._json(200, api_apps())
            return
        if path == "/api/apps/log":
            self._json(200, app_log(qs.get("name", [""])[0]))
            return
        if path == "/api/fs/related":
            res = fs_related(qs.get("path", [""])[0])
            self._json(200 if res["ok"] else 400, res)
            return
        if path == "/api/error-defaults/content":
            res = error_default_content(qs.get("code", [""])[0])
            self._json(200 if res["ok"] else 400, res)
            return
        if path == "/api/fs/download":
            fp = fs_download(qs.get("path", [""])[0])
            if not fp:
                self._json(403, {"error": "path not allowed"})
                return
            self._send(200, open(fp, "rb").read(),
                       ctype="application/octet-stream",
                       extra={"Content-Disposition": "attachment; filename=\"%s\"" % os.path.basename(fp)})
            return
        if path.startswith("/api/sites/"):
            parts = path.split("/")
            if len(parts) == 4:
                name = urllib.parse.unquote(parts[3])
                site = get_site(name)
                if site:
                    self._json(200, site)
                else:
                    self._json(404, {"error": "site not found"})
                return
            if len(parts) == 5 and parts[4] == "disk":
                name = urllib.parse.unquote(parts[3])
                site = get_site(name)
                if site and site.get("root"):
                    root = site["root"]
                    if os.path.isdir(root):
                        r = run(["du", "-sh", root], timeout=10)
                        size = r["out"].split()[0] if r["out"] else "-"
                        self._json(200, {"ok": True, "disk_usage": size})
                    else:
                        self._json(200, {"ok": True, "disk_usage": "-"})
                else:
                    self._json(200, {"ok": True, "disk_usage": "-"})
                return
            if len(parts) == 5 and parts[4] == "ssl-files":
                name = urllib.parse.unquote(parts[3])
                self._json(200, ssl_files(name))
                return
            if len(parts) == 5 and parts[4] == "errorpages":
                name = urllib.parse.unquote(parts[3])
                res = error_pages_list(name)
                if isinstance(res, dict) and "error" in res:
                    self._json(404, res)
                else:
                    self._json(200, res)
                return
        self._json(404, {"error": "not found"})

    def handle_api_post(self, path, qs):
        data = self._read_json()
        if path == "/api/apps/install":
            self._json(200, app_install(data.get("name", "")))
            return
        if path == "/api/apps/uninstall":
            self._json(200, app_uninstall(data.get("name", "")))
            return
        if path == "/api/features":
            self._json(200, set_features(data))
            return
        if path == "/api/modules":
            res = set_modules(data)
            self._json(200, res)
            return
        if path == "/api/cron" or path == "/api/cron/toggle":
            if not module_enabled("cron"):
                self._json(403, {"error": "module not enabled"})
                return
        if path == "/api/ftp" or path == "/api/ftp/delete" or path == "/api/ftp/update":
            if not module_enabled("ftp"):
                self._json(403, {"error": "module not enabled"})
                return
        if path == "/api/cron":
            res = cron_add(data)
            self._json(200 if res["ok"] else 400, res)
            return
        if path == "/api/cron/toggle":
            res = cron_toggle(data.get("name", ""), data.get("enabled", True))
            self._json(200 if res["ok"] else 400, res)
            return
        if path == "/api/ftp":
            res = ftp_add(data.get("user", ""), data.get("password", ""), data.get("root", ""))
            self._json(200 if res["ok"] else 400, res)
            return
        if path == "/api/ftp/update":
            res = ftp_update(data.get("original", data.get("user", "")), data)
            self._json(200 if res["ok"] else 400, res)
            return
        if path == "/api/ftp/delete":
            res = ftp_delete(data.get("user", ""))
            self._json(200 if res["ok"] else 400, res)
            return
        if path == "/api/error-defaults/save":
            res = error_default_save(data.get("code", ""), data.get("content", ""))
            self._json(200 if res["ok"] else 400, res)
            return
        if path == "/api/error-defaults/delete":
            res = error_default_delete(data.get("code", ""))
            self._json(200 if res["ok"] else 400, res)
            return
        if path == "/api/sites":
            res = create_site(data.get("name"), data.get("domains", []), data.get("root"), data.get("note", ""), data.get("port", 80), data.get("runtime", "static"))
            self._json(200 if res["ok"] else 400, res)
            return
        if path == "/api/nginx/reload":
            self._json(200, nginx_test_reload())
            return
        if path == "/api/ssl/renew":
            self._json(200, renew_ssl())
            return
        if path == "/api/password":
            self._json(200, change_credentials(
                data.get("old_user", ""), data.get("old_pass", ""),
                data.get("new_user", ""), data.get("new_pass", "")))
            return
        if path == "/api/port":
            self._json(200, set_panel_port(int(data.get("port", 0))))
            return
        if path == "/api/fs/write":
            res = fs_write(data.get("path"), data.get("content", ""))
            if res is None:
                self._json(403, {"error": "path not allowed"})
            elif "error" in res:
                self._json(400, res)
            else:
                self._json(200, res)
            return
        if path == "/api/system/release":
            self._json(200, release_resources())
            return
        if path == "/api/fs/chmod":
            res = fs_chmod(data.get("path"), data.get("mode"))
            if res is None:
                self._json(403, {"error": "path not allowed"})
            elif "error" in res:
                self._json(400, res)
            else:
                self._json(200, res)
            return
        if path == "/api/fs/mkdir":
            res = fs_mkdir(data.get("path"))
            if res is None:
                self._json(403, {"error": "path not allowed"})
            else:
                self._json(200, res)
            return
        if path == "/api/fs/rename":
            res = fs_rename(data.get("path"), data.get("new_name"))
            if res is None:
                self._json(403, {"error": "path not allowed"})
            elif "error" in res:
                self._json(400, res)
            else:
                self._json(200, res)
            return
        if path == "/api/fs/copy":
            res = fs_copy(data.get("paths", []), data.get("dest"))
            if res is None:
                self._json(403, {"error": "path not allowed"})
            elif "error" in res:
                self._json(400, res)
            else:
                self._json(200, res)
            return
        if path == "/api/fs/move":
            res = fs_move(data.get("paths", []), data.get("dest"))
            if res is None:
                self._json(403, {"error": "path not allowed"})
            elif "error" in res:
                self._json(400, res)
            else:
                self._json(200, res)
            return
        if path == "/api/fs/zip":
            res = fs_zip(data.get("paths", []), data.get("target"))
            if res is None:
                self._json(403, {"error": "path not allowed"})
            elif "error" in res:
                self._json(400, res)
            else:
                self._json(200, res)
            return
        if path == "/api/fs/unzip":
            res = fs_unzip(data.get("path"), data.get("target"))
            if res is None:
                self._json(403, {"error": "path not allowed"})
            elif "error" in res:
                self._json(400, res)
            else:
                self._json(200, res)
            return
        if path.startswith("/api/sites/"):
            parts = path.split("/")
            if len(parts) == 5:
                name = urllib.parse.unquote(parts[3])
                action = parts[4]
                if action == "config":
                    res = update_site(name, data)
                    self._json(200 if res["ok"] else 400, res)
                    return
                if action == "domains":
                    res = update_site(name, {"domains": data.get("domains", [])})
                    self._json(200 if res["ok"] else 400, res)
                    return
                if action == "ssl":
                    self._json(200, issue_ssl(name, data.get("domain", ""), data.get("email", "")))
                    return
                if action == "ssl-upload":
                    res = upload_ssl(name, data.get("cert", ""), data.get("key", ""))
                    self._json(200 if res["ok"] else 400, res)
                    return
            if len(parts) == 6 and parts[4] == "errorpage":
                name = urllib.parse.unquote(parts[3])
                code = urllib.parse.unquote(parts[5])
                res = error_page_save(name, code, data.get("content", ""), bool(data.get("enable", True)))
                if res is None:
                    self._json(404, {"error": "site not found"})
                else:
                    self._json(200 if res.get("ok") else 400, res)
                return
        self._json(404, {"error": "not found"})

    def handle_site_delete(self, qs):
        name = qs.get("name", [""])[0]
        keep = qs.get("keep", ["0"])[0] == "1"
        res = delete_site(name, keep_files=keep)
        self._json(200 if res["ok"] else 400, res)

    def handle_fs_delete(self, qs):
        data = self._read_json()
        if "paths" in data and data["paths"]:
            paths = data["paths"]
            recursive = bool(data.get("recursive", False))
        else:
            paths = [qs.get("path", [""])[0]]
            recursive = qs.get("recursive", ["0"])[0] == "1"
        res = fs_delete(paths, recursive)
        if res is None:
            self._json(403, {"error": "path not allowed"})
        elif "error" in res:
            self._json(400, res)
        else:
            self._json(200, res)

    def handle_cron_delete(self, qs):
        name = qs.get("name", [""])[0]
        res = cron_delete(name)
        self._json(200 if res["ok"] else 400, res)

    def handle_upload(self, qs):
        path = safe_path(qs.get("path", [""])[0])
        if not path:
            self._json(403, {"error": "path not allowed"})
            return
        length = int(self.headers.get("Content-Length", 0))
        if length <= 0 or length > UPLOAD_LIMIT:
            self._json(400, {"error": "invalid size"})
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        self._json(200, {"ok": True, "path": path})


def main():
    if hasattr(os, "geteuid") and os.geteuid() != 0:
        print("WARNING: not running as root; nginx/file management may fail.", file=sys.stderr)
    ensure_init()
    mods = api_modules()
    print("enabled modules: %s" % ", ".join([m for m in MODULE_LIST if mods.get(m)] or ["(none)"]))
    if os.path.exists("/etc/nginx/sites-available"):
        regen_all_site_confs()
        nginx_test_reload()
    if module_enabled("monitor"):
        th = threading.Thread(target=monitor_loop, daemon=True)
        th.start()
    if module_enabled("cron"):
        tc = threading.Thread(target=cron_loop, daemon=True)
        tc.start()
    if module_enabled("ftp"):
        tf = threading.Thread(target=ftp_server_loop, daemon=True)
        tf.start()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("Panel running at http://%s:%d" % (HOST, PORT))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
