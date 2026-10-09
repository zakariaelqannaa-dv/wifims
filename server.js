// wifims LAN chat — secure, offline-only, no Gmail / no cloud.
// Run: npm start  (http)   |   npm run https  (TLS, recommended on shared Wi-Fi)

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

const PORT_HTTP = parseInt(process.env.PORT || "3000", 10);
const PORT_HTTPS = parseInt(process.env.HTTPS_PORT || "3443", 10);
const USE_HTTPS = process.argv.includes("--https") || process.env.USE_HTTPS === "1";

const ROOM_PASSWORD = process.env.ROOM_PASSWORD || "house123";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin1234";
const MESSAGE_TTL_DAYS = 7;
const MAX_TEXT = 2000;
const MAX_HISTORY = 300;
const FILE_LIMIT_MB = 10;

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const USERS_FILE = path.join(DATA_DIR, "users.json");       // soft-lock reservations: { lower: { display, deviceId, createdAt } }
const MESSAGES_FILE = path.join(DATA_DIR, "messages.json"); // [{...}]
const PUBLIC_DIR = path.join(ROOT, "public");

for (const d of [DATA_DIR, UPLOAD_DIR, PUBLIC_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// ---- password hashes (kept in memory only) ----
const roomHash = bcrypt.hashSync(ROOM_PASSWORD, 10);
const adminHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
const okRoom = (pw) => bcrypt.compareSync(String(pw || ""), roomHash);
const okAdmin = (pw) => bcrypt.compareSync(String(pw || ""), adminHash);

if (!process.env.ROOM_PASSWORD || !process.env.ADMIN_PASSWORD) {
  console.log("  [!] Using default passwords. Set them like:");
  console.log('      $env:ROOM_PASSWORD="my-house-pw"; $env:ADMIN_PASSWORD="my-admin-pw"; npm start');
}

let reservations = readJson(USERS_FILE, {}); // lower -> { display, deviceId, createdAt }
let messages = readJson(MESSAGES_FILE, []);
function pruneMessages() {
  const cutoff = Date.now() - MESSAGE_TTL_DAYS * 24 * 3600 * 1000;
  const before = messages.length;
  messages = messages.filter((m) => (m.ts || 0) >= cutoff).slice(-MAX_HISTORY);
  if (messages.length !== before) writeJson(MESSAGES_FILE, messages);
}
function saveMessages() {
  pruneMessages();
  writeJson(MESSAGES_FILE, messages);
}
function pushMessage(m) {
  messages.push(m);
  saveMessages();
  return m;
}
pruneMessages();

// ---- express ----
const app = express();
// LAN HTTP (http://192.168.x.x) is not a "trustworthy origin" for COOP/OAC,
// and we serve same-origin only with no popups/SharedArrayBuffer — so turn
// those headers OFF to avoid console warnings. Inline styles (avatars,
// show/hide) need 'unsafe-inline' for style-src only; scripts stay 'self'.
app.use(helmet({
  contentSecurityPolicy: {
    // useDefaults:false + fully explicit list: helmet's defaults include
    // upgrade-insecure-requests, which makes phones rewrite style.css/app.js/
    // socket.io to https://IP:3000 (plain-HTTP port) -> SSL fail ->
    // unstyled page, dead chat. It must NOT be sent on LAN http.
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", "https:", "data:"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      imgSrc: ["'self'", "data:", "blob:"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "ws:", "wss:"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  strictTransportSecurity: false, // never force HTTPS; user picks http(:3000) or https(:3443)
}));
app.use(express.json({ limit: "100kb" }));

// global HTTP flood guard
app.use(rateLimit({ windowMs: 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));
// strict guard for login/upload/admin
const strictLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });

app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));

// ---- in-memory session state ----
const online = new Map();      // lower -> { display, deviceId, sockets: Set<socketId> }
const socketUser = new Map();  // socketId -> lower
const tokens = new Map();      // authToken -> lower
const msgTimes = new Map();    // socketId -> [timestamps] for socket flood control

function getLanIps() {
  const out = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}
function onlineList() {
  return [...online.values()].map((u) => u.display);
}
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const FILE_RE = /^[a-f0-9-]{8,60}\.[a-z0-9]{2,5}$/;

function socketFloodOk(socketId) {
  const now = Date.now();
  const arr = (msgTimes.get(socketId) || []).filter((t) => now - t < 60 * 1000);
  arr.push(now);
  msgTimes.set(socketId, arr);
  return arr.length <= 60; // 60 msgs / min per socket
}

// ---- uploads ----
const ALLOWED = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain",
  ".mp3": "audio/mpeg", ".mp4": "video/mp4",
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    cb(null, crypto.randomUUID() + ext);
  },
});
function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname || "").toLowerCase();
  if (!ALLOWED[ext]) return cb(new Error("File type not allowed"));
  cb(null, true);
}
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: FILE_LIMIT_MB * 1024 * 1024, files: 1 },
});

function requireToken(req, res, next) {
  const t = req.headers["x-auth-token"];
  const lower = tokens.get(String(t || ""));
  if (!lower || !reservations[lower]) return res.status(401).json({ error: "Not joined. Refresh and join first." });
  req.usernameLower = lower;
  req.username = reservations[lower].display;
  next();
}

app.post("/upload", strictLimiter, requireToken, upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  // double-check mime matches extension (basic anti-spoof)
  const ext = path.extname(req.file.originalname || "").toLowerCase();
  const expected = ALLOWED[ext];
  if (req.file.mimetype !== expected && !(ext === ".jpg" && req.file.mimetype === "image/jpeg")) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: "MIME mismatch" });
  }
  const to = String(req.body.to || "group").slice(0, 20);
  const lower = req.usernameLower;
  const msg = pushMessage({
    id: crypto.randomUUID(),
    kind: "file",
    from: reservations[lower].display,
    fromLower: lower,
    to: to === "group" ? "group" : to.toLowerCase(),
    file: {
      url: "/files/" + req.file.filename,
      name: (req.file.originalname || "file").slice(0, 80),
      mime: req.file.mimetype,
      size: req.file.size,
    },
    ts: Date.now(),
  });
  // deliver: group -> all, private -> sender + recipient online sockets
  if (msg.to === "group") {
    emitAll("chat-msg", msg);
  } else {
    emitToUserSockets(lower, "chat-msg", msg);
    if (msg.to !== lower) emitToUserSockets(msg.to, "chat-msg", msg);
  }
  res.json({ ok: true, msg });
});

app.get("/files/:name", (req, res) => {
  const n = String(req.params.name || "");
  if (!FILE_RE.test(n)) return res.status(400).end();
  const f = path.join(UPLOAD_DIR, n);
  if (!f.startsWith(UPLOAD_DIR) || !fs.existsSync(f)) return res.status(404).end();
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(f);
});

app.get("/api/info", async (req, res) => {
  const ips = getLanIps();
  const primary = ips[0] || "localhost";
  const httpUrl = `http://${primary}:${PORT_HTTP}`;
  const httpsUrl = `https://${primary}:${PORT_HTTPS}`;
  const joinUrl = httpUrl; // plain HTTP = no browser warning, simplest for family
  let qr = null;
  try {
    qr = await QRCode.toDataURL(joinUrl, { width: 220, margin: 1 });
  } catch { /* ignore */ }
  res.json({ joinUrl, httpUrl, httpsUrl, lanIps: ips, port: PORT_HTTP, httpsPort: PORT_HTTPS, https: false, qr, online: onlineList() });
});

// ---- admin (LAN host) ----
function requireAdmin(req, res, next) {
  if (!okAdmin(req.body?.adminPassword || req.headers["x-admin-password"])) {
    return res.status(403).json({ error: "Wrong admin password" });
  }
  next();
}
app.post("/api/admin/users", strictLimiter, requireAdmin, (req, res) => {
  res.json({
    reservations: Object.values(reservations),
    online: onlineList(),
    messages: messages.length,
  });
});
app.post("/api/admin/kick", strictLimiter, requireAdmin, (req, res) => {
  const lower = String(req.body.username || "").toLowerCase();
  const ent = online.get(lower);
  if (!ent) return res.status(404).json({ error: "User not online" });
  for (const sid of [...ent.sockets]) {
    const s = live.get(sid);
    if (s) {
      s.emit("kicked", { reason: "Kicked by host" });
      s.disconnect(true);
    }
  }
  res.json({ ok: true });
});
app.post("/api/admin/release", strictLimiter, requireAdmin, (req, res) => {
  const lower = String(req.body.username || "").toLowerCase();
  if (!reservations[lower]) return res.status(404).json({ error: "Name not reserved" });
  delete reservations[lower];
  writeJson(USERS_FILE, reservations);
  // also drop tokens for that user
  for (const [t, u] of [...tokens]) if (u === lower) tokens.delete(t);
  res.json({ ok: true });
});
app.post("/api/admin/clear", strictLimiter, requireAdmin, (req, res) => {
  messages = [];
  writeJson(MESSAGES_FILE, messages);
  emitAll("chat-cleared");
  res.json({ ok: true });
});

// ---- socket.io ----
const live = new Map(); // sid -> server-side socket, across http + https
function emitAll(ev, data) { for (const [, s] of live) s.emit(ev, data); }
function emitGroupExcept(sender, ev, data) {
  for (const [, s] of live) {
    if (s.id !== sender.id && s.rooms.has("group")) s.emit(ev, data);
  }
}
function emitToUserSockets(lower, ev, data) {
  const ent = online.get(lower);
  if (!ent) return;
  for (const sid of ent.sockets) {
    const s = live.get(sid);
    if (s) s.emit(ev, data);
  }
}
function attachSocket(server) {
  const io = new Server(server, {
    cors: { origin: false }, // same-origin only; page is served by this server
    maxHttpBufferSize: 1e6,
  });

  io.on("connection", (socket) => {
    live.set(socket.id, socket);
    socket.emit("hello", { maxText: MAX_TEXT, fileLimitMb: FILE_LIMIT_MB });

    socket.on("join", ({ username, roomPassword, deviceId } = {}) => {
      const display = String(username || "").trim();
      const lower = display.toLowerCase();
      const dev = String(deviceId || "").slice(0, 64);

      if (!NAME_RE.test(display)) {
        return socket.emit("join-error", { error: "Name must be 3-16 chars: letters, numbers, _" });
      }
      if (!dev) return socket.emit("join-error", { error: "Missing device id. Reload page." });
      if (!okRoom(roomPassword)) {
        return socket.emit("join-error", { error: "Wrong room password. Ask the host." });
      }

      const existing = reservations[lower];
      if (!existing) {
        // A) first claim — soft-lock: bind name -> device (choose ONCE)
        reservations[lower] = { display, deviceId: dev, createdAt: Date.now() };
        writeJson(USERS_FILE, reservations);
      } else if (existing.deviceId !== dev) {
        // different device trying a reserved name
        if (existing.display !== display) {
          // case-variant guard
          return socket.emit("join-error", { error: `Name taken (reserved as "${existing.display}"). Pick another or ask host to Release it.` });
        }
        return socket.emit("join-error", { error: `Name "${existing.display}" is locked to another device (chosen once). Ask host to Release it, or use your original device.` });
      } else if (existing.display !== display) {
        // same device, different case — keep original casing to stop impersonation-by-case
        return socket.emit("join-error", { error: `Use your exact locked name: "${existing.display}"` });
      }

      const token = crypto.randomUUID();
      tokens.set(token, lower);

      let ent = online.get(lower);
      if (!ent) {
        ent = { display: reservations[lower].display, deviceId: dev, sockets: new Set() };
        online.set(lower, ent);
      }
      ent.sockets.add(socket.id);
      socketUser.set(socket.id, lower);
      socket.join("group");
      socket.join("u:" + lower);

      socket.emit("joined", {
        username: ent.display,
        authToken: token,
        online: onlineList(),
        history: messages.slice(-200),
      });
      emitGroupExcept(socket, "presence", { text: `${ent.display} joined`, ts: Date.now() });
      emitAll("users", { online: onlineList() });
    });

    socket.on("group-msg", ({ text } = {}) => {
      const lower = socketUser.get(socket.id);
      if (!lower || !online.has(lower)) return;
      if (!socketFloodOk(socket.id)) return socket.emit("rate", { error: "Slow down — too many messages" });
      const t = String(text || "").trim().slice(0, MAX_TEXT);
      if (!t) return;
      const msg = pushMessage({
        id: crypto.randomUUID(), kind: "text",
        from: online.get(lower).display, fromLower: lower, to: "group", text: t, ts: Date.now(),
      });
      emitAll("chat-msg", msg);
    });

    socket.on("private-msg", ({ to, text } = {}) => {
      const lower = socketUser.get(socket.id);
      if (!lower || !online.has(lower)) return;
      if (!socketFloodOk(socket.id)) return socket.emit("rate", { error: "Slow down — too many messages" });
      const target = String(to || "").toLowerCase();
      if (!online.has(target)) return socket.emit("pm-error", { error: "User is offline" });
      if (target === lower) return;
      const t = String(text || "").trim().slice(0, MAX_TEXT);
      if (!t) return;
      const msg = pushMessage({
        id: crypto.randomUUID(), kind: "text",
        from: online.get(lower).display, fromLower: lower, to: target, text: t, ts: Date.now(),
      });
      // echo to sender tabs + deliver to recipient tabs (any protocol)
      emitToUserSockets(lower, "chat-msg", msg);
      emitToUserSockets(target, "chat-msg", msg);
    });

    socket.on("typing", ({ to } = {}) => {
      const lower = socketUser.get(socket.id);
      if (!lower) return;
      const payload = { from: online.get(lower)?.display || "?", to: to || "group" };
      if (!to || to === "group") emitGroupExcept(socket, "typing", payload);
      else emitToUserSockets(String(to).toLowerCase(), "typing", payload);
    });

    socket.on("logout", () => {
      // go offline but KEEP reservation (soft-lock: name stays yours)
      const lower = socketUser.get(socket.id);
      if (!lower) return;
      for (const [t, u] of [...tokens]) if (u === lower) tokens.delete(t);
      socket.disconnect(true);
    });

    socket.on("disconnect", () => {
      const lower = socketUser.get(socket.id);
      live.delete(socket.id);
      socketUser.delete(socket.id);
      msgTimes.delete(socket.id);
      if (!lower) return;
      const ent = online.get(lower);
      if (ent) {
        ent.sockets.delete(socket.id);
        if (ent.sockets.size === 0) {
          online.delete(lower);
          emitGroupExcept(socket, "presence", { text: `${ent.display} left`, ts: Date.now() });
          emitAll("users", { online: onlineList() });
        }
      }
    });
  });
  return io;
}

// ---- boot (http or https) ----
function getCert() {
  const keyFile = path.join(DATA_DIR, "key.pem");
  const certFile = path.join(DATA_DIR, "cert.pem");
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  console.log("  [*] Generating self-signed certificate (first HTTPS run)...");
  const selfsigned = require("selfsigned");
  const pems = selfsigned.generate([{ name: "commonName", value: "wifichat.local" }], { keySize: 2048, days: 825 });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

// ---- boot: ALWAYS serve both, so neither URL can fail with
// ERR_SSL_PROTOCOL_ERROR again:
//   http://IP:3000  (plain, simplest — no warning) and
//   https://IP:3443 (encrypted — browser warns once, click Advanced/Proceed)
const httpServer = http.createServer(app);
attachSocket(httpServer);
httpServer.listen(PORT_HTTP, "0.0.0.0", () => printBanner(`http`, PORT_HTTP));

const httpsServer = https.createServer(getCert(), app);
attachSocket(httpsServer);
httpsServer.listen(PORT_HTTPS, "0.0.0.0", () => printBanner(`https`, PORT_HTTPS));

async function printBanner(scheme, port) {
  const ips = getLanIps();
  const primary = ips[0] || "localhost";
  const url = `${scheme}://${primary}:${port}`;
  console.log("\n  ================= WiFi-MS LAN chat ==================");
  console.log(`  Join URL : ${url}`);
  if (ips.length > 1) console.log(`  Also     : ${ips.slice(1).map((ip) => `${scheme}://${ip}:${port}`).join(", ")}`);
  if (scheme === "https") {
    console.log(`  NOTE     : encrypted — open https://...:${port}, NOT http. Browser warns once (self-signed) → Advanced → Proceed.`);
  } else {
    console.log(`  NOTE     : plain HTTP — open http://...:${port}. NEVER type https:// on this port (gives ERR_SSL_PROTOCOL_ERROR). Encrypted alt: https://...:${PORT_HTTPS}.`);
  }
  console.log(`  Mode     : BOTH ports live — http :${PORT_HTTP} (simple) + https :${PORT_HTTPS} (encrypted)`);
  console.log(`  Names    : choose ONCE, locked to device (soft-lock A)`);
  console.log(`  Auth     : no Gmail — room password only`);
  console.log("  ===================================================\n");
  try {
    const qrText = await QRCode.toString(url, { type: "terminal", small: true });
    console.log(qrText);
    console.log(`  Guests: connect to the SAME Wi-Fi, scan QR or type the URL, enter name ONCE + room password.\n`);
  } catch { /* ignore */ }
}
