import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();

// ===== CORS drošs iestatījums =====
const ALLOWED = [
  "https://thezone.lv",
  "http://thezone.lv",
  "https://www.thezone.lv",
  "http://www.thezone.lv",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

app.use(cors({ origin: ALLOWED, credentials: true }));
app.use(express.json());

// ===== statiskie faili =====
app.use(express.static("public"));

// Health
app.get("/health", (_, res) => res.type("text").send("Duraks serveris strādā."));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED, credentials: true }
});

// ====== Vienkārša istabu vadība (6 sēdvietas) ======
const ROOMS = new Map();
/*
  room = {
    code, deckType, solo, createdAt,
    players: [ {id, name, seat} ... ], // seat: 0..5 vai null
  }
*/

// util
const seatCount = 6;
const genCode = () => Math.random().toString(36).slice(2, 6).toUpperCase();

const publicState = (room) => {
  if (!room) return null;
  const seats = Array.from({ length: seatCount }, (_, i) => {
    const p = room.players.find(x => x.seat === i);
    return p ? { seat: i, name: p.name, id: p.id } : { seat: i, name: null, id: null };
  });
  return {
    code: room.code,
    deckType: room.deckType,
    solo: room.solo,
    seats
  };
};

io.on("connection", (socket) => {
  console.log("✅ Socket pieslēdzās:", socket.id);

  // heartbeat
  socket.on("ping:client", () => socket.emit("pong:server"));

  // istabas izveide
  socket.on("room:create", ({ name, deckType, solo }) => {
    try {
      console.log("➡️ room:create no", socket.id, { name, deckType, solo });
      const code = genCode();
      const room = {
        code,
        deckType: Number(deckType) || 36,
        solo: !!solo,
        createdAt: Date.now(),
        players: []
      };
      ROOMS.set(code, room);

      // pirmo spēlētāju automātiski piesēdinām pie 1. sēdvietas (0)
      const pname = (name || "Spēlētājs").trim() || "Spēlētājs";
      room.players.push({ id: socket.id, name: pname, seat: 0 });

      socket.join(code);
      socket.emit("room:code", code);
      io.to(code).emit("state:public", publicState(room));
      console.log("✅ Room izveidota:", code);
    } catch (e) {
      console.error("❌ room:create kļūda:", e);
      socket.emit("toast", { type: "error", text: "Neizdevās izveidot istabu." });
    }
  });

  // pievienoties sēdvietai
  socket.on("seat:join", ({ code, seat, name }) => {
    const room = ROOMS.get(code);
    if (!room) {
      socket.emit("toast", { type: "error", text: "Istaba nav atrasta." });
      return;
    }
    if (seat < 0 || seat >= seatCount) {
      socket.emit("toast", { type: "error", text: "Sēdvietas numurs nav derīgs." });
      return;
    }
    // ja sēdvieta aizņemta
    if (room.players.some(p => p.seat === seat)) {
      socket.emit("toast", { type: "error", text: "Sēdvieta jau aizņemta." });
      return;
    }
    // ja jau sēž citā vietā – atbrīvo
    const me = room.players.find(p => p.id === socket.id);
    if (me) me.seat = seat;
    else room.players.push({ id: socket.id, name: (name || "Spēlētājs").trim() || "Spēlētājs", seat });

    socket.join(code);
    io.to(code).emit("state:public", publicState(room));
  });

  // atstāt sēdvietu
  socket.on("seat:leave", ({ code }) => {
    const room = ROOMS.get(code);
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx >= 0) {
      room.players[idx].seat = null;
      io.to(code).emit("state:public", publicState(room));
    }
  });

  socket.on("disconnect", () => {
    // noņemam no visām istabām
    for (const room of ROOMS.values()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx >= 0) {
        room.players.splice(idx, 1);
        io.to(room.code).emit("state:public", publicState(room));
      }
    }
    console.log("🔌 atslēdzās:", socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Duraks Online darbojas uz porta:", PORT);
  console.log("Statiskie faili no /public, health: /health");
});
