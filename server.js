// server.js — Duraks Online (MVP)
// Node 18/20/22 compatible

import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

// ====== CONFIG ======
const PORT = process.env.PORT || 10000;
const ORIGINS = [
  "https://thezone.lv",           // tavs domēns
  "https://www.thezone.lv",
  "http://thezone.lv",
  "http://localhost:3000",        // lokāliem testiem
  "http://127.0.0.1:3000",
];

// ====== APP / IO ======
const app = express();
app.use(cors({ origin: ORIGINS, credentials: true }));
app.get("/", (_, res) => res.type("text/plain").send("Duraks serveris strādā."));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGINS, credentials: true },
  transports: ["websocket"], // tīrs WS — stabilāk caur hostingu
});

// ====== SPĒLES DATU STRUKTŪRA ======
/*
room: {
  code, deckType: 36|52, solo: bool,
  seats: [ {id,name,isBot,hand:[]}, ... 6 ],
  trump: {suit, rank},
  deck: [card...],
  table: [ {attack, defend?}, ... ],
  phase: "lobby"|"attack"|"defend"|"cleanup",
  attackerSeat: n, defenderSeat: n,
  started: bool
}
*/
const rooms = new Map();

const SUITS = ["♠","♥","♦","♣"];
const RANKS36 = ["6","7","8","9","10","J","Q","K","A"];
const RANKS52 = ["2","3","4","5", ...RANKS36]; // pilns
const RANK_ORDER = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const rankVal = (r) => RANK_ORDER.indexOf(r);

function makeDeck(deckType=36){
  const ranks = deckType===36 ? RANKS36 : RANKS52;
  const deck = [];
  for (const s of SUITS) for (const r of ranks) deck.push({suit:s, rank:r, id:`${r}${s}`});
  // shuffle
  for (let i=deck.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  return deck;
}

function draw(room, n=1){
  const out=[];
  for(let i=0;i<n;i++){ const c=room.deck.shift(); if(c) out.push(c); }
  return out;
}
function fillHands(room){
  // aizstāvis pirmais, tad pulkstenim
  const order = seatOrder(room.defenderSeat);
  for(const s of order){
    const seat = room.seats[s-1];
    if(!seat || !seat.id) continue;
    if(seat.hand.length<6){
      seat.hand.push(...draw(room, 6-seat.hand.length));
    }
  }
}
function seatOrder(fromSeat){
  // 1..6
  const arr=[];
  for(let i=0;i<6;i++) arr.push( (fromSeat-1+i)%6 +1 );
  return arr;
}
function nextSeat(n){ return ( (n)%6 ) + 1; }

function canDefend(room, defCard, attCard){
  if(!defCard||!attCard) return false;
  const trump = room.trump.suit;
  if(defCard.suit === attCard.suit){
    return rankVal(defCard.rank) > rankVal(attCard.rank);
  }
  if(defCard.suit === trump && attCard.suit !== trump) return true;
  return false;
}

function legalAddRanks(room){
  // uz galda esošo kāršu rangi
  const ranks=new Set();
  room.table.forEach(p => { ranks.add(p.attack.rank); if(p.defend) ranks.add(p.defend.rank); });
  return ranks;
}

function canAdd(room, card){
  if(room.table.length===0) return false;
  return legalAddRanks(room).has(card.rank);
}

function startRound(room){
  room.phase = "attack";
  // Uzbrucējs — tas, kam mazākā trumpja vērtība sākumā. Vienkāršoti: seat1 => aizstāvis seat2.
  if(!room.attackerSeat || !room.defenderSeat){
    room.attackerSeat = 1;
    room.defenderSeat = nextSeat(room.attackerSeat);
  }
  ioRoomState(room.code);
}

function endTurn(room){
  // ja visi nosisti -> aizmet uzmetuma kārtis, papildini rokas, pāreja
  const allDefended = room.table.length>0 && room.table.every(p => !!p.defend);
  if(allDefended){
    // uz galda visas prom
    room.table = [];
    fillHands(room);
    room.attackerSeat = nextSeat(room.attackerSeat);
    room.defenderSeat = nextSeat(room.defenderSeat);
    room.phase = "attack";
  } else {
    // aizstāvis paņem visas
    const defSeat = room.seats[room.defenderSeat-1];
    const takeCards = [];
    room.table.forEach(p => { takeCards.push(p.attack); if(p.defend) takeCards.push(p.defend); });
    defSeat.hand.push(...takeCards);
    room.table = [];
    fillHands(room);
    // Uzbrukumu dod nākamajam ap aizstāvi
    room.attackerSeat = nextSeat(room.defenderSeat);
    room.defenderSeat = nextSeat(room.attackerSeat);
    room.phase = "attack";
  }
  // izkritušie (bez kārtīm) izkrīt; uzvara, ja palicis 1 vai 0
  for(let i=0;i<6;i++){
    const s = room.seats[i];
    if(s?.id && s.hand.length===0){ s.out = true; }
  }
  const active = room.seats.filter(s => s?.id && !s.out);
  if(active.length<=1){
    room.phase = "finished";
  }
  ioRoomState(room.code);
}

function currentSeat(room){ return room.phase==="defend" ? room.defenderSeat : room.attackerSeat; }

function roomByCode(code){ return rooms.get(code); }

function emitToRoom(room, ev, data){ io.to(room).emit(ev, data); }

function publicState(room){
  // neliekam citu spēlētāju rokas
  const seats = room.seats.map(s => s?.id ? { name:s.name, isBot:!!s.isBot, out:!!s.out, handCount:s.hand.length } : null );
  return {
    code: room.code,
    deckType: room.deckType,
    solo: room.solo,
    seats,
    trump: room.trump,
    deckLeft: room.deck.length,
    table: room.table,
    phase: room.phase,
    attackerSeat: room.attackerSeat,
    defenderSeat: room.defenderSeat,
  };
}
function privateSeatInfo(room, socketId){
  const seatIndex = room.seats.findIndex(s => s?.id === socketId);
  if(seatIndex<0) return null;
  return { seat: seatIndex+1, hand: room.seats[seatIndex].hand };
}
function ioRoomState(code){
  const room = roomByCode(code);
  if(!room) return;
  // visiem — publiskais
  emitToRoom(code, "state:public", publicState(room));
  // katram — privātā roka
  room.seats.forEach((s, i)=>{
    if(s?.id && !s.isBot){
      io.to(s.id).emit("state:private", privateSeatInfo(room, s.id));
    }
  });
  // ja solo un ir bot — lai iet
  maybeBotMove(room);
}

// ===== BOT (ļoti vienkāršs) =====
function botSeat(room){
  const idx = room.seats.findIndex(s=>s?.isBot && !s.out);
  return idx>=0 ? idx+1 : null;
}
function seatByNum(room, n){ return room.seats[n-1]; }

function botAttack(room, seat){
  const s = seatByNum(room, seat);
  if(!s) return false;
  const card = s.hand[0];
  if(!card) return false;
  room.table.push({ attack:card });
  s.hand.splice(0,1);
  room.phase = "defend";
  ioRoomState(room.code);
  return true;
}
function botAdd(room, seat){
  const s = seatByNum(room, seat);
  if(!s) return false;
  const idx = s.hand.findIndex(c => canAdd(room, c));
  if(idx>=0){
    const c = s.hand[idx];
    room.table.push({ attack:c });
    s.hand.splice(idx,1);
    ioRoomState(room.code);
    return true;
  }
  return false;
}
function botDefend(room, seat){
  const s = seatByNum(room, seat);
  if(!s) return false;
  // atrodi pēdējo neapklātu uzbrukumu
  const pair = room.table.find(p => !p.defend);
  if(!pair) return false;
  const idx = s.hand.findIndex(c => canDefend(room, c, pair.attack));
  if(idx>=0){
    pair.defend = s.hand[idx];
    s.hand.splice(idx,1);
    // ja visi nosisti, paliek fāze "defend", līdz nospiedīs End turn (vai uzbrucējs piemetīs)
    ioRoomState(room.code);
    return true;
  }else{
    // paņem
    const defSeat = seatByNum(room, room.defenderSeat);
    const takeCards = [];
    room.table.forEach(p => { takeCards.push(p.attack); if(p.defend) takeCards.push(p.defend); });
    defSeat.hand.push(...takeCards);
    room.table = [];
    fillHands(room);
    room.attackerSeat = nextSeat(room.defenderSeat);
    room.defenderSeat = nextSeat(room.attackerSeat);
    room.phase = "attack";
    ioRoomState(room.code);
    return true;
  }
}

let botTimers = new Map();
function clearBotTimer(code){
  const t = botTimers.get(code);
  if(t){ clearTimeout(t); botTimers.delete(code); }
}
function maybeBotMove(room){
  if(!room?.solo) return;
  clearBotTimer(room.code);
  const bSeat = botSeat(room);
  if(!bSeat) return;
  const cur = currentSeat(room);
  if(cur !== bSeat) return;

  // mazs delays, lai ir "dzīvs" sajūta
  const delay = 600 + Math.random()*600;
  const handle = setTimeout(()=>{
    if(room.phase==="attack") botAttack(room, bSeat);
    else if(room.phase==="defend") botDefend(room, bSeat);
  }, delay);
  botTimers.set(room.code, handle);
}

// ===== IO HANDLERS =====
io.on("connection", (socket)=>{
  socket.on("ping", ()=> socket.emit("pong"));

  socket.on("room:create", ({ name, deckType, solo })=>{
    const code = Math.random().toString(36).slice(2,6).toUpperCase();
    const room = {
      code, deckType: (deckType===52?52:36), solo: !!solo,
      seats: [null,null,null,null,null,null],
      trump: null, deck:[], table:[],
      phase: "lobby", attackerSeat:null, defenderSeat:null, started:false
    };
    rooms.set(code, room);
    socket.join(code);

    // sēdvieta 1 — radītājs
    room.seats[0] = { id: socket.id, name: name||"Spēlētājs", hand:[], isBot:false, out:false };
    // ja solo — bot sēdvietā 2
    if(room.solo){
      room.seats[1] = { id: `BOT:${code}`, name: "BOT", hand:[], isBot:true, out:false };
    }

    ioRoomState(code);
    socket.emit("room:code", code);
  });

  socket.on("seat:join", ({ code, seat, name })=>{
    const room = roomByCode(code); if(!room) return;
    if(seat<1 || seat>6) return;
    const s = room.seats[seat-1];
    if(s && s.id) return; // aizņemta
    // atvienojam no citām sēdvietām
    const prev = room.seats.findIndex(x=>x?.id===socket.id);
    if(prev>=0) room.seats[prev] = null;

    room.seats[seat-1] = { id: socket.id, name: name||`Spēlētājs ${seat}`, hand:[], isBot:false, out:false };
    socket.join(code);
    ioRoomState(code);
  });

  socket.on("game:start", ({ code })=>{
    const room = roomByCode(code); if(!room) return;
    if(room.started) return;
    room.started = true;

    // kāršu kava
    room.deck = makeDeck(room.deckType);
    room.trump = room.deck[room.deck.length-1];
    // pirmais uzbrukums – vienkāršoti: seat1 uzbrūk, seat2 aizstāvas
    room.attackerSeat = 1;
    room.defenderSeat = nextSeat(room.attackerSeat);

    // iedod 6 katram, kam vietā sēž spēlētājs/bots
    for(let i=0;i<6;i++){
      const s = room.seats[i];
      if(s?.id){ s.hand.push(...draw(room,6)); }
    }
    room.phase = "attack";
    ioRoomState(code);
  });

  socket.on("play:attack", ({ code, cards })=>{
    const room = roomByCode(code); if(!room) return;
    if(room.phase!=="attack") return;
    const seatIndex = room.seats.findIndex(s=>s?.id===socket.id);
    if(seatIndex+1 !== room.attackerSeat) return;

    const seat = room.seats[seatIndex];
    if(!Array.isArray(cards)||cards.length===0) return;

    // vairāku kāršu uzbrukums: visiem jābūt vienāda ranga
    const r = cards[0].rank;
    if(!cards.every(c=>c.rank===r)) return;

    // no spēlētāja rokas
    const toPlace=[];
    for(const c of cards){
      const idx = seat.hand.findIndex(h=>h.id===c.id);
      if(idx<0) return;
      toPlace.push(seat.hand[idx]);
    }
    // ja jau ir galda kārtis, piemet tikai tādus pašus rangus
    if(room.table.length>0){
      const allowed = legalAddRanks(room);
      if(!allowed.has(r)) return;
    }
    // liekam pārus ar aizsardzību = null
    for(const c of toPlace){
      room.table.push({ attack: c });
      const i = seat.hand.findIndex(h=>h.id===c.id);
      seat.hand.splice(i,1);
    }
    room.phase = "defend";
    ioRoomState(code);
  });

  socket.on("play:add", ({ code, card })=>{
    const room = roomByCode(code); if(!room) return;
    if(room.phase!=="defend") return; // piemet tikai aizsardzības laikā
    const atkSeat = room.attackerSeat;
    const seatIndex = room.seats.findIndex(s=>s?.id===socket.id);
    if(seatIndex<0) return;
    // piemet var jebkurš, kamēr atļauts (vienk. noteikums)
    const seat = room.seats[seatIndex];
    const idx = seat.hand.findIndex(h=>h.id===card.id);
    if(idx<0) return;
    const c = seat.hand[idx];
    if(!canAdd(room, c)) return;
    room.table.push({ attack:c });
    seat.hand.splice(idx,1);
    ioRoomState(code);
  });

  socket.on("play:defend", ({ code, attackId, defend })=>{
    const room = roomByCode(code); if(!room) return;
    if(room.phase!=="defend") return;
    const seatIndex = room.seats.findIndex(s=>s?.id===socket.id);
    if(seatIndex+1 !== room.defenderSeat) return;

    const seat = room.seats[seatIndex];
    const pair = room.table.find(p=>p.attack.id===attackId && !p.defend);
    if(!pair) return;

    const idx = seat.hand.findIndex(h=>h.id===defend.id);
    if(idx<0) return;
    const c = seat.hand[idx];
    if(!canDefend(room, c, pair.attack)) return;

    pair.defend = c;
    seat.hand.splice(idx,1);
    ioRoomState(code);
  });

  socket.on("turn:take", ({ code })=>{
    const room = roomByCode(code); if(!room) return;
    const seatIndex = room.seats.findIndex(s=>s?.id===socket.id);
    if(seatIndex+1 !== room.defenderSeat) return;

    const defSeat = room.seats[seatIndex];
    const takeCards = [];
    room.table.forEach(p => { takeCards.push(p.attack); if(p.defend) takeCards.push(p.defend); });
    defSeat.hand.push(...takeCards);
    room.table = [];
    fillHands(room);
    room.attackerSeat = nextSeat(room.defenderSeat);
    room.defenderSeat = nextSeat(room.attackerSeat);
    room.phase = "attack";
    ioRoomState(code);
  });

  socket.on("turn:end", ({ code })=>{
    const room = roomByCode(code); if(!room) return;
    // manuāls "Gājiens beigts" — ja visi nosisti vai uzbrucējs vairs nepievieno
    const seatIndex = room.seats.findIndex(s=>s?.id===socket.id);
    // ļaujam jebkuram nospiest, bet loģika pati izlems
    endTurn(room);
  });

  socket.on("disconnect", ()=>{
    // ja kāds iziet — atbrīvo sēdvietu
    for(const [code, room] of rooms){
      const i = room.seats.findIndex(s=>s?.id===socket.id);
      if(i>=0){ room.seats[i]=null; ioRoomState(code); }
    }
  });
});

server.listen(PORT, ()=> console.log("Duraks serveris klausās uz", PORT));
