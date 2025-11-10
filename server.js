// server.js — Duraks (podkidnoy) serveris
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.get("/health", (_, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const RANKS = ["6","7","8","9","10","J","Q","K","A"];
const SUITS = ["♣","♦","♥","♠"];

const rankValue = (r) => RANKS.indexOf(r);

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s, id: `${r}${s}-${Math.random().toString(36).slice(2,7)}` });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function canCover(attack, defend, trump) {
  if (!attack || !defend) return false;
  if (defend.s === attack.s) return rankValue(defend.r) > rankValue(attack.r);
  if (defend.s === trump && attack.s !== trump) return true;
  if (defend.s === trump && attack.s === trump) return rankValue(defend.r) > rankValue(attack.r);
  return false;
}

const nextIndex = (i, list) => (i + 1) % list.length;

const rooms = new Map();
/*
room = {
  id, hostId,
  players: [{ id, nick, hand: Card[], ready: boolean, connected: boolean }],
  deck: Card[], discard: Card[],
  trumpSuit: string, trumpCard: Card,
  table: [{ attack: Card, defend?: Card }],
  attacker: number, defender: number,
  phase: "lobby"|"attack"|"end",
  passes: Set(socketId),
  chat: string[]
}
*/

function visibleState(room, socketId) {
  return {
    id: room.id,
    phase: room.phase,
    trumpSuit: room.trumpSuit,
    trumpCard: room.trumpCard,
    deckCount: room.deck.length,
    discardCount: room.discard.length,
    attacker: room.attacker,
    defender: room.defender,
    table: room.table,
    players: room.players.map((p, idx) => ({
      nick: p.nick,
      connected: p.connected,
      ready: p.ready,
      handCount: p.hand.length,
      me: p.id === socketId,
      index: idx
    })),
    myHand: room.players.find(p => p.id === socketId)?.hand ?? [],
    chat: room.chat.slice(-50)
  };
}

function emitState(room) {
  for (const p of room.players) io.to(p.id).emit("state", visibleState(room, p.id));
  io.to(room.id).emit("lobbyState", {
    id: room.id,
    players: room.players.map(p => ({ nick: p.nick, ready: p.ready, connected: p.connected })),
    phase: room.phase
  });
}

function tableRanks(room) {
  const ranks = new Set();
  for (const pair of room.table) {
    if (pair.attack) ranks.add(pair.attack.r);
    if (pair.defend) ranks.add(pair.defend.r);
  }
  return ranks;
}

function maxPairsAllowed(room) {
  const def = room.players[room.defender];
  return Math.min(6, def.hand.length);
}

function dealUpToSix(room) {
  let i = room.attacker;
  for (let k = 0; k < room.players.length; k++) {
    const p = room.players[i];
    while (p.hand.length < 6 && room.deck.length > 0) p.hand.push(room.deck.pop());
    i = nextIndex(i, room.players);
  }
}

function endBoutDefended(room) {
  // viss aizsegts → metamajā
  for (const pair of room.table) {
    room.discard.push(pair.attack);
    if (pair.defend) room.discard.push(pair.defend);
  }
  room.table = [];
  dealUpToSix(room);
  room.attacker = room.defender; // nākamais uzbrucējs = iepriekšējais aizsargs
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.phase = "attack";
}

function endBoutTook(room) {
  const def = room.players[room.defender];
  for (const pair of room.table) {
    def.hand.push(pair.attack);
    if (pair.defend) def.hand.push(pair.defend);
  }
  room.table = [];
  dealUpToSix(room);
  room.attacker = nextIndex(room.defender, room.players); // pēc aizsarga
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.phase = "attack";
}

function checkGameEnd(room) {
  const active = room.players.filter(p => p.hand.length > 0);
  if (room.deck.length === 0) {
    // izkrīt tie, kam 0 rokā
    // ja paliek tikai viens ar kārtīm → spēle beidzas
  }
  if (active.length <= 1) {
    room.phase = "end";
    io.to(room.id).emit("end", {
      losers: active.map(p => p.nick),
      winners: room.players.filter(p => p.hand.length === 0).map(p => p.nick)
    });
    return true;
  }
  return false;
}

io.on("connection", (socket) => {
  // Helper – emit tikai vienam
  const sendErr = (msg) => socket.emit("error", msg);

  socket.on("createRoom", ({ roomId, nickname }) => {
    if (!roomId) return sendErr("Room ID nav norādīts");
    if (rooms.has(roomId)) return sendErr("Istaba jau eksistē");
    const deck = makeDeck();
    const trumpCard = deck[deck.length - 1]; // klasika: apakšējā karte — trumpis redzams
    const trumpSuit = trumpCard.s;
    const room = {
      id: roomId,
      hostId: socket.id,
      players: [{ id: socket.id, nick: nickname || "Spēlētājs", hand: [], ready: false, connected: true }],
      deck,
      discard: [],
      trumpSuit,
      trumpCard,
      table: [],
      attacker: 0,
      defender: 0,
      phase: "lobby",
      passes: new Set(),
      chat: []
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    emitState(room);
  });

  socket.on("joinRoom", ({ roomId, nickname }) => {
    const room = rooms.get(roomId);
    if (!room) return sendErr("Istaba nav atrasta");
    if (room.phase !== "lobby") return sendErr("Spēle jau sākusies");
    if (room.players.length >= 6) return sendErr("Istaba ir pilna");

    room.players.push({ id: socket.id, nick: nickname || "Spēlētājs", hand: [], ready: false, connected: true });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("toggleReady", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "lobby") return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    p.ready = !p.ready;
    emitState(room);
  });

  socket.on("startGame", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return sendErr("Istaba nav atrasta");
    if (socket.id !== room.hostId) return sendErr("Tikai host var sākt");
    if (room.players.length < 2) return sendErr("Vajag vismaz 2 spēlētājus");
    // (Neobligāti) pārbaudīt, ka visi ir gatavi:
    // if (!room.players.every(p => p.ready)) return sendErr("Ne visi gatavi");

    // Dala līdz 6
    for (const p of room.players) while (p.hand.length < 6 && room.deck.length > 0) p.hand.push(room.deck.pop());

    // Sāk uzbrukt zemākā trumpja īpašnieks (ja nav — 0)
    let best = { have: false, val: Infinity, idx: 0 };
    room.players.forEach((p, idx) => {
      p.hand.forEach(c => { if (c.s === room.trumpSuit && rankValue(c.r) < best.val) best = { have: true, val: rankValue(c.r), idx }; });
    });
    room.attacker = best.have ? best.idx : 0;
    room.defender = nextIndex(room.attacker, room.players);
    room.phase = "attack";
    room.passes = new Set();

    io.to(room.id).emit("message", `Trumpis: ${room.trumpCard.r}${room.trumpCard.s}`);
    emitState(room);
  });

  socket.on("playAttack", ({ roomId, card }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "attack") return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx < 0) return;
    if (idx === room.defender) return sendErr("Aizsargs nevar uzbrukt");
    if (room.table.length >= maxPairsAllowed(room)) return sendErr("Sasniegts pāru limits");

    const ranks = tableRanks(room);
    const canAdd = room.table.length === 0 || ranks.has(card.r);
    if (!canAdd) return sendErr("Jāliek tāda paša ranga kārts");

    const player = room.players[idx];
    const handIdx = player.hand.findIndex(c => c.id === card.id);
    if (handIdx < 0) return sendErr("Tev tādas kārts nav");

    player.hand.splice(handIdx, 1);
    room.table.push({ attack: card });

    room.passes.delete(socket.id);
    emitState(room);
  });

  socket.on("playDefend", ({ roomId, attackIndex, card }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "attack") return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.defender) return sendErr("Tikai aizsargs drīkst aizsegt");

    const pair = room.table[attackIndex];
    if (!pair) return sendErr("Nav tāda uzbrukuma kārts");
    if (pair.defend) return sendErr("Šis jau aizsegts");

    const player = room.players[idx];
    const handIdx = player.hand.findIndex(c => c.id === card.id);
    if (handIdx < 0) return sendErr("Tev tādas kārts nav");
    if (!canCover(pair.attack, card, room.trumpSuit)) return sendErr("Ar šo kārti nevar aizsegt");

    player.hand.splice(handIdx, 1);
    pair.defend = card;

    const allCovered = room.table.length > 0 && room.table.every(p => p.defend);
    if (allCovered && room.passes.size === room.players.length - 1) {
      endBoutDefended(room);
      if (!checkGameEnd(room)) emitState(room);
      return;
    }
    emitState(room);
  });

  socket.on("takeCards", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "attack") return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.defender) return sendErr("Tikai aizsargs var ņemt");

    endBoutTook(room);
    if (!checkGameEnd(room)) emitState(room);
  });

  socket.on("pass", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "attack") return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx < 0) return;
    if (idx === room.defender) return sendErr("Aizsargs nevar pasēt — ņem vai aizsedz!");

    room.passes.add(socket.id);

    const allCovered = room.table.length > 0 && room.table.every(p => p.defend);
    const everyonePassed = room.passes.size === room.players.length - 1;
    if (allCovered && everyonePassed) {
      endBoutDefended(room);
      if (!checkGameEnd(room)) emitState(room);
      return;
    }
    emitState(room);
  });

  socket.on("chat", ({ roomId, text }) => {
    const room = rooms.get(roomId);
    if (!room || !text) return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    const msg = `${p.nick}: ${String(text).slice(0, 200)}`;
    room.chat.push(msg);
    io.to(room.id).emit("message", msg);
    emitState(room);
  });

  socket.on("leaveRoom", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const i = room.players.findIndex(p => p.id === socket.id);
    if (i >= 0) room.players[i].connected = false;
    emitState(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const p = room.players.find(pl => pl.id === socket.id);
      if (p) p.connected = false;
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log("Duraks serveris klausās uz porta " + PORT));
