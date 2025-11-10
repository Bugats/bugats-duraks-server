// Duraks Online — Bugats Edition (server.js)
// Pilns Node + Socket.IO serveris ar solo BOT un kāršu sadali.
// Darbojas ar thezone.lv/rps/ “lobby” frontendu (bez izmaiņām).

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

// ==== KONFIGS ====
const PORT = process.env.PORT || 10000;
// Hostinger fronte (pieliec arī savu “www.” ja vajag)
const ALLOWED_ORIGINS = [
  "https://thezone.lv",
  "https://www.thezone.lv",
  "http://thezone.lv",
  "http://www.thezone.lv",
  // attīstībai:
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const app = express();
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
  })
);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS, credentials: true },
  transports: ["websocket", "polling"],
});

// Veselības pārbaude
app.get("/health", (_req, res) => res.json({ ok: true }));

// ==== SPĒLES DATI ====
const SUITS = ["♣", "♦", "♥", "♠"];
const RANKS_36 = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const RANKS_52 = ["2", "3", "4", "5", ...RANKS_36];
const RANK_VALUE = {
  "2": 2, "3": 3, "4": 4, "5": 5,
  "6": 6, "7": 7, "8": 8, "9": 9, "10": 10,
  J: 11, Q: 12, K: 13, A: 14,
};

// istabas: { [code]: Room }
const rooms = new Map();

// Palīgfunkcijas
const rnd = (n) => Math.floor(Math.random() * n);
const makeCode = () =>
  Array.from({ length: 4 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[rnd(32)]).join("");

function buildDeck(type /*36|52*/) {
  const ranks = type === 52 ? RANKS_52 : RANKS_36;
  const deck = [];
  for (const s of SUITS) {
    for (const r of ranks) {
      deck.push({ suit: s, rank: r, val: RANK_VALUE[r], code: `${r}${s}` });
    }
  }
  // sajauc
  for (let i = deck.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function seatCount(room) {
  return room.seats.length;
}

function playerBySocket(room, socketId) {
  return room.players.find((p) => p.socketId === socketId);
}

function serializeRoomPublic(room, viewerSocketId) {
  const you = room.players.find((p) => p.socketId === viewerSocketId);
  return {
    code: room.code,
    deckType: room.deckType,
    trump: room.trump, // {suit, rank, code}
    trumpSuit: room.trumpSuit,
    drawCount: room.deck.length,
    phase: room.phase, // 'idle'|'attack'|'defend'|'refill'|'done'
    attackerSeat: room.attackerSeat,
    defenderSeat: room.defenderSeat,
    table: room.table, // [{attack: card, defend: card|null}, ...]
    seats: room.seats.map((sid) => {
      const p = room.players.find((q) => q.seat === sid);
      return p
        ? { seat: sid, name: p.name, isBot: p.isBot, handCount: p.hand.length }
        : { seat: sid, name: null, isBot: false, handCount: 0 };
    }),
    you: you
      ? {
          name: you.name,
          seat: you.seat,
          hand: you.hand, // tava roka pilna
        }
      : null,
  };
}

function emitState(room) {
  for (const p of room.players) {
    io.to(p.socketId).emit("state", serializeRoomPublic(room, p.socketId));
  }
}

function addBot(room) {
  // atrodi brīvu sēdvietu
  const free = room.seats.find(
    (s) => !room.players.some((p) => p.seat === s)
  );
  if (free == null) return false;
  room.players.push({
    id: "BOT_" + Math.random().toString(36).slice(2, 7),
    socketId: "BOT",
    name: "BOT",
    isBot: true,
    seat: free,
    hand: [],
  });
  return true;
}

// Sākspēles iestatījumi
function startGame(room) {
  // izveido un nosaka trumpi
  room.deck = buildDeck(room.deckType);
  room.trump = room.deck[room.deck.length - 1];
  room.trumpSuit = room.trump.suit;

  // izdala pa 6
  for (const p of room.players) p.hand = [];
  for (let r = 0; r < 6; r++) {
    for (const p of room.players) {
      if (room.deck.length) p.hand.push(room.deck.pop());
    }
  }

  // izvēlas uzbrucēju: mazākā trumpja īpašnieks, citādi mazākā kārts
  const all = room.players.map((p) => ({
    p,
    minTrump:
      p.hand
        .filter((c) => c.suit === room.trumpSuit)
        .sort((a, b) => a.val - b.val)[0] || null,
    minAny: p.hand.sort((a, b) => a.val - b.val)[0],
  }));
  let attacker = all
    .filter((x) => x.minTrump)
    .sort((A, B) => A.minTrump.val - B.minTrump.val)[0]?.p;
  if (!attacker) {
    attacker = all.sort((A, B) => A.minAny.val - B.minAny.val)[0].p;
  }
  room.attackerSeat = attacker.seat;

  // aizstāvis – nākamā sēdvieta
  const seatsSorted = [...room.seats].sort((a, b) => a - b);
  const idx = seatsSorted.indexOf(room.attackerSeat);
  room.defenderSeat = seatsSorted[(idx + 1) % seatsSorted.length];

  room.table = [];
  room.phase = "attack";
  room.limitRanks = new Set(); // atļautie ranki "piemest"

  emitState(room);
  maybeBotMove(room);
}

// “Piemest” atļautie ranki (rank, kas jau atrodas uz galda)
function refreshLimitRanks(room) {
  room.limitRanks = new Set(
    room.table.flatMap((p) => [p.attack?.rank, p.defend?.rank]).filter(Boolean)
  );
}

// Vai kārts nositama
function canBeat(att, def, trumpSuit) {
  if (!def) return false;
  if (def.suit === att.suit && def.val > att.val) return true;
  if (def.suit === trumpSuit && att.suit !== trumpSuit) return true;
  return false;
}

function currentAttacker(room) {
  return room.players.find((p) => p.seat === room.attackerSeat);
}
function currentDefender(room) {
  return room.players.find((p) => p.seat === room.defenderSeat);
}

function seatAfter(room, seat) {
  const s = [...room.seats].sort((a, b) => a - b);
  const i = s.indexOf(seat);
  return s[(i + 1) % s.length];
}

// Pēc gājiena – papildini līdz 6 (vispirms uzbrucējs, tad citi, beigās aizstāvis)
function refillToSix(room) {
  const order = [];
  let s = room.attackerSeat;
  for (let i = 0; i < room.seats.length; i++) {
    order.push(s);
    s = seatAfter(room, s);
  }
  for (const seat of order) {
    const p = room.players.find((x) => x.seat === seat);
    while (p && p.hand.length < 6 && room.deck.length) {
      p.hand.push(room.deck.pop());
    }
  }
}

// Pabeidz raundu (pēc “Nosists visur” vai “Paņem”)
function endRound(room, defenderTook) {
  if (defenderTook) {
    // aizstāvis paņem visas kārtis no galda
    const def = currentDefender(room);
    for (const pair of room.table) {
      if (pair.attack) def.hand.push(pair.attack);
      if (pair.defend) def.hand.push(pair.defend);
    }
    room.attackerSeat = def.seat; // tas pats uzbrucējs paliek
  } else {
    // viss nosists – uzbrucējs pāriet tālāk
    room.attackerSeat = room.defenderSeat;
  }

  room.table = [];
  room.phase = "refill";
  emitState(room);

  refillToSix(room);

  // ja kāds iztukšo roku, viņš izkrīt
  room.players = room.players.filter((p) => p.hand.length > 0 || room.deck.length > 0);
  room.seats = room.seats.filter((seat) =>
    room.players.some((p) => p.seat === seat)
  );

  // beigu stāvoklis – paliek 0 vai 1 spēlētājs ar kārtīm
  const stillIn = room.players.filter((p) => p.hand.length > 0);
  if (stillIn.length <= 1) {
    room.phase = "done";
    emitState(room);
    return;
  }

  // nākamais aizstāvis
  room.defenderSeat = seatAfter(room, room.attackerSeat);
  room.phase = "attack";
  refreshLimitRanks(room);
  emitState(room);
  maybeBotMove(room);
}

// BOT AI (vienkāršs, bet korekts)
function botAttackChoose(room, bot) {
  // ja galda nav – sīkākā kārts
  if (room.table.length === 0) {
    return [...bot.hand]
      .sort((a, b) => a.val - b.val || (a.suit === room.trumpSuit) - (b.suit === room.trumpSuit))[0];
  }
  // drīkst piemest tikai esošos rankus
  const ranks = new Set(
    room.table.flatMap((p) => [p.attack?.rank, p.defend?.rank]).filter(Boolean)
  );
  const candidates = bot.hand.filter((c) => ranks.has(c.rank));
  if (candidates.length === 0) return null;
  // paņem minimālo
  return candidates.sort((a, b) => a.val - b.val)[0];
}
function botDefendChoose(room, bot, against) {
  const candidates = bot.hand.filter((c) => canBeat(against, c, room.trumpSuit));
  if (candidates.length === 0) return null;
  // minimālā derīgā
  return candidates.sort((a, b) => a.val - b.val)[0];
}

function maybeBotMove(room) {
  const atk = currentAttacker(room);
  const def = currentDefender(room);
  if (!atk || !def) return;

  // BOT uzbrukums
  if (atk.isBot && room.phase === "attack") {
    setTimeout(() => {
      // mēģina uzbrukt/“piemest”
      const pick = botAttackChoose(room, atk);
      if (!pick) {
        // nav ko sist – gājiens beigts (viss nosists)
        endRound(room, false);
        return;
      }
      // noņem no rokas
      atk.hand.splice(atk.hand.findIndex((c) => c.code === pick.code), 1);
      room.table.push({ attack: pick, defend: null });
      refreshLimitRanks(room);
      emitState(room);
      // ja aizstāvis arī BOT – automātiski nosit vai paņem
      maybeBotMove(room);
    }, 650);
  }

  // BOT aizsardzība
  if (def.isBot && room.phase === "attack") {
    setTimeout(() => {
      // atrodi 1. nenosisto uzbrukumu
      const pair = room.table.find((p) => p.attack && !p.defend);
      if (!pair) return; // nav ko sist
      const choose = botDefendChoose(room, def, pair.attack);
      if (!choose) {
        // nevar nosist – paņem
        endRound(room, true);
        return;
      }
      // ieliek aizsardzību
      def.hand.splice(def.hand.findIndex((c) => c.code === choose.code), 1);
      pair.defend = choose;
      emitState(room);

      // ja viss nosists un nav jauna uzbrukuma -> gājiens beigts
      const allBeaten = room.table.length > 0 && room.table.every((p) => p.defend);
      if (allBeaten) {
        setTimeout(() => endRound(room, false), 500);
      }
    }, 700);
  }
}

// ==== SOCKET HANDLERS ====
io.on("connection", (socket) => {
  // handshake ping
  socket.on("ping:front", () => socket.emit("pong:back"));

  // izveidot istabu
  socket.on("room:create", ({ name, deckType, solo } = {}, cb) => {
    try {
      const code = makeCode();
      const room = {
        code,
        deckType: +deckType === 52 ? 52 : 36,
        seats: [1, 2, 3, 4, 5, 6], // max 6
        players: [],
        deck: [],
        trump: null,
        trumpSuit: null,
        table: [],
        attackerSeat: null,
        defenderSeat: null,
        phase: "idle",
        limitRanks: new Set(),
      };
      rooms.set(code, room);

      // pirmais spēlētājs sēžas 1. vietā
      room.players.push({
        id: socket.id,
        socketId: socket.id,
        name: name || "Spēlētājs",
        isBot: false,
        seat: 1,
        hand: [],
      });

      if (solo) addBot(room);

      socket.join(code);
      cb?.({ ok: true, code });
      emitState(room);
    } catch (e) {
      cb?.({ ok: false, error: e?.message || "room:create error" });
    }
  });

  // pievienoties istabai
  socket.on("room:join", ({ code, name } = {}, cb) => {
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Istaba nav atrodama" });
    // brīva sēdvieta
    const free = room.seats.find((s) => !room.players.some((p) => p.seat === s));
    if (!free) return cb?.({ ok: false, error: "Istaba pilna" });

    room.players.push({
      id: socket.id,
      socketId: socket.id,
      name: name || "Spēlētājs",
      isBot: false,
      seat: free,
      hand: [],
    });
    socket.join(code);
    cb?.({ ok: true });
    emitState(room);
  });

  // sēdvietas maiņa
  socket.on("seat:take", ({ code, seat }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false });
    if (room.players.some((p) => p.seat === seat))
      return cb?.({ ok: false, error: "Vieta aizņemta" });
    const me = playerBySocket(room, socket.id);
    if (!me) return cb?.({ ok: false });

    me.seat = seat;
    emitState(room);
    cb?.({ ok: true });
  });

  // sākt spēli
  socket.on("game:start", ({ code }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Nav istabas" });
    if (room.players.length < 2)
      return cb?.({ ok: false, error: "Nepietiek spēlētāju" });
    startGame(room);
    cb?.({ ok: true });
  });

  // uzbrukuma kārts
  socket.on("card:attack", ({ code, card } = {}, cb) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "attack") return cb?.({ ok: false });
    const me = playerBySocket(room, socket.id);
    if (!me || me.seat !== room.attackerSeat) return cb?.({ ok: false });

    // ja nav “piemest” ranku – atļauts tikai pirmajai kārtij
    if (room.table.length > 0) {
      refreshLimitRanks(room);
      if (!room.limitRanks.has(card.rank))
        return cb?.({ ok: false, error: "Šo rangu nevar piemest" });
    }
    // izņem no rokas
    const idx = me.hand.findIndex((c) => c.code === card.code);
    if (idx === -1) return cb?.({ ok: false });
    const put = me.hand.splice(idx, 1)[0];
    room.table.push({ attack: put, defend: null });
    refreshLimitRanks(room);
    emitState(room);
    cb?.({ ok: true });
    maybeBotMove(room);
  });

  // aizsardzības kārts
  socket.on("card:defend", ({ code, attackCode, defendCard } = {}, cb) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "attack") return cb?.({ ok: false });
    const me = playerBySocket(room, socket.id);
    if (!me || me.seat !== room.defenderSeat) return cb?.({ ok: false });

    const pair = room.table.find((p) => p.attack && p.attack.code === attackCode && !p.defend);
    if (!pair) return cb?.({ ok: false, error: "Nav atbilstoša uzbrukuma" });

    // vai drīkst nosist
    if (!canBeat(pair.attack, defendCard, room.trumpSuit))
      return cb?.({ ok: false, error: "Nevar nosist" });

    const idx = me.hand.findIndex((c) => c.code === defendCard.code);
    if (idx === -1) return cb?.({ ok: false });
    pair.defend = me.hand.splice(idx, 1)[0];
    emitState(room);
    cb?.({ ok: true });

    // ja viss nosists un uzbrucējs nepievieno – beidzam raundu
    const allBeaten = room.table.length > 0 && room.table.every((p) => p.defend);
    if (allBeaten) {
      setTimeout(() => endRound(room, false), 400);
    } else {
      maybeBotMove(room);
    }
  });

  // aizstāvis “Paņem”
  socket.on("turn:take", ({ code } = {}, cb) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "attack") return cb?.({ ok: false });
    const me = playerBySocket(room, socket.id);
    if (!me || me.seat !== room.defenderSeat) return cb?.({ ok: false });

    endRound(room, true);
    cb?.({ ok: true });
  });

  // uzbrucējs “Gājiens beigts” (kad vairs nepievieno)
  socket.on("turn:end", ({ code } = {}, cb) => {
    const room = rooms.get(code);
    if (!room || room.phase !== "attack") return cb?.({ ok: false });
    const me = playerBySocket(room, socket.id);
    if (!me || me.seat !== room.attackerSeat) return cb?.({ ok: false });

    // ja ir kāds nenosists uzbrukums – nevar beigt
    if (room.table.some((p) => p.attack && !p.defend))
      return cb?.({ ok: false, error: "Nav viss nosists" });

    endRound(room, false);
    cb?.({ ok: true });
  });

  socket.on("disconnect", () => {
    // izņem spēlētāju no istabas
    for (const [code, room] of rooms.entries()) {
      const before = room.players.length;
      room.players = room.players.filter((p) => p.socketId !== socket.id);
      if (room.players.length !== before) {
        // iztīri tukšas sēdvietas
        room.seats = room.seats.filter((seat) =>
          room.players.some((p) => p.seat === seat)
        );
        if (room.players.length === 0) {
          rooms.delete(code);
        } else {
          emitState(room);
        }
      }
    }
  });
});

server.listen(PORT, () => {
  console.log("Duraks Online server running on", PORT);
});
