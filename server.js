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

const rooms = new Map();

const ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const rc = () => Array.from({ length: 4 }, () => ABC[Math.floor(Math.random() * ABC.length)]).join("");

function createDeck(deckSize) {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks36 = ["6","7","8","9","10","J","Q","K","A"];
  const extra = ["2","3","4","5"];
  const base = [];
  for (const s of suits) for (const r of ranks36) base.push({ r, s });
  if (deckSize === 52) for (const r of extra) for (const s of suits) base.push({ r, s });
  for (let i = base.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [base[i], base[j]] = [base[j], base[i]];
  }
  return base;
}

function lowestTrumpIndex(hand, trumpSuit) {
  const order = ["6","7","8","9","10","J","Q","K","A","2","3","4","5"];
  let idx = -1, best = 999;
  hand.forEach((c, i) => {
    if (c.s === trumpSuit) {
      const score = order.indexOf(c.r);
      if (score < best) { best = score; idx = i; }
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
    trump: null,
    stock: 0,
    table: [],
    attacker: null,
    defender: null,
  };
  rooms.set(code, room);
  return room;
}

function dealUpTo6(room) {
  for (const p of room.players) {
    while (p.hand.length < 6 && room.deck.length) p.hand.push(room.deck.pop());
  }
  room.stock = room.deck.length;
}

function emitState(room) {
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
      hand: p.id === room.attacker || p.id === room.defender ? p.hand : []
    }))
  });
}

// DEBUG – atklāt rokas (tikai testiem)
function emitStateDebug(room) {
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
      hand: p.hand
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

  // SOLO tests – pievieno BOT, lai var testēt viens pats
  sock.on("room.solo", ({ room }, ack) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r) return ack?.({ ok:false, error:"no-room" });
    if (r.players.length >= 2) return ack?.({ ok:true });
    r.players.push({ id: `bot:${r.code}`, nick: "BOT", hand: [] });
    io.to(r.code).emit("room.update", { players: r.players.map(p=>({id:p.id, nick:p.nick})) });
    ack?.({ ok:true });
  });

  // START
  sock.on("game.start", ({ room }, ack) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r || r.players.length < 2) { ack?.({ok:false}); return; }
    r.deck = createDeck(r.deckSize);
    r.trump = r.deck[0];
    dealUpTo6(r);

    const [p1, p2] = r.players;
    const tSuit = r.trump.s;
    const i1 = lowestTrumpIndex(p1.hand, tSuit);
    const i2 = lowestTrumpIndex(p2.hand, tSuit);
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

  // DEBUG – atklāt rokas (aktivizē frontē ar ?debug)
  sock.on("game.debugReveal", ({ room }) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r) return;
    emitStateDebug(r);
  });

  sock.on("game.take", ({ room }) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r) return;
    const def = r.players.find(p => p.id === r.defender);
    r.table.forEach(pair => { def.hand.push(pair.atk); if (pair.def) def.hand.push(pair.def); });
    r.table = [];
    dealUpTo6(r);
    r.phase = "attack";
    emitState(r);
  });

  sock.on("game.endAttack", ({ room }) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r) return;
    r.table = [];
    dealUpTo6(r);
    const oldAtk = r.attacker;
    r.attacker = r.defender;
    r.defender = oldAtk;
    r.phase = "attack";
    emitState(r);
  });

  sock.on("chat", ({ room, msg }) => {
    const r = rooms.get((room || "").toUpperCase());
    if (!r) return;
    const p = r.players.find(x => x.id === sock.id);
    io.to(r.code).emit("chat", { nick: p ? p.nick : "?", msg: String(msg).slice(0,300) });
  });

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

app.use(express.static(__dirname));
app.get("/", (_req,res)=>res.sendFile(path.join(__dirname,"index.html")));

httpServer.listen(PORT, ()=>console.log("Duraks Online on", PORT));
