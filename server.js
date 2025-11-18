// server.js – Uhmegel / BabyBoom Random Video Chat

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static public folder
app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// ----------------------------------------
// GLOBALS
// ----------------------------------------
let waitingUser = null;
let onlineUsers = 0;

// ----------------------------------------
// SOCKET.IO
// ----------------------------------------
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  onlineUsers++;
  io.emit("onlineUsers", onlineUsers);

  // -------------------------------------
  // WebRTC signaling
  // -------------------------------------
  socket.on("offer", (data) => {
    socket.to(data.roomId).emit("offer", data);
  });

  socket.on("answer", (data) => {
    socket.to(data.roomId).emit("answer", data);
  });

  socket.on("iceCandidate", (data) => {
    socket.to(data.roomId).emit("iceCandidate", data);
  });

  // -------------------------------------
  // FIND PARTNER + PROFILE SUPPORT
  // -------------------------------------
  socket.on("findPartner", (data) => {

    socket.profile = {
      nickname: data?.profile?.nickname || "",
      age: data?.profile?.age || "",
      gender: data?.profile?.gender || "any",
      country: data?.profile?.country || ""
    };

    if (waitingUser && waitingUser.id !== socket.id) {

      const roomId = `room-${waitingUser.id}-${socket.id}`;

      socket.join(roomId);
      waitingUser.join(roomId);

      socket.partnerId = waitingUser.id;
      waitingUser.partnerId = socket.id;

      socket.emit("partnerFound", {
        roomId,
        partnerProfile: waitingUser.profile
      });

      waitingUser.emit("partnerFound", {
        roomId,
        partnerProfile: socket.profile
      });

      waitingUser = null;

    } else {
      waitingUser = socket;
      socket.emit("waiting");
    }
  });

  // -------------------------------------
  // Text chat
  // -------------------------------------
  socket.on("message", ({ roomId, text }) => {
    io.to(roomId).emit("message", { from: socket.id, text });
  });

  socket.on("typing", ({ roomId }) => {
    socket.to(roomId).emit("typing");
  });

  // -------------------------------------
  // Manual disconnect
  // -------------------------------------
  socket.on("disconnectFromChat", ({ roomId }) => {
    socket.leave(roomId);

    if (socket.partnerId) {
      io.to(socket.partnerId).emit("partnerDisconnected");
      socket.partnerId = null;
    }
  });

  // -------------------------------------
  // Report user
  // -------------------------------------
  socket.on("reportUser", ({ roomId, reason }) => {
    console.log(`⚠ REPORT from ${socket.id}: ${reason}`);
    if (socket.partnerId) {
      io.to(socket.partnerId).emit("partnerDisconnected");
    }
  });

  // -------------------------------------
  // Full disconnect
  // -------------------------------------
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    onlineUsers--;
    io.emit("onlineUsers", onlineUsers);

    if (waitingUser && waitingUser.id === socket.id) {
      waitingUser = null;
    }

    if (socket.partnerId) {
      io.to(socket.partnerId).emit("partnerDisconnected");
    }
  });
});

// ----------------------------------------
// START SERVER
// ----------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("http://localhost:3000" + PORT);
});
