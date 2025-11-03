import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" }, transports: ["websocket"] });
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));

const rooms = new Map();
const ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const rc = () => Array.from({ length: 4 }, () => ABC[Math.floor(Math.random() * ABC.length)]).join("");
const RANKS = ["6","7","8","9","10","J","Q","K","A","2","3","4","5"]; // 52-deck extra at end for salīdzināšanai

function createDeck(deckSize) {
  const suits = ["♠","♥","♦","♣"];
  const ranks36 = ["6","7","8","9","10","J","Q","K","A"];
  const deck = [];
  for (const s of suits) for (const r of ranks36) deck.push({ r, s });
  if (deckSize === 52) {
    for (const r of ["2","3","4","5"]) for (const s of suits) deck.push({ r, s });
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
const rankVal = (r) => RANKS.indexOf(r);

function cardBeats(a, b, trumpSuit) {
  if (!a || !b) return false;
  if (a.s === b.s) return rankVal(a.r) > rankVal(b.r);
  if (a.s === trumpSuit && b.s !== trumpSuit) return true;
  return false;
}

function lowestTrumpIndex(hand, trumpSuit) {
  let idx = -1, best = 999;
  hand.forEach((c, i) => {
    if (c.s === trumpSuit) {
      const v = rankVal(c.r);
      if (v < best) { best = v; idx = i; }
    }
  });
  return idx;
}

function makeRoom(deckSize) {
  const code = rc();
  const room = {
    code,
    deckSize: deckSize === 52 ? 52 : 36,
    players: [], // {id,nick,hand:[]}
    phase: "wait",
    deck: [],
    trump: null,  // {r,s}
    stock: 0,
    table: [],    // [{atk,def}]
    attacker: null,
    defender: null,
  };
  rooms.set(code, room);
  return room;
}

function dealUpTo6(room) {
  // Uzbrucējs velk pirmais, tad aizstāvis
  const order = [room.attacker, room.defender];
  for (const pid of order) {
    const p = room.players.find(x => x.id === pid);
    if (!p) continue;
    while (p.hand.length < 6 && room.deck.length) p.hand.push(room.deck.pop());
  }
  room.stock = room.deck.length;
}

function allowedAttackRanks(room) {
  const ranks = new Set();
  room.table.forEach(pair => { if (pair.atk) ranks.add(pair.atk.r); if (pair.def) ranks.add(pair.def.r); });
  return ranks;
}

function emitState(room, revealAll=false) {
  io.to(room.code).emit("game.state", {
    phase: room.phase,
    stock: room.stock,
    trump: room.trump,
    attacker: room.attacker,
    defender: room.defender,
    table: room.table,
    players: room.players.map(p => ({
      id: p.id,
      nick: p.nick,
      handCount: p.hand.length,
      hand: revealAll ? p.hand : []
    }))
  });
}

io.on("connection", (sock) => {
  sock.on("room.create", ({ nick, deckSize }, ack) => {
    const r = makeRoom(deckSize);
    r.players.push({ id: sock.id, nick: nick || "Spēlētājs", hand: [] });
    sock.join(r.code);
    sock.emit("room.created", { room: r.code });
    ack?.({ ok: true, room: r.code });
    io.to(r.code).emit("room.update", { players: r.players.map(p=>({id:p.id,nick:p.nick})) });
  });

  sock.on("room.join", ({ nick, room }, ack) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r) { ack?.({ok:false}); io.to(sock.id).emit("error.msg","Istaba neeksistē"); return; }
    if (r.players.length >= 2) { ack?.({ok:false}); io.to(sock.id).emit("error.msg","Istaba pilna"); return; }
    r.players.push({ id: sock.id, nick: nick || "Spēlētājs", hand: [] });
    sock.join(r.code);
    sock.emit("room.joined", { room: r.code, players: r.players.map(p=>({id:p.id,nick:p.nick})) });
    ack?.({ ok:true, room: r.code });
    io.to(r.code).emit("room.update", { players: r.players.map(p=>({id:p.id,nick:p.nick})) });
  });

  // Solo tests (BOT)
  sock.on("room.solo", ({ room }, ack) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r) return ack?.({ ok:false, error:"no-room" });
    if (r.players.length >= 2) return ack?.({ ok:true });
    r.players.push({ id: `bot:${r.code}`, nick: "BOT", hand: [] });
    io.to(r.code).emit("room.update", { players: r.players.map(p=>({id:p.id, nick:p.nick})) });
    ack?.({ ok:true });
  });

  // Start
  sock.on("game.start", ({ room }, ack) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r || r.players.length < 2) { ack?.({ok:false}); return; }
    r.deck = createDeck(r.deckSize);
    r.trump = r.deck[0];
    // trumpa kārts nolikta apakšā (klasiski) — pildīsim no gala
    r.deck.push(r.deck.shift());
    dealUpTo6(r);

    const [p1, p2] = r.players;
    const t = r.trump.s;
    const i1 = lowestTrumpIndex(p1.hand, t);
    const i2 = lowestTrumpIndex(p2.hand, t);
    if (i1 === -1 && i2 === -1) r.attacker = p1.id;
    else if (i1 === -1) r.attacker = p2.id;
    else if (i2 === -1) r.attacker = p1.id;
    else r.attacker = (i1 < i2) ? p1.id : p2.id;
    r.defender = r.players.find(p => p.id !== r.attacker).id;

    r.phase = "attack";
    r.table = [];
    emitState(r);
    ack?.({ ok:true });
  });

  // Attack play
  sock.on("play.attack", ({ room, cardIndex }, ack) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r || r.phase !== "attack" || sock.id !== r.attacker) { ack?.({ok:false}); return; }
    const atk = r.players.find(p=>p.id===r.attacker);
    const def = r.players.find(p=>p.id===r.defender);
    if (!atk || !def) { ack?.({ok:false}); return; }

    // limits
    const limit = def.hand.length;
    const onTable = r.table.length;
    if (onTable >= limit) { ack?.({ok:false}); return; }

    const card = atk.hand[cardIndex];
    if (!card) { ack?.({ok:false}); return; }

    // ja nav pirmā kārts, drīkst mest tikai rangus, kas jau ir uz galda
    if (r.table.length > 0) {
      const allow = allowedAttackRanks(r);
      if (!allow.has(card.r)) { ack?.({ok:false}); return; }
    }

    // izņem no rokas, ieliek galdā kā jaunu pāri
    atk.hand.splice(cardIndex,1);
    r.table.push({ atk: card, def: null });
    emitState(r);
    ack?.({ ok:true });
  });

  // Defend play
  sock.on("play.defend", ({ room, attackIndex, cardIndex }, ack) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r || r.phase !== "attack" || sock.id !== r.defender) { ack?.({ok:false}); return; }
    const def = r.players.find(p=>p.id===r.defender);
    if (!def) { ack?.({ok:false}); return; }
    const pair = r.table[attackIndex];
    if (!pair || pair.def) { ack?.({ok:false}); return; }

    const card = def.hand[cardIndex];
    if (!card) { ack?.({ok:false}); return; }

    if (!cardBeats(card, pair.atk, r.trump.s)) { ack?.({ok:false}); return; }

    def.hand.splice(cardIndex,1);
    pair.def = card;
    emitState(r);
    ack?.({ ok:true });
  });

  // Defender takes
  sock.on("game.take", ({ room }, ack) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r || sock.id !== r.defender) { ack?.({ok:false}); return; }
    const def = r.players.find(p=>p.id===r.defender);
    if (!def) { ack?.({ok:false}); return; }
    r.table.forEach(pair => { def.hand.push(pair.atk); if (pair.def) def.hand.push(pair.def); });
    r.table = [];
    // pēc paņemšanas uzbrucējs paliek uzbrucējs
    dealUpTo6(r);
    r.phase = "attack";
    emitState(r);
    ack?.({ ok:true });
  });

  // Attacker ends attack (only if all covered or tukšs)
  sock.on("game.endAttack", ({ room }, ack) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r || sock.id !== r.attacker) { ack?.({ok:false}); return; }
    // drīkst beigt, ja visas uzbruktās kārtis ir nosegtas vai nav nevienas
    if (r.table.some(p=>!p.def)) { ack?.({ok:false}); return; }

    r.table = [];
    dealUpTo6(r);
    // lomas mainās
    const oldAtk = r.attacker;
    r.attacker = r.defender;
    r.defender = oldAtk;
    r.phase = "attack";
    emitState(r);
    ack?.({ ok:true });
  });

  // Debug
  sock.on("game.debugReveal", ({ room }) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r) return;
    emitState(r, true);
  });

  // Chat
  sock.on("chat", ({ room, msg }) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r) return;
    const p = r.players.find(x => x.id === sock.id);
    io.to(r.code).emit("chat", { nick: p ? p.nick : "?", msg: String(msg).slice(0,300) });
  });

  // Disconnect
  sock.on("disconnect", () => {
    for (const [code, r] of rooms) {
      const i = r.players.findIndex(p=>p.id===sock.id);
      if (i>-1) {
        r.players.splice(i,1);
        io.to(code).emit("room.update", { players: r.players.map(p=>({id:p.id,nick:p.nick})) });
      }
      if (!r.players.length) rooms.delete(code);
    }
  });
});

httpServer.listen(PORT, ()=>console.log("Duraks Online on", PORT));
