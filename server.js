import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] },
  path: "/socket.io"
});

const PORT = process.env.PORT || 3001;

/* ---------- Helpers ---------- */
const SUITS = ["♠","♣","♦","♥"];
const RANKS52 = ["6","7","8","9","10","J","Q","K","A","2","3","4","5"]; // augšā, ja gribi 52 secību
const RANKS36 = ["6","7","8","9","10","J","Q","K","A"];

function buildDeck(deckSize, trumpSuit) {
  const ranks = deckSize === 36 ? RANKS36 : RANKS52;
  const deck = [];
  for (const s of SUITS) {
    for (const r of ranks) {
      deck.push(makeCard(r, s, trumpSuit));
    }
  }
  // sajaucam
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function makeCard(rank, suit, trumpSuit) {
  const order = {"6":1,"7":2,"8":3,"9":4,"10":5,"J":6,"Q":7,"K":8,"A":9,"2":10,"3":11,"4":12,"5":13};
  return {
    id: `${rank}${suit}-${Math.random().toString(36).slice(2,7)}`,
    rank,
    suit,
    value: order[rank] || 1,
    trump: suit === trumpSuit
  };
}
function beats(card, target, trumpSuit) {
  if (!target) return false;
  if (card.suit === target.suit && card.value > target.value) return true;
  if (card.suit !== target.suit && card.suit === trumpSuit && !target.trump) return true;
  return false;
}
function ranksOnTable(room) {
  const set = new Set();
  for (const p of room.table) {
    if (p.attack) set.add(p.attack.rank);
    if (p.defend) set.add(p.defend.rank);
  }
  return set;
}
function visibleTableCount(room) {
  return room.table.filter(p => p.attack && !p.defend).length;
}
function handOf(room, id){ return room.hands[id] || []; }
function removeFromHand(room, id, cardId){
  const h = handOf(room, id);
  const idx = h.findIndex(c => c.id === cardId);
  if (idx !== -1) h.splice(idx,1);
}
function pushLog(room, text){ room.log.push(text); if (room.log.length>100) room.log.shift(); }
function pushState(room){
  const payload = {
    code: room.code,
    phase: room.phase,
    trump: room.trumpSuit,
    stock: room.stock.length,
    turnId: room.turnId,
    attackerId: room.attackerId,
    defenderId: room.defenderId,
    players: Object.fromEntries(Object.entries(room.players).map(([id,p])=>[id,{nick:p.nick,isBot:p.isBot||false}])),
    you: null, // aizpildām `connection` pusē
    table: room.table,
    handsCount: Object.fromEntries(Object.keys(room.players).map(id => [id, handOf(room,id).length])),
    canThrowLimit: Math.max(0, Math.min(handOf(room, room.defenderId).length - visibleTableCount(room), 6)),
    log: room.log
  };
  // individuāli nosūtām lombas/rokas
  for (const id of Object.keys(room.players)) {
    const pl = room.players[id];
    payload.you = { id, nick: pl.nick, isBot: !!pl.isBot };
    payload.hand = handOf(room, id);
    io.to(id).emit("state", payload);
  }
}
function dealUpTo6(room){
  const order = [room.attackerId, room.defenderId];
  for (const id of order) {
    while (handOf(room, id).length < 6 && room.stock.length) {
      handOf(room, id).push(room.stock.pop());
    }
  }
}
function burnTable(room){
  room.table = [];
}
function nextRolesAfterDefended(room){
  // visi pāri nosisti -> izmetam, iedodam līdz 6, maiņa lomām
  burnTable(room);
  dealUpTo6(room);
  // maiņa lomām
  const oldAtt = room.attackerId;
  room.attackerId = room.defenderId;
  room.defenderId = oldAtt;
  room.turnId = room.attackerId;
  room.phase = "attack";
}
function afterTake(room){
  // aizstāvis paņem visas kārtis, uzbrucējs paliek uzbrucējs nākamajā gājienā
  const defender = room.defenderId;
  for (const p of room.table) {
    if (p.attack) handOf(room, defender).push(p.attack);
    if (p.defend) handOf(room, defender).push(p.defend);
  }
  burnTable(room);
  dealUpTo6(room);
  room.turnId = room.attackerId;
  room.phase = "attack";
}

/* ---------- Rooms ---------- */
const rooms = new Map(); // code -> room

function newRoom(code, deckSize, creatorId, nick) {
  const trumpSuit = SUITS[Math.floor(Math.random()*4)];
  const stock = buildDeck(deckSize, trumpSuit);
  const room = {
    code,
    deckSize,
    trumpSuit,
    players: {},
    hands: {},
    stock,
    table: [],
    attackerId: null,
    defenderId: null,
    turnId: null,
    phase: "attack", // starta fāze
    log: []
  };
  // pievieno pirmo spēlētāju
  room.players[creatorId] = {nick, isBot:false};
  room.hands[creatorId] = [];
  rooms.set(code, room);
  return room;
}
function addPlayer(room, id, nick, isBot=false){
  room.players[id] = {nick, isBot};
  room.hands[id] = room.hands[id] || [];
}
function startIfReady(room){
  const ids = Object.keys(room.players).filter(id=>!room.players[id].isBot || room.players[id].isBot);
  if (ids.length >= 2 && !room.attackerId) {
    // izvēlamies uzbrucēju/ aizstāvi
    const [A,B] = ids.slice(0,2);
    room.attackerId = A;
    room.defenderId = B;
    room.turnId = room.attackerId;
    // iedodam pa 6
    dealUpTo6(room);
    pushLog(room, `Spēle sākta. Trumpis: ${room.trumpSuit}`);
  }
}

/* ---------- BOT ---------- */
function isBot(room, id){ return !!room.players[id]?.isBot; }

function botAct(room){
  // drošībai – ja istaba pazudusi vai nav botu
  if (!room) return;
  const actor = room.turnId;
  if (!isBot(room, actor)) return;
  setTimeout(()=> {
    // BOT stratēģija (vienkārša, bet korekta):
    if (room.phase === "attack") {
      const h = handOf(room, actor).slice().sort((a,b)=>(a.trump-b.trump)|| (a.value-b.value));
      // pirmais gājiens – var likt jebkuru; vēlāk – piemest drīkst tikai rangu kas uz galda
      const ranksSet = ranksOnTable(room);
      const canThrow = Math.max(0, Math.min(handOf(room, room.defenderId).length - visibleTableCount(room), 6));
      let chosen = [];
      for (const c of h) {
        if (room.table.length===0 || ranksSet.has(c.rank)){
          chosen.push(c);
          break;
        }
      }
      if (chosen.length && canThrow>0) {
        doAttack(room, actor, chosen.map(c=>c.id));
      } else {
        // neko neliek -> beidz metienu (ja jau ir kas uzlikts)
        if (room.table.length>0) {
          endAttack(room, actor);
        } else {
          // ja nav ko likt pirmajā gājienā (reti), padod gājienu (nav standarta durak, bet lai nestāv)
          endAttack(room, actor);
        }
      }
    } else if (room.phase==="defend") {
      // aizstāvis (BOT) mēģina nosist minimāli
      const targets = room.table.map((p,i)=>({i,p})).filter(x=>x.p.attack && !x.p.defend);
      let moved = false;
      for (const t of targets) {
        const h = handOf(room, actor).slice().sort((a,b)=>(a.trump-b.trump)|| (a.value-b.value));
        let card = h.find(c=>beats(c, t.p.attack, room.trumpSuit));
        if (card) {
          doDefend(room, actor, [{attackIndex:t.i, cardId:card.id}]);
          moved = true;
        } else {
          // nevar nosist -> paņem
          takeCards(room, actor);
          moved = true;
          break;
        }
      }
      if (moved) return;
      // ja viss bija nosists un mēs esam aizstāvis, vienkārši gaidām uzbrucēja "beigt metienu"
    }
  }, 400); // neliels delays, lai redzama animācija
}

/* ---------- Core actions with validation ---------- */

// *** ŠEIT IR TAVA PIEPRASĪTĀ IZMAIŅA ***
// Uzbrucējs drīkst "piemest" arī fāzē "defend", ja gājiens ir uzbrucējam.
function canAttackerAct(room, socketId){
  return room.turnId === socketId && (room.phase === "attack" || room.phase === "defend");
}

function doAttack(room, playerId, cardIds){
  if (!canAttackerAct(room, playerId)) return;
  if (!cardIds?.length) return;

  // limits: nevar vairāk par aizstāvja rokas atlikumu
  const limit = Math.max(0, Math.min(handOf(room, room.defenderId).length - visibleTableCount(room), 6));
  const take = Math.min(limit, cardIds.length);
  const selected = [];
  const ranksSet = ranksOnTable(room);
  const isFirst = room.table.length === 0;

  for (const id of cardIds) {
    if (selected.length>=take) break;
    const c = handOf(room, playerId).find(x=>x.id===id);
    if (!c) continue;
    // pirmais gājiens – jebkura, piemest – tikai rindas no galda
    if (isFirst || ranksSet.has(c.rank)) {
      selected.push(c);
    }
  }
  if (!selected.length) return;

  for (const c of selected) {
    removeFromHand(room, playerId, c.id);
    room.table.push({attack:c, defend:null});
  }
  room.phase = "defend";
  room.turnId = room.defenderId;
  pushLog(room, `${room.players[playerId].nick} uzbrūk ar ${selected.map(c=>c.rank+c.suit).join(", ")}`);
  pushState(room);
  botAct(room);
}
function doDefend(room, playerId, pairs){
  if (room.turnId !== playerId || room.phase!=="defend") return;
  if (!pairs?.length) return;
  const trump = room.trumpSuit;
  for (const p of pairs) {
    const row = room.table[p.attackIndex];
    if (!row || row.defend || !row.attack) continue;
    const c = handOf(room, playerId).find(x=>x.id===p.cardId);
    if (!c) continue;
    if (!beats(c, row.attack, trump)) continue; // nav derīga
    removeFromHand(room, playerId, c.id);
    row.defend = c;
  }
  pushLog(room, `${room.players[playerId].nick} aizstāvas.`);
  pushState(room);
  // ja viss nosists – gājiens atpakaļ uzbrucējam (piemest vai beigt metienu)
  if (room.table.every(r=>r.attack && r.defend)) {
    room.turnId = room.attackerId;
    room.phase  = "defend"; // paliek "defend" – bet uzbrucējs var piemest (mūsu labojums), vai beigt metienu
    pushState(room);
    botAct(room);
  }
}
function endAttack(room, playerId){
  if (room.turnId !== playerId) return;
  // beigt metienu drīkst tikai uzbrucējs
  if (playerId !== room.attackerId) return;
  // ja nav aizstāvēto pāru – nav ko beigt
  if (!room.table.length) return;
  // ja ir nenosisti uzbrukumi – vēl nevar beigt
  if (room.table.some(r=>r.attack && !r.defend)) return;

  pushLog(room, `${room.players[playerId].nick} beidz metienu.`);
  nextRolesAfterDefended(room);
  pushState(room);
  botAct(room);
}
function takeCards(room, playerId){
  if (room.turnId !== playerId || playerId !== room.defenderId) return;
  pushLog(room, `${room.players[playerId].nick} paņem kārtis.`);
  afterTake(room);
  pushState(room);
  botAct(room);
}

/* ---------- Sockets ---------- */
io.on("connection", (socket) => {
  // room-code <-> client piesaiste
  socket.on("createRoom", ({nick, deckSize, soloBot})=>{
    const code = Math.random().toString(36).slice(2,6).toUpperCase();
    const room = newRoom(code, deckSize||52, socket.id, nick||"Spēlētājs");
    socket.join(code);
    pushLog(room, `${nick} izveido istabu ${code}.`);
    // ja solo – pievieno BOT
    if (soloBot) {
      const botId = `${code}-BOT`;
      addPlayer(room, botId, "BOT", true);
      startIfReady(room);
    }
    startIfReady(room);
    pushState(room);
    botAct(room);
  });

  socket.on("joinRoom", ({nick, code})=>{
    const room = rooms.get((code||"").toUpperCase());
    if (!room) return;
    addPlayer(room, socket.id, nick||"Spēlētājs");
    socket.join(room.code);
    pushLog(room, `${nick} pievienojas ${room.code}.`);
    startIfReady(room);
    pushState(room);
    botAct(room);
  });

  socket.on("attack", ({cardIds})=>{
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    doAttack(room, socket.id, cardIds);
  });
  socket.on("defend", ({pairs})=>{
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    doDefend(room, socket.id, pairs);
  });
  socket.on("endAttack", ()=>{
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    endAttack(room, socket.id);
  });
  socket.on("take", ()=>{
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    takeCards(room, socket.id);
  });

  socket.on("chat", (msg)=>{
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    pushLog(room, `💬 ${room.players[socket.id]?.nick||"?"}: ${msg}`);
    pushState(room);
  });

  socket.on("disconnect", ()=>{
    const room = findRoomBySocket(socket.id);
    if (!room) return;
    pushLog(room, `${room.players[socket.id]?.nick || "Spēlētājs"} atvienojas.`);
    delete room.players[socket.id];
    delete room.hands[socket.id];
    // ja paliek 1 spēlētājs/bot – spēle turpinās, ja nav vispār – istabu dzēšam
    if (Object.keys(room.players).length === 0) {
      rooms.delete(room.code);
    } else {
      pushState(room);
    }
  });
});

function findRoomBySocket(id){
  for (const r of rooms.values()) if (r.players[id]) return r;
  return null;
}

server.listen(PORT, () => console.log(`Server running on :${PORT}`));
