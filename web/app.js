"use strict";

const state = {
  token: localStorage.getItem("panel_token") || "",
  view: "overview",
  sites: [],
  fsRoot: "/var/www",
  fsPath: "/var/www",
  selected: {},
  fsEntries: [],
  fsRendered: 0,
  clipboard: null,
  timer: null,
  monoTimer: null,
  logs: [],
  logEntries: [],
  logPage: 1,
  modules: {},
  features: {},
  apps: [],
  appLogTimer: null,
};

const $ = (id) => document.getElementById(id);

function api(method, url, body) {
  const opts = { method, headers: {} };
  if (state.token) opts.headers["Authorization"] = "Bearer " + state.token;
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  return fetch(url, opts).then(async (res) => {
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    if (res.status === 401 && url !== "/api/login") {
      logout();
      throw new Error("unauthorized");
    }
    if (!res.ok) {
      const msg = (data && data.error) || (data && data.msg) || res.statusText;
      throw new Error(msg);
    }
    return data;
  });
}

function toast(msg, ms) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms || 2200);
}

function fmtBytes(n) {
  if (n == null) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + " " + units[i];
}

function fmtDate(ts) {
  if (!ts) return "-";
  const d = new Date(ts * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " +
         p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function fmtUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return (d ? d + " 天 " : "") + h + " 小时 " + m + " 分";
}

function fileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  const map = {
    html: "🌐", htm: "🌐", css: "🎨", js: "⚡", mjs: "⚡", json: "🧩", md: "📝",
    py: "🐍", sh: "🐚", txt: "📄", log: "📋", conf: "⚙️", ini: "⚙️", yml: "⚙️", yaml: "⚙️",
    zip: "🗜️", tar: "🗜️", gz: "🗜️", png: "🖼️", jpg: "🖼️", jpeg: "🖼️", gif: "🖼️", svg: "🖼️", webp: "🖼️",
    ico: "🖼️", mp3: "🎵", mp4: "🎬", pdf: "📕", php: "🐘", sql: "🗄️", xml: "🧾",
  };
  return map[ext] || "📄";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
function escAttr(s) { return esc(s); }
function jsq(s) {
  return "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

/* ---------------- motion ----------------
   Lightweight animation layer: number roll-up, ring gauges, live sparkline
   and cursor spotlight. Everything degrades gracefully under
   prefers-reduced-motion and on very small screens.                        */

const MOTION = {
  reduce: false,
  spark: null,
  clockTimer: null,
  lastStats: null,
};

function motionReduced() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

/* roll a number from its current value to `to` */
function countUp(el, to, opt) {
  if (!el) return;
  const o = opt || {};
  const decimals = o.decimals || 0;
  const suffix = o.suffix || "";
  const raw = parseFloat(String(el.textContent).replace(/[^\d.\-]/g, ""));
  const from = isFinite(raw) ? raw : 0;
  const target = isFinite(to) ? to : 0;

  if (el._raf) { cancelAnimationFrame(el._raf); el._raf = 0; }
  if (MOTION.reduce || Math.abs(target - from) < 0.01) {
    el.textContent = target.toFixed(decimals) + suffix;
    return;
  }
  const dur = o.duration || 900;
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = (from + (target - from) * e).toFixed(decimals) + suffix;
    if (p < 1) el._raf = requestAnimationFrame(step);
    else el._raf = 0;
  };
  el._raf = requestAnimationFrame(step);
}

/* drive one of the overview ring gauges (pathLength = 100) */
const _ringCache = {};
function setRing(key, pct, label) {
  let box = _ringCache[key];
  if (!box || !box.isConnected) {
    box = _ringCache[key] = document.querySelector('[data-ring="' + key + '"]');
  }
  if (!box) return;
  const fill = box.querySelector(".ring-fill");
  const txt = box.querySelector(".ring-pct");
  const v = Math.max(0, Math.min(100, Number(pct) || 0));
  if (fill) {
    fill.style.strokeDashoffset = String(100 - v);
    fill.style.opacity = v < 0.6 ? "0" : "1";
  }
  if (txt) txt.textContent = label != null ? label : Math.round(v) + "%";
}

/* live multi-series sparkline */
function createSpark(canvasId, colors, cap) {
  const noop = { push: function () {}, reset: function () {}, setColor: function () {}, redraw: function () {} };
  const cv = $(canvasId);
  if (!cv || !cv.getContext) return noop;
  const capN = cap || 60;
  const series = colors.map(function () { return []; });
  const ctx = cv.getContext("2d");
  if (!ctx) return noop;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || (cv.parentElement && cv.parentElement.clientWidth) || 260;
    const h = cv.clientHeight || 58;
    const pw = Math.floor(w * dpr), ph = Math.floor(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    let hi = 0;
    series.forEach(function (a) { a.forEach(function (v) { if (v > hi) hi = v; }); });
    if (hi <= 0) hi = 1;

    ctx.strokeStyle = "rgba(128,138,160,.13)";
    ctx.lineWidth = 1;
    [0.28, 0.56, 0.84].forEach(function (f) {
      const y = Math.round(h * f) + 0.5;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    });

    series.forEach(function (arr, si) {
      if (arr.length < 2) return;
      const pad = 3;
      const iw = w - pad * 2, ih = h - pad * 2;
      const px = function (i) { return pad + (i / (arr.length - 1)) * iw; };
      const py = function (v) { return pad + ih - (v / hi) * ih; };

      ctx.beginPath();
      ctx.moveTo(px(0), py(arr[0]));
      for (let i = 1; i < arr.length; i++) {
        const cx = (px(i - 1) + px(i)) / 2;
        ctx.bezierCurveTo(cx, py(arr[i - 1]), cx, py(arr[i]), px(i), py(arr[i]));
      }
      ctx.strokeStyle = colors[si];
      ctx.lineWidth = 1.8;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();

      const lx = px(arr.length - 1), ly = py(arr[arr.length - 1]);
      ctx.globalAlpha = 0.22;
      ctx.beginPath(); ctx.arc(lx, ly, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = colors[si]; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(lx, ly, 2.6, 0, Math.PI * 2);
      ctx.fillStyle = colors[si]; ctx.fill();
    });
  }

  function push(vals) {
    vals.forEach(function (v, i) {
      if (!series[i]) return;
      series[i].push(isFinite(v) ? v : 0);
      if (series[i].length > capN) series[i].shift();
    });
    draw();
  }

  function reset() {
    series.forEach(function (a) { a.length = 0; });
    draw();
  }

  function setColor(i, c) {
    if (i < colors.length && c) { colors[i] = c; draw(); }
  }

  let resizeRaf = 0;
  window.addEventListener("resize", function () {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(function () { resizeRaf = 0; draw(); });
  });
  draw();
  return { push: push, reset: reset, setColor: setColor, redraw: draw };
}

/* cursor spotlight on glass cards — rAF-batched, rect read once per frame
   so a pointermove storm never forces more than one layout read, and the
   glow stays pinned correctly even while the page scrolls underneath. */
function initSpotlight() {
  if (MOTION.reduce) return;
  if (!window.matchMedia || !window.matchMedia("(hover: hover)").matches) return;
  let cur = null, pending = null, raf = 0;

  const apply = function () {
    raf = 0;
    if (cur && pending) {
      const r = cur.getBoundingClientRect();
      cur.style.setProperty("--mx", (pending.x - r.left) + "px");
      cur.style.setProperty("--my", (pending.y - r.top) + "px");
    }
  };
  const schedule = function () { if (!raf) raf = requestAnimationFrame(apply); };
  const clear = function () {
    if (cur) { cur.classList.remove("is-lit"); cur = null; }
    pending = null;
  };

  document.addEventListener("pointermove", function (e) {
    const card = e.target && e.target.closest ? e.target.closest(".card") : null;
    if (card !== cur) {            /* re-measure only when entering a new card */
      clear();
      if (card) { cur = card; card.classList.add("is-lit"); }
    }
    if (cur) { pending = { x: e.clientX, y: e.clientY }; schedule(); }
  }, { passive: true });

  /* keep the cached rect fresh on scroll/resize so the glow stays accurate */
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", schedule, { passive: true });
  document.addEventListener("pointerleave", clear);
}

/* hero helpers */
function greetingText() {
  const h = new Date().getHours();
  if (h < 6) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

function tickHeroClock() {
  const el = $("hero-clock");
  if (!el) return;
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  el.textContent = p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

function initMotion() {
  if (MOTION.ready) return;
  MOTION.ready = true;
  MOTION.reduce = motionReduced();

  const cssVar = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
  MOTION.spark = createSpark("spark-net", [cssVar("--c-net", "#34D399"), cssVar("--c-err", "#FB7185")], 48);

  initSpotlight();
  tickHeroClock();
  if (MOTION.clockTimer) clearInterval(MOTION.clockTimer);
  /* only tick while the overview is actually visible — no work in
     background tabs or on other views */
  MOTION.clockTimer = setInterval(function () {
    if (document.hidden || state.view !== "overview") return;
    tickHeroClock();
  }, 1000);
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && state.view === "overview") tickHeroClock();
  });

  const g = $("hero-greet");
  if (g) g.textContent = greetingText();

  /* keep sparkline colours in sync with the active theme */
  window.addEventListener("qk:theme", () => {
    if (!MOTION.spark || !MOTION.spark.setColor) return;
    MOTION.spark.setColor(0, cssVar("--c-net", "#34D399"));
    MOTION.spark.setColor(1, cssVar("--c-err", "#FB7185"));
  });
}

/* ---------------- auth ---------------- */

function logout() {
  state.token = "";
  localStorage.removeItem("panel_token");
  $("app").classList.add("hidden");
  $("login-screen").classList.remove("hidden");
  $("login-pass").value = "";
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}
function initLogin() {
  if (state.token) {
    api("GET", "/api/info").then(() => enterApp()).catch(() => logout());
  } else {
    $("login-screen").classList.remove("hidden");
  }
}

function enterApp() {
  $("login-screen").classList.add("hidden");
  $("app").classList.remove("hidden");
  loadModules();
  switchView("overview");
  loadOverview();
  initMotion();
  state.timer = setInterval(() => {
    if (document.hidden) return;   /* no point polling a tab nobody is looking at */
    if (state.view === "overview") loadOverview(true);
    if (state.view === "sites") loadSites(true);
    if (state.view === "monitor") loadMonitor(true);
  }, 10000);
}

$("login-btn").addEventListener("click", doLogin);
$("login-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("login-user").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

function doLogin() {
  const user = $("login-user").value;
  const pw = $("login-pass").value;
  const btn = $("login-btn");
  btn.disabled = true;
  api("POST", "/api/login", { username: user, password: pw })
    .then((r) => {
      state.token = r.token;
      localStorage.setItem("panel_token", r.token);
      $("login-msg").textContent = "";
      enterApp();
    })
    .catch((e) => {
      $("login-msg").textContent = e.message;
    })
    .finally(() => { btn.disabled = false; });
}

$("logout-btn").addEventListener("click", logout);

/* ---------------- nav ---------------- */

document.querySelectorAll(".nav-item").forEach((el) => {
  el.addEventListener("click", () => switchView(el.dataset.view));
});

function switchView(v) {
  if (v !== "settings" && ["ftp", "cron", "monitor", "logs"].indexOf(v) >= 0 && !state.modules[v]) {
    toast("该模块未安装，请到设置中勾选安装");
    return;
  }
  state.view = v;
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === v);
  });
  const titles = { overview: "概览", sites: "网站管理", apps: "应用市场", files: "文件管理", monitor: "监控看板", ftp: "FTP 管理", cron: "计划任务", logs: "操作日志", settings: "设置" };
  $("page-title").textContent = titles[v] || v;
  document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
  $("view-" + v).classList.remove("hidden");
  if (v === "overview" && MOTION.spark && MOTION.spark.redraw) MOTION.spark.redraw();
  if (v === "sites") loadSites();
  if (v === "apps") loadApps();
  if (v === "files") loadFileRoots();
  if (v === "monitor") loadMonitor();
  if (v === "ftp") loadFtp();
  if (v === "cron") loadCron();
  if (v === "logs") loadLogList();
  if (v === "settings") { loadInfo(); loadErrorDefaults(); }
  if (v !== "apps" && state.appLogTimer) {
    clearInterval(state.appLogTimer);
    state.appLogTimer = null;
  }
  document.querySelectorAll(".settab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".settab-pane").forEach((el) => el.classList.add("hidden"));
  document.querySelector('[data-settab="base"]').classList.add("active");
  $("settab-base").classList.remove("hidden");
}

document.querySelectorAll(".settab-btn").forEach((b) => {
  b.addEventListener("click", () => {
    const tab = b.dataset.settab;
    document.querySelectorAll(".settab-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll(".settab-pane").forEach((el) => el.classList.add("hidden"));
    $("settab-" + tab).classList.remove("hidden");
    if (tab === "err") loadErrorDefaults();
    if (tab === "mod") loadInfo();
    if (tab === "feat") loadFeatures();
  });
});

/* ---------------- modules ---------------- */

const MODULE_UI = {
  ftp: { icon: "⇄", name: "FTP 管理", desc: "内置 FTP 服务端（端口 21）与账号管理，开启后监听 21 端口" },
  cron: { icon: "◷", name: "计划任务", desc: "cron 调度器，支持 Shell 命令 / 访问 URL，不运行时零消耗" },
  monitor: { icon: "◔", name: "监控看板", desc: "监控采样线程 + 图表 + 概览页实时流量，默认不启动采样" },
  logs: { icon: "≡", name: "操作日志", desc: "记录建站、删站、文件增删改、FTP、计划任务等关键操作" },
};

function applyNav() {
  ["ftp", "cron", "monitor", "logs"].forEach((m) => {
    const item = document.querySelector('.nav-item[data-view="' + m + '"]');
    if (item) item.classList.toggle("hidden", !state.modules[m]);
  });
  const netCard = $("ov-net-card");
  if (netCard) netCard.classList.toggle("hidden", !state.modules.monitor);
}

function loadModules() {
  api("GET", "/api/info").then((d) => {
    state.modules = d.modules || {};
    state.features = d.features || {};
    state.apps = Object.keys(d.apps || {}).map((k) => ({
      id: k, installed: !!(d.apps[k] && d.apps[k].installed),
      version: (d.apps[k] && d.apps[k].version) || "-",
      extra: (d.apps[k] && d.apps[k].extra) || "",
    }));
    applyNav();
    renderModuleList();
  }).catch(() => {});
}

function renderModuleList() {
  const box = $("mod-list");
  if (!box) return;
  box.innerHTML = ["ftp", "cron", "monitor", "logs"].map((m) =>
    '<label class="check mod-check">' +
      '<input type="checkbox" id="mod-' + m + '"' + (state.modules[m] ? " checked" : "") + "> " +
      "<b>" + esc(MODULE_UI[m].name) + "</b>" +
      '<span class="muted small" style="display:block;margin-left:24px">' + esc(MODULE_UI[m].desc) + "</span>" +
    "</label>"
  ).join("");
}

function saveModules() {
  const body = {};
  ["ftp", "cron", "monitor", "logs"].forEach((m) => { body[m] = $("mod-" + m).checked; });
  const btn = $("mod-save");
  btn.disabled = true;
  const msg = $("mod-msg");
  msg.textContent = "";
  msg.className = "msg";
  api("POST", "/api/modules", body)
    .then((r) => {
      msg.textContent = r.msg || "已保存";
      msg.className = "msg" + (r.restart === false ? " err" : "");
      toast("模块配置已保存，面板重启中…");
      setTimeout(() => {
        localStorage.removeItem("panel_token");
        state.token = "";
        location.reload();
      }, 3500);
    })
    .catch((e) => {
      btn.disabled = false;
      msg.textContent = "保存失败：" + e.message;
      msg.className = "msg err";
    });
}

/* ---------------- app store ---------------- */

$("apps-refresh").addEventListener("click", loadApps);

function loadApps() {
  api("GET", "/api/apps").then((d) => {
    state.apps = d.apps || [];
    renderApps();
    const busy = state.apps.find((a) => a.busy);
    if (busy) startAppLogPoll(busy.id);
  }).catch((e) => toast(e.message));
}

function startAppLogPoll(aid) {
  if (state.appLogTimer) return;
  $("apps-log-card").classList.remove("hidden");
  const poll = () => {
    api("GET", "/api/apps/log?name=" + encodeURIComponent(aid))
      .then((d) => {
        $("apps-log").textContent = (d.lines || []).join("\n");
        $("apps-log").scrollTop = $("apps-log").scrollHeight;
      }).catch(() => {});
  };
  poll();
  state.appLogTimer = setInterval(() => {
    const stillBusy = state.apps.some((a) => a.busy);
    if (!stillBusy) {
      clearInterval(state.appLogTimer);
      state.appLogTimer = null;
      loadApps();
      return;
    }
    poll();
  }, 2000);
}

function renderApps() {
  const box = $("apps-list");
  box.innerHTML = state.apps.map((a) => {
    const btn = a.busy
      ? '<button class="btn btn-mini" disabled>处理中…</button>'
      : (a.installed
          ? '<button class="btn btn-mini btn-outline" onclick="uninstallApp(' + jsq(a.id) + ')">卸载</button>'
          : '<button class="btn btn-mini btn-primary" onclick="installApp(' + jsq(a.id) + ')">安装</button>');
    const ver = a.installed ? '<div class="app-ver">' + esc(a.version) + "</div>" : '<div class="app-ver muted">未安装</div>';
    const extra = a.extra ? '<div class="muted small">' + esc(a.extra) + "</div>" : "";
    return (
      '<div class="card app-card">' +
        '<div class="app-head">' +
          '<span class="app-icon">' + (a.icon || "▦") + "</span>" +
          "<div>" +
            '<div class="app-name">' + esc(a.name) + "</div>" +
            ver +
          "</div>" +
        "</div>" +
        '<div class="muted small" style="margin-top:8px">' + esc(a.desc) + "</div>" +
        '<div class="muted small mono" style="margin-top:6px;font-size:11px">' + esc(a.pkgs) + "</div>" +
        extra +
        '<div class="app-actions" style="margin-top:12px">' + btn + "</div>" +
      "</div>"
    );
  }).join("");
}

window.installApp = (aid) => {
  api("POST", "/api/apps/install", { name: aid })
    .then((r) => {
      toast(r.msg || (r.ok ? "开始安装" : "操作失败"));
      if (r.ok) loadApps();
    })
    .catch((e) => toast(e.message));
};

window.uninstallApp = (aid) => {
  api("POST", "/api/apps/uninstall", { name: aid })
    .then((r) => {
      toast(r.msg || (r.ok ? "开始卸载" : "操作失败"));
      if (r.ok) loadApps();
    })
    .catch((e) => toast(e.message));
};

/* ---------------- features ---------------- */

function loadFeatures() {
  api("GET", "/api/info").then((d) => {
    state.features = d.features || {};
    const box = $("feat-php-status");
    if (box) {
      const php = (d.apps && d.apps.php82) || {};
      box.textContent = php.installed
        ? "PHP 8.2 已安装（" + (php.version || "") + "）" + (php.extra ? "，" + php.extra : "")
        : "PHP 8.2 未安装，请先到「应用市场」安装";
    }
    const cb = $("feat-php");
    if (cb) cb.checked = !!state.features.php;
  }).catch(() => {});
}

$("feat-save").addEventListener("click", () => {
  const msg = $("feat-msg");
  msg.textContent = "";
  msg.className = "msg";
  api("POST", "/api/features", { php: $("feat-php").checked })
    .then((r) => {
      msg.textContent = r.msg || "已保存";
      msg.className = "msg ok";
      toast("功能设置已保存");
    })
    .catch((e) => { msg.textContent = "保存失败：" + e.message; msg.className = "msg err"; });
});

/* ---------------- overview ---------------- */

function loadOverview(silent) {
  api("GET", "/api/stats")
    .then((s) => {
      const el = (id) => document.getElementById(id);
      MOTION.lastStats = s;

      /* CPU */
      const cpu = Number(s.cpu) || 0;
      countUp(el("stat-cpu"), cpu, { decimals: 1, suffix: "%" });
      setRing("cpu", cpu, Math.round(cpu) + "%");
      el("bar-cpu").style.width = Math.min(100, cpu) + "%";
      if (el("stat-cpu-sub")) {
        el("stat-cpu-sub").textContent =
          (s.cpus ? s.cpus + " 核" : "-") + (s.load && s.load.length ? " · 负载 " + s.load[0] : "");
      }

      /* memory */
      const memUsed = s.mem_total - s.mem_avail;
      const memPct = s.mem_total ? (memUsed / s.mem_total) * 100 : 0;
      countUp(el("stat-mem-pct"), memPct, { decimals: 0, suffix: "%" });
      setRing("mem", memPct, Math.round(memPct) + "%");
      el("stat-mem").textContent = fmtBytes(memUsed) + " / " + fmtBytes(s.mem_total);
      el("bar-mem").style.width = Math.min(100, memPct) + "%";

      /* disk */
      const diskUsed = s.disk_total - s.disk_free;
      const diskPct = s.disk_total ? (diskUsed / s.disk_total) * 100 : 0;
      countUp(el("stat-disk-pct"), diskPct, { decimals: 0, suffix: "%" });
      setRing("disk", diskPct, Math.round(diskPct) + "%");
      el("stat-disk").textContent = fmtBytes(diskUsed) + " / " + fmtBytes(s.disk_total);
      el("bar-disk").style.width = Math.min(100, diskPct) + "%";

      /* nginx */
      const nginxOn = !!s.nginx;
      el("stat-nginx").textContent = nginxOn ? "运行中" : "停止";
      el("stat-nginx").style.color = nginxOn ? "var(--bc-success)" : "var(--bc-danger)";
      el("stat-nginx-sub").textContent = nginxOn ? "服务正常" : "需要检查";
      setRing("nginx", nginxOn ? 100 : 100, nginxOn ? "✓" : "✕");
      const nf = document.querySelector('[data-ring="nginx"] .ring-fill');
      if (nf) nf.style.stroke = nginxOn ? "var(--c-ok)" : "var(--c-err)";
      const np = document.querySelector('[data-ring="nginx"] .ring-pct');
      if (np) np.style.color = nginxOn ? "var(--c-ok)" : "var(--c-err)";
      el("bar-nginx").style.width = nginxOn ? "100%" : "0%";
      el("bar-nginx").style.background = nginxOn ? "var(--c-ok)" : "var(--c-err)";

      /* hero */
      if (el("hero-greet")) el("hero-greet").textContent = greetingText();
      if (el("hero-host")) el("hero-host").textContent = s.hostname || "服务器";
      if (el("hero-uptime")) el("hero-uptime").textContent = fmtUptime(s.uptime);
      if (el("hero-load") && s.load) el("hero-load").textContent = s.load.join(" / ");
      if (el("hero-status")) el("hero-status").textContent = nginxOn ? "系统运行正常" : "NGINX 未运行";
      if (el("hero-pulse")) el("hero-pulse").classList.toggle("is-off", !nginxOn);
      if (el("hero-sub")) {
        el("hero-sub").textContent =
          (s.cpus ? s.cpus + " 核 CPU · " : "") + fmtBytes(s.mem_total) + " 内存 · " + (s.procs || "-") + " 个进程";
      }

      /* system info table */
      if (el("ov-host")) el("ov-host").textContent = s.hostname;
      if (el("ov-kernel")) el("ov-kernel").textContent = s.uname;
      if (el("ov-load")) el("ov-load").textContent = s.load.join("  ");
      if (el("ov-procs")) el("ov-procs").textContent = s.procs;
      if (el("ov-uptime")) el("ov-uptime").textContent = fmtUptime(s.uptime);

      /* network */
      const rx = s.net_rx_rate != null ? Number(s.net_rx_rate) : 0;
      const tx = s.net_tx_rate != null ? Number(s.net_tx_rate) : 0;
      if (el("ov-rx")) el("ov-rx").textContent = s.net_rx_rate != null ? fmtBytes(rx) + "/s" : "--";
      if (el("ov-tx")) el("ov-tx").textContent = s.net_tx_rate != null ? fmtBytes(tx) + "/s" : "--";
      if (el("ov-rx-total")) el("ov-rx-total").textContent = fmtBytes(s.net_rx);
      if (el("ov-tx-total")) el("ov-tx-total").textContent = fmtBytes(s.net_tx);
      if (MOTION.spark && (rx || tx)) MOTION.spark.push([rx, tx]);

      $("sys-host").textContent = s.hostname;
      const cores = s.cpus ? s.cpus : "N";
      $("foot-res").textContent = cores + " 核 CPU / " + fmtBytes(s.mem_total) + " 内存 / Python 标准库 · 零依赖";
      if (el("ov-sites")) el("ov-sites").textContent = (s.site_count != null ? s.site_count : "-") + " 个";
      if (el("ov-domains")) el("ov-domains").textContent = (s.domain_count != null ? s.domain_count : "-") + " 个";
      if (el("ov-ports")) el("ov-ports").textContent = s.used_ports || "-";
    })
    .catch(() => { if (!silent) toast("获取系统状态失败"); });
}

/* ---------------- sites ---------------- */

$("new-site-btn").addEventListener("click", openNewSite);
$("renew-ssl-btn").addEventListener("click", () => {
  api("POST", "/api/ssl/renew")
    .then((r) => toast(r.ok ? "证书续期完成" : "续期失败"))
    .catch((e) => toast(e.message));
});
$("reload-nginx-btn").addEventListener("click", () => {
  api("POST", "/api/nginx/reload")
    .then((r) => toast(r.ok ? "Nginx 已重载" : "配置错误"))
    .catch((e) => toast(e.message));
});

$("release-btn").addEventListener("click", () => {
  api("POST", "/api/system/release")
    .then((r) => {
      const det = (r.detail || []).join("；");
      toast((r.ok ? "释放完成：" : "释放失败：") + (det || r.msg || ""));
    })
    .catch((e) => toast(e.message));
});

/* one delegated listener for all site-row actions — survives innerHTML rebuilds */
$("site-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const name = btn.dataset.name, act = btn.dataset.act;
  if (act === "config") openSiteConfig(name);
  else if (act === "bind") openBind(name);
  else if (act === "ssl") openSSL(name);
  else if (act === "files") goFiles(name);
  else if (act === "del") openDelete(name);
});

function loadSites(silent) {
  api("GET", "/api/sites")
    .then((d) => {
      state.sites = d.sites;
      renderSites();
    })
    .catch((e) => { if (!silent) toast("获取网站列表失败"); });
}

function renderSites() {
  const box = $("site-list");
  let html;
  if (!state.sites.length) {
    html = '<div class="empty">还没有网站，点击右上角「新建网站」</div>';
  } else {
  const head = (
    '<div class="site-grid-head">' +
      '<span class="site-head-label">网站</span>' +
      '<span class="site-head-label">域名</span>' +
      '<span class="site-head-label">SSL</span>' +
      '<span class="site-head-label">根目录</span>' +
      '<span class="site-head-label">备注</span>' +
      '<span class="site-head-label">空间</span>' +
      '<span class="site-head-label">日流量</span>' +
      '<span class="site-head-label">操作</span>' +
    "</div>"
  );
  const rows = state.sites.map((s) => {
    const enabled = s.enabled
      ? '<span class="badge badge-on">启用</span>'
      : '<span class="badge badge-off">停用</span>';
    const note = s.note ? '<div class="site-note">' + esc(s.note) + "</div>" : '<div class="site-note">-</div>';
    const domain = s.domains.length ? s.domains[0] : "";
    const sPort = s.port || 80;
    const sslOn = !!(s.ssl && s.ssl.enabled);
    const proto = sslOn ? "https" : "http";
    const suffix = (sPort === 80 || sPort === 443) ? "" : ":" + sPort;
    const host = domain || location.hostname;
    const visitBtn = host
      ? '<a class="site-visit" href="' + proto + '://' + esc(host) + suffix + '" target="_blank" title="访问网站">访问 ↗</a>'
      : "";
    const diskInfo = s.disk_usage
      ? '<div class="site-disk">' + esc(s.disk_usage) + "</div>"
      : '<div class="site-disk">-</div>';
    const trafficInfo = s.daily_traffic
      ? '<div class="site-traffic">' + esc(s.daily_traffic) + "</div>"
      : '<div class="site-traffic">-</div>';
    const domains = s.domains.length
      ? s.domains.map((d) => '<div class="domain-line">' + esc(d) + '</div>').join("")
      : '<div class="domain-line">' + esc(location.hostname) + ":" + sPort + '</div>';
    const sslCell = sslOn
      ? '<span class="ssl-cell ssl-on" title="到期：' + esc((s.ssl && s.ssl.expiry) || "-") + '">已部署' +
        (s.ssl && s.ssl.days_left != null ? " · " + s.ssl.days_left + " 天" : "") + "</span>"
      : '<span class="ssl-cell ssl-off">未部署</span>';
    const rtBadge = s.runtime === "php"
      ? '<span class="badge badge-php" title="PHP 运行环境">PHP</span>'
      : "";
    return (
      '<div class="site-item">' +
        '<div class="site-name">' + esc(s.name) + rtBadge + " " + enabled + "</div>" +
        '<div class="site-col site-domains">' + domains + "</div>" +
        '<div class="site-col site-ssl">' + sslCell + "</div>" +
        '<div class="site-col root-path">根目录 ' + esc(s.root || "/var/www/" + s.name) + "</div>" +
        "<div class='site-col'>" + note + "</div>" +
        "<div class='site-col'>" + diskInfo + "</div>" +
        "<div class='site-col'>" + trafficInfo + "</div>" +
        '<div class="site-actions">' +
          visitBtn +
          '<button class="btn btn-mini btn-primary" data-act="config" data-name="' + escAttr(s.name) + '">配置</button>' +
          '<button class="btn btn-mini btn-outline" data-act="bind" data-name="' + escAttr(s.name) + '">绑定域名</button>' +
          '<button class="btn btn-mini btn-outline" data-act="ssl" data-name="' + escAttr(s.name) + '">SSL</button>' +
          '<button class="btn btn-mini btn-outline" data-act="files" data-name="' + escAttr(s.root || "/var/www/" + s.name) + '">文件</button>' +
          '<button class="btn btn-mini btn-danger" data-act="del" data-name="' + escAttr(s.name) + '">删除</button>' +
        "</div>" +
      "</div>"
    );
  }).join("");
    html = head + rows;
  }
  if (renderSites._last === html) return;   /* data unchanged → skip DOM rebuild */
  renderSites._last = html;
  box.innerHTML = html;
}

function openModal(html) {
  $("modal-box").innerHTML = html;
  $("modal").classList.remove("hidden");
}
function closeModal() {
  $("modal").classList.add("hidden");
  $("modal-box").classList.remove("modal-wide");
}
$("modal-mask").addEventListener("click", closeModal);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

function openNewSite() {
  const phpReady = state.features.php && (state.apps.find((a) => a.id === "php82") || {}).installed;
  const rtHint = phpReady
    ? ""
    : '<div class="muted small">（PHP 运行环境需先在应用市场安装 PHP 8.2，并在 设置 → 功能开关 开启 PHP 支持）</div>';
  openModal(
    '<div class="modal-title">新建网站</div>' +
    '<label class="small muted">网站名称（支持中文/字母/数字/-/_）</label>' +
    '<input id="ns-name" class="field" placeholder="myblog" spellcheck="false">' +
    '<label class="small muted">绑定域名（多个用空格分隔，可留空）</label>' +
    '<input id="ns-domains" class="field" placeholder="example.com www.example.com" spellcheck="false">' +
    '<label class="small muted">监听端口（默认 80；留空域名时用 IP+端口 访问）</label>' +
    '<input id="ns-port" class="field" type="number" min="1" max="65535" value="80">' +
    '<label class="small muted">运行环境</label>' +
    '<select id="ns-runtime" class="select">' +
      '<option value="static" selected>静态 HTML</option>' +
      '<option value="php"' + (phpReady ? "" : " disabled") + ">PHP 8.2" + (phpReady ? "" : "（未就绪）") + "</option>" +
    "</select>" +
    rtHint +
    '<label class="small muted">根目录（已按域名/端口自动填入，可直接修改，如 blog → /var/www/blog；清空则重新自动生成）</label>' +
    '<input id="ns-root" class="field" spellcheck="false">' +
    '<div id="ns-root-preview" class="muted small mono" style="margin:2px 0 6px"></div>' +
    '<label class="small muted">备注</label>' +
    '<input id="ns-note" class="field" placeholder="选填" spellcheck="false">' +
    '<div class="modal-actions">' +
      '<button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
      '<button class="btn btn-primary" id="ns-submit">创建</button>' +
    "</div>"
  );
    let rootTouched = false;
  const autoDir = () => {
    const dl = $("ns-domains").value.trim().split(/\s+/).filter(Boolean);
    if (dl.length) return dl[0].replace(/\./g, "").replace(/[^a-zA-Z0-9_\-]/g, "");
    return "DK" + (parseInt($("ns-port").value, 10) || 80);
  };
  const previewRoot = () => {
    const r = $("ns-root").value.trim();
    const full = r.startsWith("/") ? r : (r ? "/var/www/" + r : "/var/www/" + autoDir());
    $("ns-root-preview").textContent = "根目录：" + full;
  };
  $("ns-root").addEventListener("input", () => {
    rootTouched = $("ns-root").value.trim().length > 0;
    previewRoot();
  });
  $("ns-domains").addEventListener("input", () => {
    if (!rootTouched) $("ns-root").value = autoDir();
    previewRoot();
  });
  $("ns-port").addEventListener("input", () => {
    if (!rootTouched) $("ns-root").value = autoDir();
    previewRoot();
  });
  previewRoot();
  $("ns-submit").addEventListener("click", () => {
    const name = $("ns-name").value.trim();
    const domains = $("ns-domains").value.trim().split(/\s+/).filter(Boolean);
    const root = $("ns-root").value.trim();
    const note = $("ns-note").value.trim();
    const port = parseInt($("ns-port").value, 10) || 80;
    if (!name) return toast("请输入网站名称");
    if (port < 1 || port > 65535) return toast("端口必须在 1-65535 之间");
    if (root && root.startsWith("/") && !root.startsWith("/var/www/")) return toast("完整路径必须以 /var/www/ 开头");
    api("POST", "/api/sites", { name, domains, root, note, port, runtime: $("ns-runtime").value })
      .then((r) => { closeModal(); toast(r.ok ? "网站创建成功" : r.msg); loadSites(); })
      .catch((e) => toast(e.message));
  });
}

function openBind(name) {
  const site = state.sites.find((s) => s.name === name);
  api("GET", "/api/sites/" + encodeURIComponent(name)).then((s) => {
    openModal(
      '<div class="modal-title">绑定域名 · ' + esc(name) + "</div>" +
      '<div class="muted small">请先在 DNS 中将域名解析到本机 IP，然后保存。</div><br>' +
      '<input id="bd-domains" class="field" value="' + escAttr(s.domains.join(" ")) + '" placeholder="example.com www.example.com" spellcheck="false">' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
        '<button class="btn btn-primary" id="bd-submit">保存</button>' +
      "</div>"
    );
    $("bd-submit").addEventListener("click", () => {
      const domains = $("bd-domains").value.trim().split(/\s+/).filter(Boolean);
      api("POST", "/api/sites/" + encodeURIComponent(name) + "/domains", { domains })
        .then((r) => { closeModal(); toast(r.ok ? "域名已更新" : r.msg); loadSites(); })
        .catch((e) => toast(e.message));
    });
  });
}

function openSSL(name) {
  const site = state.sites.find((s) => s.name === name);
  api("GET", "/api/sites/" + encodeURIComponent(name) + "/ssl-files").then((sf) => {
    openModal(
      '<div class="modal-title">SSL 证书 · ' + esc(name) + "</div>" +
      '<div class="muted small">使用 Let\'s Encrypt（certbot --nginx）自动申请，或上传自有证书文件。</div><br>' +
      '<div class="modal-tabs">' +
        '<button class="tab-btn active" data-tab="issue">自动申请</button>' +
        '<button class="tab-btn" data-tab="upload">上传证书</button>' +
      "</div>" +
      '<div id="tab-issue">' +
        '<label class="small muted">申请证书的域名</label>' +
        '<input id="ssl-domain" class="field" value="' + escAttr(site.domains[0] || "") + '" placeholder="example.com" spellcheck="false">' +
        '<label class="small muted">邮箱（用于续期通知）</label>' +
        '<input id="ssl-email" class="field" placeholder="admin@example.com" spellcheck="false">' +
      "</div>" +
      '<div id="tab-upload" class="hidden">' +
        '<label class="small muted">证书内容（PEM）</label>' +
        '<textarea id="ssl-cert" class="editor" style="min-height:120px" placeholder="-----BEGIN CERTIFICATE-----..." spellcheck="false">' + esc(sf.cert || "") + "</textarea>" +
        '<label class="small muted">私钥内容（PEM）</label>' +
        '<textarea id="ssl-key" class="editor" style="min-height:120px" placeholder="-----BEGIN PRIVATE KEY-----..." spellcheck="false">' + esc(sf.key || "") + "</textarea>" +
      "</div>" +
      '<div id="ssl-out" class="mono hidden"></div>' +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" onclick="closeModal()">关闭</button>' +
        '<button class="btn btn-primary" id="ssl-submit">应用</button>' +
      "</div>"
    );
    document.querySelectorAll("#modal .tab-btn").forEach((b) => {
      b.addEventListener("click", () => {
        document.querySelectorAll("#modal .tab-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        $("tab-issue").classList.toggle("hidden", b.dataset.tab !== "issue");
        $("tab-upload").classList.toggle("hidden", b.dataset.tab !== "upload");
      });
    });
    $("ssl-submit").addEventListener("click", () => {
    const btn = $("ssl-submit");
    btn.disabled = true;
    btn.textContent = "处理中…";
    const out = $("ssl-out");
    const activeTab = document.querySelector("#modal .tab-btn.active").dataset.tab;
    const body = activeTab === "issue"
      ? { domain: $("ssl-domain").value.trim(), email: $("ssl-email").value.trim() }
      : { cert: $("ssl-cert").value, key: $("ssl-key").value };
    const url = activeTab === "issue"
      ? "/api/sites/" + encodeURIComponent(name) + "/ssl"
      : "/api/sites/" + encodeURIComponent(name) + "/ssl-upload";
    out.classList.remove("hidden");
    out.textContent = "正在处理，可能需要几十秒…";
    api("POST", url, body)
      .then((r) => {
        out.textContent = (r.detail || r.msg || "").slice(-1500);
        toast(r.ok ? "SSL 配置成功" : (r.msg || "SSL 处理失败，请看下方输出"));
        loadSites();
      })
      .catch((e) => { out.textContent = e.message; })
      .finally(() => { btn.disabled = false; btn.textContent = "应用"; });
  });
  }).catch((e) => toast(e.message));
}

function openDelete(name) {
  const site = state.sites.find((s) => s.name === name);
  openModal(
    '<div class="modal-title">删除网站 · ' + esc(name) + "</div>" +
    '<div class="muted small">将删除 Nginx 配置。是否同时删除根目录文件？</div><br>' +
    '<div class="mono">' + esc(site ? site.root : "/var/www/" + name) + "</div>" +
    '<div class="modal-actions">' +
      '<button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
      '<button class="btn btn-danger" id="del-no">仅删除配置</button>' +
      '<button class="btn btn-danger" id="del-yes">连同文件删除</button>' +
    "</div>"
  );
  $("del-no").addEventListener("click", () => doDelete(name, true));
  $("del-yes").addEventListener("click", () => doDelete(name, false));
}

function doDelete(name, keep) {
  api("DELETE", "/api/sites?name=" + encodeURIComponent(name) + "&keep=" + (keep ? "1" : "0"))
    .then((r) => { closeModal(); toast(r.ok ? "已删除" : r.msg); loadSites(); })
    .catch((e) => toast(e.message));
}

/* ---------------- site config dialog ---------------- */

window.openSiteConfig = (name) => {
  api("GET", "/api/sites/" + encodeURIComponent(name)).then((s) => {
    const cors = s.cors || {};
    const hot = s.hotlink || {};
    const eps = s.error_pages || {};
    const rds = (s.redirects || []).map((r) =>
      '<div class="rd-row"><input class="field rd-path" placeholder="/old" value="' + escAttr(r.path) + '">' +
      '<input class="field rd-target" placeholder="https://new" value="' + escAttr(r.target) + '">' +
      '<select class="select rd-code"><option value="301"' + (r.code === 301 ? " selected" : "") + '>301</option>' +
      '<option value="302"' + (r.code === 302 ? " selected" : "") + '>302</option>' +
      '<option value="308"' + (r.code === 308 ? " selected" : "") + '>308</option></select>' +
      '<button class="btn btn-mini btn-danger rd-del">×</button></div>'
    ).join("");
    const prot = (s.protect || []).map((p) =>
      '<div class="pt-row"><input class="field pt-path" value="' + escAttr(p) + '">' +
      '<button class="btn btn-mini btn-danger pt-del">×</button></div>'
    ).join("");
    const cb = (id, on, lbl) => '<label class="check"><input type="checkbox" id="' + id + '"' + (on ? " checked" : "") + "> " + lbl + "</label>";

    openModal(
      '<div class="modal-title">网站配置 · ' + esc(s.name) + "</div>" +
      '<div class="modal-tabs">' +
        '<button class="tab-btn active" data-tab="basic">基本</button>' +
        '<button class="tab-btn" data-tab="ssl">SSL</button>' +
        '<button class="tab-btn" data-tab="sec">防盗链/CORS</button>' +
        '<button class="tab-btn" data-tab="err">错误页/重定向</button>' +
        '<button class="tab-btn" data-tab="protect">目录保护</button>' +
      "</div>" +
      '<div id="tab-basic">' +
        '<label class="small muted">备注</label>' +
        '<input id="sc-note" class="field" value="' + escAttr(s.note || "") + '" placeholder="选填" spellcheck="false">' +
        '<label class="small muted">运行环境</label>' +
        '<select id="sc-runtime" class="select">' +
          '<option value="static"' + (s.runtime === "php" ? "" : " selected") + ">静态 HTML</option>" +
          '<option value="php"' + (s.runtime === "php" ? " selected" : "") + ">PHP 8.2</option>" +
        "</select>" +
        '<label class="small muted">域名（多个用空格分隔）</label>' +
        '<input id="sc-domains" class="field" value="' + escAttr(s.domains.join(" ")) + '" spellcheck="false">' +
        '<label class="small muted">监听端口（默认 80；留空域名时用 IP+端口 访问）</label>' +
        '<input id="sc-port" class="field" type="number" min="1" max="65535" value="' + (s.port || 80) + '">' +
        '<label class="small muted">根目录（完整路径）</label>' +
        '<input id="sc-root" class="field" value="' + escAttr(s.root || "/var/www/" + s.name) + '" spellcheck="false">' +
        '<label class="small muted">默认文档</label>' +
        '<input id="sc-index" class="field" value="' + escAttr(s.default_doc || "index.html index.htm index.php") + '" spellcheck="false">' +
      "</div>" +
      '<div id="tab-ssl" class="hidden">' +
        '<div class="kv">' +
          '<div class="row"><span>证书到期</span><span id="sc-expiry">' + esc((s.ssl && s.ssl.expiry) || "无") + "</span></div>" +
          '<div class="row"><span>剩余天数</span><span id="sc-days">' + ((s.ssl && s.ssl.days_left != null) ? s.ssl.days_left + " 天" : "-") + "</span></div>" +
        "</div>" +
        '<div class="muted small" style="margin:10px 0 8px">证书管理请到网站列表的「SSL」按钮，支持自动申请与上传更换。</div>' +
        '<div class="modal-tabs" style="margin-top:12px">' +
          '<button class="tab-btn active" data-tab="ssl-issue">自动申请</button>' +
          '<button class="tab-btn" data-tab="ssl-upload">上传证书</button>' +
        "</div>" +
        '<div id="ssl-issue">' +
          '<label class="small muted">申请证书的域名</label>' +
          '<input id="sc-ssl-domain" class="field" value="' + escAttr((s.domains && s.domains[0]) || "") + '" placeholder="example.com" spellcheck="false">' +
          '<label class="small muted">邮箱（用于续期通知）</label>' +
          '<input id="sc-ssl-email" class="field" placeholder="admin@example.com" spellcheck="false">' +
        "</div>" +
        '<div id="ssl-upload" class="hidden">' +
          '<label class="small muted">证书内容（PEM）</label>' +
          '<textarea id="sc-ssl-cert" class="editor" style="min-height:100px" placeholder="-----BEGIN CERTIFICATE-----..." spellcheck="false"></textarea>' +
          '<label class="small muted">私钥内容（PEM）</label>' +
          '<textarea id="sc-ssl-key" class="editor" style="min-height:100px" placeholder="-----BEGIN PRIVATE KEY-----..."></textarea>' +
        "</div>" +
        '<div id="sc-ssl-out" class="mono hidden"></div>' +
      "</div>" +
      '<div id="tab-sec" class="hidden">' +
        cb("sc-hot", hot.enabled, "启用防盗链") + "<br>" +
        '<label class="small muted">允许的来源域名（空格分隔）</label>' +
        '<input id="sc-referers" class="field" value="' + escAttr((hot.referers || []).join(" ")) + '" spellcheck="false">' +
        cb("sc-cors", cors.enabled, "启用 CORS") + "<br>" +
        '<label class="small muted">允许来源（* 或具体域名）</label>' +
        '<input id="sc-cors-origin" class="field" value="' + escAttr(cors.origin || "*") + '" spellcheck="false">' +
      "</div>" +
      '<div id="tab-err" class="hidden">' +
        '<div class="muted small">启用后自动生成对应错误页面。</div><br>' +
        cb("sc-404", !!eps["404"], "404 Not Found") + " " +
        cb("sc-403", !!eps["403"], "403 Forbidden") + " " +
        cb("sc-500", !!eps["500"], "500 Internal") + "<br>" +
        cb("sc-502", !!eps["502"], "502 Bad Gateway") + " " +
        cb("sc-503", !!eps["503"], "503 Unavailable") + " " +
        cb("sc-504", !!eps["504"], "504 Timeout") + "<br><br>" +
        '<button class="btn btn-mini btn-outline" id="err-manage">管理错误页内容（编辑/上传/下载/删除）</button>' +
        '<div class="muted small" style="margin-top:10px">重定向规则（源路径 → 目标 URL）</div><br>' +
        '<div id="rd-list">' + (rds || '<div class="muted small">暂无重定向规则</div>') + "</div>" +
        '<button class="btn btn-mini btn-ghost" id="rd-add">+ 添加重定向</button>' +
      "</div>" +
      '<div id="tab-protect" class="hidden">' +
        '<div class="muted small">受保护目录（访问返回 403），如：admin、backup、.git</div><br>' +
        '<div id="pt-list">' + (prot || '<div class="muted small">暂无受保护目录</div>') + "</div>" +
        '<button class="btn btn-mini btn-ghost" id="pt-add">+ 添加目录</button>' +
      "</div>" +
      '<div class="modal-actions">' +
        '<button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
        '<button class="btn btn-primary" id="sc-save">保存</button>' +
      "</div>"
    );

    document.querySelectorAll("#modal .tab-btn").forEach((b) => {
      b.addEventListener("click", () => {
        const tab = b.dataset.tab;
        if (["basic", "ssl", "sec", "err", "protect"].includes(tab)) {
          document.querySelectorAll("#modal .tab-btn").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          ["basic", "ssl", "sec", "err", "protect"].forEach((t) => {
            $("tab-" + t).classList.toggle("hidden", tab !== t);
          });
        } else if (tab === "ssl-issue" || tab === "ssl-upload") {
          document.querySelectorAll("#tab-ssl .tab-btn").forEach((x) => x.classList.remove("active"));
          b.classList.add("active");
          $("ssl-issue").classList.toggle("hidden", tab !== "ssl-issue");
          $("ssl-upload").classList.toggle("hidden", tab !== "ssl-upload");
        }
      });
    });

    $("err-manage").addEventListener("click", () => errPageManager(s.name));

    api("GET", "/api/sites/" + encodeURIComponent(name) + "/ssl-files").then((sf) => {
      if (sf && sf.cert) $("sc-ssl-cert").value = sf.cert;
      if (sf && sf.key) $("sc-ssl-key").value = sf.key;
    }).catch(() => {});

    $("rd-add").addEventListener("click", () => {
      const div = document.createElement("div");
      div.className = "rd-row";
      div.innerHTML = '<input class="field rd-path" placeholder="/old">' +
        '<input class="field rd-target" placeholder="https://new">' +
        '<select class="select rd-code"><option value="301" selected>301</option><option value="302">302</option><option value="308">308</option></select>' +
        '<button class="btn btn-mini btn-danger rd-del">×</button>';
      div.querySelector(".rd-del").addEventListener("click", () => div.remove());
      $("rd-list").appendChild(div);
    });
    $("pt-add").addEventListener("click", () => {
      const div = document.createElement("div");
      div.className = "pt-row";
      div.innerHTML = '<input class="field pt-path" placeholder="admin">' +
        '<button class="btn btn-mini btn-danger pt-del">×</button>';
      div.querySelector(".pt-del").addEventListener("click", () => div.remove());
      $("pt-list").appendChild(div);
    });
    document.querySelectorAll("#rd-list .rd-del").forEach((b) => b.addEventListener("click", () => b.closest(".rd-row").remove()));
    document.querySelectorAll("#pt-list .pt-del").forEach((b) => b.addEventListener("click", () => b.closest(".pt-row").remove()));

    $("sc-save").addEventListener("click", () => {
      const redirects = Array.from(document.querySelectorAll("#rd-list .rd-row")).map((r) => ({
        path: r.querySelector(".rd-path").value.trim(),
        target: r.querySelector(".rd-target").value.trim(),
        code: parseInt(r.querySelector(".rd-code").value, 10),
      })).filter((r) => r.path && r.target);
      const protect = Array.from(document.querySelectorAll("#pt-list .pt-row")).map((r) => r.querySelector(".pt-path").value.trim()).filter(Boolean);
      const body = {
        note: $("sc-note").value.trim(),
        domains: $("sc-domains").value.trim().split(/\s+/).filter(Boolean),
        port: parseInt($("sc-port").value, 10) || 80,
        root: $("sc-root").value.trim(),
        default_doc: $("sc-index").value.trim(),
        hotlink: { enabled: $("sc-hot").checked, referers: $("sc-referers").value.trim().split(/\s+/).filter(Boolean) },
        cors: { enabled: $("sc-cors").checked, origin: $("sc-cors-origin").value.trim() },
        error_pages: {
          "404": $("sc-404").checked, "403": $("sc-403").checked, "500": $("sc-500").checked,
          "502": $("sc-502").checked, "503": $("sc-503").checked, "504": $("sc-504").checked,
        },
        redirects,
        protect,
        runtime: $("sc-runtime").value,
      };
      if (body.root && !body.root.startsWith("/var/www/")) return toast("根目录必须以 /var/www/ 开头");
      api("POST", "/api/sites/" + encodeURIComponent(name) + "/config", body)
        .then((r) => { closeModal(); toast(r.ok ? "配置已保存" : (r.msg || r.detail || "保存失败")); loadSites(); })
        .catch((e) => toast(e.message));
    });
  });
};

function openEpEditor(code, site, content, reload) {
  openModal(
    '<div class="modal-title">编辑 ' + esc(code) + ' 错误页 · ' + esc(site) + "</div>" +
    '<div class="muted small">保存后该站点启用自己的错误页（不再跟随全局默认）。</div><br>' +
    '<textarea id="ep-content" class="editor" style="min-height:260px" spellcheck="false">' + esc(content || "") + "</textarea>" +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
    '<button class="btn btn-primary" id="ep-save">保存</button></div>'
  );
  $("ep-save").addEventListener("click", () => {
    api("POST", "/api/sites/" + encodeURIComponent(site) + "/errorpage/" + code, {
      content: $("ep-content").value, enable: true,
    }).then((r) => { closeModal(); toast(r.ok ? "错误页已保存" : (r.msg || "保存失败")); reload(); })
      .catch((e) => toast(e.message));
  });
}

window.errPageManager = (name) => {
  api("GET", "/api/sites/" + encodeURIComponent(name) + "/errorpages").then((d) => {
    const rows = (d.pages || []).map((pg) =>
      "<tr>" +
        "<td>" + esc(pg.code) + "</td>" +
        '<td><span class="tag ' + (pg.enabled ? "tag-ok" : "tag-warn") + '">' + (pg.enabled ? "自定义" : "全局默认") + "</span></td>" +
        '<td><span class="tag ' + (pg.has_file ? "tag-blue" : "") + '">' + (pg.has_file ? "已存在" : "无文件") + "</span></td>" +
        '<td class="mono-td">' + (pg.has_file ? fmtBytes(pg.size) + " / " + fmtDate(pg.mtime) : "-") + "</td>" +
        "<td>" +
          '<button class="btn btn-mini btn-outline" data-ep-edit="' + pg.code + '">编辑</button>' +
          '<label class="btn btn-mini btn-ghost">上传<input type="file" hidden data-ep-up="' + pg.code + '"></label>' +
          (pg.has_file ? '<button class="btn btn-mini btn-ghost" data-ep-dl="' + pg.code + '">下载</button>' : "") +
          '<button class="btn btn-mini btn-danger" data-ep-del="' + pg.code + '">恢复默认</button>' +
        "</td>" +
      "</tr>"
    ).join("");
    openModal(
      '<div class="modal-title">错误页管理 · ' + esc(d.site) + "</div>" +
      '<div class="muted small">未自定义的错误码显示全局默认页；编辑或上传内容后该站点即使用自己的错误页；恢复默认则回退到全局默认页。</div><br>' +
      '<div class="table-wrap"><table class="table"><thead><tr><th style="width:70px">错误码</th><th style="width:110px">状态</th><th style="width:150px">文件</th><th style="width:130px">大小/时间</th><th style="width:400px">操作</th></tr></thead>' +
      "<tbody>" + (rows || '<tr><td colspan="5" class="empty">暂无数据</td></tr>') + "</tbody></table></div>" +
      '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">关闭</button></div>'
    );
    const reload = () => errPageManager(name);
    document.querySelectorAll("[data-ep-edit]").forEach((b) => {
      b.addEventListener("click", () => {
        api("GET", "/api/fs/read?path=" + encodeURIComponent(d.root + "/" + b.dataset.epEdit + ".html")).then((r) => {
          let content;
          if (r && !r.error) content = r.content;
          else {
            api("GET", "/api/error-defaults/content?code=" + b.dataset.epEdit).then((g) => {
              content = (g && g.ok) ? g.content : "";
              openEpEditor(b.dataset.epEdit, d.site, content, reload);
            }).catch(() => openEpEditor(b.dataset.epEdit, d.site, "", reload));
            return;
          }
          openEpEditor(b.dataset.epEdit, d.site, content, reload);
        }).catch((e) => toast(e.message));
      });
    });
    document.querySelectorAll("[data-ep-up]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          api("POST", "/api/sites/" + encodeURIComponent(d.site) + "/errorpage/" + inp.dataset.epUp, {
            content: rd.result, enable: true,
          }).then((r) => { closeModal(); toast(r.ok ? "错误页已上传" : (r.msg || "上传失败")); reload(); })
            .catch((e) => toast(e.message));
        };
        rd.readAsText(f);
      });
    });
    document.querySelectorAll("[data-ep-dl]").forEach((b) => {
      b.addEventListener("click", () => {
        window.open("/api/fs/download?path=" + encodeURIComponent(d.root + "/" + b.dataset.epDl + ".html") + "&token=" + encodeURIComponent(state.token) + "&t=" + Date.now(), "_blank");
      });
    });
    document.querySelectorAll("[data-ep-del]").forEach((b) => {
      b.addEventListener("click", () => {
        if (!confirm("确定删除 " + b.dataset.epDel + " 错误页并停用？")) return;
        api("DELETE", "/api/sites/" + encodeURIComponent(d.site) + "/errorpage/" + b.dataset.epDel)
          .then((r) => { toast(r.ok ? "已删除" : (r.msg || "删除失败")); reload(); })
          .catch((e) => toast(e.message));
      });
    });
  }).catch((e) => toast(e.message));
};

/* ---------------- global error pages (settings) ---------------- */

function loadErrorDefaults() {
  api("GET", "/api/error-defaults").then((d) => {
    const tb = document.querySelector("#edef-table tbody");
    tb.innerHTML = (d.pages || []).map((pg) =>
      "<tr>" +
        "<td><b>" + esc(pg.code) + "</b></td>" +
        '<td>' + esc(pg.name_zh) + '<span class="muted small"> · ' + esc(pg.name_en) + "</span></td>" +
        '<td class="mono-td">' + (pg.has_file ? fmtBytes(pg.size) + " / " + fmtDate(pg.mtime) : "-") + "</td>" +
        '<td class="fops">' +
          '<button class="btn btn-mini btn-outline" data-edef-prev="' + pg.code + '">预览</button>' +
          '<button class="btn btn-mini btn-outline" data-edef-edit="' + pg.code + '">编辑</button>' +
          '<label class="btn btn-mini btn-ghost">上传<input type="file" hidden data-edef-up="' + pg.code + '"></label>' +
          '<button class="btn btn-mini btn-ghost" data-edef-dl="' + pg.code + '">下载</button>' +
          '<button class="btn btn-mini btn-danger" data-edef-del="' + pg.code + '">删除</button>' +
        "</td>" +
      "</tr>"
    ).join("");
    tb.querySelectorAll("[data-edef-prev]").forEach((b) => {
      b.addEventListener("click", () => {
        window.open("/panel-err/" + b.dataset.edefPrev + ".html?t=" + Date.now(), "_blank");
      });
    });
    tb.querySelectorAll("[data-edef-edit]").forEach((b) => {
      b.addEventListener("click", () => {
        api("GET", "/api/error-defaults/content?code=" + b.dataset.edefEdit).then((r) => {
          if (!r || !r.ok) return toast("读取失败");
          openModal(
            '<div class="modal-title">编辑默认错误页 ' + esc(b.dataset.edefEdit) + "</div>" +
            '<div class="muted small">保存后所有未自定义该错误码的站点立即生效。</div><br>' +
            '<textarea id="edef-content" class="editor" style="min-height:300px" spellcheck="false">' + esc(r.content) + "</textarea>" +
            '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
            '<button class="btn btn-primary" id="edef-save">保存</button></div>'
          );
          $("edef-save").addEventListener("click", () => {
            api("POST", "/api/error-defaults/save", { code: b.dataset.edefEdit, content: $("edef-content").value })
              .then((r2) => { closeModal(); toast(r2.ok ? (r2.msg || "已保存") : (r2.msg || "保存失败")); loadErrorDefaults(); })
              .catch((e) => toast(e.message));
          });
        }).catch((e) => toast(e.message));
      });
    });
    tb.querySelectorAll("[data-edef-up]").forEach((inp) => {
      inp.addEventListener("change", () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const rd = new FileReader();
        rd.onload = () => {
          api("POST", "/api/error-defaults/save", { code: inp.dataset.edefUp, content: rd.result })
            .then((r) => { toast(r.ok ? (r.msg || "已上传") : (r.msg || "上传失败")); loadErrorDefaults(); })
            .catch((e) => toast(e.message));
        };
        rd.readAsText(f);
      });
    });
    tb.querySelectorAll("[data-edef-dl]").forEach((b) => {
      b.addEventListener("click", () => {
        api("GET", "/api/error-defaults/content?code=" + b.dataset.edefDl).then((r) => {
          if (!r || !r.ok) return toast("读取失败");
          const blob = new Blob([r.content], { type: "text/html" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = b.dataset.edefDl + ".html";
          a.click();
          URL.revokeObjectURL(a.href);
        }).catch((e) => toast(e.message));
      });
    });
    tb.querySelectorAll("[data-edef-del]").forEach((b) => {
      b.addEventListener("click", () => {
        if (!confirm("确定删除默认错误页 " + b.dataset.edefDel + " ？将恢复为内置默认内容。")) return;
        api("POST", "/api/error-defaults/delete", { code: b.dataset.edefDel })
          .then((r) => { toast(r.ok ? (r.msg || "已恢复默认") : (r.msg || "操作失败")); loadErrorDefaults(); })
          .catch((e) => toast(e.message));
      });
    });
  }).catch((e) => toast(e.message));
}

/* ---------------- files ---------------- */

function loadFileRoots() {
  api("GET", "/api/sites").then((d) => {
    state.sites = d.sites || [];
    const sel = $("file-root");
    const opts = ['<option value="/var/www">/var/www</option>'];
    d.sites.forEach((s) => {
      if (s.root) opts.push('<option value="' + escAttr(s.root) + '">' + esc(s.name) + " → " + esc(s.root) + "</option>");
    });
    sel.innerHTML = opts.join("");
    sel.value = state.fsRoot;
    loadFiles(state.fsPath);
  }).catch((e) => toast(e.message));
}

$("file-root").addEventListener("change", (e) => {
  state.fsRoot = e.target.value;
  state.fsPath = e.target.value;
  loadFiles(state.fsPath);
});

function goFiles(path) {
  state.fsPath = path;
  state.fsRoot = path;
  switchView("files");
}
window.goFiles = goFiles;

$("up-btn").addEventListener("click", () => {
  const parent = state.fsPath.split("/").slice(0, -1).join("/");
  if (parent) { state.fsPath = parent; loadFiles(parent); }
});
$("refresh-btn").addEventListener("click", () => loadFiles(state.fsPath));

function selCount() {
  return Object.values(state.selected).filter(Boolean).length;
}
function updateSelBar() {
  const n = selCount();
  $("sel-bar").classList.toggle("hidden", n === 0);
  $("sel-count").textContent = "已选 " + n + " 项";
}
function toggleSel(path) {
  state.selected[path] = !state.selected[path];
  const cb = document.querySelector('input[data-cb="' + CSS.escape(path) + '"]');
  if (cb) cb.checked = state.selected[path];
  updateSelBar();
}
window.toggleSel = toggleSel;

function selectedPaths() {
  return Object.keys(state.selected).filter((p) => state.selected[p]);
}

function openDirPicker(title, callback) {
  let currentDir = "/var/www";
  function renderPicker() {
    api("GET", "/api/fs?path=" + encodeURIComponent(currentDir))
      .then((d) => {
        const dirs = (d.entries || []).filter((e) => e.type === "dir");
        const parent = currentDir.split("/").slice(0, -1).join("/") || "/";
        const dirList = dirs.map((e) =>
          '<div class="dp-item" onclick="dpNav(\'' + escAttr(currentDir + "/" + e.name) + '\')">' +
          '<span class="dp-icon">📁</span> ' + esc(e.name) + '</div>'
        ).join("");
        openModal(
          '<div class="modal-title">' + title + '</div>' +
          '<div class="dp-path" id="dp-current">' + esc(currentDir) + '</div>' +
          '<div class="dp-list">' +
            (currentDir !== "/" ? '<div class="dp-item dp-up" onclick="dpNav(\'' + escAttr(parent) + '\')">📂 .. 上级</div>' : '') +
            dirList +
          '</div>' +
          '<div class="modal-actions">' +
            '<button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
            '<button class="btn btn-primary" id="dp-ok">选择此目录</button>' +
          '</div>'
        );
        $("dp-ok").addEventListener("click", () => { closeModal(); callback(currentDir); });
      });
  }
  window.dpNav = (dir) => { currentDir = dir; renderPicker(); };
  renderPicker();
}

$("sel-copy").addEventListener("click", () => {
  state.clipboard = selectedPaths();
  toast("已复制 " + state.clipboard.length + " 项，请导航到目标目录后点击粘贴");
  updatePasteBtn();
});
$("sel-move").addEventListener("click", () => openDirPicker("移动到…", (dest) => {
  api("POST", "/api/fs/move", { paths: selectedPaths(), dest }).then((r) => {
    closeModal(); clearSel(); toast("移动完成"); loadFiles(state.fsPath);
  }).catch((e) => toast(e.message));
}));
$("sel-zip").addEventListener("click", () => {
  openDirPicker("压缩保存到…", (dest) => {
    const filename = "archive.zip";
    const target = dest + "/" + filename;
    api("POST", "/api/fs/zip", { paths: selectedPaths(), target })
      .then((r) => { clearSel(); toast("压缩完成"); loadFiles(state.fsPath); })
      .catch((e) => toast(e.message));
  });
});
$("sel-delete").addEventListener("click", () => {
  const paths = selectedPaths();
  const openBatch = () => {
    openModal(
      '<div class="modal-title">批量删除</div>' +
      '<div class="muted small">确定删除选中的 ' + selCount() + ' 项？目录将递归删除。</div><br>' +
      '<div class="mono">' + esc(paths.join("<br>")) + "</div>" +
      '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
      '<button class="btn btn-danger" id="sd-go">删除</button></div>'
    );
    $("sd-go").addEventListener("click", () => {
      api("DELETE", "/api/fs", { paths, recursive: true })
        .then((r) => { closeModal(); clearSel(); toast("已删除"); loadFiles(state.fsPath); })
        .catch((e) => toast(e.message));
    });
  };
  Promise.all(paths.map((p) =>
    api("GET", "/api/fs/related?path=" + encodeURIComponent(p))
      .then((rel) => ({ p, rel })).catch(() => ({ p, rel: null }))
  )).then((rows) => {
    const items = [];
    rows.forEach(({ p, rel }) => {
      if (!rel || !rel.ok) return;
      (rel.ftp || []).forEach((u) => items.push({ type: "ftp", key: u, label: esc(p) + " → FTP 账号：" + esc(u) }));
      (rel.sites || []).forEach((s) => items.push({ type: "site", key: s, label: esc(p) + " → 网站：" + esc(s) }));
    });
    if (!items.length) { openBatch(); return; }
    openModal(
      '<div class="modal-title">批量删除（含关联项）</div>' +
      '<div class="warn-box">以下目录与内容绑定，可选择是否一并删除：</div>' +
      relItemsHtml(items) +
      '<label class="warn-check"><input type="checkbox" id="sd-confirm"> <span>我已了解删除影响，确认执行删除</span></label>' +
      '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
      '<button class="btn btn-danger" id="sd-go" disabled>删除</button></div>'
    );
    $("sd-confirm").addEventListener("change", (e) => { $("sd-go").disabled = !e.target.checked; });
    $("sd-go").addEventListener("click", () => deleteBoundAndBatch("modal", paths));
  });
});
$("sel-clear").addEventListener("click", clearSel);

function clearSel() {
  state.selected = {};
  document.querySelectorAll("#file-table input[type=checkbox]").forEach((c) => { c.checked = false; });
  updateSelBar();
}

function updatePasteBtn() {
  const btn = $("paste-btn");
  if (btn) btn.classList.toggle("hidden", !state.clipboard || !state.clipboard.length);
}
window.updatePasteBtn = updatePasteBtn;

$("paste-btn").addEventListener("click", () => {
  if (!state.clipboard || !state.clipboard.length) return toast("剪贴板为空");
  api("POST", "/api/fs/copy", { paths: state.clipboard, dest: state.fsPath })
    .then(() => { state.clipboard = null; updatePasteBtn(); toast("粘贴完成"); loadFiles(state.fsPath); })
    .catch((e) => toast(e.message));
});

const FILE_BATCH = 200;

function loadFiles(path) {
  state.fsPath = path;
  api("GET", "/api/fs?path=" + encodeURIComponent(path))
    .then((d) => {
      $("breadcrumb").textContent = d.path;
      state.fsEntries = d.entries || [];
      state.fsRendered = 0;
      renderFileBatch(true);
    })
    .catch((e) => toast("读取目录失败：" + e.message));
}

/* render the file list in chunks so a directory with thousands of entries
   never builds one giant DOM at once — "load more" appends the next batch */
function renderFileBatch(reset) {
  const tb = document.querySelector("#file-table tbody");
  if (!tb) return;
  const all = state.fsEntries || [];
  if (!all.length) {
    tb.innerHTML = '<tr><td colspan="5" class="empty">空目录</td></tr>';
    return;
  }
  const more = tb.querySelector(".file-more");
  if (more) more.remove();
  const start = reset ? 0 : state.fsRendered;
  const end = Math.min(start + FILE_BATCH, all.length);
  let html = "";
  for (let i = start; i < end; i++) html += fileRowHtml(all[i], state.fsPath);
  if (reset) tb.innerHTML = html;
  else tb.insertAdjacentHTML("beforeend", html);
  state.fsRendered = end;
  if (end < all.length) {
    const tr = document.createElement("tr");
    tr.className = "file-more";
    tr.innerHTML = '<td colspan="5" class="file-more-cell">已显示 ' + end + " / " + all.length +
      ' 项 · <span class="file-more-link" data-more="1" role="button">加载更多 ↓</span></td>';
    tb.appendChild(tr);
  }
}

function fileRowHtml(e, path) {
  const isDir = e.type === "dir";
  const icon = isDir ? "📁" : fileIcon(e.name);
  const iconCls = isDir ? "ficon ficon-dir" : "ficon ficon-file";
  const size = isDir ? "-" : fmtBytes(e.size);
  const full = path + "/" + e.name;
  const checked = state.selected[full] ? " checked" : "";
  return (
    "<tr data-path='" + escAttr(full) + "' data-isdir='" + (isDir ? "1" : "0") + "'>" +
      '<td><input type="checkbox" data-cb="' + escAttr(full) + '"' + checked + ' onclick="toggleSel(' + jsq(full) + ')"></td>' +
      '<td class="fname" onclick="' + (isDir ? "loadFiles(" + jsq(full) + ")" : "openEditor(" + jsq(full) + ")") + '">' +
        '<span class="' + iconCls + '">' + icon + "</span><span>" + esc(e.name) + "</span></td>" +
      "<td class='fsize'>" + size + "</td>" +
      "<td>" + fmtDate(e.mtime) + "</td>" +
      "<td class='fops'>" +
        (isDir ? '<button class="btn btn-mini btn-ghost" title="新建子目录" onclick="mkdirInside(' + jsq(full) + ')">+目录</button>' : "") +
        '<button class="btn btn-mini btn-ghost" title="' + (isDir ? "打开" : "编辑") + '" onclick="' + (isDir ? "loadFiles(" + jsq(full) + ")" : "openEditor(" + jsq(full) + ")") + '">✎</button>' +
        (isDir ? '<button class="btn btn-mini btn-ghost" title="解压到此处" onclick="unzipHere(' + jsq(full) + ')">解压</button>' : "") +
        '<button class="btn btn-mini btn-ghost" title="重命名" onclick="renameFile(' + jsq(full) + ')">改名</button>' +
        (isDir ? "" : '<button class="btn btn-mini btn-ghost" title="复制外链" onclick="copyExternal(' + jsq(full) + ')">外链</button>') +
        (isDir ? "" : '<button class="btn btn-mini btn-ghost" title="下载" onclick="dlFile(' + jsq(full) + ')">下载</button>') +
        '<button class="btn btn-mini btn-ghost" title="设置权限" onclick="chmodFile(' + jsq(full) + ')">权限</button>' +
        '<button class="btn btn-mini btn-danger" title="删除" onclick="delFile(' + jsq(full) + ',' + isDir + ')">删除</button>' +
      "</td>" +
    "</tr>"
  );
}

window.loadFiles = loadFiles;

document.addEventListener("click", () => { const m = $("ctx-menu"); if (m) m.remove(); });
/* delegated "load more" for the chunked file list */
document.addEventListener("click", (e) => {
  if (e.target.closest && e.target.closest("[data-more]")) renderFileBatch(false);
});
document.addEventListener("contextmenu", (e) => {
  const tr = e.target.closest("#file-table tbody tr");
  if (!tr) return;
  e.preventDefault();
  const p = tr.dataset.path;
  const isDir = tr.dataset.isdir === "1";
  const items = [
    { act: "open", label: "打开" },
    { act: "edit", label: "编辑", fileOnly: true },
    { act: "rename", label: "重命名" },
    { act: "download", label: "下载", fileOnly: true },
    { act: "external", label: "外链", fileOnly: true },
    { act: "perm", label: "权限" },
    { act: "copy", label: "复制" },
    { act: "move", label: "移动" },
    { act: "delete", label: "删除" },
  ];
  const menu = document.createElement("div");
  menu.id = "ctx-menu";
  menu.className = "ctx-menu";
  items.filter((it) => !it.fileOnly || !isDir).forEach((it) => {
    const b = document.createElement("button");
    b.textContent = it.label;
    b.dataset.act = it.act;
    if (it.act === "delete") b.className = "ctx-danger";
    b.addEventListener("click", () => {
      menu.remove();
      const act = b.dataset.act;
      if (act === "open") (isDir ? loadFiles(p) : openEditor(p));
      else if (act === "edit") openEditor(p);
      else if (act === "rename") renameFile(p);
      else if (act === "download") dlFile(p);
      else if (act === "external") copyExternal(p);
      else if (act === "perm") chmodFile(p);
      else if (act === "copy") {
        state.clipboard = [p];
        toast("已复制，请导航到目标目录后点击粘贴");
        updatePasteBtn();
      } else if (act === "move") {
        openDirPicker("移动到…", (dest) => {
          api("POST", "/api/fs/move", { paths: [p], dest }).then((r) => {
            closeModal(); toast("移动完成"); loadFiles(state.fsPath);
          }).catch((e) => toast(e.message));
        });
      } else if (act === "delete") delFile(p, isDir);
    });
    menu.appendChild(b);
  });
  const bw = 150;
  let x = e.clientX, y = e.clientY;
  if (x + bw > window.innerWidth - 8) x = window.innerWidth - bw - 8;
  if (y + menu.offsetHeight + 12 > window.innerHeight) y = window.innerHeight - menu.offsetHeight - 12;
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  document.body.appendChild(menu);
});
window.mkdirInside = (p) => {
  openModal(
    '<div class="modal-title">新建子目录</div>' +
    '<input id="mk-name" class="field" placeholder="目录名" spellcheck="false" style="color:#1a1a2e !important">' +
    '<div class="mono">' + esc(p) + "</div>" +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
    '<button class="btn btn-primary" id="mk-submit">创建</button></div>'
  );
  $("mk-submit").addEventListener("click", () => {
    const n = $("mk-name").value.trim();
    if (!n) return toast("请输入目录名");
    api("POST", "/api/fs/mkdir", { path: p + "/" + n })
      .then((r) => { closeModal(); loadFiles(state.fsPath); })
      .catch((e) => toast(e.message));
  });
};

$("mkdir-btn").addEventListener("click", () => window.mkdirInside(state.fsPath));
$("newfile-btn").addEventListener("click", () => {
  openModal(
    '<div class="modal-title">新建文件</div>' +
    '<label class="small muted">文件名</label>' +
    '<input id="nf-name" class="field" placeholder="index.html" spellcheck="false" style="color:#1a1a2e !important">' +
    '<label class="small muted">快速创建</label>' +
    '<div class="nf-quick">' +
      '<button class="btn btn-mini btn-outline nf-tpl" data-tpl="index.html">HTML</button>' +
      '<button class="btn btn-mini btn-outline nf-tpl" data-tpl="index.htm">HTM</button>' +
      '<button class="btn btn-mini btn-outline nf-tpl" data-tpl="style.css">CSS</button>' +
      '<button class="btn btn-mini btn-outline nf-tpl" data-tpl="script.js">JS</button>' +
      '<button class="btn btn-mini btn-outline nf-tpl" data-tpl="readme.txt">TXT</button>' +
      '<button class="btn btn-mini btn-outline nf-tpl" data-tpl="index.php">PHP</button>' +
      '<button class="btn btn-mini btn-outline nf-tpl" data-tpl="robots.txt">robots</button>' +
      '<button class="btn btn-mini btn-outline nf-tpl" data-tpl=".htaccess">.htaccess</button>' +
    '</div>' +
    '<div class="mono">' + esc(state.fsPath) + "</div>" +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
    '<button class="btn btn-primary" id="nf-submit">创建并编辑</button></div>'
  );
  document.querySelectorAll(".nf-tpl").forEach((btn) => {
    btn.addEventListener("click", () => { $("nf-name").value = btn.dataset.tpl; });
  });
  $("nf-submit").addEventListener("click", () => {
    const n = $("nf-name").value.trim();
    if (!n) return toast("请输入文件名");
    const p = state.fsPath + "/" + n;
    api("POST", "/api/fs/write", { path: p, content: "" })
      .then(() => { closeModal(); openEditor(p); })
      .catch((e) => toast(e.message));
  });
});

window.renameFile = (p) => {
  openModal(
    '<div class="modal-title">重命名</div>' +
    '<input id="rn-name" class="field" value="' + escAttr(p.split("/").pop()) + '" spellcheck="false" style="color:#1a1a2e !important">' +
    '<div class="mono">' + esc(p) + "</div>" +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
    '<button class="btn btn-primary" id="rn-submit">确定</button></div>'
  );
  $("rn-submit").addEventListener("click", () => {
    const n = $("rn-name").value.trim();
    if (!n) return toast("请输入新名称");
    api("POST", "/api/fs/rename", { path: p, new_name: n })
      .then((r) => { closeModal(); toast("已重命名"); loadFiles(state.fsPath); })
      .catch((e) => toast(e.message));
  });
};

window.chmodFile = (p) => {
  const labels = ["所有者", "所属组", "其他用户"];
  const groupHtml = (i) =>
    '<div class="chm-group">' +
      '<span class="chm-glabel">' + labels[i] + "</span>" +
      ["r", "w", "x"].map((k, j) =>
        '<label class="chm-bit"><input type="checkbox" id="chm-' + i + "-" + j + '" data-uidx="' + i + '-' + j + '"> ' + k + "</label>"
      ).join("") +
      '<span class="chm-val" id="chm-val-' + i + '">7</span>' +
    "</div>";
  const calc = () => {
    let mode = "";
    for (let i = 0; i < 3; i++) {
      let v = 0;
      if ($("chm-" + i + "-0").checked) v += 4;
      if ($("chm-" + i + "-1").checked) v += 2;
      if ($("chm-" + i + "-2").checked) v += 1;
      $("chm-val-" + i).textContent = v;
      mode += v;
    }
    $("chm-mode").textContent = mode;
    return mode;
  };
  openModal(
    '<div class="modal-title">设置权限 · ' + esc(p.split("/").pop()) + "</div>" +
    '<div class="mono">' + esc(p) + "</div>" +
    '<div class="chm-box">' + [0, 1, 2].map(groupHtml).join("") + "</div>" +
    '<div class="chm-mode-line">权限值：<span class="mono" id="chm-mode">755</span></div>' +
    '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
    '<button class="btn btn-primary" id="chm-submit">确定</button></div>'
  );
  const setBits = (mode) => {
    const d = String(mode);
    for (let i = 0; i < 3; i++) {
      const v = parseInt(d[i], 10) || 0;
      $("chm-" + i + "-0").checked = (v & 4) !== 0;
      $("chm-" + i + "-1").checked = (v & 2) !== 0;
      $("chm-" + i + "-2").checked = (v & 1) !== 0;
    }
  };
  setBits("755");
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    $("chm-" + i + "-" + j).addEventListener("change", calc);
  calc();
  $("chm-submit").addEventListener("click", () => {
    const mode = $("chm-mode").textContent;
    api("POST", "/api/fs/chmod", { path: p, mode })
      .then((r) => { closeModal(); toast(r.ok ? "权限已设置" : (r.error || r.msg || "设置失败")); loadFiles(state.fsPath); })
      .catch((e) => toast(e.message));
  });
};

window.dlFile = (p) => {
  window.open("/api/fs/download?path=" + encodeURIComponent(p) + "&token=" + encodeURIComponent(state.token) + "&t=" + Date.now(), "_blank");
};

function externalUrlFor(p) {
  const site = (state.sites || [])
    .filter((s) => s.root && p.indexOf(s.root.replace(/\/$/, "") + "/") === 0)
    .sort((a, b) => b.root.length - a.root.length)[0];
  if (!site) return "";
  const root = site.root.replace(/\/$/, "");
  const rel = p.slice(root.length).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const proto = site.ssl && site.ssl.enabled ? "https" : "http";
  const host = (site.domains && site.domains.length) ? site.domains[0] : location.hostname;
  const port = site.port || 80;
  const suffix = (port === 80 || port === 443) ? "" : ":" + port;
  return proto + "://" + host + suffix + "/" + rel;
}

window.copyExternal = (p) => {
  const url = externalUrlFor(p);
  if (!url) return toast("未找到可用域名，无法生成外链");
  const done = () => toast("外链已复制：" + url);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done));
  } else {
    fallbackCopy(url, done);
  }
};

function fallbackCopy(text, cb) {
  const input = document.createElement("input");
  input.value = text;
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  document.body.removeChild(input);
  cb();
}

window.unzipHere = (p) => {
  if (!p.endsWith(".zip")) { window.openEditor(p); return; }
  openDirPicker("解压到…", (target) => {
    api("POST", "/api/fs/unzip", { path: p, target })
      .then((r) => { toast("解压完成"); loadFiles(state.fsPath); })
      .catch((e) => toast(e.message));
  });
};

window.openEditor = (p) => {
  api("GET", "/api/fs/read?path=" + encodeURIComponent(p))
    .then((d) => {
      if (d.error) return toast(d.error);
      if (d.size && d.size > 2 * 1024 * 1024) {
        toast("文件较大（" + fmtBytes(d.size) + "），编辑器可能卡顿，大文件建议用下载处理");
      }
      openModal(
        '<div class="modal-title editor-titlebar"><span>编辑 · ' + esc(p) + "</span></div>" +
        '<button class="modal-close" onclick="closeModal()" title="关闭">✕</button>' +
        '<div class="editor-toolbar editor-toolbar-ide">' +
          '<button class="btn btn-ghost" id="ed-save" title="保存 (Ctrl+S)">保存</button>' +
          '<span class="ed-sep"></span>' +
          '<button class="btn btn-ghost" id="ed-undo" title="撤销">↩</button>' +
          '<button class="btn btn-ghost" id="ed-redo" title="重做">↪</button>' +
          '<span class="ed-sep"></span>' +
          '<button class="btn btn-ghost" id="ed-find" title="查找替换">🔍</button>' +
          '<span class="ed-sep"></span>' +
          '<button class="btn btn-ghost" id="ed-zoom-out" title="缩小">−</button>' +
          '<button class="btn btn-ghost" id="ed-zoom-in" title="放大">+</button>' +
          '<span class="ed-sep"></span>' +
          '<button class="btn btn-ghost" id="ed-wrap" title="切换自动换行">换行</button>' +
          '<span class="ed-sep"></span>' +
          '<button class="btn btn-ghost" id="ed-font-down" title="减小字号">A−</button>' +
          '<button class="btn btn-ghost" id="ed-font-up" title="增大字号">A+</button>' +
          '<span class="ed-status" id="ed-status">行 1, 列 1</span>' +
        "</div>" +
        '<div class="editor-shell"><div id="ed-host" style="min-height:520px"></div></div>' +
        '<div class="editor-mode" id="ed-mode">加载编辑器…</div>'
      );
      $("modal-box").classList.add("modal-wide");
      const host = $("ed-host");
      const mode = $("ed-mode");
      let edInstance = null;
      let getVal = () => $("ed-content") ? $("ed-content").value : "";
      let fontSize = 13;
      let wordWrap = "off";
      if (window.monaco) {
        try {
          edInstance = window.monaco.editor.create(host, {
            value: d.content,
            language: langFor(p),
            theme: document.documentElement.classList.contains("dark") ? "vs-dark" : "vs",
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: fontSize,
            scrollBeyondLastLine: false,
            wordWrap: wordWrap,
            bracketPairColorization: { enabled: true },
            smoothScrolling: true,
            cursorBlinking: "smooth",
          });
          getVal = () => edInstance.getValue();
          mode.textContent = "Monaco Editor";
          window._edInstance = edInstance;
          edInstance.onDidChangeCursorPosition((e) => {
            const st = $("ed-status");
            if (st) st.textContent = "行 " + e.position.lineNumber + ", 列 " + e.position.column;
          });
        } catch (e) {
          host.innerHTML = '<textarea class="editor" id="ed-content" style="width:100%;min-height:520px" spellcheck="false"></textarea>';
          $("ed-content").value = d.content;
          mode.textContent = "Monaco 加载失败，已切换为普通编辑器";
        }
      } else {
        host.innerHTML = '<textarea class="editor" id="ed-content" style="width:100%;min-height:520px" spellcheck="false"></textarea>';
        $("ed-content").value = d.content;
        mode.textContent = "Monaco 未加载，使用普通编辑器";
      }
      const doSave = () => {
        api("POST", "/api/fs/write", { path: p, content: getVal() })
          .then((r) => { closeModal(); toast("已保存"); loadFiles(state.fsPath); })
          .catch((e) => toast(e.message));
      };
      $("ed-save").addEventListener("click", doSave);
      $("ed-undo").addEventListener("click", () => { if (edInstance) edInstance.trigger("keyboard", "undo"); else document.execCommand("undo"); });
      $("ed-redo").addEventListener("click", () => { if (edInstance) edInstance.trigger("keyboard", "redo"); else document.execCommand("redo"); });
      $("ed-find").addEventListener("click", () => { if (edInstance) edInstance.trigger("keyboard", "actions.find"); });
      $("ed-zoom-in").addEventListener("click", () => {
        fontSize = Math.min(30, fontSize + 1);
        if (edInstance) edInstance.updateOptions({ fontSize });
      });
      $("ed-zoom-out").addEventListener("click", () => {
        fontSize = Math.max(8, fontSize - 1);
        if (edInstance) edInstance.updateOptions({ fontSize });
      });
      $("ed-wrap").addEventListener("click", () => {
        wordWrap = wordWrap === "on" ? "off" : "on";
        if (edInstance) edInstance.updateOptions({ wordWrap });
        $("ed-wrap").style.background = wordWrap === "on" ? "var(--bc-primary-light)" : "";
      });
      $("ed-font-down").addEventListener("click", () => {
        fontSize = Math.max(8, fontSize - 1);
        if (edInstance) edInstance.updateOptions({ fontSize });
      });
      $("ed-font-up").addEventListener("click", () => {
        fontSize = Math.min(30, fontSize + 1);
        if (edInstance) edInstance.updateOptions({ fontSize });
      });
      document.addEventListener("keydown", function edKeyHandler(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); doSave(); }
        if (!$("modal") || $("modal").classList.contains("hidden")) {
          document.removeEventListener("keydown", edKeyHandler);
        }
      });
    })
    .catch((e) => toast(e.message));
};

function langFor(p) {
  const ext = p.split(".").pop().toLowerCase();
  const map = {
    js: "javascript", mjs: "javascript", ts: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", c: "c", h: "c", cpp: "cpp",
    html: "html", htm: "html", css: "css", scss: "scss",
    json: "json", yml: "yaml", yaml: "yaml",
    md: "markdown", xml: "xml", svg: "xml",
    sh: "shell", bash: "shell", php: "php", sql: "sql",
    ini: "ini", conf: "ini", toml: "ini",
  };
  return map[ext] || "plaintext";
}

function relItemsHtml(rows) {
  return rows.map((it) =>
    '<label class="rel-item"><input type="checkbox" data-rel="' + escAttr(it.type + ":" + it.key) + '" checked> ' +
      '<span>' + esc(it.label) + "</span></label>"
  ).join("");
}

function deleteBoundAndDir(sel, p) {
  const rels = [];
  document.querySelectorAll("#" + sel + " [data-rel]").forEach((cb) => { if (cb.checked) rels.push(cb.dataset.rel); });
  const jobs = [];
  rels.forEach((r) => {
    if (r.startsWith("ftp:")) jobs.push(api("POST", "/api/ftp/delete", { user: r.slice(4) }).catch(() => null));
    if (r.startsWith("site:")) jobs.push(api("DELETE", "/api/sites/" + encodeURIComponent(r.slice(5)) + "?keep=1").catch(() => null));
  });
  Promise.all(jobs)
    .then(() => api("DELETE", "/api/fs?path=" + encodeURIComponent(p) + "&recursive=1"))
    .then((r) => {
      closeModal();
      toast(rels.length ? "已删除目录及勾选的关联项" : "已删除");
      clearSel();
      loadFiles(state.fsPath);
    })
    .catch((e) => toast(e.message));
}

function deleteBoundAndBatch(sel, paths) {
  const rels = [];
  document.querySelectorAll("#" + sel + " [data-rel]").forEach((cb) => { if (cb.checked) rels.push(cb.dataset.rel); });
  const jobs = [];
  rels.forEach((r) => {
    if (r.startsWith("ftp:")) jobs.push(api("POST", "/api/ftp/delete", { user: r.slice(4) }).catch(() => null));
    if (r.startsWith("site:")) jobs.push(api("DELETE", "/api/sites/" + encodeURIComponent(r.slice(5)) + "?keep=1").catch(() => null));
  });
  Promise.all(jobs)
    .then(() => api("DELETE", "/api/fs", { paths, recursive: true }))
    .then((r) => {
      closeModal();
      toast(rels.length ? "已删除目录及勾选的关联项" : "已删除");
      clearSel();
      loadFiles(state.fsPath);
    })
    .catch((e) => toast(e.message));
}

window.delFile = (p, isDir) => {
  if (!isDir) {
    openModal(
      '<div class="modal-title">删除</div>' +
      '<div class="muted small">确定删除该文件？</div><br>' +
      '<div class="mono">' + esc(p) + "</div>" +
      '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
      '<button class="btn btn-danger" id="df-submit">删除</button></div>'
    );
    $("df-submit").addEventListener("click", () => {
      api("DELETE", "/api/fs?path=" + encodeURIComponent(p) + "&recursive=0")
        .then((r) => { closeModal(); toast("已删除"); loadFiles(state.fsPath); })
        .catch((e) => toast(e.message));
    });
    return;
  }
  api("GET", "/api/fs/related?path=" + encodeURIComponent(p)).then((rel) => {
    const items = [];
    (rel.ftp || []).forEach((u) => items.push({ type: "ftp", key: u, label: "FTP 账号：" + u + "（不勾选则保留账号，但其目录将失效）" }));
    (rel.sites || []).forEach((s) => items.push({ type: "site", key: s, label: "网站：" + s + "（不勾选则保留站点配置，但其文件将缺失）" }));
    const openDel = () => {
      openModal(
        '<div class="modal-title">删除目录</div>' +
        '<div class="muted small">确定删除？目录将递归删除。</div><br>' +
        '<div class="mono">' + esc(p) + "</div>" +
        '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
        '<button class="btn btn-danger" id="df-submit">删除</button></div>'
      );
      $("df-submit").addEventListener("click", () => {
        api("DELETE", "/api/fs?path=" + encodeURIComponent(p) + "&recursive=1")
          .then((r) => { closeModal(); toast("已删除"); loadFiles(state.fsPath); })
          .catch((e) => toast(e.message));
      });
    };
    if (!items.length) { openDel(); return; }
    openModal(
      '<div class="modal-title">删除目录（含关联项）</div>' +
      '<div class="warn-box">该目录与以下内容绑定，可选择是否一并删除：</div>' +
      relItemsHtml(items) +
      '<label class="warn-check"><input type="checkbox" id="df-confirm"> <span>我已了解删除影响，确认执行删除</span></label>' +
      '<div class="mono muted small">' + esc(p) + "</div><br>" +
      '<div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
      '<button class="btn btn-danger" id="df-submit" disabled>删除</button></div>'
    );
    $("df-confirm").addEventListener("change", (e) => { $("df-submit").disabled = !e.target.checked; });
    $("df-submit").addEventListener("click", () => deleteBoundAndDir("modal", p));
  }).catch((e) => toast(e.message));
};

$("upload-input").addEventListener("change", (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;
  let i = 0;
  const next = () => {
    if (i >= files.length) {
      toast("上传完成");
      e.target.value = "";
      loadFiles(state.fsPath);
      return;
    }
    const f = files[i++];
    const p = state.fsPath + "/" + f.name;
    fetch("/api/fs/upload?path=" + encodeURIComponent(p), {
      method: "PUT",
      headers: { "Authorization": "Bearer " + state.token, "Content-Type": "application/octet-stream" },
      body: f,
    })
      .then((res) => res.json())
      .then((r) => { if (!r.ok) throw new Error(r.error || "upload failed"); next(); })
      .catch((e) => toast(e.message));
  };
  next();
});

/* ---------------- monitor ---------------- */

function loadMonitor(silent) {
  api("GET", "/api/monitor").then((m) => {
    drawChart("ch-cpu", m.t, m.cpu, "#2563eb", 0, 100);
    drawChart("ch-mem", m.t, m.mem, "#6366f1", 0, 100);
    drawChart("ch-disk", m.t, m.disk, "#f59e0b", 0, 100);
    const rx = (m.rx || []).map((x) => x / 1024);
    const tx = (m.tx || []).map((x) => x / 1024);
    drawChart("ch-net", m.t, rx, "#10b981", 0, null, tx, "#ef4444");
    const el = (id) => document.getElementById(id);
    if (el("mon-cpu-now") && m.cpu && m.cpu.length) el("mon-cpu-now").textContent = m.cpu[m.cpu.length - 1].toFixed(1) + "%";
    if (el("mon-mem-now") && m.mem && m.mem.length) el("mon-mem-now").textContent = m.mem[m.mem.length - 1].toFixed(1) + "%";
    if (el("mon-disk-now") && m.disk && m.disk.length) el("mon-disk-now").textContent = m.disk[m.disk.length - 1].toFixed(1) + "%";
    if (el("mon-net-now") && rx.length) {
      const last = rx[rx.length - 1];
      const lastTx = tx.length ? tx[tx.length - 1] : 0;
      el("mon-net-now").textContent = "↓" + fmtBytes(last * 1024) + "/s ↑" + fmtBytes(lastTx * 1024) + "/s";
    }
  }).catch(() => { if (!silent) toast("获取监控数据失败"); });
}

function drawChart(id, times, data, color, min, max, data2, color2) {
  const cv = $(id);
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const parent = cv.parentElement;
  const maxW = parent ? parent.clientWidth : window.innerWidth;
  const w = Math.min(cv.clientWidth || maxW || 600, maxW || 600);
  const h = parseInt(cv.getAttribute("height"), 10) || 180;
  const dw = w * dpr, dh = h * dpr;
  if (cv.width !== dw || cv.height !== dh) { cv.width = dw; cv.height = dh; }
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!data || !data.length) {
    ctx.fillStyle = "#64748b";
    ctx.font = "12px sans-serif";
    ctx.fillText("暂无数据", 12, 20);
    return;
  }
  let lo = min != null ? min : Math.min.apply(null, data);
  let hi = max != null ? max : Math.max.apply(null, data);
  if (lo === hi) hi = lo + 1;
  const pad = 28, top = 12;
  const iw = w - pad, ih = h - top - 8;
  const px = (i, v) => pad + (i / (data.length - 1)) * iw;
  const py = (v) => top + ih - ((v - lo) / (hi - lo)) * ih;
  const line = (arr, col) => {
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.beginPath();
    arr.forEach((v, i) => {
      const x = px(i, v), y = py(v);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  };
  const fill = (arr, col) => {
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.12;
    ctx.beginPath();
    arr.forEach((v, i) => { const x = px(i, v), y = py(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.lineTo(px(arr.length - 1, arr[arr.length - 1]), top + ih);
    ctx.lineTo(pad, top + ih);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  };
  fill(data, color);
  line(data, color);
  if (data2 && data2.length) {
    fill(data2, color2);
    line(data2, color2);
  }
  ctx.fillStyle = "#64748b";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText(hi.toFixed(1), w - 4, top + 4);
  ctx.fillText(lo.toFixed(1), w - 4, top + ih);
}

/* ---------------- logs (action log) ---------------- */

function loadLogList() {
  api("GET", "/api/actions?limit=500").then((d) => {
    state.actions = d.actions || [];
    renderActionLog();
  }).catch((e) => toast(e.message));
}

function renderActionLog() {
  const lines = parseInt($("log-lines").value, 10) || 100;
  const entries = (state.actions || []).slice(0, lines);
  const tb = document.querySelector("#log-table tbody");
  tb.innerHTML = entries.map((e) => {
    const ts = new Date((e.time || 0) * 1000);
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    const t = ts.getFullYear() + "-" + pad(ts.getMonth() + 1) + "-" + pad(ts.getDate()) + " " +
      pad(ts.getHours()) + ":" + pad(ts.getMinutes()) + ":" + pad(ts.getSeconds());
    return (
      "<tr>" +
        '<td class="mono-td">' + esc(t) + "</td>" +
        '<td><span class="tag tag-blue">' + esc(e.action) + "</span></td>" +
        '<td class="mono-td">' + esc(e.detail || "") + "</td>" +
      "</tr>"
    );
  }).join("");
  if (!entries.length) {
    tb.innerHTML = '<tr><td colspan="3" class="empty">暂无操作日志</td></tr>';
  }
}

$("log-lines").addEventListener("change", renderActionLog);
$("log-refresh").addEventListener("click", loadLogList);

/* ---------------- FTP ---------------- */

function renderFtpPicker(path) {
  const base = "/var/www";
  let cur = path && String(path).startsWith(base) ? String(path).replace(/\/+$/, "") : base;
  if (cur.length < base.length) cur = base;
  let acc = "";
  const crumbs = [];
  cur.split("/").forEach((seg) => {
    if (!seg) return;
    acc += "/" + seg;
    crumbs.push({ label: seg, path: acc });
  });
  $("ftp-crumb").innerHTML = crumbs.map((c, i) =>
    '<a href="javascript:void(0)" class="crumb" data-path="' + escAttr(c.path) + '">' + esc(c.label) + "</a>" +
    (i < crumbs.length - 1 ? '<span class="crumb-sep">/</span>' : "")
  ).join("");
  document.querySelectorAll(".crumb").forEach((a) => {
    a.addEventListener("click", () => renderFtpPicker(a.dataset.path));
  });
  $("ftp-sel").textContent = cur;
  $("ftp-dirs").innerHTML = '<div class="muted small">加载中…</div>';
  api("GET", "/api/ftp/dirs?path=" + encodeURIComponent(cur)).then((d) => {
    if (!d.ok) {
      $("ftp-dirs").innerHTML = '<div class="muted small">' + esc(d.msg || "无法读取") + "</div>";
      return;
    }
    const list = d.dirs || [];
    if (!list.length) {
      $("ftp-dirs").innerHTML = '<div class="muted small">该目录下没有子目录</div>';
    } else {
      $("ftp-dirs").innerHTML = list.map((p) =>
        '<button class="dir-item" data-path="' + escAttr(p) + '">' +
          '<span class="dir-ico">▸</span>' + esc(p.split("/").pop()) +
        "</button>"
      ).join("");
    }
    document.querySelectorAll(".dir-item").forEach((b) => {
      b.addEventListener("click", () => renderFtpPicker(b.dataset.path));
    });
  }).catch((e) => toast(e.message));
}

function ftpDialog(title, saveLabel, payload, onOk) {
  openModal(
    '<div class="modal-title">' + title + "</div>" +
    '<div class="muted small">连接地址为服务器 IP，端口 21；FTP 账号只能访问分配目录及其子目录。</div><br>' +
    '<label class="small muted">账号名（2-32 位，字母数字 _ . -）</label>' +
    '<input id="ftp-user" class="field" value="' + escAttr(payload.user || "") + '" spellcheck="false">' +
    '<label class="small muted">密码（至少 6 位）</label>' +
    '<input id="ftp-pass" type="password" class="field" value="' + escAttr(payload.password || "") + '" placeholder="' + (payload.edit ? "留空则保持原密码" : "") + '">' +
    '<label class="small muted">分配目录（点击目录逐级进入，面包屑可返回上级）</label>' +
    '<div class="ftp-picker">' +
      '<div id="ftp-crumb" class="ftp-crumb"></div>' +
      '<div id="ftp-dirs" class="ftp-dirs"></div>' +
      '<div class="ftp-sel">当前选择：<b id="ftp-sel">--</b></div>' +
    "</div>" +
    '<div class="modal-actions">' +
      '<button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
      '<button class="btn btn-primary" id="ftp-save">' + saveLabel + "</button>" +
    "</div>"
  );
  renderFtpPicker(payload.root || "/var/www");
  $("ftp-save").addEventListener("click", () => {
    const user = $("ftp-user").value.trim();
    const pass = $("ftp-pass").value.trim();
    const root = $("ftp-sel").textContent.trim().replace(/\/+$/, "") || "/var/www";
    if (!root.startsWith("/var/www")) return toast("目录必须以 /var/www 开头");
    api("POST", payload.api, { user, root, password: pass })
        .then((r) => {
          if (r.ok) { closeModal(); toast(r.msg || "已保存"); loadFtp(); }
          else toast(r.msg || "保存失败");
        })
        .catch((e) => toast(e.message));
  });
}

function loadFtp() {
  api("GET", "/api/ftp").then((d) => {
    const accs = d.accounts || [];
    $("ftp-addr").textContent = location.hostname;
    const tb = document.querySelector("#ftp-table tbody");
    tb.innerHTML = accs.map((a) =>
      "<tr>" +
        "<td>" + esc(a.user) + "</td>" +
        '<td class="mono-td">' + esc(a.pass) + "</td>" +
        '<td class="mono-td">' + esc(a.root || a.home) + "</td>" +
        '<td class="fops">' +
          '<button class="btn btn-mini btn-outline" data-ftp-edit="' + escAttr(a.user) + '">编辑</button>' +
          '<button class="btn btn-mini btn-danger" data-ftp-del="' + escAttr(a.user) + '">删除</button>' +
        "</td>" +
      "</tr>"
    ).join("");
    if (!accs.length) tb.innerHTML = '<tr><td colspan="4" class="empty">暂无 FTP 账号</td></tr>';
    tb.querySelectorAll("[data-ftp-del]").forEach((b) => {
      b.addEventListener("click", () => {
        if (!confirm("确定删除 FTP 账号 " + b.dataset.ftpDel + " ？")) return;
        api("POST", "/api/ftp/delete", { user: b.dataset.ftpDel })
          .then((r) => { toast(r.ok ? "已删除" : r.msg); loadFtp(); })
          .catch((e) => toast(e.message));
      });
    });
    tb.querySelectorAll("[data-ftp-edit]").forEach((b) => {
      b.addEventListener("click", () => {
        const a = accs.find((x) => x.user === b.dataset.ftpEdit);
        if (!a) return;
        ftpDialog("编辑 FTP 账号 · " + a.user, "保存", {
          api: "/api/ftp/update", original: a.user, user: a.user, root: a.root || a.home, edit: true,
        });
      });
    });
  }).catch((e) => toast(e.message));
}

$("ftp-refresh").addEventListener("click", loadFtp);

$("ftp-add-btn").addEventListener("click", () => {
  ftpDialog("新建 FTP 账号", "创建", { api: "/api/ftp", user: "", root: "/var/www/" });
});

/* ---------------- cron ---------------- */

function loadCron() {
  api("GET", "/api/cron").then((d) => {
    const jobs = d.jobs || [];
    const tb = document.querySelector("#cron-table tbody");
    tb.innerHTML = jobs.map((j) => {
      const last = j.last_run ? new Date(j.last_run * 1000).toLocaleString("zh-CN") : "未执行";
      return (
        "<tr>" +
          "<td>" + esc(j.name) + "</td>" +
          '<td class="mono-td">' + esc(j.spec) + "</td>" +
          "<td>" + esc(j.type === "url" ? "URL" : "Shell") + "</td>" +
          '<td class="mono-td">' + esc((j.payload || "").slice(0, 50)) + "</td>" +
          "<td>" + esc(last) + "</td>" +
          '<td><span class="tag ' + (j.last_result && j.last_result.indexOf("失败") >= 0 ? "tag-err" : "tag-ok") + '">' +
            esc(j.last_result || "-") + "</span></td>" +
          '<td>' +
            '<button class="btn btn-mini btn-outline" data-cron-tog="' + escAttr(j.name) + '">' + (j.enabled ? "停用" : "启用") + "</button>" +
            '<button class="btn btn-mini btn-danger" data-cron-del="' + escAttr(j.name) + '">删除</button>' +
          "</td>" +
        "</tr>"
      );
    }).join("");
    if (!jobs.length) tb.innerHTML = '<tr><td colspan="7" class="empty">暂无计划任务</td></tr>';
    tb.querySelectorAll("[data-cron-tog]").forEach((b) => {
      b.addEventListener("click", () => {
        api("POST", "/api/cron/toggle", { name: b.dataset.cronTog, enabled: b.textContent.trim() === "启用" })
          .then(() => { loadCron(); })
          .catch((e) => toast(e.message));
      });
    });
    tb.querySelectorAll("[data-cron-del]").forEach((b) => {
      b.addEventListener("click", () => {
        if (!confirm("确定删除计划任务 " + b.dataset.cronDel + " ？")) return;
        api("DELETE", "/api/cron?name=" + encodeURIComponent(b.dataset.cronDel))
          .then(() => { loadCron(); })
          .catch((e) => toast(e.message));
      });
    });
  }).catch((e) => toast(e.message));
}

$("cron-refresh").addEventListener("click", loadCron);

$("cron-add-btn").addEventListener("click", () => {
  openModal(
    '<div class="modal-title">新建计划任务</div>' +
    '<div class="muted small">时间规则为 5 段 cron 格式：分 时 日 月 周。示例：<code>*/5 * * * *</code> 每 5 分钟。</div><br>' +
    '<label class="small muted">任务名称</label>' +
    '<input id="cron-name" class="field" spellcheck="false">' +
    '<label class="small muted">时间规则（分 时 日 月 周）</label>' +
    '<input id="cron-spec" class="field mono" value="*/5 * * * *" spellcheck="false">' +
    '<label class="small muted">类型</label>' +
    '<select id="cron-type" class="select"><option value="shell">Shell 命令</option><option value="url">访问 URL</option></select>' +
    '<label class="small muted">内容（Shell 命令或 URL）</label>' +
    '<input id="cron-payload" class="field mono" spellcheck="false" placeholder="如：curl -s https://example.com/cron.php">' +
    '<label class="check"><input type="checkbox" id="cron-enabled" checked> 启用</label>' +
    '<div class="modal-actions">' +
      '<button class="btn btn-ghost" onclick="closeModal()">取消</button>' +
      '<button class="btn btn-primary" id="cron-save">创建</button>' +
    "</div>"
  );
  $("cron-save").addEventListener("click", () => {
    api("POST", "/api/cron", {
      name: $("cron-name").value.trim(),
      spec: $("cron-spec").value.trim(),
      type: $("cron-type").value,
      payload: $("cron-payload").value.trim(),
      enabled: $("cron-enabled").checked,
    }).then((r) => {
      if (r.ok) { closeModal(); toast("计划任务已创建"); loadCron(); }
      else toast(r.msg || "创建失败");
    }).catch((e) => toast(e.message));
  });
});

/* ---------------- theme ---------------- */

function applyTheme(dark) {
  document.documentElement.classList.toggle("dark", dark);
  const btn = $("theme-toggle");
  if (btn) btn.textContent = dark ? "☀️" : "🌙";
  setTimeout(() => {
    if (MOTION.spark && MOTION.spark.redraw) MOTION.spark.redraw();
    window.dispatchEvent(new CustomEvent("qk:theme", { detail: { dark: dark } }));
  }, 0);
}
$("theme-toggle").addEventListener("click", () => {
  const dark = !document.documentElement.classList.contains("dark");
  applyTheme(dark);
  localStorage.setItem("qk_theme", dark ? "dark" : "light");
});
(function initTheme() {
  const saved = localStorage.getItem("qk_theme");
  applyTheme(saved === "dark" || (!saved && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches));
})();

/* ---------------- settings ---------------- */

function loadInfo() {
  api("GET", "/api/info").then((d) => {
    $("info-ver").textContent = d.version;
    $("info-host").textContent = d.host;
    $("info-url").textContent = location.host;
    $("foot-ver").textContent = d.version;
    state.modules = d.modules || {};
    applyNav();
    renderModuleList();
  }).catch(() => {});
  api("GET", "/api/config").then((c) => {
    $("cfg-running-port").textContent = c.running_port;
    $("cfg-configured-port").textContent = c.configured_port + (c.service ? "" : " (未用 systemd)");
  }).catch(() => {});
}

$("mod-save").addEventListener("click", saveModules);

$("set-port-btn").addEventListener("click", () => {
  const port = parseInt($("set-port").value, 10);
  const el = $("set-port-msg");
  if (!port || port < 1 || port > 65535) {
    el.textContent = "请输入 1-65535 的有效端口";
    el.className = "msg err";
    return;
  }
  const btn = $("set-port-btn");
  btn.disabled = true;
  btn.textContent = "修改中…";
  api("POST", "/api/port", { port })
    .then((r) => {
      el.textContent = r.ok ? "新端口已生效，请通过新端口访问面板" : r.msg;
      el.className = "msg " + (r.ok ? "ok" : "err");
      if (r.ok) {
        setTimeout(() => { location.reload(); }, 1500);
      }
    })
    .catch((e) => {
      el.textContent = "修改请求可能已生效，请尝试访问新端口。详情：" + e.message;
      el.className = "msg ok";
    })
    .finally(() => { btn.disabled = false; btn.textContent = "修改"; });
});

$("set-pass-btn").addEventListener("click", () => {
  const oldU = $("set-old-user").value, oldP = $("set-old-pass").value;
  const newU = $("set-new-user").value, newP = $("set-new-pass").value;
  api("POST", "/api/password", { old_user: oldU, old_pass: oldP, new_user: newU, new_pass: newP })
    .then((r) => {
      const el = $("set-pass-msg");
      el.textContent = r.msg;
      el.className = "msg " + (r.ok ? "ok" : "err");
      if (r.ok) { $("set-old-user").value = ""; $("set-old-pass").value = ""; $("set-new-user").value = ""; $("set-new-pass").value = ""; }
    })
    .catch((e) => toast(e.message));
});

/* ---------------- monaco loader ---------------- */

function loadMonaco() {
  if (window.monaco) return;
  if (state.monoTimer) return;
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js";
  s.onload = () => {
    window.require.config({ paths: { vs: "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs" } });
    window.require(["vs/editor/editor.main"], () => {
      window.monaco = monaco;
      if (window._edInstance) { try { window._edInstance.dispose(); } catch (e) {} }
    });
  };
  document.head.appendChild(s);
  state.monoTimer = setTimeout(() => { state.monoTimer = null; }, 20000);
}
loadMonaco();

initLogin();
