// server.js – Uhmegel / BabyBoom Random Video Chat
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static public folder
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ----------------------------------------
// GLOBALS
// ----------------------------------------
let waitingUser = null; // socket waiting for partner
let onlineUsers = 0;

// Helper to safely get a socket by id
function getSocket(id) {
  try {
    return io.sockets.sockets.get(id);
  } catch (e) {
    return null;
  }
}

// ----------------------------------------
// SOCKET.IO
// ----------------------------------------
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  // init per-socket state
  socket.profile = null;
  socket.partnerId = null;
  socket.currentRoom = null;

  // update and broadcast online count
  onlineUsers++;
  io.emit("onlineUsers", onlineUsers);

  // ---------------------------
  // CAMERA STATUS SYNC
  // ---------------------------
  // forward camera on/off to other peer in same room
  socket.on("remoteCamera", ({ enabled } = {}) => {
    if (!socket.currentRoom) return;
    socket.to(socket.currentRoom).emit("remoteCamera", { enabled });
  });

  // -------------------------------------
  // WebRTC signaling (forwarding)
  // -------------------------------------
  socket.on("offer", (data = {}) => {
    if (!data.roomId) return;
    socket.to(data.roomId).emit("offer", data);
  });

  socket.on("answer", (data = {}) => {
    if (!data.roomId) return;
    socket.to(data.roomId).emit("answer", data);
  });

  socket.on("iceCandidate", (data = {}) => {
    if (!data.roomId) return;
    socket.to(data.roomId).emit("iceCandidate", data);
  });

  // -------------------------------------
  // FIND PARTNER + PROFILE SUPPORT
  // -------------------------------------
  socket.on("findPartner", (data = {}) => {
    // If this socket was in a room already, clean that up first
    if (socket.currentRoom) {
      const oldRoom = socket.currentRoom;
      socket.leave(oldRoom);
      socket.currentRoom = null;
      if (socket.partnerId) {
        const partnerSocket = getSocket(socket.partnerId);
        if (partnerSocket) {
          partnerSocket.partnerId = null;
          partnerSocket.currentRoom = null;
          partnerSocket.emit("partnerDisconnected");
        }
        socket.partnerId = null;
      }
    }

    // Save profile safely
    socket.profile = {
      nickname: data?.profile?.nickname || "",
      age: data?.profile?.age || "",
      gender: data?.profile?.gender || "any",
      country: data?.profile?.country || ""
    };

    // If waitingUser exists and is not this socket, pair them
    if (waitingUser && waitingUser.id !== socket.id) {
      // ensure waitingUser still connected
      const waitingSock = getSocket(waitingUser.id);
      if (!waitingSock) {
        // stale waiting socket — replace it and continue waiting
        waitingUser = socket;
        socket.emit("waiting");
        return;
      }

      const roomId = `room-${waitingSock.id}-${socket.id}`;

      // join both sockets to the room
      try {
        socket.join(roomId);
        waitingSock.join(roomId);
      } catch (e) {
        console.warn("Join room error:", e);
      }

      // set currentRoom and partnerId for both sockets
      socket.currentRoom = roomId;
      waitingSock.currentRoom = roomId;

      socket.partnerId = waitingSock.id;
      waitingSock.partnerId = socket.id;

      // notify both sides that a partner is found
      socket.emit("partnerFound", {
        roomId,
        partnerProfile: waitingSock.profile || null
      });

      waitingSock.emit("partnerFound", {
        roomId,
        partnerProfile: socket.profile || null
      });

      // clear waiting slot
      waitingUser = null;
    } else {
      // place this socket into waiting state
      waitingUser = socket;
      socket.emit("waiting");
    }
  });

  // -------------------------------------
  // Text chat
  // -------------------------------------
  socket.on("message", ({ roomId, text } = {}) => {
    if (!roomId || typeof text !== "string") return;
    io.to(roomId).emit("message", { from: socket.id, text });
  });

  socket.on("typing", ({ roomId } = {}) => {
    if (!roomId) return;
    socket.to(roomId).emit("typing");
  });

  // -------------------------------------
  // Manual disconnect from chat
  // -------------------------------------
  socket.on("disconnectFromChat", ({ roomId } = {}) => {
    const rId = roomId || socket.currentRoom;
    if (!rId) return;

    // notify partner(s) in the room
    socket.to(rId).emit("partnerDisconnected");

    // try to clear partner state
    if (socket.partnerId) {
      const partnerSocket = getSocket(socket.partnerId);
      if (partnerSocket) {
        partnerSocket.partnerId = null;
        partnerSocket.currentRoom = null;
        partnerSocket.leave(rId);
      }
      socket.partnerId = null;
    }

    // leave room and clear currentRoom for this socket
    socket.leave(rId);
    socket.currentRoom = null;
  });

  // -------------------------------------
  // Report user
  // -------------------------------------
  socket.on("reportUser", ({ roomId, reason } = {}) => {
    console.log(`⚠ REPORT from ${socket.id}: ${reason}`);
    if (roomId) {
      socket.to(roomId).emit("partnerDisconnected");
    }
    // Optional: persist report to DB or flat file
  });

  // -------------------------------------
  // Full disconnect (browser closed / network)
  // -------------------------------------
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);

    // update online count
    onlineUsers = Math.max(0, onlineUsers - 1);
    io.emit("onlineUsers", onlineUsers);

    // if this socket was waiting, clear waitingUser
    if (waitingUser && waitingUser.id === socket.id) {
      waitingUser = null;
    }

    // If this socket had a partner, notify partner and tidy their state
    if (socket.partnerId) {
      const partnerSocket = getSocket(socket.partnerId);
      if (partnerSocket) {
        partnerSocket.partnerId = null;
        partnerSocket.currentRoom = null;
        partnerSocket.emit("partnerDisconnected");
        // make partner leave the room if known
        if (socket.currentRoom) {
          partnerSocket.leave(socket.currentRoom);
        }
      }
    }

    // leave and clear current room for this socket
    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
      socket.currentRoom = null;
    }
  });
});

// ----------------------------------------
// START SERVER
// ----------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server live on http://localhost:" + PORT);
});
