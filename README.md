<div align="center">

# 🏠 WiFi-MS — Home Wi-Fi Chat

### Talk with everyone on your home Wi-Fi — even with **no internet**. No accounts. No cloud. No Gmail. Just family.

![MIT License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-black?style=for-the-badge&logo=express&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-realtime-010101?style=for-the-badge&logo=socket.io&logoColor=white)
![Offline First](https://img.shields.io/badge/offline-first-22c55e?style=for-the-badge)
![Zero CDN](https://img.shields.io/badge/0%20CDN-100%25%20local-blue?style=for-the-badge)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?style=for-the-badge)

**One device hosts. Everyone else just opens an address in their browser. That's it.**

[Features](#-features) • [Quick Start](#-quick-start-60-seconds) • [Join from Phone](#-join-from-your-phone) • [Security](#-security--privacy) • [Tech Stack](#️-tech-stack) • [Contributing](#-contributing)

</div>

---

## 💡 The idea

WhatsApp needs the internet. **WiFi-MS doesn't.** As long as every device is on the same house Wi-Fi, messages flow through your own router — unplug the internet cable and the chat keeps working. Perfect for families, small offices, classrooms, events, and places with no (or expensive) internet.

```
   Phone ──────┐
               ├──→ Home Router ──→ Host PC (runs WiFi-MS) ←── chat lives HERE, nowhere else
   Laptop ─────┘
```

## ✨ Features

| | |
|---|---|
| 💬 **Group chat** | `# Everyone` room for the whole house |
| 🤫 **Private 1-to-1** | Tap a person for a secret chat only you two can read |
| 📎 **Photos & files** | Up to 10 MB — images preview inline, paste or drag & drop works |
| 😀 **Emoji picker** | Built-in, works offline — zero external requests |
| 🔍 **Search** | Find people, search words inside any conversation |
| ⌨️ **Live feel** | Typing indicators, join/leave presence, date dividers, unread badges, new-message pill, message sounds |
| 🔒 **Locked names** | Pick your name **once** — it's bound to your device so nobody can impersonate you |
| 📜 **History** | Last messages saved locally, auto-expire after 7 days |
| 📱 **Mobile-first UI** | Big buttons, people drawer, back flow — grandparents approved |
| 👑 **Host admin** | See people, kick, release names, wipe chat — from the login page |
| 📷 **QR join** | Server prints a QR code — phones scan & join in seconds |

## 🚀 Quick Start (60 seconds)

**Requirements:** [Node.js](https://nodejs.org/) 18+ on the host computer (Windows, macOS or Linux).

```bash
# 1. Clone & enter
git clone https://github.com/ZAKARIAELQANNAA-DV/wifims.git
cd wifims

# 2. Install (one time)
npm install

# 3. Run
npm start
```

You'll see something like:

```
  ================= WiFi-MS LAN chat ==================
  Join URL : http://192.168.1.116:3000
  ...
  [QR CODE — scan it with a phone]
```

> 🔒 **Encryption?** Both ports are served automatically —
> plain `http://…:3000` (simplest, no warnings) **and** encrypted `https://…:3443`
> (self-signed cert generated on first run; browser warns once → *Advanced → Proceed*).

### ⚙️ Configuration

| Variable | Default | What it does |
|---|---|---|
| `ROOM_PASSWORD` | `house123` | Password every guest types to join — **change this!** |
| `ADMIN_PASSWORD` | `admin1234` | Host-only password (kick / release / wipe) — **change this!** |
| `PORT` | `3000` | Plain-HTTP port |
| `HTTPS_PORT` | `3443` | Encrypted-HTTPS port |

PowerShell example:

```powershell
$env:ROOM_PASSWORD="our-family-secret"; $env:ADMIN_PASSWORD="dad-only-42"; npm start
```

## 📱 Join from your phone

1. Connect the phone to the **same Wi-Fi** as the host (turn **mobile data OFF** and **VPN OFF** — VPNs break local addresses).
2. Open `http://192.168.1.116:3000` in the address bar (use **http**, not https — or scan the QR code).
3. Pick your **name once** (e.g. `Papa`) + type the house password → you're in `# Everyone`.
4. Tap any person for a 🤫 secret chat. Paperclip 📎 sends photos.

> 🆘 **Phone can't open the page?** Tap *"Phone can't open the page? Fix it"* right on the login screen. 99% of the time it's: wrong Wi-Fi, mobile data still on, or typing `https` on the http port.

## 🔒 Security & Privacy

Designed so **nothing ever leaves your house**:

- 🚫 **No Gmail, no OAuth, no accounts, no cloud, no CDN, no tracking.** Page, styles, scripts and even the Socket.IO client are all served by your own machine.
- 🧂 **Passwords hashed** with bcrypt (room + admin, kept in memory only).
- 🔒 **Name soft-lock** — `data/users.json` binds each name to its device. Nobody can steal your name unless the host *Releases* it.
- 🛡️ **Hardened headers** (helmet) with a LAN-safe policy: strict `script-src 'self'`, no forced-HTTPS (so plain-HTTP LAN keeps working on every phone).
- 🚦 **Rate limits** — 200 HTTP requests/min globally, 60 chat messages/min per device (anti-flood).
- 📎 **Upload guardrails** — extension + MIME whitelist, 10 MB cap, random UUID filenames, `nosniff`.
- 🧹 **Local-only storage** — `data/` + `uploads/` live on the host. Delete the folder = everything's gone.

## 🛠️ Tech Stack

**No build step. No framework. No CDN. Just clean, dependency-light code that runs anywhere Node runs.**

| Layer | Technology |
|---|---|
| Runtime | [Node.js](https://nodejs.org/) 18+ |
| Server | [Express](https://expressjs.com/) 4 + [Socket.IO](https://socket.io/) 4 (WebSocket realtime) |
| Frontend | Vanilla HTML + CSS + JS (single page, mobile-first, fully offline) |
| Auth hashing | [bcryptjs](https://github.com/dcodeIO/bcrypt.js) (pure JS, no native builds) |
| Hardening | [helmet](https://helmetjs.github.io/) + [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) |
| Uploads | [multer](https://github.com/expressjs/multer) (validated, size-capped) |
| QR codes | [qrcode](https://github.com/soldair/node-qrcode) (terminal + in-page) |
| Self-signed TLS | [selfsigned](https://github.com/jfromaniello/selfsigned) (2048-bit, auto-generated) |
| Storage | Local JSON (`data/`) — no database to install, no native modules |

```
wifims/
├── server.js        → Express + Socket.IO + auth + uploads + dual HTTP/HTTPS
├── package.json
├── public/          → 100% offline UI (index.html, style.css, app.js)
├── data/            → users.json, messages.json, cert.pem (local only, gitignored)
└── uploads/         → shared photos/files (local only, gitignored)
```

## 🧪 Tested & working

Every release is verified live: wrong-password rejected, joins, name-steal blocked, group + private delivery, upload auth, admin auth, **cross-protocol chat** (http ⇄ https) — plus serving checks for `/`, `/style.css`, `/app.js`, `/socket.io.js` over the real LAN address.

## 🗺️ Roadmap

- [ ] Light mode
- [ ] Voice notes over LAN
- [ ] mDNS (`http://wifichat.local` instead of IP)
- [ ] Installable PWA (still 100% offline)
- [ ] Multi-language UI (Arabic / French / English)

Ideas? [Open an issue](https://github.com/ZAKARIAELQANNAA-DV/wifims/issues) — or just send a PR. 💚

## 🤝 Contributing

1. Fork it 🍴
2. Create a branch: `git checkout -b my-cool-feature`
3. Keep it offline-friendly (no CDN, no cloud calls!)
4. Open a Pull Request — all ideas welcome, especially UI polish ✨

## 👨‍💻 Author

Made with ❤️ by **[ZAKARIAELQANNAA-DV](https://github.com/ZAKARIAELQANNAA-DV)**

> *"Chat with your house, not with the cloud."* 🏠💬

If WiFi-MS helped your family — ⭐ star the repo, it means a lot!

## 📄 License

[MIT](LICENSE) — free for personal, family, school and commercial use. Do cool things with it. 🚀

---

<div align="center">

`#offline-first` `#lan-chat` `#socket-io` `#express` `#vanilla-js` `#no-cloud` `#privacy` `#home-network` `#pwa-ready` `#family-tech`

**🏠 WiFi-MS — your house, your chat, your rules.**

</div>
