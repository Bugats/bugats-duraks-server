// CommonJS (bez "type":"module") lai nebūtu require/import konflikti
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.static('public')); // servē klienta failus no ./public

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ======= Istabu glabātuve =======
/**
 * room objektam:
 * {
 *   id: 'ABCD',
 *   seats: [ {occupant:null}, ... x6 ],
 *   players: Map<playerId, { nick, socketId }>,
 *   playerSeat: Map<playerId, seatId>
 *   // te vēlāk var likt spēles stāvokli, trumpi, kavu u.c.
 * }
 */
const rooms = new Map();

// Palīg-funkcijas
function genCode(len = 4) {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  while (s.length < len) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}
function ensureRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId,
      seats: Array.from({ length: 6 }, () => ({ occupant: null })),
      players: new Map(),
      playerSeat: new Map()
    };
    rooms.set(roomId, room);
  } else {
    room.seats ??= Array.from({ length: 6 }, () => ({ occupant: null }));
    room.players ??= new Map();
    room.playerSeat ??= new Map();
  }
  return room;
}
function publicSeats(room) {
  return room.seats.map((s, i) => ({
    id: i,
    occupied: !!s.occupant,
    nick: s.occupant ? (room.players.get(s.occupant)?.nick ?? 'Spēlētājs') : null,
    you: false // klients pēc tam atzīmēs pats
  }));
}
function emitSeatUpdate(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  io.to(roomId).emit('seat:update', { seats: publicSeats(room) });
}

// ======= Socket.IO =======
io.on('connection', (socket) => {
  // drošības anti-spam ierobežojums uz "seat:join"
  socket._lastJoinTs = 0;

  // Izveido istabu
  socket.on('room:create', ({ nick }, ack) => {
    const id = (() => {
      let code;
      do code = genCode(4); while (rooms.has(code));
      return code;
    })();
    const room = ensureRoom(id);

    // reģistrē spēlētāju
    const playerId = socket.id;
    socket.playerId = playerId;
    socket.roomId = id;
    room.players.set(playerId, { nick: nick?.trim() || 'Spēlētājs', socketId: socket.id });

    socket.join(id);
    ack?.({ ok: true, roomId: id, seats: publicSeats(room), playerId });
    emitSeatUpdate(id);
  });

  // Pievienojas esošai istabai
  socket.on('room:join', ({ roomId, nick }, ack) => {
    const room = rooms.get(roomId);
    if (!room) return ack?.({ ok: false, err: 'room-not-found' });

    const playerId = socket.id;
    socket.playerId = playerId;
    socket.roomId = roomId;

    room.players.set(playerId, { nick: nick?.trim() || 'Spēlētājs', socketId: socket.id });

    socket.join(roomId);
    ack?.({ ok: true, seats: publicSeats(room), playerId });
    emitSeatUpdate(roomId);
  });

  // Viena sēdvieta uz spēlētāju (autoritatīvi)
  socket.on('seat:join', ({ roomId, seatId }, ack) => {
    const now = Date.now();
    if (now - socket._lastJoinTs < 600) return ack?.({ ok: false, err: 'too-fast' });
    socket._lastJoinTs = now;

    const room = rooms.get(roomId);
    const pid = socket.playerId;
    if (!room || !pid) return ack?.({ ok: false, err: 'bad-state' });

    room.seats ??= Array.from({ length: 6 }, () => ({ occupant: null }));
    room.playerSeat ??= new Map();

    const current = room.playerSeat.get(pid);
    if (current !== undefined) {
      if (current === seatId) return ack?.({ ok: true, seatId }); // idempotenti
      return ack?.({ ok: false, err: 'already-seated', seatId: current });
    }

    const seat = room.seats[seatId];
    if (!seat) return ack?.({ ok: false, err: 'bad-seat' });
    if (seat.occupant) return ack?.({ ok: false, err: 'taken' });

    seat.occupant = pid;
    room.playerSeat.set(pid, seatId);

    emitSeatUpdate(roomId);
    ack?.({ ok: true, seatId });
  });

  // Atvienošanās: atbrīvo sēdvietu
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    const pid = socket.playerId;
    if (!roomId || !pid) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const seatId = room.playerSeat.get(pid);
    if (seatId !== undefined) {
      const seat = room.seats[seatId];
      if (seat) seat.occupant = null;
      room.playerSeat.delete(pid);
    }
    room.players.delete(pid);
    emitSeatUpdate(roomId);
  });
});

// Health-check / sākum-lapa
app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server listening on http://localhost:' + PORT);
});
