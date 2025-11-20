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

let localStream = null;
let myId = null;
let currentRoom = null;
let pc = null;
let beautyOn = false;

/* Voice Changer Globals */
let vcAudioCtx = null;
let vcProcessor = null;
let pendingVoiceMode = null;

/* ------------------ Helpers ------------------ */
function addSystem(t){ if(chatBox){ let d=document.createElement("div"); d.className="system"; d.textContent=t; chatBox.appendChild(d); chatBox.scrollTop=chatBox.scrollHeight;} }
function addMsg(t,me){ if(chatBox){ let d=document.createElement("div"); d.className=me?"message me":"message other"; d.textContent=t; chatBox.appendChild(d); chatBox.scrollTop=chatBox.scrollHeight;} }
function setStatus(t){ if(statusEl) statusEl.textContent = t; }

/* ------------------ THEME ------------------ */
(function initTheme(){
  try{
    const saved = localStorage.getItem("babyboom-theme");
    if(saved==="light"){
      document.documentElement.classList.add("light-mode");
      themeToggle.textContent = "☀";
    }
  }catch(e){}
})();
if(themeToggle){
  themeToggle.addEventListener("click",()=>{
    document.documentElement.classList.toggle("light-mode");
    const isLight=document.documentElement.classList.contains("light-mode");
    localStorage.setItem("babyboom-theme",isLight?"light":"dark");
    themeToggle.textContent = isLight?"☀":"🌙";
  });
}

/* ------------------ LOCAL MEDIA ------------------ */
async function ensureLocal(){
  if(localStream) return localStream;

  localStream = await navigator.mediaDevices.getUserMedia({
    video:{ facingMode:"user" },
    audio:true
  });

  localVideo.srcObject = localStream;
  return localStream;
}

/* ------------------ VOICE EFFECT ------------------ */
async function applyVoiceEffect(mode){
  await ensureLocal();

  if(vcAudioCtx){ try{ vcAudioCtx.close(); }catch(e){} }

  vcAudioCtx = new (window.AudioContext||window.webkitAudioContext)();

  let pitch = 1.0;
  if(mode==="female") pitch=1.6;
  if(mode==="cute") pitch=1.9;
  if(mode==="child") pitch=2.3;
  if(mode==="deep") pitch=0.6;

  const source = vcAudioCtx.createMediaStreamSource(localStream);
  vcProcessor = vcAudioCtx.createScriptProcessor(2048,1,1);

  vcProcessor.onaudioprocess = e=>{
    const input=e.inputBuffer.getChannelData(0);
    const output=e.outputBuffer.getChannelData(0);
    for(let i=0;i<input.length;i++){
      const idx=Math.floor(i/pitch);
      output[i]=input[idx]||0;
    }
  };

  const dest = vcAudioCtx.createMediaStreamDestination();
  source.connect(vcProcessor);
  vcProcessor.connect(dest);

  const newTrack = dest.stream.getAudioTracks()[0];

  if(pc){
    const sender = pc.getSenders().find(s=>s.track&&s.track.kind==="audio");
    if(sender){ sender.replaceTrack(newTrack).catch(()=>{}); }
  }
}

/* ------------------ CREATE PEER ------------------ */
async function createPeerIfNeeded(){
  if(pc) return pc;

  await ensureLocal();
  pc = new RTCPeerConnection({ iceServers:[{urls:"stun:stun.l.google.com:19302"}] });

  localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));

  pc.ontrack = ev => remoteVideo.srcObject = ev.streams[0];
  pc.onicecandidate = ev => {
    if(ev.candidate && currentRoom){
      socket.emit("iceCandidate",{ roomId:currentRoom, candidate:ev.candidate });
    }
  };
  pc.onconnectionstatechange = ()=>{
    if(pc && ["failed","closed","disconnected"].includes(pc.connectionState)){
      pc.close();
      pc=null;
    }
  };

  return pc;
}

/* ------------------ WEBSOCKET ------------------ */
socket.on("connect",()=>myId = socket.id);
socket.on("onlineUsers",n=>onlineCountEl.textContent="Online: "+n);

socket.on("waiting",()=>{ addSystem("Waiting for partner..."); setStatus("Waiting..."); });

socket.on("partnerFound", async({roomId})=>{
  currentRoom = roomId;
  addSystem("Stranger connected!");
  setStatus("Connected");

  remoteWrap.classList.remove("cam-off");

  await createPeerIfNeeded();
  const shouldOffer = !roomId.endsWith(myId);

  if(shouldOffer){
    setTimeout(()=>startAsInitiator(),120);
  }
});

/* OFFER */
socket.on("offer",async(data)=>{
  await createPeerIfNeeded();
  if(pc.signalingState!=="stable") return;
  await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
  const ans = await pc.createAnswer();
  await pc.setLocalDescription(ans);
  socket.emit("answer",{roomId:currentRoom,answer:ans});
});

/* ANSWER */
socket.on("answer",async(data)=>{
  if(pc.signalingState!=="have-local-offer") return;
  await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
});

/* ICE */
socket.on("iceCandidate",async data=>{
  pc?.addIceCandidate(data.candidate).catch(()=>{});
});

/* ------------------ CHAT ------------------ */
sendBtn.onclick=()=>{
  const msg=(messageInput.value||"").trim();
  if(!msg||!currentRoom) return;
  socket.emit("message",{roomId:currentRoom,text:msg});
  addMsg(msg,true);
  messageInput.value="";
};

messageInput.oninput=()=>{ if(currentRoom) socket.emit("typing",{roomId:currentRoom}); };
socket.on("message",({from,text})=>{ if(from!==myId) addMsg(text,false); });

socket.on("typing",()=>{ typingDots.style.display="block"; setTimeout(()=>typingDots.style.display="none",1200); });

/* ------------------ SKIP ------------------ */
skipBtn.onclick=()=>{
  if(currentRoom) socket.emit("disconnectFromChat",{roomId:currentRoom});
  currentRoom=null;
  chatBox.innerHTML="";
  addSystem("Searching for next partner...");
  socket.emit("findPartner",{ profile:{} });
  setStatus("Searching...");
};

/* ------------------ CAMERA / MIC ------------------ */
muteBtn.onclick=async()=>{
  await ensureLocal();
  const t=localStream.getAudioTracks()[0];
  t.enabled=!t.enabled;
  document.getElementById("micIcon").src=t.enabled?"mic.png":"mic-off.png";
};

cameraBtn.onclick=async()=>{
  await ensureLocal();
  const t=localStream.getVideoTracks()[0];
  t.enabled=!t.enabled;
  document.getElementById("camIcon").src=t.enabled?"video.png":"video-off.png";
  localWrap.classList.toggle("cam-off",!t.enabled);
  socket.emit("remoteCamera",{enabled:t.enabled});
};

socket.on("remoteCamera",({enabled})=>{
  remoteWrap.classList.toggle("cam-off",!enabled);
});

/* ------------------ BEAUTY ------------------ */
beautyBtn.onclick=()=>{
  beautyOn=!beautyOn;
  localVideo.style.filter = beautyOn ? "blur(1px) brightness(1.15) contrast(1.1)" : "none";
};

/* ------------------ VOICE ------------------ */
document.getElementById("voiceMode").onchange=e=>applyVoiceEffect(e.target.value);

/* ------------------ CLEANUP ------------------ */
window.addEventListener("beforeunload",()=>{
  pc?.close();
  localStream?.getTracks().forEach(t=>t.stop());
});
