// Duraks Online — Bugats Edition (Server)
// Pilna versija ar BOT labojumu: pēc bota uzbrukuma fāze tiek pārslēgta uz 'defend'

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.get('/', (_req, res) => res.send('Duraks Online server is up'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

/* ======== Spēles loģikas palīgrīki ======== */

const RANKS = ['6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♣','♦','♥','♠']; // klub, karo, sirs, pīķis

const rankValue = r => RANKS.indexOf(r);
const makeDeck = (use52=false) => {
  const ranks = use52 ? ['2','3','4','5', ...RANKS] : RANKS;
  const deck = [];
  for (const s of SUITS) for (const r of ranks) deck.push({ r, s });
  // samaisām
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
};

const canBeat = (defCard, atkCard, trump) => {
  if (!defCard || !atkCard) return false;
  // Trumpis sit jebko netrumpi
  if (defCard.s === trump && atkCard.s !== trump) return true;
  // Ja vienā mastā, vajag lielāku rangu
  if (defCard.s === atkCard.s && rankValue(defCard.r) > rankValue(atkCard.r)) return true;
  return false;
};

const canAddByRanksOnTable = (table, ranks) => {
  if (table.length === 0) return true; // pirmajam gājienam ok
  const onTable = new Set();
  for (const pair of table) {
    if (pair.attack) onTable.add(pair.attack.r);
    if (pair.defend) onTable.add(pair.defend.r);
  }
  return ranks.every(r => onTable.has(r));
};

const drawTo = (hand, deck, n = 6) => {
  while (hand.length < n && deck.length) {
    hand.push(deck.shift());
  }
};

const nextPlayer = (room, currentId) => {
  const alive = room.order.filter(id => room.players[id]); // drošība
  const idx = alive.indexOf(currentId);
  return alive[(idx + 1) % alive.length];
};

const roomStateForClient = room => ({
  id: room.id,
  deckCount: room.deck.length,
  trump: room.trump,
  phase: room.phase,               // 'attack' vai 'defend'
  turn: room.turn,                 // kuram gājiens
  table: room.table,               // [{attack, defend}]
  log: room.log.slice(-80),
  players: Object.fromEntries(Object.entries(room.players).map(([pid, p]) => [
    pid,
    { nick: p.nick, handCount: p.hand.length }
  ]))
});

const pushState = room => {
  io.to(room.id).emit('state', roomStateForClient(room));
};

const pushLog = (room, line) => {
  room.log.push(line);
  io.to(room.id).emit('log', line);
};

/* ======== Istabas glabātuve ======== */

const ROOMS = new Map();
/*
Room struktūra:
{
  id, deck, trump, phase, turn, order:[socketId,...],
  table:[ {attack:{r,s,by}, defend:{r,s,by}|null}, ... ],
  players: {
    [socketId]: { nick, hand:[{r,s}], isBot:boolean }
  },
  log:[...]
}
*/

/* ======== Palīgfunkcijas darbībām ======== */

function startRound(room) {
  // pirmajā raundā — sadalām 6, atklājam trumpi
  if (!room.deck || room.deck.length === 0) {
    const use52 = room.use52 === true;
    room.deck = makeDeck(use52);
  }
  if (!room.trump) {
    // pēdējo kārti uz apakšu — trumpis
    const last = room.deck[room.deck.length - 1];
    room.trump = last.s;
  }

  for (const pid of room.order) drawTo(room.players[pid].hand, room.deck, 6);

  // kuram pirmā gājiena priekšrocības?
  // izvēlamies pēc zemākā trumpja, pretējā gadījumā pēc zemākā ranka
  let best = room.order[0];
  let bestCard = getLowestStarterCard(room.players[best].hand, room.trump);
  for (const pid of room.order.slice(1)) {
    const c = getLowestStarterCard(room.players[pid].hand, room.trump);
    if (compareStarter(c, bestCard, room.trump) < 0) {
      best = pid;
      bestCard = c;
    }
  }
  room.turn = best;
  room.phase = 'attack';
  room.table = [];
  pushState(room);
}

function getLowestStarterCard(hand, trump) {
  // vispirms zemākais trumpis, ja nav — zemākais vispār
  const trumps = hand.filter(c => c.s === trump).sort((a,b)=>rankValue(a.r)-rankValue(b.r));
  if (trumps.length) return trumps[0];
  const others = hand.slice().sort((a,b)=>rankValue(a.r)-rankValue(b.r));
  return others[0] || null;
}
function compareStarter(a,b,trump) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (a.s === trump && b.s !== trump) return -1;
  if (a.s !== trump && b.s === trump) return 1;
  return rankValue(a.r) - rankValue(b.r);
}

/* ======== BOT AI ======== */

function botAct(room) {
  const botId = room.order.find(pid => room.players[pid]?.isBot && room.turn === pid);
  if (!botId) return;

  const me = room.players[botId];
  const hand = me.hand;

  // Aizsardzība
  if (room.phase === 'defend') {
    // atrodam nesistu pāri
    const idx = room.table.findIndex(p => !p.defend && p.attack);
    if (idx === -1) return;

    const atk = room.table[idx].attack;
    // same suit larger OR any trump
    let choice = hand
      .filter(c => canBeat(c, atk, room.trump))
      .sort((a,b)=>rankValue(a.r)-rankValue(b.r))[0];

    if (choice) {
      removeCard(hand, choice);
      room.table[idx].defend = { ...choice, by: botId };
      pushLog(room, `BOT nosit ar ${choice.r}${choice.s}`);
      pushState(room);

      // Ja visi attačoti uzbrukumi nosisti — beidzam metienu bot vārdā
      if (room.table.every(p => p.attack && p.defend)) {
        endTrick(room, /*defenderTook*/ false);
      }
      return;
    } else {
      // nevar nosist — ņem
      defenderTakes(room, botId);
      return;
    }
  }

  // UZBRUKUMS
  if (room.phase === 'attack') {
    // izvēlamies zemāko (netrumps vispirms)
    const sorted = hand
      .slice()
      .sort((a,b)=>{
        const at = a.s === room.trump, bt = b.s === room.trump;
        if (at !== bt) return at - bt; // netrumpi pirms trumpja
        return rankValue(a.r) - rankValue(b.r);
      });

    let toPlay = sorted[0];
    if (!toPlay) return;

    // ja uz galda jau ir kārtis, drīkst piemest tikai saskaņā ar rangu
    if (!canAddByRanksOnTable(room.table, [toPlay.r])) {
      // mēģinam atrast jebkuru karti ar atļautu rangu
      const allowed = sorted.find(c => canAddByRanksOnTable(room.table, [c.r]));
      if (!allowed) {
        // nav ko piemest — beidzam metienu
        endTrick(room, /*defenderTook*/ false);
        return;
      }
      toPlay = allowed;
    }

    removeCard(hand, toPlay);
    room.table.push({ attack: { ...toPlay, by: botId }, defend: null });

    // *** SVARĪGS LABOJUMS: uzreiz pārslēdzam uz aizsardzību ***
    room.phase = 'defend';

    pushLog(room, `BOT uzbrūk ar ${toPlay.r}${toPlay.s}`);
    pushState(room);
    return;
  }
}

function removeCard(hand, card) {
  const i = hand.findIndex(c => c.r === card.r && c.s === card.s);
  if (i >= 0) hand.splice(i,1);
}

/* ======== Metiena beigas / paņemšana ======== */

function defenderTakes(room, defenderId) {
  // aizstāvis paņem VISU no galda
  const pile = [];
  for (const p of room.table) {
    if (p.attack) pile.push(p.attack);
    if (p.defend) pile.push(p.defend);
  }
  room.players[defenderId].hand.push(...pile);
  room.table = [];
  pushLog(room, 'Paņemts.');

  // Dozejam līdz 6: vispirms uzbrucējs, tad pārējie pulksteņrādītāja virzienā
  refillAfterTrick(room, /*defenderTook*/ true);

  // nākamajā gājienā uzbrucējs paliek tas pats
  room.phase = 'attack';
  pushState(room);
  // ja nākamais ir BOT — ļaujam tam iet
  botAct(room);
}

function endTrick(room, defenderTook) {
  // visi uzbrukumi nosisti un aizstāvis nepacēla
  const oldAttacker = room.turn;
  room.table = [];
  pushLog(room, 'Metiens beigts.');

  // Dozejam līdz 6 (vispirms uzbrucējs, tad citi)
  refillAfterTrick(room, defenderTook);

  // nākamo uzbrukumu sāk nākamais no aizstāvja (ja nosita), citādi tas pats
  if (!defenderTook) {
    // uzbruka oldAttacker -> aizstāvis bija next
    const defenderId = nextPlayer(room, oldAttacker);
    room.turn = defenderId; // nākamo metienu uzsāk cilvēks aiz aizstāvja
  } else {
    room.turn = oldAttacker; // ja paņēma, uzbrucējs paliek
  }

  room.phase = 'attack';
  pushState(room);
  botAct(room);
}

function refillAfterTrick(room, defenderTook) {
  // Kā Durak: velk vispirms uzbrucējs, tad nākamie pa kārtai, aizstāvis velk pēdējais
  const attacker = room.turn;
  const defender = nextPlayer(room, attacker);

  let drawOrder = [];
  if (defenderTook) {
    // ja aizstāvis paņēma, velk pirms viņa visi citi sākot no uzbrucēja
    drawOrder = orderFrom(room, attacker);
  } else {
    // ja nosita, vispirms velk uzbrucējs, tad tie pa labi, aizstāvis pēdējais
    drawOrder = orderFrom(room, attacker);
  }

  for (const pid of drawOrder) {
    drawTo(room.players[pid].hand, room.deck, 6);
  }
}

function orderFrom(room, pidStart) {
  const arr = [];
  let cur = pidStart;
  for (let i = 0; i < room.order.length; i++) {
    arr.push(cur);
    cur = nextPlayer(room, cur);
  }
  return arr;
}

/* ======== Socket.io notikumi ======== */

io.on('connection', socket => {
  // drošībai
  socket.data.nick = 'Anon';

  socket.on('createRoom', ({ nick, deckSize = 52, soloBot = false }) => {
    const id = genRoomId();
    const room = {
      id,
      use52: Number(deckSize) === 52,
      deck: [],
      trump: null,
      phase: 'attack',
      turn: null,
      table: [],
      order: [],
      players: {},
      log: []
    };
    ROOMS.set(id, room);

    // reģistrē spēlētāju
    room.players[socket.id] = { nick: nick || 'Spēlētājs', hand: [], isBot: false };
    room.order.push(socket.id);
    socket.join(id);
    socket.data.roomId = id;
    socket.data.nick = nick || 'Spēlētājs';

    // Pievieno BOT ja izvēlēts
    if (soloBot) {
      const botId = `BOT_${id}`;
      room.players[botId] = { nick: 'BOT', hand: [], isBot: true };
      room.order.push(botId);
    }

    pushLog(room, 'Savienots ar serveri.');
    pushLog(room, `Istaba izveidota: ${id}`);

    startRound(room);
  });

  socket.on('joinRoom', ({ nick, roomId }) => {
    const room = ROOMS.get(roomId);
    if (!room) { socket.emit('errorMsg', 'Nav istabas.'); return; }
    if (room.order.length >= 4) { socket.emit('errorMsg', 'Istaba pilna.'); return; }

    room.players[socket.id] = { nick: nick || 'Spēlētājs', hand: [], isBot: false };
    room.order.push(socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.nick = nick || 'Spēlētājs';

    pushLog(room, `${socket.data.nick} pievienojās.`);
    drawTo(room.players[socket.id].hand, room.deck, 6);
    pushState(room);
  });

  socket.on('start', () => {
    const room = getRoom(socket);
    if (!room) return;
    startRound(room);
    botAct(room);
  });

  // Uzbrukuma izvēle (no klienta var nākt viena vai vairākas kārtis ar vienādu rangu)
  socket.on('attack', (cards) => {
    const room = getRoom(socket);
    if (!room) return;
    if (room.turn !== socket.id || room.phase !== 'attack') return;

    const me = room.players[socket.id];
    if (!me) return;

    // pārbaude — vai var piemest šīs kārtis pēc ranga
    const ranks = cards.map(c => c.r);
    if (!canAddByRanksOnTable(room.table, ranks)) return;

    // ieliekam visas izvēlētās kārtis
    for (const c of cards) {
      removeCard(me.hand, c);
      room.table.push({ attack: { ...c, by: socket.id }, defend: null });
    }

    // pēc cilvēka uzbrukuma — uzreiz fāze 'defend'
    room.phase = 'defend';
    pushLog(room, `${me.nick} uzbrūk ar ${cards.map(c=>c.r + c.s).join(', ')}`);
    pushState(room);
    botAct(room);
  });

  // Nosist kārti (defend)
  socket.on('defend', ({ attackIndex, card }) => {
    const room = getRoom(socket);
    if (!room) return;

    // aizstāvis ir nākamais spēlētājs pēc uzbrucēja
    const defenderId = nextPlayer(room, room.turn);
    if (socket.id !== defenderId || room.phase !== 'defend') return;

    const pair = room.table[attackIndex];
    if (!pair || !pair.attack || pair.defend) return;

    if (!canBeat(card, pair.attack, room.trump)) return;

    const me = room.players[socket.id];
    removeCard(me.hand, card);
    room.table[attackIndex].defend = { ...card, by: socket.id };
    pushLog(room, `${me.nick} nosit ${pair.attack.r}${pair.attack.s} ar ${card.r}${card.s}`);
    pushState(room);

    // ja viss nosists — beidz metienu
    if (room.table.every(p => p.attack && p.defend)) {
      endTrick(room, /*defenderTook*/ false);
    } else {
      // vēl nav — bot var mēģināt piemest (ja bot ir uzbrucējs)
      botAct(room);
    }
  });

  // Paņemt (defender nevar nosist)
  socket.on('take', () => {
    const room = getRoom(socket);
    if (!room) return;
    const defenderId = nextPlayer(room, room.turn);
    if (socket.id !== defenderId || room.phase !== 'defend') return;
    defenderTakes(room, defenderId);
  });

  // Beigt metienu (uzbrucējs), ja aizstāvis nositis visu
  socket.on('endTrick', () => {
    const room = getRoom(socket);
    if (!room) return;
    if (room.turn !== socket.id) return; // tikai uzbrucējs
    if (room.phase !== 'defend') return;
    if (!room.table.every(p => p.attack && p.defend)) return; // vēl nav viss nosists
    endTrick(room, /*defenderTook*/ false);
  });

  socket.on('chat', (msg) => {
    const room = getRoom(socket);
    if (!room) return;
    pushLog(room, `💬 ${socket.data.nick}: ${String(msg).slice(0,160)}`);
  });

  socket.on('disconnect', () => {
    const room = getRoom(socket);
    if (!room) return;
    pushLog(room, `${socket.data.nick} atvienojās.`);
    delete room.players[socket.id];
    room.order = room.order.filter(id => id !== socket.id);
    socket.leave(room.id);
    pushState(room);
  });
});

/* ======== Palīgi ======== */

function genRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random()*chars.length)];
  if (ROOMS.has(id)) return genRoomId();
  return id;
}

function getRoom(socket) {
  const id = socket.data.roomId;
  if (!id) return null;
  return ROOMS.get(id) || null;
}

/* ======== Start ======== */
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Duraks server listening on', PORT));
