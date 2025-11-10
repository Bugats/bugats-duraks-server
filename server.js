// server.js (ESM)
import express from "express";
import http from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, "src", "public")));
app.get("/", (_req, res) => res.send("Duraks Online server is running."));

// ------------- istabu loģika (tieši tā pati kā iepriekš dotajā CommonJS) -------------
const rooms = new Map();
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

io.on("connection", (socket) => {
  socket.emit("pong");

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

      socket.join(code);
      broadcastRoom(room);

      ack?.({ ok: true, code });
    } catch (e) {
      ack?.({ ok: false, error: e.message || "room:create error" });
    }
  });

  socket.on("seat:join", ({ code, seatIndex, name }, ack) => {
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: "Istaba nav atrasta" });
    if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex > 5)
      return ack?.({ ok: false, error: "Nederīgs sēdvietas indekss" });

    for (let i = 0; i < 6; i++) {
      const s = room.seats[i];
      if (s.taken && s.socketId === socket.id) {
        s.taken = false; s.socketId = undefined; s.name = undefined;
      }
    }

    const seat = room.seats[seatIndex];
    if (seat.taken) return ack?.({ ok: false, error: "Sēdvieta jau aizņemta" });

    seat.taken = true;
    seat.socketId = socket.id;
    seat.name = (name || "Spēlētājs").toString().slice(0, 24);

    socket.join(room.code);
    broadcastRoom(room);

    if (room.solo) {
      const humanCount = room.seats.filter(s => s.taken && s.socketId).length;
      const botIndex = 1;
      if (humanCount === 1 && !room.seats[botIndex].taken) {
        room.seats[botIndex] = { taken: true, name: "BOT", socketId: null };
        broadcastRoom(room);
      }
    }

    socket.emit("seat:you", seatIndex);
    ack?.({ ok: true, seatIndex });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      let changed = false;
      for (let i = 0; i < 6; i++) {
        const s = room.seats[i];
        if (s.taken && s.socketId === socket.id) {
          s.taken = false; s.socketId = undefined; s.name = undefined;
          changed = true;
        }
      }
      if (changed) broadcastRoom(room);
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Duraks Online running on port", PORT));
