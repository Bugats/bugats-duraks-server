import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
  transports: ["websocket"],
});

const PORT = process.env.PORT || 3000;

// ===== Rooms (vienkāršots “lobby” ar čatu) =====
const rooms = new Map();

function roomCode() {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function makeRoom(deckSize) {
  const code = roomCode();
  const room = {
    code,
    deckSize: deckSize === 52 ? 52 : 36,
    players: [], // { id, nick }
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

// ===== Socket.IO =====
io.on("connection", (sock) => {
  // Izveidot istabu
  sock.on("room.create", ({ nick, deckSize }, ack) => {
    try {
      const r = makeRoom(deckSize);
      r.players.push({ id: sock.id, nick: nick || "Spēlētājs" });
      sock.join(r.code);

      // droši paziņojumi
      sock.emit("room.created", { room: r.code });
      ack?.({ ok: true, room: r.code });

      io.to(r.code).emit("room.update", {
        players: r.players.map((p) => ({ id: p.id, nick: p.nick })),
      });
    } catch (e) {
      ack?.({ ok: false, error: "create-failed" });
      io.to(sock.id).emit("error.msg", "Neizdevās izveidot istabu.");
    }
  });

  // Pievienoties istabai
  sock.on("room.join", ({ nick, room }, ack) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r) {
      ack?.({ ok: false, error: "no-room" });
      io.to(sock.id).emit("error.msg", "Istaba neeksistē");
      return;
    }
    if (r.players.length >= 2) {
      ack?.({ ok: false, error: "full" });
      io.to(sock.id).emit("error.msg", "Istaba pilna");
      return;
    }
    r.players.push({ id: sock.id, nick: nick || "Spēlētājs" });
    sock.join(r.code);

    sock.emit("room.joined", {
      room: r.code,
      players: r.players.map((p) => ({ id: p.id, nick: p.nick })),
    });
    ack?.({ ok: true, room: r.code });

    io.to(r.code).emit("room.update", {
      players: r.players.map((p) => ({ id: p.id, nick: p.nick })),
    });
  });

  // Čats
  sock.on("chat", ({ room, msg }) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r) return;
    const p = r.players.find((x) => x.id === sock.id);
    io.to(r.code).emit("chat", { nick: p ? p.nick : "?", msg: String(msg).slice(0, 300) });
  });

  // Atvienošanās
  sock.on("disconnect", () => {
    for (const [code, r] of rooms) {
      const i = r.players.findIndex((p) => p.id === sock.id);
      if (i > -1) {
        r.players.splice(i, 1);
        io.to(code).emit("room.update", {
          players: r.players.map((p) => ({ id: p.id, nick: p.nick })),
        });
      }
      // Tīrām tukšas istabas
      if (r.players.length === 0) rooms.delete(code);
    }
  });
});

// ===== Static files =====
app.use(express.static(__dirname));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

httpServer.listen(PORT, () => {
  console.log("Duraks Online running on port", PORT);
});
