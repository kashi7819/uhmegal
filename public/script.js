/* ------------------ SOCKET ------------------ */
const socket = io();

/* ------------------ DOM ------------------ */
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

const localWrap = document.getElementById("localWrap");
const remoteWrap = document.getElementById("remoteWrap");

const skipBtn = document.getElementById("skipBtn");
const sendBtn = document.getElementById("sendBtn");
const messageInput = document.getElementById("messageInput");
const chatBox = document.getElementById("chatBox");

const statusEl = document.getElementById("status");
const onlineCountEl = document.getElementById("onlineCount");
const typingDots = document.getElementById("typingDots");

const muteBtn = document.getElementById("muteBtn");
const cameraBtn = document.getElementById("cameraBtn");
const beautyBtn = document.getElementById("beautyBtn");
const themeToggle = document.getElementById("themeToggle");

const pfNickname = document.getElementById("pfNickname");
const pfAge = document.getElementById("pfAge");
const pfGender = document.getElementById("pfGender");
const saveProfileBtn = document.getElementById("saveProfileBtn");
let audioCtx;
let sourceNode;
let pitchNode;
let gainNode;
let destinationStream;

/* ------------------ STATE ------------------ */
let myId = null;
let currentRoom = null;
let localStream = null;
let pc = null;
let beautyOn = false;

/* ------------------ HELPERS ------------------ */
function safeGet(el, fallback = null) {
  return el || fallback;
}

function addSystem(text) {
  if (!chatBox) return;
  const div = document.createElement("div");
  div.className = "system";
  div.textContent = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function addMsg(text, me) {
  if (!chatBox) return;
  const div = document.createElement("div");
  div.className = me ? "message me" : "message other";
  div.textContent = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function setStatus(t) {
  if (statusEl) statusEl.textContent = t;
}

/* ------------------ THEME (persisted) ------------------ */
(function initTheme() {
  try {
    const saved = localStorage.getItem("babyboom-theme");
    if (saved === "light") {
      document.documentElement.classList.add("light-mode");
      if (themeToggle) themeToggle.textContent = "☀";
    } else {
      if (themeToggle) themeToggle.textContent = "🌙";
    }
  } catch (e) {}
})();
if (themeToggle) {
  themeToggle.addEventListener("click", () => {
    document.documentElement.classList.toggle("light-mode");
    const isLight = document.documentElement.classList.contains("light-mode");
    localStorage.setItem("babyboom-theme", isLight ? "light" : "dark");
    themeToggle.textContent = isLight ? "☀" : "🌙";
  });
}

/* ------------------ LOCAL MEDIA ------------------ */
async function ensureLocal() {
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: true
    });
    if (localVideo) localVideo.srcObject = localStream;
    return localStream;
  } catch (err) {
    console.error("getUserMedia failed:", err);
    throw err;
  }
}

/* ------------------ WEBRTC: utility to wait for a desired signaling state ------------------ */
function waitForSignalingState(targetState, timeout = 3000) {
  return new Promise((resolve) => {
    if (!pc) return resolve(false);
    if (pc.signalingState === targetState) return resolve(true);

    let resolved = false;
    const onChange = () => {
      if (pc.signalingState === targetState && !resolved) {
        resolved = true;
        pc.removeEventListener("signalingstatechange", onChange);
        clearTimeout(timer);
        resolve(true);
      }
    };
    pc.addEventListener("signalingstatechange", onChange);
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        pc.removeEventListener("signalingstatechange", onChange);
        resolve(false);
      }
    }, timeout);
  });
}

/* ------------------ CREATE / CLEAN PC ------------------ */
async function createPeerIfNeeded() {
  if (pc) return pc;

  await ensureLocal();

  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  // add tracks
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  // remote track
  pc.ontrack = (ev) => {
    if (remoteVideo) remoteVideo.srcObject = ev.streams[0];
  };

  // ICE candidates
  pc.onicecandidate = (ev) => {
    if (ev.candidate && currentRoom) {
      socket.emit("iceCandidate", { roomId: currentRoom, candidate: ev.candidate });
    }
  };

  // cleanup on close
  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
      try { pc.close(); } catch (e) {}
      pc = null;
    }
  };

  return pc;
}

async function startAsInitiator() {
  // create peer and offer
  await createPeerIfNeeded();
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (currentRoom) socket.emit("offer", { roomId: currentRoom, offer });
  } catch (e) {
    console.warn("Failed to create/send offer:", e);
  }
}

/* ------------------ SOCKET EVENTS ------------------ */
socket.on("connect", () => {
  myId = socket.id;
});

socket.on("onlineUsers", (n) => {
  if (onlineCountEl) onlineCountEl.textContent = "Online: " + n;
});

socket.on("waiting", () => {
  addSystem("Waiting for partner...");
  setStatus("Waiting...");
});

socket.on("partnerFound", async ({ roomId, partnerProfile, initiator } = {}) => {
  // partnerFound from server should set a roomId
  currentRoom = roomId;
  addSystem("Stranger connected!");
  setStatus("Connected");

  // show remote wrap as active
  if (remoteWrap) remoteWrap.classList.remove("cam-off");

  // ensure we have a pc but do NOT create duplicate offers
  await createPeerIfNeeded();

  // Decide who creates offer:
  // if server provided `initiator` flag use it; otherwise fall back to deterministic rule:
  // create offer on the side with lexicographically smaller socket id (if both present).
  let shouldInitiate = false;
  if (typeof initiator === "boolean") {
    shouldInitiate = initiator;
  } else {
    // deterministic fallback: socket.id and partnerProfile won't give partnerId,
    // so try heuristic: if myId exists and roomId ends with myId then do NOT initiate.
    // roomId format is: room-waitingId-currentId (server uses waitingUser.id - socket.id)
    // If roomId ends with myId -> this socket was the one that joined second (server used socket.id as second part)
    // The waiting user (first) should be initiator. So only start offer if myId is NOT the second part.
    try {
      if (roomId && myId) {
        const parts = roomId.split("-");
        const last = parts[parts.length - 1];
        // If I'm the second (last) part, do not initiate; otherwise initiate.
        shouldInitiate = last !== myId;
      }
    } catch (e) {
      shouldInitiate = true;
    }
  }

  if (shouldInitiate) {
    // small delay to avoid simultaneous offers
    setTimeout(() => startAsInitiator().catch(()=>{}), 120);
  }
});

socket.on("message", ({ from, text } = {}) => {
  if (from && from !== myId) addMsg(text, false);
});

socket.on("typing", () => {
  if (typingDots) typingDots.style.display = "block";
  setTimeout(() => { if (typingDots) typingDots.style.display = "none"; }, 1200);
});

socket.on("partnerDisconnected", () => {
  addSystem("Stranger disconnected");
  setStatus("Disconnected");
  if (remoteVideo) remoteVideo.srcObject = null;
  if (remoteWrap) remoteWrap.classList.add("cam-off");

  if (pc) {
    try { pc.close(); } catch (e) {}
    pc = null;
  }
});

/* ------------------ SIGNALING: SAFELY HANDLE OFFER/ANSWER/CANDIDATE ------------------ */
socket.on("offer", async (data = {}) => {
  if (!data.offer) return;

  await createPeerIfNeeded();

  // if pc has non-stable state, postpone setting remote description briefly
  if (pc.signalingState !== "stable") {
    const ok = await waitForSignalingState("stable", 2000);
    if (!ok) {
      console.warn("offer received but pc isn't stable; skipping to avoid bad state:", pc.signalingState);
      return;
    }
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  } catch (e) {
    console.warn("setRemoteDescription (offer) failed:", e);
    return;
  }

  // create answer
  try {
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    if (currentRoom) socket.emit("answer", { roomId: currentRoom, answer: ans });
  } catch (e) {
    console.warn("Failed to create/send answer:", e);
  }
});

socket.on("answer", async (data = {}) => {
  if (!data.answer || !pc) return;

  // only set answer when we are in have-local-offer state
  if (pc.signalingState !== "have-local-offer") {
    // try waiting briefly
    const ok = await waitForSignalingState("have-local-offer", 2000);
    if (!ok) {
      console.warn("Skipping answer: pc not in have-local-offer (state=" + pc.signalingState + ")");
      return;
    }
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
  } catch (e) {
    console.warn("setRemoteDescription(answer) failed:", e);
  }
});

socket.on("iceCandidate", async (data = {}) => {
  if (!data.candidate || !pc) return;
  try {
    await pc.addIceCandidate(data.candidate);
  } catch (e) {
    // ignore occasional add errors from older browsers
    // console.warn("addIceCandidate failed", e);
  }
});

/* ------------------ UI ACTIONS ------------------ */
if (sendBtn) {
  sendBtn.addEventListener("click", () => {
    const msg = (messageInput && messageInput.value || "").trim();
    if (!msg || !currentRoom) return;
    socket.emit("message", { roomId: currentRoom, text: msg });
    addMsg(msg, true);
    if (messageInput) messageInput.value = "";
  });
}
if (messageInput) {
  messageInput.addEventListener("input", () => { if (currentRoom) socket.emit("typing", { roomId: currentRoom }); });
}

/* Skip / Start */
if (skipBtn) {
  skipBtn.addEventListener("click", () => {
    if (currentRoom) socket.emit("disconnectFromChat", { roomId: currentRoom });
    currentRoom = null;
    if (chatBox) chatBox.innerHTML = "";
    addSystem("Searching for next partner...");
    if (localStream == null) {
      // don't force camera on
    }
    socket.emit("findPartner", { profile: {} });
    setStatus("Searching...");
  });
}

/* ------------------ MUTE / CAMERA ------------------ */
if (muteBtn) {
  muteBtn.addEventListener("click", async () => {
    try {
      await ensureLocal();
      const track = localStream.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      const micIcon = document.getElementById("micIcon");
      if (micIcon) micIcon.src = track.enabled ? "mic.png" : "mic-off.png";
    } catch (e) {
      console.warn("mute error", e);
    }
  });
}

if (cameraBtn) {
  cameraBtn.addEventListener("click", async () => {
    try {
      await ensureLocal();
      const t = localStream.getVideoTracks()[0];
      if (!t) return;
      t.enabled = !t.enabled;
      const camIcon = document.getElementById("camIcon");
      if (camIcon) camIcon.src = t.enabled ? "video.png" : "video-off.png";
      if (!t.enabled) localWrap.classList.add("cam-off"); else localWrap.classList.remove("cam-off");

      // notify partner
      socket.emit("remoteCamera", { enabled: t.enabled });
    } catch (e) {
      console.warn("camera toggle error", e);
    }
  });
}

/* Receive remote camera status */
socket.on("remoteCamera", ({ enabled } = {}) => {
  if (!remoteWrap) return;
  if (!enabled) remoteWrap.classList.add("cam-off");
  else remoteWrap.classList.remove("cam-off");
});

/* ------------------ BEAUTY FILTER ------------------ */
if (beautyBtn) {
  beautyBtn.addEventListener("click", () => {
    beautyOn = !beautyOn;
    if (localVideo) {
      localVideo.style.filter = beautyOn ? "blur(1px) brightness(1.15) contrast(1.1)" : "none";
    }
    beautyBtn.classList.toggle("off", !beautyOn);
  });
}

/* ------------------ CLEANUP ------------------ */
window.addEventListener("beforeunload", () => {
  try {
    pc?.close();
    localStream?.getTracks().forEach(t => t.stop());
  } catch {}
});

