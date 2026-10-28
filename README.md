# 轻壳面板 · Qingke Panel

轻量、零依赖的服务器运维面板。一个 Python 文件起服务，前端纯原生、无构建步骤，开箱即用。

---

## ✨ 特性

- **概览与监控**：主机信息、运行时长、CPU / 内存 / 磁盘 / 网络实时指标，附动态环形仪表与网络 sparkline。
- **网站管理**：基于 Nginx 的站点管理（配置、绑定、SSL、文件）。
- **SSL 证书**：证书申请与一键续签。
- **文件管理**：完整的在线文件管理器 —— 上传 / 下载 / 新建 / 重命名 / 移动 / 复制 / 压缩 / 解压 / 改权限 / 在线编辑。大目录分批渲染，不卡顿。
- **计划任务**：Cron 任务管理，支持启停开关。
- **应用管理**：一键安装 / 卸载常用应用，查看运行日志。
- **FTP 管理**：FTP 账号的创建、更新与目录绑定。
- **系统管理**：端口调整、管理员密码、配置文件、凭证管理、Nginx 重载、系统信息发布。
- **自定义错误页**：内置 11 套品牌化错误页（400/401/403/404/405/408/500/501/502/503/504）。
- **日志查看**：集中浏览系统与应用日志。

界面采用 **Kinetic Glass** 设计语言（深空底 + 液态玻璃 + 冷色能量渐变），暗色为签名形态，并完整适配 `prefers-reduced-motion`。

---

## 🧱 技术栈

| 层 | 实现 |
|---|---|
| 后端 | Python 3（仅标准库，`http.server` 自研路由，**零第三方依赖**） |
| 前端 | 原生 HTML / CSS / JavaScript（无框架、无打包） |
| 分发 | Shell 安装 / 升级脚本 + R2/CDN 远程安装 |

整个项目只有一个 `panel.py` 作为服务端，前端三件套（`web/`）直读静态资源，因此不需要 `pip install`、不需要 `npm`、`node`、`package.json` 或任何构建步骤。

---

## 📁 目录结构

```
轻壳面板/
├── panel.py              # 面板服务（Python 标准库，零依赖）
├── web/                  # 前端静态资源
│   ├── index.html        # 单页应用入口
│   ├── style.css         # Kinetic Glass 设计系统（68 个 CSS 变量）
│   └── app.js            # 前端逻辑（动效引擎 / 轮询 / 文件管理器 / 编辑器）
├── error_pages/          # 11 套品牌化错误页
├── install.sh            # 本地安装器（交互式，默认端口 8888）
├── pull-install.sh       # 从 tar.gz 远程安装（带 SHA256 校验）
├── qingliang-install.sh  # 由 build.sh 生成的 CDN 远程安装 / 管理器
├── build.sh              # 打包工具（生成安装脚本 + tar.gz）
├── check-local.sh        # 上传前：本地文件哈希自检
├── check-r2.sh           # 上传后：CDN 文件哈希自检
└── .gitignore            # 忽略密钥、证书、发布包等敏感/二进制文件
```

---

## 🚀 快速开始

> 适用于 Linux 服务器，需 root 权限。默认安装目录 `/opt/qingliang`，默认端口 `8888`。

### 方式一：本地安装（已有源码）

```bash
sudo bash install.sh
```

按提示输入端口（回车默认 `8888`），脚本会把面板部署到 `/opt/qingliang` 并配置为系统服务。

### 方式二：远程拉取安装（从 CDN）

```bash
bash pull-install.sh -u https://cdn.example.com/qingliang.tar.gz -s <SHA256>
```

`-s` 可省略；带上后可做防篡改校验。

### 方式三：一键远程安装（CDN 安装器）

```bash
curl -fsSL https://<CDN>/qingliang-install.sh | sudo bash
```

安装器同时是管理器，支持子命令：

```bash
bash qingliang-install.sh install      # 安装
bash qingliang-install.sh restart      # 重启
bash qingliang-install.sh info         # 查看运行状态
bash qingliang-install.sh uninstall    # 卸载
```

### 访问面板

安装完成后浏览器打开 `http://<服务器IP>:8888`，首次登录按提示设置管理员凭据。

---

## 🛠 构建与发布

发布前用 `build.sh` 重新生成安装脚本与压缩包，并做哈希自检：

```bash
# 1. 生成 qingliang-install.sh + qingliang.tar.gz
bash build.sh -u https://cdn.example.com -p qingliang

# 2. 上传前：核对本地文件与脚本内嵌哈希一致
bash check-local.sh

# 3. 把 panel.py / web/ / qingliang-install.sh 上传到 CDN 后：
bash check-r2.sh https://cdn.example.com qingliang
```

---

## 🔒 安全说明

`.gitignore` 已排除以下敏感 / 二进制内容，**不会进入版本库**：

- `SSH密码.txt`、`panel.conf`（运行配置）
- `ssl/`（证书与私钥）
- `*.tar.gz`、`*.tar.gz.sha256`（发布包）

请勿将服务器密码、私钥等敏感信息写入源码或在公开渠道分享。

---

## 📄 许可

许可协议待定。如需商用或二次分发，请先联系作者。
