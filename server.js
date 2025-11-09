// server.js
// Duraks Online — Bugats Edition (stable)
// Node 18+, "type": "module" NAV vajadzīgs (CommonJS)

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3001;

// --------- Static for quick test ----------
app.use(express.static(path.join(__dirname, './')));

app.get('/health', (_, res) => res.send('ok'));

// ================== GAME STATE ==================
const SUITS = ['♠','♥','♦','♣']; // black: spade/club; red: heart/diamond
const RANKS52 = ['6','7','8','9','10','J','Q','K','A','2','3','4','5']; // flexibility if ever needed
const RANKS36 = ['6','7','8','9','10','J','Q','K','A'];

const rooms = new Map(); // code -> room

function newRoom(code) {
  return {
    code,
    seats: makeSeats(),
    playerSeat: new Map(), // socket.id -> seatId
    game: null,            // active game or null
    winners: [],
  };
}

function makeSeats() {
  const m = new Map();
  for (let i = 0; i < 6; i++) {
    m.set(String(i+1), { id: String(i+1), name: `Sēdvieta ${i+1}`, playerId: null, isBot: false });
  }
  return m;
}

function rankOrder(deckSize) {
  return deckSize === 36 ? RANKS36 : RANKS52;
}

function buildDeck(deckSize) {
  const ranks = rankOrder(deckSize);
  const deck = [];
  for (const s of SUITS) for (const r of ranks) deck.push({ suit: s, rank: r });
  shuffle(deck);
  return deck;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function rankValue(deckSize, rank, suit, trump) {
  const ranks = rankOrder(deckSize);
  const base = ranks.indexOf(rank);
  // trump boost as tiebreaker layer:
  return base + (suit === trump ? 100 : 0);
}

function roomPublicState(room) {
  const seats = {};
  for (const [id, s] of room.seats.entries()) {
    seats[id] = {
      id: s.id,
      name: s.name,
      busy: !!s.playerId,
      isBot: !!s.isBot
    };
  }
  return {
    code: room.code,
    seats,
    winners: room.winners
  };
}

// ================== GAME ==================
function startGame(room, options) {
  // options: { deckSize, solo }
  const deckSize = options.deckSize === 52 ? 52 : 36;
  const seated = [...room.seats.values()].filter(s => s.playerId || s.isBot);

  // Solo režīms: ja viens spēlētājs un solo true -> izveido botu vienā brīvā vietā
  if (options.solo) {
    const players = seated.filter(s => s.playerId);
    if (players.length === 1) {
      const firstFree = [...room.seats.values()].find(s => !s.playerId && !s.isBot);
      if (firstFree) firstFree.isBot = true;
    }
  }

  const finalSeats = [...room.seats.values()].filter(s => s.playerId || s.isBot);
  if (finalSeats.length < 2) return false;

  const deck = buildDeck(deckSize);
  const trumpCard = deck[deck.length - 1];
  const trumpSuit = trumpCard.suit;

  const players = finalSeats.map(s => ({
    pid: s.playerId || `BOT:${room.code}:${s.id}`,
    isBot: !s.playerId,
    seatId: s.id,
    name: s.playerId ? `Spēlētājs ${s.id}` : `BOT`,
    hand: []
  }));

  // do 6 cards to each
  function dealToSix() {
    for (const p of players) {
      while (p.hand.length < 6 && deck.length) p.hand.push(deck.pop());
    }
  }
  dealToSix();

  // Who has the lowest trump begins as attacker
  let attackerIdx = 0;
  let best = Infinity;
  players.forEach((p, idx) => {
    const minTrump = p.hand
      .filter(c => c.suit === trumpSuit)
      .reduce((m, c) => Math.min(m, rankValue(deckSize, c.rank, c.suit, trumpSuit)), Infinity);
    if (minTrump < best) {
      best = minTrump;
      attackerIdx = idx;
    }
  });
  const defenderIdx = (attackerIdx + 1) % players.length;

  room.game = {
    deckSize,
    deck,
    trumpSuit,
    trumpCard,
    players,
    attackerIdx,
    defenderIdx,
    turnPhase: 'attack', // 'attack' | 'defense'
    table: [], // [{attack, defense:null|card}]
    lastChange: Date.now(),
    code: room.code,
    _timer: null
  };
  room.winners = [];

  broadcastState(room);
  scheduleTurnTimer(room);
  return true;
}

function scheduleTurnTimer(room) {
  const g = room.game;
  if (!g) return;
  clearTimeout(g._timer);
  g._timer = setTimeout(() => {
    if (!room.game) return;
    if (Date.now() - g.lastChange >= 6000) {
      endTurn(room, { auto: true });
    } else {
      scheduleTurnTimer(room);
    }
  }, 6000);
}

function setChanged(room) {
  if (!room.game) return;
  room.game.lastChange = Date.now();
  scheduleTurnTimer(room);
}

function addToTable(room, attackerPid, cards) {
  const g = room.game; if (!g) return false;
  if (g.turnPhase !== 'attack') return false;
  const attacker = g.players[g.attackerIdx];
  if (attacker.pid !== attackerPid) return false;

  // validācija: visas viena ranga
  const r = cards[0].rank;
  if (!cards.every(c => c.rank === r)) return false;

  // ja uz galda jau ir rangi — drīkst mest tikai jau esošos rangus
  if (g.table.length) {
    const allowed = new Set();
    g.table.forEach(p => {
      allowed.add(p.attack.rank);
      if (p.defense) allowed.add(p.defense.rank);
    });
    if (!cards.every(c => allowed.has(c.rank))) return false;
  }

  // no rokas izņemam, uz galdu pievienojam kā atsevišķus pārus
  for (const c of cards) {
    const idx = attacker.hand.findIndex(h => h.rank === c.rank && h.suit === c.suit);
    if (idx === -1) return false;
    attacker.hand.splice(idx,1);
    g.table.push({ attack: c, defense: null });
  }

  // ja uzbrucējs izmeta, pārejam uz aizstāšanās fāzi
  g.turnPhase = 'defense';
  setChanged(room);
  broadcastState(room);
  return true;
}

function canBeat(deckSize, trump, a, d) {
  if (d.suit === a.suit) {
    return rankOrder(deckSize).indexOf(d.rank) > rankOrder(deckSize).indexOf(a.rank);
  }
  if (d.suit === trump && a.suit !== trump) return true;
  return false;
}

function defendCard(room, defenderPid, pairIndex, defCard) {
  const g = room.game; if (!g) return false;
  if (g.turnPhase !== 'defense') return false;
  const defender = g.players[g.defenderIdx];
  if (defender.pid !== defenderPid) return false;
  const pair = g.table[pairIndex]; if (!pair) return false;
  if (pair.defense) return false;

  // validācija
  if (!canBeat(g.deckSize, g.trumpSuit, pair.attack, defCard)) return false;

  const idx = defender.hand.findIndex(h => h.rank === defCard.rank && h.suit === defCard.suit);
  if (idx === -1) return false;

  defender.hand.splice(idx, 1);
  pair.defense = defCard;

  setChanged(room);
  broadcastState(room);
  return true;
}

function attackerAdd(room, attackerPid, cards) {
  const g = room.game; if (!g) return false;
  // atļaujam piemest tikai aizstāšanās fāzē, un kartes jābūt tā paša ranga kā uz galda
  if (g.turnPhase !== 'defense') return false;
  const attacker = g.players[g.attackerIdx];
  if (attacker.pid !== attackerPid) return false;
  if (!g.table.length) return false;

  const allowed = new Set();
  g.table.forEach(p => {
    allowed.add(p.attack.rank);
    if (p.defense) allowed.add(p.defense.rank);
  });
  if (!cards.every(c => allowed.has(c.rank))) return false;

  for (const c of cards) {
    const idx = attacker.hand.findIndex(h => h.rank === c.rank && h.suit === c.suit);
    if (idx === -1) return false;
    attacker.hand.splice(idx,1);
    g.table.push({ attack: c, defense: null });
  }
  setChanged(room);
  broadcastState(room);
  return true;
}

function takeAll(room, defenderPid) {
  const g = room.game; if (!g) return false;
  if (g.turnPhase !== 'defense') return false;
  const defender = g.players[g.defenderIdx];
  if (defender.pid !== defenderPid) return false;

  const toTake = [];
  g.table.forEach(p => {
    toTake.push(p.attack);
    if (p.defense) toTake.push(p.defense);
  });
  defender.hand.push(...toTake);
  g.table = [];

  // Nākamais uzbrucējs saglabājas tas pats (defender nākamais aizstāvis)
  g.turnPhase = 'attack';
  g.attackerIdx = g.attackerIdx; // unchanged
  g.defenderIdx = (g.attackerIdx + 1) % g.players.length;

  // iedodam līdz 6
  dealUpToSix(room);
  afterAction(room);
  setChanged(room);
  broadcastState(room);
  return true;
}

function endTurn(room, opts={}) {
  const g = room.game; if (!g) return false;

  // ja uz galda pāri, kam nav aizsardzības — aizstāvis nevar beigt
  if (g.table.some(p => !p.defense)) {
    if (!opts.auto) return false;
  }

  // notīrām galdu “nometē”
  g.table = [];
  // Attacker kļūst nākamais spēlētājs
  g.attackerIdx = (g.attackerIdx + 1) % g.players.length;
  g.defenderIdx = (g.attackerIdx + 1) % g.players.length;
  g.turnPhase = 'attack';

  // iedod līdz 6 (pēc kārtas uzbrucējs -> citi)
  dealUpToSix(room);
  afterAction(room);
  setChanged(room);
  broadcastState(room);
  return true;
}

function dealUpToSix(room) {
  const g = room.game; if (!g) return;
  // dalām no uzbrucēja, tad pulksteņrādītāja virzienā
  const order = [];
  for (let i=0;i<g.players.length;i++){
    order.push((g.attackerIdx + i) % g.players.length);
  }
  for (const i of order) {
    const p = g.players[i];
    while (p.hand.length < 6 && g.deck.length) p.hand.push(g.deck.pop());
  }
}

function afterAction(room) {
  const g = room.game; if (!g) return;
  // uzvarētāji (izkrīt)
  for (const p of g.players) {
    if (p.hand.length === 0 && !room.winners.includes(p.pid)) {
      room.winners.push(p.pid);
      io.to(room.code).emit('game:winnerProgress', winnerNames(room));
    }
  }
  const alive = g.players.filter(p => p.hand.length > 0);
  if (alive.length === 1) {
    room.winners.push(alive[0].pid);
    io.to(room.code).emit('game:finish', winnerNames(room));
    g._timer && clearTimeout(g._timer);
    room.game = null;
  }
}

function winnerNames(room) {
  return room.winners.map(pid => {
    const seat = [...room.seats.values()].find(s => s.playerId === pid || (`BOT:${room.code}:${s.id}`) === pid);
    if (!seat) return '???';
    return seat.playerId ? `Spēlētājs ${seat.id}` : `BOT`;
  });
}

function broadcastState(room) {
  const g = room.game;
  const base = {
    room: roomPublicState(room),
    game: null
  };
  if (!g) {
    io.to(room.code).emit('state', base);
    return;
  }
  // visiem redzamais
  const publicGame = {
    deckSize: g.deckSize,
    trumpSuit: g.trumpSuit,
    trumpCard: g.trumpCard,
    turnPhase: g.turnPhase,
    attackerSeat: g.players[g.attackerIdx].seatId,
    defenderSeat: g.players[g.defenderIdx].seatId,
    table: g.table.map(p => ({ attack: p.attack, defense: p.defense })),
    counts: g.players.map(p => ({ seatId: p.seatId, count: p.hand.length })),
    deckCount: g.deck.length
  };

  // katram atsevišķi — viņa roka
  g.players.forEach(p => {
    const your = JSON.parse(JSON.stringify(publicGame));
    your.yourHand = p.hand;
    io.to(room.code).emit('public', publicGame);
    if (p.isBot) return; // nav socket
    io.to(p.pid).emit('state', { room: roomPublicState(room), game: your });
  });

  // skatītājiem (nepiesēdušies)
  const spectators = [...io.sockets.adapter.rooms.get(room.code) || []]
    .filter(id => !g.players.find(pp => pp.pid === id));
  const specGame = JSON.parse(JSON.stringify(publicGame));
  specGame.yourHand = []; // neko nerādām
  spectators.forEach(id => io.to(id).emit('state', { room: roomPublicState(room), game: specGame }));
}

// ================== SOCKETS ==================
io.on('connection', (socket) => {
  // izveidot / pievienoties istabai (vienkāršs UI variants)
  socket.on('room:create', (code, cb) => {
    if (!code) code = Math.random().toString(36).slice(2,6).toUpperCase();
    if (rooms.has(code)) return cb?.({ ok:false, error:'Istaba jau ir' });
    const r = newRoom(code);
    rooms.set(code, r);
    cb?.({ ok:true, code });
    socket.join(code);
    io.to(code).emit('seat:update', roomPublicState(r));
    socket.emit('room:joined', code);
  });

  socket.on('room:join', (code, cb) => {
    const r = rooms.get(code);
    if (!r) return cb?.({ ok:false, error:'Nav istabas' });
    socket.join(code);
    cb?.({ ok:true });
    io.to(code).emit('seat:update', roomPublicState(r));
    socket.emit('room:joined', code);
  });

  socket.on('seat:join', ({ roomCode, seatId }, cb) => {
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok:false, error:'Nav istabas' });

    // jau sēž kur citur?
    const already = [...room.seats.values()].find(s => s.playerId === socket.id);
    if (already && already.id !== seatId) {
      return cb?.({ ok:false, error:'Tu jau sēdi citā vietā' });
    }

    const seat = room.seats.get(seatId);
    if (!seat || seat.playerId || seat.isBot) return cb?.({ ok:false, error:'Vieta aizņemta' });
    seat.playerId = socket.id;
    room.playerSeat.set(socket.id, seatId);
    io.to(room.code).emit('seat:update', roomPublicState(room));
    cb?.({ ok:true });
  });

  socket.on('seat:leave', ({ roomCode }, cb) => {
    const room = rooms.get(roomCode);
    if (room) {
      const sid = room.playerSeat.get(socket.id);
      if (sid) {
        const st = room.seats.get(sid);
        if (st) st.playerId = null;
        room.playerSeat.delete(socket.id);
        io.to(room.code).emit('seat:update', roomPublicState(room));
      }
    }
    cb?.({ ok:true });
  });

  socket.on('game:start', ({ roomCode, deckSize=36, solo=false }, cb) => {
    const room = rooms.get(roomCode);
    if (!room) return cb?.({ ok:false, error:'Nav istabas' });
    if (room.game) return cb?.({ ok:false, error:'Spēle jau notiek' });
    const ok = startGame(room, { deckSize, solo });
    if (!ok) return cb?.({ ok:false, error:'Nepietiek spēlētāju' });
    cb?.({ ok:true });
  });

  // ===== Actions =====
  socket.on('attack', ({ roomCode, cards }, cb) => {
    const room = rooms.get(roomCode);
    if (!room?.game) return cb?.({ ok:false, error:'Nav spēles' });
    const ok = addToTable(room, socket.id, cards);
    cb?.({ ok });
  });

  socket.on('defend', ({ roomCode, pairIndex, card }, cb) => {
    const room = rooms.get(roomCode);
    if (!room?.game) return cb?.({ ok:false, error:'Nav spēles' });
    const ok = defendCard(room, socket.id, pairIndex, card);
    cb?.({ ok });
  });

  socket.on('attacker:add', ({ roomCode, cards }, cb) => {
    const room = rooms.get(roomCode);
    if (!room?.game) return cb?.({ ok:false, error:'Nav spēles' });
    const ok = attackerAdd(room, socket.id, cards);
    cb?.({ ok });
  });

  socket.on('take', ({ roomCode }, cb) => {
    const room = rooms.get(roomCode);
    if (!room?.game) return cb?.({ ok:false, error:'Nav spēles' });
    const ok = takeAll(room, socket.id);
    cb?.({ ok });
  });

  socket.on('endTurn', ({ roomCode }, cb) => {
    const room = rooms.get(roomCode);
    if (!room?.game) return cb?.({ ok:false, error:'Nav spēles' });
    const ok = endTurn(room);
    cb?.({ ok });
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const sid = room.playerSeat.get(socket.id);
      if (sid) {
        const st = room.seats.get(sid);
        if (st) st.playerId = null;
        room.playerSeat.delete(socket.id);
        io.to(room.code).emit('seat:update', roomPublicState(room));
      }
      // spēli nepārtraucam – citi var turpināt
    }
  });

  // Bind personal room for direct emits
  socket.join(socket.id);
});

server.listen(PORT, () => {
  console.log('Duraks server running on :'+PORT);
});
