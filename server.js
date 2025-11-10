// socket.io serveris Duraks Online (minimālais, drošs skelets savienojumam)
// Piezīme: te nav pilnā spēles loģika — tas ir stabils pamats savienojumam,
// istabām un sēdvietām; varēsim ielikt tavu pilno loģiku, kad konekcija ir ok.

import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";

const PORT = process.env.PORT || 10000;

// ~~~ DROŠĪBA ~~~
// Atļaujam tikai tavu frontu (Hostinger). Ja izmanto apakšlapas, atstāj domēnu:
const ORIGIN = process.env.ORIGIN || "https://thezone.lv";

// Express – tikai health-checks (socket.io strādā pa /socket.io)
const app = express();
app.use(
  cors({
    origin: ORIGIN,
    credentials: true,
  })
);

// Health-check, lai Render rādītu “Healthy”
app.get("/", (_req, res) => res.status(200).send("Duraks socket server is up"));

const server = http.createServer(app);

// Socket.IO – tikai WebSocket transportam (stabilāk Hostinger <-> Render)
const io = new Server(server, {
  transports: ["websocket"],
  cors: {
    origin: ORIGIN,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Vienkārša istabu un spēlētāju glabātuve (skelets)
const rooms = new Map(); // code -> { code, seats: {1..6}, players: Map(socketId->{name, seat}) }

function createRoom(code, deckType, solo) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      deckType: deckType || 36,
      solo: !!solo,
      seats: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null },
      players: new Map(), // socket.id -> { name, seat }
      stateVersion: 0,
      phase: "lobby", // 'lobby'|'attack'|'defend' etc. (skelets)
    });
  }
  return rooms.get(code);
}

function safeState(room) {
  // Minimāls stāvoklis klientam (skelets)
  return {
    room: { code: room.code },
    deckLeft: 0,
    trump: null,
    phase: room.phase,
    seats: Object.fromEntries(
      Object.entries(room.seats).map(([k, val]) => [
        k,
        val ? { taken: true, playerId: val } : { taken: false },
      ])
    ),
    players: Object.fromEntries(
      Array.from(room.players.entries()).map(([sid, p]) => [
        sid,
        { name: p.name, seat: p.seat, hand: [] }, // šeit vēl nav kārtis (skelets)
      ])
    ),
    battlefield: [],
    turn: null,
    stateVersion: room.stateVersion,
  };
}

function broadcast(room) {
  room.stateVersion++;
  io.to(room.code).emit("state", safeState(room));
}

io.on("connection", (socket) => {
  // Fronts pieslēdzies
  socket.emit("turn:info", "Savienots ar serveri.");

  socket.on("room:create", ({ code, name, deckType, solo }) => {
    try {
      const roomCode =
        (code || Math.random().toString(36).slice(2, 6)).toUpperCase();
      const room = createRoom(roomCode, deckType, solo);

      socket.join(roomCode);
      room.players.set(socket.id, { name: name || "Spēlētājs", seat: null });

      socket.emit("room:created", { code: roomCode, state: safeState(room) });
      broadcast(room);
    } catch (e) {
      socket.emit("error:msg", "Istabu izveidot neizdevās.");
    }
  });

  socket.on("room:join", ({ code }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return socket.emit("error:msg", "Istaba nav atrasta.");
    socket.join(room.code);
    if (!room.players.has(socket.id)) {
      room.players.set(socket.id, { name: "Spēlētājs", seat: null });
    }
    socket.emit("room:joined", { code: room.code, state: safeState(room) });
    broadcast(room);
  });

  socket.on("seat:take", ({ code, seat }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    if (seat < 1 || seat > 6) return;

    // viena sēdvieta uz spēlētāju
    for (const k of Object.keys(room.seats)) {
      if (room.seats[k] === socket.id) room.seats[k] = null;
    }
    // ja aizņemts – atpakaļ paziņojums
    if (room.seats[seat]) {
      return socket.emit("seat:busy", seat);
    }
    room.seats[seat] = socket.id;

    const p = room.players.get(socket.id) || { name: "Spēlētājs", seat: null };
    p.seat = seat;
    room.players.set(socket.id, p);

    socket.emit("seat:accepted", { seat, state: safeState(room) });
    broadcast(room);
  });

  socket.on("seat:leave", ({ code }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    for (const k of Object.keys(room.seats)) {
      if (room.seats[k] === socket.id) room.seats[k] = null;
    }
    const p = room.players.get(socket.id);
    if (p) p.seat = null;
    broadcast(room);
  });

  // ======= Spēles pogu notikumi (skelets) =======
  socket.on("play:attack", ({ code /*, indices*/ }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    room.phase = "attack";
    broadcast(room);
  });

  socket.on("play:add", ({ code /*, indices*/ }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    broadcast(room);
  });

  socket.on("play:defend", ({ code /*, indices*/ }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    room.phase = "defend";
    broadcast(room);
  });

  socket.on("play:take", ({ code }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    broadcast(room);
  });

  socket.on("turn:end", ({ code }) => {
    const room = rooms.get((code || "").toUpperCase());
    if (!room) return;
    room.phase = "attack";
    broadcast(room);
  });

  socket.on("disconnect", () => {
    // iztīrām sēdvietas un spēlētāju
    for (const room of rooms.values()) {
      let changed = false;
      if (room.players.has(socket.id)) {
        for (const k of Object.keys(room.seats)) {
          if (room.seats[k] === socket.id) {
            room.seats[k] = null;
            changed = true;
          }
        }
        room.players.delete(socket.id);
        changed = true;
      }
      if (changed) broadcast(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Duraks socket server listening on ${PORT}`);
});
