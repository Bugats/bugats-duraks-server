// server.js — Duraks Lobby/Seats minimāls serveris ar Socket.IO

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// statika (ja atver no Render)
app.use(express.static(path.join(__dirname, "src", "public")));

app.get("/", (_req, res) => {
  res.send("Duraks Online server is running.");
});

// ====== Istabu glabātuve ======
/**
 * room = {
 *   code: 'ABCD',
 *   deckType: 36|52,
 *   solo: boolean,
 *   seats: [{taken:bool, name?:string, socketId?:string}, x6],
 *   started: false,
 * }
 */
const rooms = new Map();

// util
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let c = "";
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}
function getPublicSeats(room) {
  return room.seats.map(s => ({ taken: !!s.taken, name: s.taken ? s.name : undefined }));
}
function broadcastRoom(room) {
  io.to(room.code).emit("room:update", {
    code: room.code,
    seats: getPublicSeats(room),
    deckType: room.deckType,
    solo: room.solo,
    started: !!room.started
  });
}

// ====== Socket.io ======
io.on("connection", (socket) => {
  socket.emit("pong");

  // ISTABAS IZVEIDE
  socket.on("room:create", ({ name, deckType, solo }, ack) => {
    try {
      const code = makeCode();
      const room = {
        code,
        deckType: (deckType === 52 ? 52 : 36),
        solo: !!solo,
        seats: Array.from({ length: 6 }, () => ({ taken: false })),
        started: false,
      };
      rooms.set(code, room);

      // Klients automātiski pievienosies istabai ar seat:join,
      // bet varam ielikt arī patīkamu default: (nav obligāti)

      socket.join(code);
      // Sākotnējais stāvoklis
      broadcastRoom(room);

      if (ack) ack({ ok: true, code });
    } catch (e) {
      if (ack) ack({ ok: false, error: e.message || "room:create error" });
    }
  });

  // SĒDVIETA PIEVIENOŠANĀS
  socket.on("seat:join", ({ code, seatIndex, name }, ack) => {
    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: "Istaba nav atrasta" });

    if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex > 5) {
      return ack && ack({ ok: false, error: "Nederīgs sēdvietas indekss" });
    }

    // ja jau esi kādā sēdvietā tajā pašā istabā — atbrīvo
    for (let i = 0; i < 6; i++) {
      const s = room.seats[i];
      if (s.taken && s.socketId === socket.id) {
        s.taken = false;
        s.socketId = undefined;
        s.name = undefined;
      }
    }

    // pārbaudi vai brīva
    const seat = room.seats[seatIndex];
    if (seat.taken) return ack && ack({ ok: false, error: "Sēdvieta jau aizņemta" });

    // piesēdini
    seat.taken = true;
    seat.socketId = socket.id;
    seat.name = (name || "Spēlētājs").toString().slice(0, 24);

    socket.join(room.code);
    broadcastRoom(room);

    // SOLO režīms: ja vienīgais cilvēks istabā un seat 1 brīvs — ieliec BOT uz 1. vietu
    if (room.solo) {
      const humanCount = room.seats.filter(s => s.taken && s.socketId).length;
      const botIndex = 1;
      if (humanCount === 1 && !room.seats[botIndex].taken) {
        room.seats[botIndex] = { taken: true, name: "BOT", socketId: null };
        broadcastRoom(room);
      }
    }

    // paziņo tikai šim soketam, kur viņš sēž
    socket.emit("seat:you", seatIndex);
    return ack && ack({ ok: true, seatIndex });
  });

  // Atvienošanās — atbrīvo sēdvietu
  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      let changed = false;
      for (let i = 0; i < 6; i++) {
        const s = room.seats[i];
        if (s.taken && s.socketId === socket.id) {
          s.taken = false;
          s.socketId = undefined;
          s.name = undefined;
          changed = true;
        }
      }
      if (changed) broadcastRoom(room);
    }
  });
});

// ====== START ======
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Duraks Online running on port", PORT);
});
