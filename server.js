// server.js — Duraks Online MVP (6 sēdvietas, 36/52 kava, BOT, auto-end 6s)
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

// --- util paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- app
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// statics
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- spēles dati ----------
const RANKS36 = ['6','7','8','9','10','J','Q','K','A'];
const RANKS52 = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['S','C','H','D']; // ♠ ♣ ♥ ♦
const SEATS = 6;
const HAND_LIMIT = 6;
const AUTO_END_MS = 6000;
const TURN_TIMEOUT_MS = 30000; // vienkāršs “anti-afk”

// Palīgi
const uid = () => Math.random().toString(36).slice(2, 9);
const toPower = (deckType, rank, suit, trumpSuit) => {
  const ranks = deckType === '36' ? RANKS36 : RANKS52;
  const base = ranks.indexOf(rank);
  const trumpBoost = suit === trumpSuit ? 100 : 0;
  return base + trumpBoost;
};

function makeDeck(deckType) {
  const ranks = deckType === '36' ? RANKS36 : RANKS52;
  const deck = [];
  for (const s of SUITS) {
    for (const r of ranks) {
      deck.push({ id: uid(), rank: r, suit: s });
    }
  }
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function lowestTrumpIndex(deckType, hand, trump) {
  let best = -1, bestPow = 1e9;
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c.suit === trump) {
      const pow = toPower(deckType, c.rank, c.suit, trump);
      if (pow < bestPow) { bestPow = pow; best = i; }
    }
  }
  return best;
}

// ---------- istabas ----------
const rooms = new Map(); // code -> Room

class Room {
  constructor({ code, deckType = '36', solo = false }) {
    this.code = code;
    this.deckType = deckType; // '36' | '52'
    this.solo = solo;
    this.seats = Array.from({ length: SEATS }, () => ({
      id: null, name: null, type: null, cards: [], active: false
    }));
    this.sockets = new Map(); // socket.id -> seatIndex
    this.playersOrder = []; // aktīvo sēdvietu indeksu rotācija
    this.deck = [];
    this.trumpSuit = null;
    this.attacker = 0;
    this.defender = 1;
    this.phase = 'waiting';
    this.board = []; // pāri: {atk?, def?}
    this.autoEndTimer = null;
    this.turnTimer = null;
  }

  broadcast(event, payload) {
    io.to(this.code).emit(event, payload);
  }

  seatIndexBySocket(socketId) {
    return this.sockets.get(socketId) ?? null;
  }

  seatOf(i) { return this.seats[i]; }

  activeSeatCount() {
    return this.seats.filter(s => s.type).length;
  }

  // ---------- spēles sākums / kava ----------
  startGame() {
    this.deck = makeDeck(this.deckType);
    // trumps = pēdējās kartes masts:
    const trumpCard = this.deck[this.deck.length - 1];
    this.trumpSuit = trumpCard.suit;

    // Tukšo rokas un izdala līdz 6
    for (const s of this.seats) if (s.type) s.cards = [];
    this.fillHandsStart();

    // Nosaka starta uzbrucēju: zemākais trumpis
    let bestPow = 1e9, startIdx = 0;
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (!s.type) continue;
      const ti = lowestTrumpIndex(this.deckType, s.cards, this.trumpSuit);
      if (ti >= 0) {
        const c = s.cards[ti];
        const pow = toPower(this.deckType, c.rank, c.suit, this.trumpSuit);
        if (pow < bestPow) { bestPow = pow; startIdx = i; }
      }
    }
    this.attacker = startIdx;
    // defenders nākamais pa kreisi:
    this.defender = this.nextActive(startIdx);

    this.phase = 'attack';
    this.board = [];

    this.playersOrder = this.seats
      .map((s, i) => ({ i, s }))
      .filter(x => x.s.type)
      .map(x => x.i);

    this.pushState();
    this.startTurnTimer();
    this.maybeBotTick();
  }

  fillHandsStart() {
    const order = this.seats.map((s, i) => i).filter(i => this.seats[i].type);
    // līdz 6 visiem; ņem no kavas virspuses
    for (let round = 0; round < HAND_LIMIT; round++) {
      for (const i of order) {
        const s = this.seats[i];
        if (!s.type) continue;
        if (s.cards.length < HAND_LIMIT && this.deck.length) {
          const c = this.deck.pop();
          s.cards.push(c);
        }
      }
    }
    // ieskaitām power
    for (const s of this.seats) {
      for (const c of s.cards) c.power = toPower(this.deckType, c.rank, c.suit, this.trumpSuit);
    }
  }

  refillHandsAfterTurn(paemējsSeatIdx = null) {
    // noteikums: uzbrucējs, metēji -> aizstāvis; paņēmējs pēdējais
    const order = this.makeRefillOrder(paemējsSeatIdx);
    for (const i of order) {
      const s = this.seats[i];
      while (s.cards.length < HAND_LIMIT && this.deck.length) {
        const c = this.deck.pop();
        c.power = toPower(this.deckType, c.rank, c.suit, this.trumpSuit);
        s.cards.push(c);
      }
    }
  }

  makeRefillOrder(paemējs) {
    // sākot no uzbrucēja, pa kreisi, līdz aizstāvim. Ja paņēmējs — viņš pēdējais
    const active = this.playersOrder.slice();
    const idxAtt = active.indexOf(this.attacker);
    const ref = [];
    // no uzbrucēja līdz aizstāvim (iekļaujot citus metējus starpā)
    for (let k = 0; k < active.length; k++) {
      const i = active[(idxAtt + k) % active.length];
      ref.push(i);
      if (i === this.defender) break;
    }
    // aizstāvis jau iekļauts; ja paņēmējs, ieliec pēdējo
    if (paemējs != null) {
      const pos = ref.indexOf(paemējs);
      if (pos >= 0) ref.splice(pos, 1);
      ref.push(paemējs);
    }
    return ref;
  }

  nextActive(i) {
    for (let k = 1; k <= SEATS; k++) {
      const j = (i + k) % SEATS;
      if (this.seats[j].type) return j;
    }
    return i;
  }

  // ---------- stāvoklis / izsūtījumi ----------
  pushState() {
    const pubPlayers = this.seats.map(s => ({
      name: s.name, type: s.type, count: s.cards.length
    }));
    this.broadcast('game:state', {
      code: this.code,
      phase: this.phase,
      attacker: this.attacker,
      defender: this.defender,
      deckCount: this.deck.length,
      trump: this.trumpSuit,
      players: pubPlayers
    });
    this.broadcast('board:update', {
      pairs: this.board.map(p => ({
        atk: p.atk ? { rank: p.atk.rank, suit: p.atk.suit } : null,
        def: p.def ? { rank: p.def.rank, suit: p.def.suit } : null
      })),
      maxPairs: this.seats[this.defender]?.cards.length ?? 0,
      canThrowRanks: this.computeThrowRanks()
    });

    // Rokas – privāti
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (!s.type) continue;
      if (!s.id) continue;
      io.to(s.id).emit('hand:update', { cards: s.cards });
    }
  }

  computeThrowRanks() {
    const present = new Set();
    for (const pr of this.board) {
      if (pr.atk) present.add(pr.atk.rank);
      if (pr.def) present.add(pr.def.rank);
    }
    return Array.from(present);
  }

  // ---------- validācijas ----------
  canAttack(seatIdx, cardIds) {
    if (this.phase !== 'attack' && this.phase !== 'defend') return false;
    // uzbrukt drīkst tikai uzbrucējs (vai piemetēji, kad viss nosists)
    const attackerTurn = (seatIdx === this.attacker && this.phase === 'attack');
    const canThrow = (this.phase === 'defend' && this.board.length > 0 && this.board.every(p => p.def));
    if (!attackerTurn && !canThrow) return false;

    const s = this.seats[seatIdx];
    const hand = s.cards.map(c => c.id);
    // visi ID jābūt rokā
    for (const id of cardIds) if (!hand.includes(id)) return false;

    const cards = s.cards.filter(c => cardIds.includes(c.id));
    // vienāds ranks
    const r = cards[0].rank;
    if (!cards.every(c => c.rank === r)) return false;

    // pair limit <= aizstāvja rokas skaits
    const maxPairs = this.seats[this.defender]?.cards.length ?? 0;
    const boardPairs = this.board.length;
    const emptySlots = boardPairs + cardIds.length <= maxPairs;

    if (!emptySlots) return false;

    // ja “throw-in” (pēc nosišanas), rangam jābūt starp jau esošajiem rangiem uz galda
    if (!attackerTurn) {
      const validRanks = this.computeThrowRanks();
      if (!validRanks.includes(r)) return false;
    }
    return true;
  }

  canDefend(seatIdx, mapPairs) {
    if (this.phase !== 'defend') return false;
    if (seatIdx !== this.defender) return false;
    // kartes jānosedz visas, kas bez def
    const targets = this.board.filter(p => !p.def);
    if (mapPairs.length !== targets.length) return false;

    const s = this.seats[seatIdx];
    const handMap = new Map(s.cards.map(c => [c.id, c]));

    for (const m of mapPairs) {
      const target = this.board.find(p => p.atk && p.atk.id === m.atkId);
      if (!target) return false;
      const defCard = handMap.get(m.defId);
      if (!defCard) return false;

      if (!this.beats(target.atk, defCard)) return false;
    }
    return true;
  }

  beats(atk, def) {
    if (def.suit === this.trumpSuit && atk.suit !== this.trumpSuit) return true;
    if (def.suit === atk.suit) {
      const order = this.deckType === '36' ? RANKS36 : RANKS52;
      return order.indexOf(def.rank) > order.indexOf(atk.rank);
    }
    return false;
  }

  // ---------- darbības ----------
  doAttack(seatIdx, cardIds) {
    const s = this.seats[seatIdx];
    const pick = [];
    for (const id of cardIds) {
      const i = s.cards.findIndex(c => c.id === id);
      if (i >= 0) pick.push(...s.cards.splice(i, 1));
    }
    for (const c of pick) this.board.push({ atk: c, def: null });
    this.phase = 'defend';
    this.pushState();
    this.restartAutoEnd(false);
    this.startTurnTimer();
    this.maybeBotTick();
  }

  doThrow(seatIdx, cardIds) {
    // kā uzbrukt, bet tikai kad viss nosists
    this.doAttack(seatIdx, cardIds);
  }

  doDefend(seatIdx, mapPairs) {
    const s = this.seats[seatIdx];
    // uzlikt defs
    for (const m of mapPairs) {
      const pair = this.board.find(p => p.atk && p.atk.id === m.atkId);
      const i = s.cards.findIndex(c => c.id === m.defId);
      const c = s.cards.splice(i, 1)[0];
      pair.def = c;
    }
    this.pushState();

    // ja viss nosists, var piemet – iedarbina auto-end 6s
    if (this.board.every(p => p.def)) {
      this.restartAutoEnd(true);
    } else {
      this.restartAutoEnd(false);
    }
    this.startTurnTimer(); // pagarinām aizsargam
    this.maybeBotTick();
  }

  doTake(seatIdx) {
    if (seatIdx !== this.defender) return;
    const s = this.seats[seatIdx];
    // paņem visas (atk + def)
    for (const p of this.board) {
      if (p.atk) s.cards.push(p.atk);
      if (p.def) s.cards.push(p.def);
    }
    this.board = [];
    this.phase = 'resolve';
    this.finishTurn({ took: true, taker: seatIdx });
  }

  endTurnByClick() {
    // manuāls “Gājiens beigts” – tikai ja viss nosists
    if (this.board.length === 0) return; // nav bijis metiens
    if (!this.board.every(p => p.def)) return;
    this.phase = 'resolve';
    this.finishTurn({ took: false });
  }

  finishTurn({ took = false, taker = null }) {
    // papildināšana
    this.clearTimers();

    if (took) {
      this.refillHandsAfterTurn(taker);
      // nākamais uzbrucējs = pa kreisi no paņēmēja
      this.attacker = this.nextActive(taker);
      this.defender = this.nextActive(this.attacker);
    } else {
      this.refillHandsAfterTurn(null);
      // ja nosedzās, uzbrucējs paliek tas pats, aizstāvis = nākamais
      this.defender = this.nextActive(this.defender);
    }

    // izmet “0 kāršu” no aktīvajiem — viņi vinnēja
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (s.type && s.cards.length === 0) {
        s.active = false; // atzīme
      }
    }
    this.playersOrder = this.seats
      .map((s, i) => ({ i, s }))
      .filter(x => x.s.type && x.s.cards.length > 0)
      .map(x => x.i);

    // game over?
    const alive = this.playersOrder.length;
    if (alive <= 1) {
      this.broadcast('game:over', {
        winners: this.seats.map((s, i) => (s.type && s.cards.length === 0 ? i : null)).filter(x => x != null),
        loser: this.seats.findIndex(s => s.type && s.cards.length > 0)
      });
      this.phase = 'waiting';
      this.board = [];
      this.pushState();
      return;
    }

    this.board = [];
    this.phase = 'attack';
    this.pushState();
    this.startTurnTimer();
    this.maybeBotTick();
  }

  restartAutoEnd(enable) {
    if (this.autoEndTimer) { clearTimeout(this.autoEndTimer); this.autoEndTimer = null; }
    if (!enable) return;
    this.autoEndTimer = setTimeout(() => {
      if (this.phase === 'defend' && this.board.length && this.board.every(p => p.def)) {
        this.endTurnByClick();
      }
    }, AUTO_END_MS);
  }

  startTurnTimer() {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
    this.turnTimer = setTimeout(() => {
      // aizstāvis → paņemt; uzbrucējs → beigt gājienu
      if (this.phase === 'defend') {
        this.doTake(this.defender);
      } else if (this.phase === 'attack') {
        // ja nav metiena — pārejam tālāk
        this.endTurnByClick();
      }
    }, TURN_TIMEOUT_MS);
  }

  clearTimers() {
    if (this.turnTimer) { clearTimeout(this.turnTimer); this.turnTimer = null; }
    if (this.autoEndTimer) { clearTimeout(this.autoEndTimer); this.autoEndTimer = null; }
  }

  // ---------- BOT ----------
  maybeBotTick() {
    const doSeat = (i) => this.seats[i]?.type === 'bot';
    const delay = 500 + Math.random()*800;

    if (this.phase === 'attack' && doSeat(this.attacker)) {
      setTimeout(() => this.botAttack(this.attacker), delay);
    }
    if (this.phase === 'defend' && doSeat(this.defender)) {
      setTimeout(() => this.botDefend(this.defender), delay);
    }
  }

  botAttack(i) {
    const s = this.seats[i];
    const hand = [...s.cards].sort((a,b)=>a.power-b.power);
    // mēģina netrumpi; ja nav – zemāko trumpi
    const nonTr = hand.filter(c => c.suit !== this.trumpSuit);
    const base = nonTr.length ? nonTr[0] : hand[0];
    if (!base) { this.endTurnByClick(); return; }

    // ja ir vēl tā paša ranga un aizstāvim >=2 kārtis, uzmet 2
    const same = hand.filter(c => c.rank === base.rank).map(c => c.id);
    const can2 = (this.seats[this.defender].cards.length >= 2 && same.length >= 2);
    const payload = can2 ? same.slice(0,2) : [base.id];

    if (this.canAttack(i, payload)) this.doAttack(i, payload);
    else this.endTurnByClick();
  }

  botDefend(i) {
    const s = this.seats[i];
    const needed = this.board.filter(p => !p.def).map(p => p.atk);
    const mapping = [];

    // greedy minimālais pārspējums
    for (const atk of needed) {
      const can = s.cards.filter(c => this.beats(atk, c)).sort((a,b)=>a.power-b.power);
      if (!can.length) { this.doTake(i); return; }
      mapping.push({ atkId: atk.id, defId: can[0].id });
      // izņem no “virtuālās rokas”
      s.cards = s.cards.filter(cc => cc.id !== can[0].id).concat(can.slice(1));
    }
    // atjauno īsto roku no servera stāvokļa (neatņemot kartes šeit) – doDefend izņems
    const mapPairs = mapping;
    if (this.canDefend(i, mapPairs)) this.doDefend(i, mapPairs);
    else this.doTake(i);
  }
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  // room:create
  socket.on('room:create', (payload) => {
    try {
      const { code, deckType, solo } = payload ?? {};
      if (!code) return socket.emit('room:error', { msg: 'Nav istabas koda.' });
      if (rooms.has(code)) rooms.delete(code);
      const room = new Room({ code, deckType: deckType==='52' ? '52' : '36', solo: !!solo });
      rooms.set(code, room);
      socket.join(code);
      socket.emit('room:created', { code, deckType: room.deckType });
    } catch (e) {
      socket.emit('room:error', { msg: 'room:create kļūda' });
    }
  });

  // seat:join
  socket.on('seat:join', ({ code, seatIndex, name }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('room:error', { msg: 'Istaba nav' });
    if (seatIndex < 0 || seatIndex >= SEATS) return;
    const already = room.seatIndexBySocket(socket.id);
    if (already != null) return; // jau sēž

    const seat = room.seats[seatIndex];
    if (seat.type) return socket.emit('room:error', { msg: 'Sēdvieta aizņemta' });

    seat.id = socket.id;
    seat.name = name?.slice(0,18) || 'Player';
    seat.type = 'human';
    seat.active = true;

    room.sockets.set(socket.id, seatIndex);
    socket.join(code);

    io.to(code).emit('seat:update', { seats: room.seats.map(s => ({ name: s.name, type: s.type })) });

    // Solo režīms: pievieno BOT, ja trūkst pretinieka
    if (room.solo && room.activeSeatCount() < 2) {
      const bi = room.seats.findIndex(s => !s.type);
      if (bi >= 0) {
        room.seats[bi] = { id: null, name: 'BOT', type: 'bot', cards: [], active: true };
        io.to(code).emit('seat:update', { seats: room.seats.map(s => ({ name: s.name, type: s.type })) });
      }
    }
  });

  socket.on('game:start', ({ code }) => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.activeSeatCount() < 2) return socket.emit('room:error', { msg: 'Nepietiek spēlētāju' });
    room.startGame();
  });

  socket.on('attack', ({ code, cards }) => {
    const room = rooms.get(code); if (!room) return;
    const i = room.seatIndexBySocket(socket.id); if (i==null) return;
    if (room.canAttack(i, cards)) room.doAttack(i, cards);
    else socket.emit('action:error', { msg: 'Uzbrukums nav derīgs' });
  });

  socket.on('throwin', ({ code, cards }) => {
    const room = rooms.get(code); if (!room) return;
    const i = room.seatIndexBySocket(socket.id); if (i==null) return;
    if (room.canAttack(i, cards)) room.doThrow(i, cards);
    else socket.emit('action:error', { msg: 'Piemest nedrīkst' });
  });

  socket.on('defend', ({ code, map }) => {
    const room = rooms.get(code); if (!room) return;
    const i = room.seatIndexBySocket(socket.id); if (i==null) return;
    if (room.canDefend(i, map)) room.doDefend(i, map);
    else socket.emit('action:error', { msg: 'Nederīga aizsardzība' });
  });

  socket.on('take', ({ code }) => {
    const room = rooms.get(code); if (!room) return;
    const i = room.seatIndexBySocket(socket.id); if (i==null) return;
    room.doTake(i);
  });

  socket.on('endturn', ({ code }) => {
    const room = rooms.get(code); if (!room) return;
    room.endTurnByClick();
  });

  socket.on('disconnect', () => {
    for (const room of rooms.values()) {
      const seatIndex = room.seatIndexBySocket(socket.id);
      if (seatIndex != null) {
        const st = room.seats[seatIndex];
        st.id = null; st.name = null; st.type = null; st.cards = []; st.active = false;
        room.sockets.delete(socket.id);
        io.to(room.code).emit('seat:update', { seats: room.seats.map(s => ({ name: s.name, type: s.type })) });
      }
    }
  });
});

// ---- run
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Duraks Online running on :' + PORT));
