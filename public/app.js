// Home Chat — usable + safe. Offline-only. No innerHTML for user content.
const $ = (id) => document.getElementById(id);
const socket = io();
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/* ---------- identity (choose name ONCE) ---------- */
let deviceId = localStorage.getItem("wifichat_device");
if (!deviceId) {
  deviceId = (crypto.randomUUID ? crypto.randomUUID() : "d" + Date.now() + Math.random().toString(16).slice(2));
  localStorage.setItem("wifichat_device", deviceId);
}
let lockedName = localStorage.getItem("wifichat_name") || "";
let me = "", meLower = "", authToken = "", activeTo = "group";
let online = [];
const unread = {};          // key -> count
const firstUnreadId = {};   // key -> msg id for "New messages" divider
const allMsgs = [];
let activeSearch = "";

const COLORS = ["#22c55e","#3b82f6","#a855f7","#ef4444","#f59e0b","#06b6d4","#ec4899","#14b8a6"];
function colorFor(n){ let h=0; n=String(n||"?"); for(const c of n) h=(h*31+c.charCodeAt(0))>>>0; return COLORS[h%COLORS.length]; }
function initial(n){ return (String(n||"?").trim().charAt(0)||"?").toUpperCase(); }
function toast(t,ms=2600){ const el=$("toast"); el.textContent=t; el.style.display="block"; clearTimeout(window._toast); window._toast=setTimeout(()=>el.style.display="none",ms); }
function friendly(err){
  err = String(err||"Something went wrong");
  if(/room password/i.test(err)) return "❌ Wrong house password. Ask the host.";
  if(/locked to another device/i.test(err)) return "🔒 Name belongs to another device. Use your own, or ask host to Release it.";
  if(/reserved as/i.test(err)) return "👤 "+err;
  if(/taken/i.test(err)) return "👤 Name already in use — pick another.";
  if(/3-16/i.test(err)) return "✏️ Name: 3–16 letters/numbers (e.g. Papa).";
  if(/exact locked name/i.test(err)) return "🔒 "+err;
  if(/Slow down/i.test(err)) return "⏳ Sending too fast — wait a second.";
  if(/offline/i.test(err)) return "📴 That person left. Talk in # Everyone.";
  if(/MIME|type not allowed/i.test(err)) return "📎 That file type is blocked. Use photo/pdf/txt/mp3/mp4.";
  if(/Too big|too large|File too large/i.test(err)) return "📎 Too big — max 10MB.";
  return "⚠️ " + err;
}
let AC = null;
function beep(){ try{ AC = AC || new (window.AudioContext||window.webkitAudioContext)(); const o=AC.createOscillator(), g=AC.createGain(); o.connect(g); g.connect(AC.destination); o.frequency.value=880; g.gain.value=0.06; o.start(); o.stop(AC.currentTime+0.12);}catch{} }

/* ---------- login ---------- */
if (lockedName) {
  $("name").value = lockedName;
  $("name").disabled = true;
  $("lockNote").innerHTML = "";
  const s = document.createElement("div");
  s.style.cssText = "background:#12331f;border:1px solid #22c55e;border-radius:10px;padding:8px 10px;margin-top:6px";
  s.textContent = `🔒 Locked as "${lockedName}" — good, nobody can steal it.`;
  $("lockNote").appendChild(s);
  const b = document.createElement("button");
  b.type="button"; b.className="ghost"; b.style.marginTop="8px"; b.textContent="Forget my name (host must Release first)";
  b.onclick = () => { if (confirm(`Forget "${lockedName}" on this device?`)) { localStorage.removeItem("wifichat_name"); location.reload(); } };
  $("lockNote").appendChild(b);
}
$("name").addEventListener("input", ()=>{
  const v = $("name").value.trim();
  $("nameHint").textContent = /^[A-Za-z0-9_]{3,16}$/.test(v) ? "✔ Looks good — you will keep this name." : "3–16 letters/numbers only. You choose it once.";
});
$("showPw").onclick = ()=>{ const p=$("roomPw"); p.type = p.type==="password"?"text":"password"; $("showPw").textContent = p.type==="password"?"👁️":"🙈"; };
fetch("/api/info").then(r=>r.json()).then(info=>{
  $("joinUrl").textContent = info.joinUrl;
  $("onlineNow").textContent = `🟢 ${info.online.length} chatting now • 🏠 home Wi-Fi`;
  const alt = document.createElement("div");
  alt.className = "small muted center";
  alt.textContent = info.httpsUrl ? `🔒 Encrypted alternative (warns once, then works): ${info.httpsUrl}` : "";
  $("onlineNow").appendChild(document.createElement("br"));
  $("onlineNow").appendChild(alt);
  if(info.qr){ const q=$("qr"); q.src=info.qr; q.style.display="block"; }
}).catch(()=>{ $("joinUrl").textContent="Cannot reach server — is the host running?"; });
$("copyBtn").onclick = async ()=>{
  const t = $("joinUrl").textContent;
  try{ await navigator.clipboard.writeText(t); toast("📋 Address copied — send it to family"); }
  catch{ prompt("Copy this address and send to family:", t); }
};
$("howBtn").onclick = ()=>{ const b=$("howBox"); b.style.display = b.style.display==="none"?"block":"none"; };
$("fixBtn").onclick = ()=>{ const b=$("fixBox"); b.style.display = b.style.display==="none"?"block":"none"; };
$("roomPw").addEventListener("keydown",e=>{ if(e.key==="Enter") doJoin(); });
$("name").addEventListener("keydown",e=>{ if(e.key==="Enter") $("roomPw").focus(); });
$("joinBtn").onclick = doJoin;
function doJoin(){
  $("loginErr").textContent="";
  const username=($("name").value||"").trim();
  if(!/^[A-Za-z0-9_]{3,16}$/.test(username)){ $("loginErr").textContent="👆 Name: 3–16 letters/numbers, e.g. Papa"; $("name").focus(); return; }
  if(!$("roomPw").value){ $("loginErr").textContent="👆 Type the house password (ask the host)"; $("roomPw").focus(); return; }
  $("joinBtn").textContent="Joining… ⏳"; $("joinBtn").disabled = true;
  socket.emit("join",{username,roomPassword:$("roomPw").value,deviceId});
}
socket.on("join-error",({error})=>{ $("joinBtn").textContent="💬 Join house chat"; $("joinBtn").disabled=false; $("loginErr").textContent=friendly(error); });

/* ---------- socket core ---------- */
socket.on("kicked",()=>{ alert("You were removed by the host."); location.reload(); });
socket.on("chat-cleared",()=>{ allMsgs.length=0; for(const k of Object.keys(unread)) delete unread[k]; renderMsgs(false); });
socket.on("hello",()=>{});
socket.on("joined",(data)=>{
  me=data.username; meLower=me.toLowerCase(); authToken=data.authToken;
  localStorage.setItem("wifichat_name",me);
  $("login").style.display="none"; $("chat").style.display="block";
  $("me").textContent=me;
  const av=$("avatarMe"); av.textContent=initial(me); av.style.background=colorFor(me);
  online=data.online||[];
  allMsgs.push(...(data.history||[]));
  buildEmoji();
  renderConvos(); renderMsgs(false);
  toast(`Welcome, ${me}! 👋 Say hello in # Everyone.`);
  setTimeout(()=>$("text").focus(),300);
});
socket.on("users",({online:list})=>{ online=list||[]; renderConvos(); });
socket.on("presence",(p)=>{ addPill(p.text); });
socket.on("chat-msg",(m)=>{
  allMsgs.push(m); if(allMsgs.length>600) allMsgs.splice(0, allMsgs.length-600);
  const mine = m.fromLower===meLower;
  const key = convoKeyFor(m, mine);
  const viewing = isViewing(key);
  if(!viewing){
    if(!mine){
      unread[key]=(unread[key]||0)+1;
      if(!firstUnreadId[key]) firstUnreadId[key]=m.id;
      renderConvos(); beep();
      if(document.hidden) toast(`💬 ${m.from}: ${previewOf(m)}`);
    }
    return;
  }
  const stick = isNearBottom();
  renderMsgs(true);
  if(!stick){ showNewPill(); } else if(!mine){ beep(); }
});
const typers = new Map();
socket.on("typing",({from,to})=>{
  const key = (!to||to==="group")?"group":String(to).toLowerCase()===$("me").textContent.toLowerCase()?"group":String(to);
  const showKey = (!to||to==="group")?"group":(String(to).toLowerCase()===meLower? "group" : String(to));
  void key;
  // only show typing for current view
  const forGroup = (!to||to==="group");
  const relevant = forGroup ? (activeTo==="group") : (activeTo!=="group" && (String(to).toLowerCase()===meLower || from.toLowerCase()===activeTo.toLowerCase()));
  if(!relevant) return;
  typers.set(from, Date.now());
  paintTyping();
  clearTimeout(window._ttype); window._ttype=setTimeout(()=>{ const now=Date.now(); for(const [k,t] of [...typers]) if(now-t>1800) typers.delete(k); paintTyping(); },1900);
});
function paintTyping(){
  const names=[...typers.keys()].filter(n=>n.toLowerCase()!==meLower).slice(0,3);
  $("typing").textContent = names.length ? `✏️ ${names.join(", ")} ${names.length>1?"are":"is"} writing…` : "";
}
socket.on("rate",({error})=>toast(friendly(error)));
socket.on("pm-error",({error})=>toast(friendly(error)));
socket.on("connect",()=>{ $("net").textContent="connected ✔"; $("dot").classList.add("on"); $("reconnect").style.display="none"; });
socket.on("disconnect",()=>{ $("net").textContent="reconnecting…"; $("dot").classList.remove("on"); $("reconnect").style.display="block"; });

function convoKeyFor(m, mine){
  if(m.to==="group") return "group";
  if(mine) return String(m.to||"").toLowerCase();
  return m.fromLower;
}
function isViewing(key){ return activeTo.toLowerCase()===String(key).toLowerCase(); }
function previewOf(m){
  if(m.kind==="file"&&m.file) return "📎 " + (m.file.name||"file");
  return String(m.text||"").slice(0,60);
}

/* ---------- conversations sidebar ---------- */
$("searchPeople").addEventListener("input", renderConvos);
function lastMsgFor(key){
  const list = key==="group" ? allMsgs.filter(m=>m.to==="group") : allMsgs.filter(m=>m.to!=="group" && ((m.fromLower===meLower&&m.to===key)||(m.fromLower===key&&m.to===meLower)));
  return list[list.length-1] || null;
}
function renderConvos(){
  const q = ($("searchPeople").value||"").toLowerCase().trim();
  const box = $("convos"); box.innerHTML="";
  const others = online.filter(u=>u.toLowerCase()!==meLower).filter(u=>!q||u.toLowerCase().includes(q));
  $("count").textContent = `${online.length} online`;
  $("noUsers").style.display = online.filter(u=>u.toLowerCase()!==meLower).length ? "none" : "block";

  // group row
  box.appendChild(convoRow("group","🟢","# Everyone","whole house", lastMsgFor("group")));
  // people rows
  others.forEach(u=>{
    box.appendChild(convoRow(u.toLowerCase(), null, u, "secret 1-to-1 🟢", lastMsgFor(u.toLowerCase())));
  });
  if(q && !others.length && !"group # everyone whole house".includes(q)){
    const d=document.createElement("div"); d.className="small muted"; d.textContent="No person matches. Try # Everyone."; box.appendChild(d);
  }
  paintBanner();
}
function convoRow(key, icon, title, sub, last){
  const b=document.createElement("button"); b.type="button";
  b.className="chan"+(activeTo.toLowerCase()===String(key).toLowerCase()?" active":"");
  const who=document.createElement("span"); who.className="who";
  const av=document.createElement("span"); av.className="miniav";
  av.textContent = key==="group" ? "🏠" : initial(title);
  av.style.background = key==="group" ? "#166534" : colorFor(title);
  if(key!=="group"){ const p=document.createElement("span"); p.className="presence"; av.appendChild(p); }
  who.appendChild(av);
  const tx=document.createElement("span"); tx.style.minWidth="0";
  const nm=document.createElement("div"); nm.className="nm"; nm.textContent=(icon?icon+" ":"")+title; tx.appendChild(nm);
  const pv=document.createElement("div"); pv.className="sub2";
  pv.textContent = last ? ((last.fromLower===meLower?"You: ":""+last.from+": ")+previewOf(last)) : sub;
  tx.appendChild(pv);
  who.appendChild(tx);
  b.appendChild(who);
  if(unread[key]){ const s=document.createElement("span"); s.className="unread"; s.textContent=unread[key]>99?"99+":unread[key]; b.appendChild(s); }
  b.onclick=()=>{ switchConvo(key==="group"?"group":title); };
  return b;
}
function switchConvo(to){
  activeTo = to;
  unread[to.toLowerCase()] = 0; delete firstUnreadId[to.toLowerCase()];
  activeSearch = ""; $("searchChat").value=""; $("searchBar").style.display="none"; $("searchCount").textContent="";
  renderConvos(); renderMsgs(false);
  closeSide();
  setTimeout(()=>$("text").focus(),100);
}
function paintBanner(){
  if(activeTo==="group"){ $("talkIcon").textContent="🟢"; $("talkTo").textContent="Everyone in the house"; $("talkHint").textContent="Everyone here can read it."; $("text").placeholder="Message Everyone… (Enter = send)"; }
  else{ $("talkIcon").textContent="🤫"; $("talkTo").textContent=activeTo+"  (secret)"; $("talkHint").textContent="Only you and "+activeTo+" can read this."; $("text").placeholder="Secret message to "+activeTo+"… (Enter = send)"; }
  $("dropTo").textContent = activeTo==="group" ? "Everyone" : activeTo;
}

/* ---------- messages ---------- */
function visibleMsgs(){
  let list;
  if(activeTo==="group") list = allMsgs.filter(m=>m.to==="group");
  else { const k=activeTo.toLowerCase(); list = allMsgs.filter(m=>m.to!=="group" && ((m.fromLower===meLower&&m.to===k)||(m.fromLower===k&&m.to===meLower))); }
  if(activeSearch){ const q=activeSearch.toLowerCase(); list = list.filter(m=> (m.text||"").toLowerCase().includes(q) || (m.file&&m.file.name.toLowerCase().includes(q)) ); }
  return list.slice(-250);
}
function dayLabel(ts){
  const d=new Date(ts), now=new Date();
  const day=(x)=>x.getFullYear()+"-"+x.getMonth()+"-"+x.getDate();
  if(day(d)===day(now)) return "Today";
  const y=new Date(now); y.setDate(now.getDate()-1);
  if(day(d)===day(y)) return "Yesterday";
  return d.toLocaleDateString([],{weekday:"short",day:"numeric",month:"short"});
}
function renderMsgs(keepSearch){
  const box=$("msgs"); box.innerHTML="";
  hideNewPill();
  const list=visibleMsgs();
  $("emptyChat").style.display = list.length?"none":"block";
  if(activeSearch) $("searchCount").textContent = `${list.length} found`;
  let lastDay="", prevFrom="", prevT=0;
  const unreadId = firstUnreadId[activeTo.toLowerCase()];
  let dividerShown=false;
  list.forEach(m=>{
    const day=dayLabel(m.ts||Date.now());
    if(day!==lastDay){ lastDay=day; const d=document.createElement("div"); d.className="daydiv"; d.textContent=day==="Today"?"📅 Today":day; box.appendChild(d); }
    if(unreadId && !dividerShown && m.id===unreadId){ const n=document.createElement("div"); n.className="newdiv"; n.textContent="↓ New messages"; box.appendChild(n); dividerShown=true; }
    const tight = (m.fromLower===prevFrom && (m.ts-prevT)<120000 && m.kind!=="file");
    box.appendChild(msgNode(m, tight));
    prevFrom=m.fromLower; prevT=m.ts||Date.now();
  });
  box.scrollTop = box.scrollHeight;
  updateScrollBtn();
}
function msgNode(m, tight){
  const mine=m.fromLower===meLower;
  const row=document.createElement("div"); row.className="msg"+(mine?" me":"")+(tight?" tight":"");
  const av=document.createElement("div"); av.className="avatar"; av.textContent=initial(m.from); av.style.background=colorFor(m.from||"?"); av.title=m.from;
  row.appendChild(av);
  const b=document.createElement("div"); b.className="bubble";
  if(!tight){
    const meta=document.createElement("div"); meta.className="meta";
    const who=document.createElement("b"); who.textContent=(mine?"You":m.from)+(m.to!=="group"?" 🤫":"");
    const when=document.createElement("span"); const dt=new Date(m.ts||Date.now());
    when.textContent=dt.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
    when.title=dt.toLocaleString();
    meta.appendChild(who); meta.appendChild(when);
    b.appendChild(meta);
  }
  if(m.kind==="file"&&m.file){
    const isImg=(m.file.mime||"").startsWith("image/");
    const a=document.createElement("a"); a.className="filecard"; a.href=m.file.url; a.target="_blank"; a.rel="noopener";
    const ic=document.createElement("span"); ic.style.fontSize="26px"; ic.textContent=isImg?"🖼️":m.file.mime==="application/pdf"?"📕":m.file.mime.startsWith("audio")?"🎵":m.file.mime.startsWith("video")?"🎬":"📄";
    const mid=document.createElement("span"); mid.style.flex="1"; mid.style.minWidth="0";
    const nm=document.createElement("div"); nm.textContent=m.file.name||"file"; nm.style.fontWeight="800"; nm.style.wordBreak="break-all";
    const sz=document.createElement("div"); sz.className="small muted"; sz.textContent=`${fmtSize(m.file.size)} • tap to open`;
    mid.appendChild(nm); mid.appendChild(sz);
    const dl=document.createElement("span"); dl.className="dl"; dl.textContent="Open";
    a.appendChild(ic); a.appendChild(mid); a.appendChild(dl);
    b.appendChild(a);
    if(isImg){ const img=document.createElement("img"); img.className="photo"; img.src=m.file.url; img.alt=m.file.name||"photo"; img.loading="lazy"; img.onclick=(e)=>{e.preventDefault(); openLightbox(m.file.url, m.file.name);}; b.appendChild(img); }
  } else {
    const body=document.createElement("div"); body.className="body";
    linkifyInto(body, String(m.text||""));
    b.appendChild(body);
  }
  row.appendChild(b);
  return row;
}
function fmtSize(n){ n=+n||0; if(n<1024) return n+" B"; if(n<1048576) return Math.round(n/1024)+" KB"; return (n/1048576).toFixed(1)+" MB"; }
// safe linkify: text nodes + <a> only for http(s) URLs
function linkifyInto(el, text){
  const re = /(https?:\/\/[^\s<>"')]+)/g;
  let m, idx = 0, found = false;
  el.innerHTML = "";
  while((m = re.exec(text))){
    found = true;
    const url = m[0].replace(/[.,!?;:]+$/, "");
    if(m.index > idx) el.appendChild(document.createTextNode(text.slice(idx, m.index)));
    const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; a.textContent = url;
    el.appendChild(a);
    idx = m.index + m[0].length;
  }
  if(!found){ el.textContent = text; return; }
  if(idx < text.length) el.appendChild(document.createTextNode(text.slice(idx)));
}
function addPill(text){
  if(!$("chat")||$("chat").style.display==="none") return;
  const d=document.createElement("div"); d.className="pill"; d.textContent=text+" • "+new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  $("msgs").appendChild(d); $("msgs").scrollTop=$("msgs").scrollHeight;
}
// scroll helpers
$("msgs").addEventListener("scroll", ()=>{ updateScrollBtn(); if(isNearBottom()) hideNewPill(); });
function isNearBottom(){ const b=$("msgs"); return b.scrollHeight-b.scrollTop-b.clientHeight < 140; }
function updateScrollBtn(){ const show=!isNearBottom() && $("msgs").children.length>2; $("scrollBtn").style.display=show?"block":"none"; }
$("scrollBtn").onclick=()=>{ $("msgs").scrollTop=$("msgs").scrollHeight; hideNewPill(); };
function showNewPill(){ const p=$("newPill"); p.style.display="block"; p.onclick=()=>{ $("msgs").scrollTop=$("msgs").scrollHeight; hideNewPill(); }; $("scrollBtn").style.display="block"; }
function hideNewPill(){ $("newPill").style.display="none"; }

/* ---------- search in chat ---------- */
$("searchToggle").onclick=()=>{ const bar=$("searchBar"); const open=bar.style.display!=="none"; bar.style.display=open?"none":"flex"; if(!open){ $("searchChat").focus(); } else { activeSearch=""; $("searchChat").value=""; renderMsgs(); } };
$("searchClear").onclick=()=>{ activeSearch=""; $("searchChat").value=""; $("searchBar").style.display="none"; renderMsgs(); };
$("searchChat").addEventListener("input",()=>{ activeSearch=$("searchChat").value.trim(); renderMsgs(); });

/* ---------- composer: textarea, emoji, uploads ---------- */
const ta=$("text");
ta.addEventListener("input",()=>{
  ta.style.height="auto"; ta.style.height=Math.min(130,ta.scrollHeight)+"px";
  const n=ta.value.length; $("charCount").textContent=`${n}/2000`;
  $("sendBtn").disabled=!ta.value.trim();
  clearTimeout(window._tt); window._tt=setTimeout(()=>socket.emit("typing",{to:activeTo}),250);
});
ta.addEventListener("keydown",(e)=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); send(); } });
function send(){
  const t=(ta.value||"").trim(); if(!t) return;
  if(activeTo==="group") socket.emit("group-msg",{text:t});
  else socket.emit("private-msg",{to:activeTo,text:t});
  ta.value=""; ta.style.height="auto"; $("charCount").textContent="0/2000"; $("sendBtn").disabled=true; ta.focus();
}
$("sendBtn").onclick=send;

const EMOJIS="😀😁😂🤣😊😍😘😎🤔😅😭😡👍👎🙏👏💪🔥🎉❤️💔✨⭐🏠🍛☕🚗⚽📎✅❌⏰💡🎵📷".split(/ (?=(?:[^\uD800-\uDFFF]|$)) /).join("").match(/./gu)||[];
function buildEmoji(){
  const p=$("emojiPanel"); if(p.children.length) return;
  const list=["😀","😁","😂","🤣","😊","😍","😘","😎","🤔","😅","😭","😡","👍","👎","🙏","👏","💪","🔥","🎉","❤️","💔","✨","⭐","🏠","🍛","☕","🚗","⚽","✅","❌","⏰","💡","🎵","📷","🌙","☀️","👋","🤝","💬","📎"];
  list.forEach(e=>{
    const b=document.createElement("button"); b.type="button"; b.textContent=e;
    b.onclick=()=>{ const s=ta.selectionStart||ta.value.length, en=ta.selectionEnd||s; ta.value=ta.value.slice(0,s)+e+ta.value.slice(en); ta.dispatchEvent(new Event("input")); ta.focus(); };
    p.appendChild(b);
  });
}
$("emojiBtn").onclick=(e)=>{ e.stopPropagation(); const p=$("emojiPanel"); p.style.display=p.style.display==="none"?"grid":"none"; };
document.addEventListener("click",(e)=>{ if(!$("emojiPanel").contains(e.target)&&e.target!==$("emojiBtn")) $("emojiPanel").style.display="none"; });

async function uploadFile(f){
  if(!f) return;
  if(f.size>10*1024*1024){ toast("📎 Too big — max 10MB"); return; }
  toast(`Sending "${f.name.slice(0,30)}…" ⏳`);
  const fd=new FormData(); fd.append("file",f); fd.append("to",activeTo);
  try{
    const r=await fetch("/upload",{method:"POST",headers:{"x-auth-token":authToken},body:fd});
    const j=await r.json().catch(()=>({}));
    if(!j.ok) toast(friendly(j.error||"Upload failed"));
    else toast("Sent ✔");
  }catch{ toast("📴 Failed — still on home Wi-Fi?"); }
}
$("file").addEventListener("change",(e)=>{ uploadFile(e.target.files[0]); e.target.value=""; });
// paste + drag-drop photos
$("main").addEventListener("paste",(e)=>{ const f=[...(e.clipboardData?.files||[])][0]; if(f) uploadFile(f); });
["dragenter","dragover"].forEach(ev=>$("main").addEventListener(ev,(e)=>{ e.preventDefault(); $("dropHint").style.display="block"; }));
["dragleave","drop"].forEach(ev=>$("main").addEventListener(ev,(e)=>{ e.preventDefault(); if(ev==="drop"){ const f=e.dataTransfer?.files?.[0]; if(f) uploadFile(f); } $("dropHint").style.display="none"; }));

/* ---------- lightbox / drawer / help / logout ---------- */
function openLightbox(src,name){ $("lightboxImg").src=src; $("lightboxName").textContent=name||""; $("lightbox").style.display="flex"; }
$("lightboxClose").onclick=()=>{ $("lightbox").style.display="none"; $("lightboxImg").src=""; };
$("lightbox").onclick=(e)=>{ if(e.target===$("lightbox")){ $("lightbox").style.display="none"; $("lightboxImg").src=""; } };
document.addEventListener("keydown",(e)=>{ if(e.key==="Escape"){ $("lightbox").style.display="none"; $("emojiPanel").style.display="none"; closeSide(); } });
$("menuBtn").onclick=()=>{ $("side").classList.add("open"); $("sideBackdrop").style.display="block"; };
function closeSide(){ $("side").classList.remove("open"); $("sideBackdrop").style.display="none"; }
$("sideBackdrop").onclick=closeSide;
$("helpBtn").onclick=()=>{ $("helpCard").style.display="block"; };
$("helpClose").onclick=()=>{ $("helpCard").style.display="none"; };
$("logoutBtn").onclick=()=>{ if(confirm("Exit chat? Your name stays locked to this device. ✔")){ try{socket.emit("logout");}catch{} setTimeout(()=>location.reload(),300); } };

/* ---------- admin ---------- */
async function adminPost(path,body){ body.adminPassword=$("adminPw").value; if(!body.adminPassword){ toast("Type admin password first"); throw 0; } const r=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}); return r.json(); }
$("adminUsers").onclick=async()=>{ try{ const j=await adminPost("/api/admin/users",{}); $("adminOut").textContent=`Online now: ${(j.online||[]).join(", ")||"nobody"}\nReserved names: ${(j.reservations||[]).map(r=>r.display).join(", ")||"none"}\nMessages stored: ${j.messages}`; }catch{} };
$("adminClear").onclick=async()=>{ if(!confirm("Delete ALL messages for everyone?")) return; try{ $("adminOut").textContent=JSON.stringify(await adminPost("/api/admin/clear",{}),null,2);}catch{} };
$("adminKick").onclick=async()=>{ try{ $("adminOut").textContent=JSON.stringify(await adminPost("/api/admin/kick",{username:$("adminTarget").value}),null,2);}catch{} };
$("adminRelease").onclick=async()=>{ try{ const j=await adminPost("/api/admin/release",{username:$("adminTarget").value}); $("adminOut").textContent=JSON.stringify(j,null,2); if(j.ok) toast(`Released "${$("adminTarget").value}" ✔`);}catch{} };
