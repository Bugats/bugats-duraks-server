// server.js — Duraks Online (Bugats Edition)
// Node 18+, Express + Socket.IO
// Auto-idle: TIKAI "Gājiens beigts" pēc 6s, ja viss nosists un neviens nepievieno.
// NAV auto-"Paņemt" pēc 6s (pēc lietotāja prasības: "5. ņem ārā").

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ====== Util ======
function randInt(n) { return Math.floor(Math.random() * n); }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const ORD36 = ['6','7','8','9','10','J','Q','K','A'];
const ORD52 = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
function rankOrder(rank, use52) {
  const A = use52 ? ORD52 : ORD36;
  return A.indexOf(rank);
}

function sortByStrength(trumpSuit, use52) {
  return (a, b) => {
    const ta = (a.suit === trumpSuit), tb = (b.suit === trumpSuit);
    if (ta && !tb) return 1;
    if (!ta && tb) return -1;
    return rankOrder(a.rank, use52) - rankOrder(b.rank, use52);
  };
}
function canBeat(att, def, trumpSuit, use52) {
  const same = def.suit === att.suit;
  const trumped = def.suit === trumpSuit && att.suit !== trumpSuit;
  if (trumped) return true;
  if (!same) return false;
  return rankOrder(def.rank, use52) > rankOrder(att.rank, use52);
}

// ====== Kavas ======
function buildDeck(use52) {
  const suits = ['♠','♥','♦','♣'];
  const ranks = use52 ? ORD52 : ORD36;
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({suit:s, rank:r, id:`${r}${s}`});
  return shuffle(deck);
}

// ====== Telpas/istabas ======
const ROOMS = new Map(); // key -> room

function newRoom(code, use52=false) {
  return {
    code,
    seats: Array.from({length:6}, () => ({ id:null, name:null, isBot:false, hand:[] })), // sockets maposim atsevišķi
    game: null,
    _idleTimer: null
  };
}

function broadcast(room, event, payload={}) {
  io.to(room.code).emit(event, payload);
}

function seatOf(room, socketId) {
  return room.seats.findIndex(s => s.id === socketId);
}
function getNextSeat(room, from, onlyOccupied=true) {
  for (let k=1;k<=6;k++){
    const i = (from + k) % 6;
    if (!onlyOccupied) return i;
    if (room.seats[i].id || room.seats[i].isBot) return i;
  }
  return from;
}

function fillBotsIfSolo(room, solo) {
  // solo režīms - vieta 2 būs BOT (īstajai spēlei vari izslēgt)
  if (!solo) return;
  if (!room.seats[1].id && !room.seats[1].isBot) {
    room.seats[1].isBot = true;
    room.seats[1].name = 'BOT';
  }
}

// ====== Spēles stāvoklis ======
function newGame(use52, seats) {
  const deck = buildDeck(use52);
  const trump = deck[deck.length-1].suit;
  const hands = seats.map(s => []);
  // sākumam 6 kārtis katram sēdošajam
  for (let r=0;r<6;r++){
    for (let i=0;i<seats.length;i++){
      if ((seats[i].id || seats[i].isBot) && deck.length) hands[i].push(deck.pop());
    }
  }
  // ieliekam rokās
  for (let i=0;i<seats.length;i++){
    if (seats[i].id || seats[i].isBot) seats[i].hand = hands[i];
  }
  // atrast zemāko trumpi startam
  let start = 0;
  let minIdx = Infinity;
  for (let i=0;i<seats.length;i++){
    if (!seats[i].id && !seats[i].isBot) continue;
    const idx = seats[i].hand.reduce((m,c)=> c.suit===trump ? Math.min(m, rankOrder(c.rank,use52)) : m, Infinity);
    if (idx < minIdx) { minIdx = idx; start = i; }
  }
  const defender = getNextSeat({seats}, start, true);

  return {
    use52,
    deck,
    trumpSuit: trump,
    table: [], // {attack:card, defense:card|null}
    attackerSeat: start,
    defenderSeat: defender,
    turnPhase: 'attack', // 'attack' | 'defend'
    winners: []
  };
}

// ====== IDLE TAIMERIS (tikai auto END TURN) ======
function clearIdleTimer(room) {
  if (room._idleTimer) { clearTimeout(room._idleTimer); room._idleTimer=null; }
}

function armIdleTimer(room) {
  clearIdleTimer(room);
  const g = room.game;
  if (!g) return;

  const tableHas = g.table && g.table.length>0;
  // auto beigts tikai, ja viss uz galda ir NOSISTS un neviens nepievieno
  const waitingToEnd = g.turnPhase==='attack' && tableHas && g.table.every(p=>!!p.defense);
  if (!waitingToEnd) return;

  room._idleTimer = setTimeout(()=>handleIdleEnd(room), 6000);
}
function handleIdleEnd(room) {
  const g = room.game; if (!g) return;
  const okToEnd = g.turnPhase==='attack' && g.table.length>0 && g.table.every(p=>!!p.defense);
  if (!okToEnd) return;
  performEndTurn(room);
  touchRoom(room);
}

// kopēja "pieskāriens" — pārrēķina idle timer
function touchRoom(room) {
  clearIdleTimer(room);
  armIdleTimer(room);
  broadcastState(room);
}

// ====== BOT ======
function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }
function chooseAttackCard(hand, trump, ranksOnTable, use52){
  const nonT = hand.filter(c=>c.suit!==trump).sort(sortByStrength(trump,use52));
  const tr = hand.filter(c=>c.suit===trump).sort(sortByStrength(trump,use52));
  if (!ranksOnTable || ranksOnTable.size===0) return nonT[0]||tr[0]||null;
  const cand = hand.filter(c=>ranksOnTable.has(c.rank)).sort(sortByStrength(trump,use52))[0];
  return cand || null;
}
function chooseDefenseCard(hand, attack, trump, use52){
  const cand = hand.filter(c=>canBeat(attack,c,trump,use52)).sort(sortByStrength(trump,use52));
  return cand[0]||null;
}

async function botAct(room){
  const g = room.game; if (!g) return;
  // atrodam kurš BOT vispār jāspēlē
  const seatId = (g.turnPhase==='attack') ? g.attackerSeat : g.defenderSeat;
  const seat = room.seats[seatId];
  if (!seat || !seat.isBot) return;

  await wait(650); // dabiskums

  const use52 = g.use52;
  if (g.turnPhase==='attack') {
    const tableEmpty = g.table.length===0;
    if (tableEmpty) {
      const card = chooseAttackCard(seat.hand, g.trumpSuit, null, use52);
      if (card) performAttack(room, seatId, [card]);
    } else {
      // mēģina piemest
      const ranks = new Set();
      g.table.forEach(p=>{ if(p.attack)ranks.add(p.attack.rank); if(p.defense)ranks.add(p.defense.rank); });
      const add = chooseAttackCard(seat.hand, g.trumpSuit, ranks, use52);
      if (add) performAttackerAdd(room, seatId, [add]);
      else performEndTurn(room);
    }
  } else {
    const idx = g.table.findIndex(p=>!p.defense);
    if (idx===-1) return;
    const att = g.table[idx].attack;
    const card = chooseDefenseCard(seat.hand, att, g.trumpSuit, use52);
    if (card) performDefend(room, seatId, idx, card);
    // NAV auto "paņemt" – ja BOT nevar nosist, viņš vienkārši klusēs līdz spēlētājs izlems (kā prasīts: 5. ņem ārā)
  }

  touchRoom(room);
}

// ====== Spēles darbības ======
function takeFromHand(hand, cardId) {
  const i = hand.findIndex(c=>c.id===cardId);
  if (i===-1) return null;
  return hand.splice(i,1)[0];
}
function dealUpToSix(room) {
  const g = room.game; if(!g) return;
  // pievelkam uzbrucējam -> citiem pulksteņrādītāja virzienā līdz 6
  const order = [];
  let i = g.attackerSeat;
  for (let k=0;k<6;k++){ order.push(i); i=(i+1)%6; }
  for (const s of order) {
    const seat = room.seats[s];
    if (!seat.id && !seat.isBot) continue;
    while (seat.hand.length<6 && g.deck.length) seat.hand.push(g.deck.pop());
  }
}

function collectRanksOnTable(g){
  const s = new Set();
  g.table.forEach(p=>{ if(p.attack) s.add(p.attack.rank); if(p.defense) s.add(p.defense.rank); });
  return s;
}

function performAttack(room, seatId, cards) {
  const g = room.game; if(!g) return;
  if (g.turnPhase!=='attack' || seatId!==g.attackerSeat) return;
  const ranks = collectRanksOnTable(g);
  const seat = room.seats[seatId];
  for (const c of cards) {
    const card = takeFromHand(seat.hand, c.id||c);
    if (!card) continue;
    if (g.table.length>0 && !ranks.has(card.rank)) { // uz piemest neder ja nav esoša ranga (pirmajai kārtij vienmēr ok)
      seat.hand.push(card); // atpakaļ
      continue;
    }
    g.table.push({ attack:card, defense:null });
  }
  // pēc pirmā uzbrukuma aizstāvis spēlē
  g.turnPhase = 'defend';
  touchRoom(room);
  botAct(room);
}
function performAttackerAdd(room, seatId, cards) {
  const g = room.game; if(!g) return;
  if (g.turnPhase!=='attack') return;
  const seat = room.seats[seatId];
  const ranks = collectRanksOnTable(g);
  for (const c of cards) {
    const card = takeFromHand(seat.hand, c.id||c);
    if (!card) continue;
    if (!ranks.has(card.rank)) { seat.hand.push(card); continue; }
    g.table.push({attack:card, defense:null});
  }
  touchRoom(room);
  botAct(room);
}
function performDefend(room, seatId, pairIndex, cardLike) {
  const g = room.game; if(!g) return;
  if (g.turnPhase!=='defend' || seatId!==g.defenderSeat) return;
  const seat = room.seats[seatId];
  const pair = g.table[pairIndex]; if (!pair || pair.defense) return;
  const card = takeFromHand(seat.hand, cardLike.id||cardLike);
  if (!card) return;
  if (!canBeat(pair.attack, card, g.trumpSuit, g.use52)) {
    // neder -> atpakaļ rokā
    seat.hand.push(card);
    return;
  }
  pair.defense = card;

  // ja viss nosists -> automātiska fāzes maiņa uz “attack” (piemest fāze)
  if (g.table.every(p=>!!p.defense)) {
    g.turnPhase = 'attack'; // atkal uzbrucēju puse var lemt piemest/“Gājiens beigts”
  }
  touchRoom(room);
  botAct(room);
}
function performTake(room, seatId) {
  const g = room.game; if(!g) return;
  const seat = room.seats[seatId];
  // paņem VISU no galda
  for (const p of g.table) {
    if (p.attack) seat.hand.push(p.attack);
    if (p.defense) seat.hand.push(p.defense);
  }
  g.table = [];
  // Pēc paņemšanas uzbrucējs un aizstāvis rotē: aizstāvis kļūst par uzbrucēju
  g.attackerSeat = seatId;
  g.defenderSeat = getNextSeat(room, g.attackerSeat, true);
  g.turnPhase = 'attack';
  dealUpToSix(room);
  touchRoom(room);
  botAct(room);
}
function performEndTurn(room) {
  const g = room.game; if(!g) return;
  // Noslaucām galdu (viss bija nosists)
  g.table = [];
  // Attacker -> nākamais (pulksteņr.)
  g.attackerSeat = getNextSeat(room, g.attackerSeat, true);
  g.defenderSeat = getNextSeat(room, g.attackerSeat, true);
  g.turnPhase = 'attack';
  // Pievelkam kārtis
  dealUpToSix(room);
  touchRoom(room);
  botAct(room);
}

// ====== State broadcast ======
function publicSeat(seat) {
  return {
    name: seat.name,
    isBot: seat.isBot,
    count: seat.hand.length
  };
}
function payloadFor(room) {
  const g = room.game || null;
  return {
    code: room.code,
    seats: room.seats.map(publicSeat),
    game: g ? {
      trumpSuit: g.trumpSuit,
      turnPhase: g.turnPhase,
      attackerSeat: g.attackerSeat,
      defenderSeat: g.defenderSeat,
      table: g.table.map(p => ({
        attack: p.attack ? {rank:p.attack.rank, suit:p.attack.suit, id:p.attack.id}: null,
        defense: p.defense ? {rank:p.defense.rank, suit:p.defense.suit, id:p.defense.id}: null
      })),
      deckLeft: g.deck.length,
      use52: g.use52
    } : null
  };
}
function privateHand(room, socketId) {
  const i = seatOf(room, socketId);
  if (i<0) return [];
  return room.seats[i].hand;
}
function broadcastState(room) {
  const base = payloadFor(room);
  // visiem (bez rokām)
  io.to(room.code).emit('state:room', base);
  // katram atsevišķi – roka
  for (const s of room.seats) {
    if (s.id) {
      io.to(s.id).emit('state:hand', s.hand);
    }
  }
}

// ====== Socket.IO ======
io.on('connection', (socket) => {
  // klienta pievienošanās lobby
  socket.on('room:create', ({code, name, deckType, solo}) => {
    // deckType: '36'|'52'
    if (!code || typeof code!=='string') return;
    let room = ROOMS.get(code);
    if (!room) {
      room = newRoom(code);
      ROOMS.set(code, room);
    }
    socket.join(code);
    // ieliek sēdvietā 1 ja brīva
    const free = room.seats.findIndex(s => !s.id && !s.isBot);
    if (free>=0) {
      room.seats[free].id = socket.id;
      room.seats[free].name = name || 'Spēlētājs';
    } else {
      // ja nav brīvu sēdvietu, tikai pievienojamies skatītāja režīmā
    }
    fillBotsIfSolo(room, !!solo);

    // start game
    const use52 = deckType === '52';
    room.game = newGame(use52, room.seats);

    broadcastState(room);
    botAct(room);
  });

  socket.on('room:join', ({code, name}) => {
    const room = ROOMS.get(code);
    if (!room) return;
    socket.join(code);
    const free = room.seats.findIndex(s => !s.id && !s.isBot);
    if (free>=0) {
      room.seats[free].id = socket.id;
      room.seats[free].name = name || 'Spēlētājs';
      broadcastState(room);
    } else {
      // tikai skatītājs
      io.to(socket.id).emit('state:room', payloadFor(room));
      io.to(socket.id).emit('state:hand', []);
    }
  });

  // ——— Spēles darbības ———
  socket.on('game:attack', ({code, cards}) => {
    const room = ROOMS.get(code); if(!room||!room.game) return;
    const seatId = seatOf(room, socket.id); if(seatId<0) return;
    performAttack(room, seatId, cards || []);
  });
  socket.on('game:add', ({code, cards}) => {
    const room = ROOMS.get(code); if(!room||!room.game) return;
    const seatId = seatOf(room, socket.id); if(seatId<0) return;
    performAttackerAdd(room, seatId, cards || []);
  });
  socket.on('game:defend', ({code, pairIndex, card}) => {
    const room = ROOMS.get(code); if(!room||!room.game) return;
    const seatId = seatOf(room, socket.id); if(seatId<0) return;
    performDefend(room, seatId, pairIndex, card);
  });
  socket.on('game:take', ({code}) => {
    const room = ROOMS.get(code); if(!room||!room.game) return;
    const seatId = seatOf(room, socket.id); if(seatId<0) return;
    performTake(room, seatId);
  });
  socket.on('game:endturn', ({code}) => {
    const room = ROOMS.get(code); if(!room||!room.game) return;
    performEndTurn(room);
  });

  socket.on('disconnect', () => {
    for (const room of ROOMS.values()) {
      const i = seatOf(room, socket.id);
      if (i>=0) {
        room.seats[i].id = null;
        room.seats[i].name = null;
        room.seats[i].hand = [];
        broadcastState(room);
      }
    }
  });
});

// ====== Static (ja vajag) ======
app.use(express.static(path.join(__dirname, 'public')));

server.listen(PORT, () => {
  console.log('Duraks server running on', PORT);
});
