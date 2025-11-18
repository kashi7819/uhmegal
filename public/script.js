/* public/script.js - Babyboom UI logic (WebRTC + socket.io) */
const socket = io();
const typingDots = document.getElementById("typingDots");
let typingTimeout = null;

/* ------------------ AUTO NEXT ------------------ */
let autoNext = true;
const autoNextBtn = document.getElementById("autoNextBtn");
if (autoNextBtn) {
  autoNextBtn.textContent = "⏺ Auto Next ON";
  autoNextBtn.style.background = "#16a34a";
  autoNextBtn.addEventListener("click", () => {
    autoNext = !autoNext;
    autoNextBtn.textContent = autoNext ? "⏺ Auto Next ON" : "⏹ Auto Next OFF";
    autoNextBtn.style.background = autoNext ? "#16a34a" : "#dc2626";
  });
}

/* ------------------ DOM ------------------ */
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const skipBtn = document.getElementById("skipBtn");
const sendBtn = document.getElementById("sendBtn");
const messageInput = document.getElementById("messageInput");
const chatBox = document.getElementById("chatBox");
const statusEl = document.getElementById("status");
const onlineCountEl = document.getElementById("onlineCount");
const themeToggle = document.getElementById("themeToggle");
const reportNav = document.getElementById("reportNav");
const reportPopup = document.getElementById("reportPopup");
const cancelReport = document.getElementById("cancelReport");
const reasonButtons = document.querySelectorAll(".reason");
const localProfileCard = document.getElementById("localProfileCard");
const remoteProfileCard = document.getElementById("remoteProfileCard");
const pfNickname = document.getElementById("pfNickname");
const pfAge = document.getElementById("pfAge");
const pfGender = document.getElementById("pfGender");
const saveProfileBtn = document.getElementById("saveProfileBtn");
const qualityIndicator = document.getElementById("qualityIndicator");

/* ------------------ STATE ------------------ */
let localStream = null;
let pc = null;
let currentRoom = null;
let myId = null;
let qualityPollInterval = null;

/* ------------------ PROFILE (local) ------------------ */
const DEFAULT_PROFILE = { nickname: "", age: "", gender: "any" };
let myProfile = JSON.parse(localStorage.getItem("babyboom-profile") || "null") || DEFAULT_PROFILE;

function renderLocalProfileUI() {
  if (!localProfileCard) return;
  const n = myProfile.nickname || "You";
  const a = myProfile.age ? `${myProfile.age} yrs` : "";
  const g = myProfile.gender !== "any" ? myProfile.gender : "";
  localProfileCard.innerHTML = `<div class="name">${n}</div><div class="meta">${g} ${a}</div>`;
  localProfileCard.classList.remove("hidden");
}
function saveProfileFromForm() {
  myProfile.nickname = (pfNickname.value || "").trim();
  myProfile.age = (pfAge.value || "").trim();
  myProfile.gender = (pfGender.value || "any");
  localStorage.setItem("babyboom-profile", JSON.stringify(myProfile));
  renderLocalProfileUI();
}
function renderRemoteProfile(profile) {
  if (!remoteProfileCard) return;
  if (!profile) { remoteProfileCard.classList.add("hidden"); return; }
  const name = profile.nickname || "Stranger";
  const age = profile.age ? `${profile.age} yrs` : "";
  const gender = profile.gender !== "any" ? profile.gender : "";
  const country = profile.country ? `${profile.country.flag || ""} ${profile.country.name || ""}` : "";
  remoteProfileCard.innerHTML = `<div class="name">${name}</div><div class="meta">${gender} ${age}</div><div class="meta">${country}</div>`;
  remoteProfileCard.classList.remove("hidden");
}

/* render saved local profile to UI */
pfNickname.value = myProfile.nickname || "";
pfAge.value = myProfile.age || "";
pfGender.value = myProfile.gender || "any";
renderLocalProfileUI();
saveProfileBtn.addEventListener("click", saveProfileFromForm);

/* ------------------ UI HELPERS ------------------ */
function addSystem(text) { const d = document.createElement("div"); d.className = "system"; d.textContent = text; chatBox.appendChild(d); chatBox.scrollTop = chatBox.scrollHeight; }
function addMsg(text, me) { const d = document.createElement("div"); d.className = me ? "message me" : "message other"; d.textContent = text; chatBox.appendChild(d); chatBox.scrollTop = chatBox.scrollHeight; }
function setStatus(t) { if (statusEl) statusEl.textContent = t; }

/* THEME */
(function initTheme(){ const saved = localStorage.getItem("babyboom-theme"); if(saved === "light"){ document.documentElement.classList.add("light-mode"); themeToggle.textContent="☀"; } else themeToggle.textContent="🌙"; })();
themeToggle.addEventListener("click", ()=>{ document.documentElement.classList.toggle("light-mode"); const is = document.documentElement.classList.contains("light-mode"); localStorage.setItem("babyboom-theme", is ? "light" : "dark"); themeToggle.textContent = is ? "☀" : "🌙"; });

/* ------------------ SOCKET EVENTS ------------------ */
socket.on("connect", ()=>{ myId = socket.id; });
socket.on("onlineUsers", (n)=>{ if(onlineCountEl) onlineCountEl.textContent = "Online: "+n; });

socket.on("waiting", ()=> { setStatus("Waiting for partner..."); addSystem("Waiting..."); });

/* When partner found, server sends roomId and partnerProfile (if any) */
socket.on("partnerFound", async ({ roomId, partnerProfile }) => {
  currentRoom = roomId;
  renderRemoteProfile(partnerProfile || null);
  setStatus("Connected!");
  addSystem("Stranger joined");
  startQualityPolling(); // start polling when connection active
  try { if (!pc) await startPeer(true); } catch(e){ console.warn("peer start error", e); }
});

/* message */
socket.on("message", ({ from, text }) => { if(from !== myId) addMsg(text, false); });

/* typing */
socket.on("typing", () => {
  if (!typingDots) return;
  typingDots.style.display = "block";
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(()=>{ typingDots.style.display = "none"; }, 1400);
});

/* partner disconnected */
socket.on("partnerDisconnected", () => {
  addSystem("Stranger disconnected");
  setStatus("Disconnected");
  renderRemoteProfile(null);
  currentRoom = null;
  stopQualityPolling();
  if (pc) { try{ pc.close(); }catch(e){} pc = null; }
  if (autoNext) { addSystem("Auto Next: Finding new partner..."); socket.emit("findPartner", { profile: myProfile }); setStatus("Searching..."); }
});

/* signaling */
socket.on("offer", async (data) => {
  if (!currentRoom) currentRoom = data.roomId;
  if (!pc) await startPeer(false);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    socket.emit("answer", { roomId: currentRoom, answer: ans });
  } catch(e) { console.error("offer error", e); }
});

socket.on("answer", async (data) => { if(pc && data.answer) await pc.setRemoteDescription(new RTCSessionDescription(data.answer)); });

socket.on("iceCandidate", async (data) => { if(pc && data.candidate) { try{ await pc.addIceCandidate(data.candidate); }catch(e){ console.warn("ice add err", e);} } });

/* ------------------ MEDIA & WEBRTC ------------------ */
async function ensureLocal() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
  localVideo.srcObject = localStream;
  return localStream;
}

async function startPeer(isInitiator = true) {
  await ensureLocal();
  pc = new RTCPeerConnection({ iceServers:[{urls:"stun:stun.l.google.com:19302"}] });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.ontrack = (ev) => { remoteVideo.srcObject = ev.streams[0]; };
  pc.onicecandidate = (ev) => { if(ev.candidate && currentRoom) socket.emit("iceCandidate", { roomId: currentRoom, candidate: ev.candidate }); };

  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("offer", { roomId: currentRoom, offer });
  }
}

/* ------------------ QUALITY (getStats) ------------------ */
function updateQualityIndicator(stats) {
  // Determine RTT + packet loss and map to Excellent/Good/Poor
  try {
    let rtt = null;
    let packetsLost = 0;
    let packetsReceived = 0;

    stats.forEach(report => {
      if (report.type === "candidate-pair" && report.state === "succeeded" && report.currentRoundTripTime != null) {
        rtt = report.currentRoundTripTime * 1000; // sec -> ms
      }
      if (report.type === "inbound-rtp" && (report.kind === "video" || !report.kind)) {
        packetsLost += (report.packetsLost || 0);
        packetsReceived += (report.packetsReceived || 0);
      }
    });

    let lossRatio = 0;
    if (packetsReceived > 0) lossRatio = packetsLost / (packetsReceived + packetsLost);

    // Heuristic
    let quality = "poor";
    if ((rtt !== null && rtt < 150 && lossRatio < 0.02) || (rtt !== null && rtt < 100)) quality = "excellent";
    else if ((rtt !== null && rtt < 400 && lossRatio < 0.06) || (lossRatio < 0.04)) quality = "good";

    // apply UI
    if (!qualityIndicator) return;
    qualityIndicator.classList.remove("quality-excellent","quality-good","quality-poor");
    if (quality === "excellent") {
      qualityIndicator.classList.add("quality-excellent");
      qualityIndicator.textContent = `Quality: Excellent (${Math.round(rtt||0)} ms)`;
    } else if (quality === "good") {
      qualityIndicator.classList.add("quality-good");
      qualityIndicator.textContent = `Quality: Good (${Math.round(rtt||0)} ms)`;
    } else {
      qualityIndicator.classList.add("quality-poor");
      qualityIndicator.textContent = `Quality: Poor (${Math.round(rtt||0)} ms)`;
    }
  } catch (e) { console.warn("quality calc err", e); }
}

function startQualityPolling() {
  stopQualityPolling();
  if (!pc) return;
  qualityPollInterval = setInterval(async () => {
    try {
      const stats = await pc.getStats();
      updateQualityIndicator(stats);
    } catch (e) { console.warn("getStats error", e); }
  }, 3500);
}

function stopQualityPolling() {
  if (qualityPollInterval) { clearInterval(qualityPollInterval); qualityPollInterval = null; }
  if (qualityIndicator) { qualityIndicator.classList.remove("quality-excellent","quality-good","quality-poor"); qualityIndicator.textContent = "Quality: —"; }
}

/* ------------------ UI ACTIONS ------------------ */
skipBtn.addEventListener("click", ()=> {
  if (currentRoom) socket.emit("disconnectFromChat", { roomId: currentRoom });
  currentRoom = null;
  chatBox.innerHTML = "";
  addSystem("Searching for a stranger...");
  // send profile with findPartner
  socket.emit("findPartner", { profile: myProfile });
  setStatus("Searching...");
});

sendBtn.addEventListener("click", ()=> {
  const t = messageInput.value.trim(); if(!t || !currentRoom) return;
  socket.emit("message", { roomId: currentRoom, text: t });
  addMsg(t, true);
  messageInput.value = "";
});

messageInput.addEventListener("keydown", (e)=>{ if(e.key === "Enter") sendBtn.click(); });
messageInput.addEventListener("input", ()=>{ if(currentRoom) socket.emit("typing", { roomId: currentRoom }); });

/* REPORT UI */
reportNav.addEventListener("click", ()=> { if(!currentRoom) return alert("No partner to report"); reportPopup.classList.remove("hidden"); });
cancelReport.addEventListener("click", ()=> reportPopup.classList.add("hidden") );
reasonButtons.forEach((b)=> { b.addEventListener("click", ()=> { const r = b.dataset.reason; socket.emit("reportUser", { roomId: currentRoom, reason: r }); addSystem("You reported: " + r); socket.emit("disconnectFromChat", { roomId: currentRoom }); reportPopup.classList.add("hidden"); }); });

/* ------------------ PROFILE SAVE BUTTON (form) ------------------ */
function ensureProfileBeforeFind() {
  // ensure myProfile is current from form fields
  myProfile.nickname = (pfNickname.value || "").trim();
  myProfile.age = (pfAge.value || "").trim();
  myProfile.gender = (pfGender.value || "any");
  localStorage.setItem("babyboom-profile", JSON.stringify(myProfile));
  renderLocalProfileUI();
}
saveProfileBtn.addEventListener("click", ()=> {
  ensureProfileBeforeFind();
  addSystem("Profile saved.");
});

/* Render helpers used earlier (re-declared for local scope) */
function renderLocalProfileUI() {
  if (!localProfileCard) return;
  const n = myProfile.nickname || "You";
  const a = myProfile.age ? `${myProfile.age} yrs` : "";
  const g = myProfile.gender !== "any" ? myProfile.gender : "";
  localProfileCard.innerHTML = `<div class="name">${n}</div><div class="meta">${g} ${a}</div>`;
  localProfileCard.classList.remove("hidden");
}
renderLocalProfileUI();

/* INITIAL READY MESSAGE */
addSystem("Ready — click Start/Skip to search.");

/* ------------------ CLEANUP on unload ------------------ */
window.addEventListener("beforeunload", ()=> {
  try { if(pc) pc.close(); } catch(e) {}
});
