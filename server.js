// server.js
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
const SUITS = ["♣","♦","♥","♠"]; // tikai simboli vizuāli; loģikai der

function makeDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ r, s, id: `${r}${s}` });
    }
  }
  // Fisher–Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function rankValue(r) {
  return RANKS.indexOf(r);
}

function canCover(attack, defend, trump) {
  if (!attack || !defend) return false;
  if (defend.s === attack.s) {
    return rankValue(defend.r) > rankValue(attack.r);
  }
  if (defend.s === trump && attack.s !== trump) return true;
  return false;
}

function nextIndex(i, list) {
  return (i + 1) % list.length;
}

const rooms = new Map();
/*
room = {
  id, hostId,
  players: [{ id, nick, hand: Card[], connected: true }],
  deck: Card[], discard: Card[],
  trumpSuit: string, trumpCard: Card,
  table: [{ attack: Card, defend?: Card }],
  attacker: number, defender: number,
  phase: "lobby"|"attack"|"refill"|"end",
  passes: Set(socketId),
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
    players: room.players.map((p) => ({
      nick: p.nick,
      connected: p.connected,
      handCount: p.hand.length,
      me: p.id === socketId
    })),
    myHand: room.players.find(p => p.id === socketId)?.hand ?? []
  };
}

function emitState(room) {
  room.players.forEach(p => {
    io.to(p.id).emit("state", visibleState(room, p.id));
  });
}

function dealUpToSix(room) {
  // sāk ar uzbrucēju, tad pulksteņrād.
  let i = room.attacker;
  for (let k = 0; k < room.players.length; k++) {
    const p = room.players[i];
    while (p.hand.length < 6 && room.deck.length > 0) {
      p.hand.push(room.deck.pop());
    }
    i = nextIndex(i, room.players);
  }
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

function endBoutDefended(room) {
  // viss aizsegts → metamajā
  for (const pair of room.table) {
    room.discard.push(pair.attack);
    if (pair.defend) room.discard.push(pair.defend);
  }
  room.table = [];
  // Refill secība sākas no uzbrucēja
  dealUpToSix(room);
  // Nākamais uzbrucējs = iepriekšējais aizsargs
  room.attacker = room.defender;
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.phase = "attack";
}

function endBoutTook(room) {
  const def = room.players[room.defender];
  // viss uz galda aiziet aizsargam rokā
  for (const pair of room.table) {
    def.hand.push(pair.attack);
    if (pair.defend) def.hand.push(pair.defend);
  }
  room.table = [];
  // Refill secība sākas no uzbrucēja
  dealUpToSix(room);
  // Nākamais uzbrucējs = spēlētājs pēc aizsarga
  room.attacker = nextIndex(room.defender, room.players);
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.phase = "attack";
}

function checkGameEnd(room) {
  // beidzas, ja palicis tikai viens ar kārtīm
  const active = room.players.filter(p => p.hand.length > 0);
  if (active.length <= 1) {
    room.phase = "end";
    io.to([...room.players.map(p=>p.id)]).emit("end", {
      losers: active.map(p => p.nick),
      winners: room.players.filter(p => p.hand.length === 0).map(p => p.nick)
    });
    return true;
  }
  return false;
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ roomId, nickname }) => {
    if (!roomId) return socket.emit("error", "Room ID nav norādīts");
    if (rooms.has(roomId)) return socket.emit("error", "Istaba jau eksistē");
    const deck = makeDeck();
    const trumpCard = deck[0]; // pēdējā apakšā, bet loģikai pietiek zināt mastu
    const trumpSuit = trumpCard.s;
    const room = {
      id: roomId,
      hostId: socket.id,
      players: [{ id: socket.id, nick: nickname || "Spēlētājs", hand: [], connected: true }],
      deck,
      discard: [],
      trumpSuit,
      trumpCard,
      table: [],
      attacker: 0,
      defender: 0,
      phase: "lobby",
      passes: new Set()
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    emitState(room);
  });

  socket.on("joinRoom", ({ roomId, nickname }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error", "Istaba nav atrasta");
    if (room.phase !== "lobby") return socket.emit("error", "Spēle jau sākusies");
    if (room.players.length >= 6) return socket.emit("error", "Istaba ir pilna");

    room.players.push({ id: socket.id, nick: nickname || "Spēlētājs", hand: [], connected: true });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("startGame", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error", "Istaba nav atrasta");
    if (socket.id !== room.hostId) return socket.emit("error", "Tikai host var sākt");
    if (room.players.length < 2) return socket.emit("error", "Vajag vismaz 2 spēlētājus");

    // Dala līdz 6
    for (const p of room.players) {
      while (p.hand.length < 6 && room.deck.length > 0) {
        p.hand.push(room.deck.pop());
      }
    }

    // Nosaka sākuma uzbrucēju: zemākais trumpis (vienkāršības labad — pirmais, kam ir trumpis)
    let startIdx = 0;
    let best = { have: false, val: Infinity };
    room.players.forEach((p, idx) => {
      p.hand.forEach(c => {
        if (c.s === room.trumpSuit && rankValue(c.r) < best.val) {
          best = { have: true, val: rankValue(c.r), idx };
        }
      });
    });
    startIdx = best.have ? best.idx : 0;

    room.attacker = startIdx;
    room.defender = nextIndex(startIdx, room.players);
    room.phase = "attack";
    room.passes = new Set();
    emitState(room);
  });

  socket.on("playAttack", ({ roomId, card }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "attack") return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx < 0) return;

    // Uzbrukt drīkst uzbrucējs vai citi, kas nav aizsargs, bet tikai ar atbilstošu rangu
    const isDefender = idx === room.defender;
    if (isDefender) return socket.emit("error", "Aizsargs nevar uzbrukt");
    if (room.table.length >= maxPairsAllowed(room)) return socket.emit("error", "Sasniegts pāru limits");

    const ranks = tableRanks(room);
    const canAdd = room.table.length === 0 || ranks.has(card.r);
    if (!canAdd) return socket.emit("error", "Jāliek tāda paša ranga kārts kā uz galda");

    const player = room.players[idx];
    const handIdx = player.hand.findIndex(c => c.id === card.id);
    if (handIdx < 0) return socket.emit("error", "Tev tādas kārts nav");

    // liek kārtī uz galda
    player.hand.splice(handIdx, 1);
    room.table.push({ attack: card });

    room.passes.delete(socket.id); // atsvaidzina pasu statusu
    emitState(room);
  });

  socket.on("addCard", ({ roomId, card }) => {
    // alias uz playAttack (pievienošana)
    io.to(socket.id).emit("message", "Pievienošana = uzbrukuma kārts pievienošana");
    io.emit("noop"); // lai dublikāti netraucē
    io.sockets.sockets.get(socket.id)?.emit("playAttack", { roomId, card });
  });

  socket.on("playDefend", ({ roomId, attackIndex, card }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "attack") return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx !== room.defender) return socket.emit("error", "Tikai aizsargs drīkst aizsegt");

    const pair = room.table[attackIndex];
    if (!pair) return socket.emit("error", "Nav tāda uzbrukuma kārts");
    if (pair.defend) return socket.emit("error", "Šis jau aizsegts");

    const player = room.players[idx];
    const handIdx = player.hand.findIndex(c => c.id === card.id);
    if (handIdx < 0) return socket.emit("error", "Tev tādas kārts nav");

    if (!canCover(pair.attack, card, room.trumpSuit)) {
      return socket.emit("error", "Ar šo kārti nevar aizsegt");
    }

    player.hand.splice(handIdx, 1);
    pair.defend = card;

    // ja viss aizsegts un visi uzbrucēji pasējuši → bout beidzas ar aizsardzību
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
    if (idx !== room.defender) return socket.emit("error", "Tikai aizsargs var ņemt");

    endBoutTook(room);
    if (!checkGameEnd(room)) emitState(room);
  });

  socket.on("pass", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "attack") return;
    const idx = room.players.findIndex(p => p.id === socket.id);
    if (idx < 0) return;
    if (idx === room.defender) return socket.emit("error", "Aizsargs nevar pasēt — ņem vai aizsedz!");

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
    if (!room) return;
    io.to(roomId).emit("message", text);
  });

  socket.on("leaveRoom", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const i = room.players.findIndex(p => p.id === socket.id);
    if (i >= 0) {
      room.players[i].connected = false;
      // vienkāršības labad istabu neaizveram uzreiz
      emitState(room);
    }
  });

  socket.on("disconnect", () => {
    // atzīmējam, ka atvienojies
    for (const room of rooms.values()) {
      const p = room.players.find(pl => pl.id === socket.id);
      if (p) p.connected = false;
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log("Duraks serveris klausās uz porta " + PORT));
