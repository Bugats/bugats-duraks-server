const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
app.use(express.static('public'));

server.listen(PORT, () => console.log('Duraks server listening on', PORT));

/* ======= Spēles stāvokļi ======= */

const rooms = new Map();      // roomId -> state
const MAX_SEATS = 6;
const BOT_PID   = 'BOT#1';
const BOT_NICK  = 'BOT';

function isBot(pid){ return pid === BOT_PID; }

function newRoom(id){
  const st = {
    id,
    seats: Array(MAX_SEATS).fill(null), // {pid, nick}
    owner: null,
    status: 'lobby',                    // lobby | playing | finished
    deck36: true,                       // 36 pēc noklusējuma
    deck: [],
    trump: null,                        // {r,s}
    ranks: ['6','7','8','9','10','J','Q','K','A'], // 36
    hands: {},                          // pid -> [ {r,s,id} ]
    table: [],                          // [{a:{}, d:{}}]
    attacker: null,
    defender: null,
    order: [],                          // sēdvietu kārta ar pid
    drawPile: [],
    lastActionTs: Date.now(),
    winners: [],
    throwCap: 6,                        // max kārtis metienā
    throwUsed: 0
  };
  rooms.set(id, st);
  return st;
}

function ensureRoom(id){
  return rooms.get(id) || newRoom(id);
}

/* ======= Palīgfunkcijas ======= */

function rVal(r, ranks){ return ranks.indexOf(r); }
function rank(c){ return c.r; }
function suit(c){ return c.s; }

function beats(card, target, trump, ranks){
  if (!card || !target) return false;
  if (suit(card) === suit(target)) {
    return rVal(rank(card), ranks) > rVal(rank(target), ranks);
  }
  if (suit(card) === trump.s && suit(target) !== trump.s) return true;
  return false;
}

function buildDeck(deck36){
  const ranks36 = ['6','7','8','9','10','J','Q','K','A'];
  const ranks52 = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const ranks = deck36 ? ranks36 : ranks52;
  const suits = ['♣','♦','♥','♠'];
  const deck = [];
  let i=0;
  for (const s of suits){
    for (const r of ranks){
      deck.push({ id:`c${i++}`, r, s });
    }
  }
  return { deck, ranks };
}

function shuffle(a){
  for (let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}

function deal(st){
  // pievelkam līdz 6
  for (const pid of st.order){
    const h = st.hands[pid] || [];
    while (h.length < 6 && st.drawPile.length){
      h.push(st.drawPile.pop());
    }
    st.hands[pid] = h;
  }
}

function allDefended(st){
  if (!st.table.length) return false;
  return st.table.every(p => !!p.d);
}

function nextPid(st, pid){
  const idx = st.order.indexOf(pid);
  return st.order[(idx+1) % st.order.length];
}

function endTurn(st){
  // ja viss nosists -> nenoņem
  if (!st.table.length) return;
  if (allDefended(st)){
    // aizstāvis izdzīvoja, metamo kārtu var turpināt nākamais
    st.attacker = nextPid(st, st.attacker);
    st.defender = nextPid(st, st.attacker);
  } else {
    // aizstāvis paņem
    defenderTakes(st);
    // Uzbrucējs paliek tas pats
    st.defender = nextPid(st, st.attacker);
  }
  // aizvācam galdu, pievelkam rokas
  st.table = [];
  st.throwUsed = 0;
  deal(st);
  st.lastActionTs = Date.now();
  checkWinners(st);
}

function defenderTakes(st){
  const def = st.defender;
  if (!st.table.length) return;
  for (const pair of st.table){
    if (pair.a) st.hands[def].push(pair.a);
    if (pair.d) st.hands[def].push(pair.d);
  }
  st.table = [];
  st.throwUsed = 0;
}

function checkWinners(st){
  // izmet no kārtas tos, kam roka tukša un pievilkt vairs nav ko
  for (const pid of [...st.order]){
    if (!st.hands[pid]?.length && !st.drawPile.length){
      st.winners.push(pid);
      st.order = st.order.filter(x => x!==pid);
    }
  }
  if (st.order.length<=1){
    st.status = 'finished';
  }
}

function broadcastState(st){
  io.to(st.id).emit('state', publicState(st));
}

function publicState(st){
  return {
    id: st.id,
    status: st.status,
    seats: st.seats.map(s => s? {nick:s.nick, pid:s.pid} : null),
    owner: st.owner,
    deck36: st.deck36,
    trump: st.trump,
    ranks: st.ranks,
    order: st.order,
    attacker: st.attacker,
    defender: st.defender,
    table: st.table.map(p=>({
      a: p.a? {r:p.a.r, s:p.a.s} : null,
      d: p.d? {r:p.d.r, s:p.d.s} : null
    })),
    myHand: null,     // aizpildām “per-socket” nosūtē
    winners: st.winners,
    throwCap: st.throwCap,
    throwUsed: st.throwUsed
  };
}

/* ======= Socket.IO ======= */

io.on('connection', (socket)=>{
  const pid = socket.id;

  socket.on('room:list', (ack)=>{
    const lst = [...rooms.values()].map(r=>({
      id:r.id,
      seats: r.seats.filter(Boolean).length,
      status: r.status,
      deck36: r.deck36
    }));
    ack({ok:true, rooms:lst});
  });

  socket.on('room:create', ({deck36}, ack)=>{
    const id = Math.random().toString(36).slice(2,6).toUpperCase();
    const st = newRoom(id);
    st.deck36 = !!deck36;
    st.ranks = deck36? ['6','7','8','9','10','J','Q','K','A']: ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    st.owner = pid;
    ack({ok:true, id});
  });

  socket.on('room:join', ({roomId}, ack)=>{
    const st = ensureRoom(roomId);
    socket.join(roomId);
    // atgriežam stāvokli
    ack({ok:true, room: publicState(st)});
  });

  socket.on('seat:join', ({nick, seat}, ack)=>{
    const roomId = [...socket.rooms].find(r=>rooms.has(r));
    if (!roomId) return ack({ok:false});
    const st = rooms.get(roomId);

    // jau sēžam?
    if (st.seats.some(s => s && s.pid === pid)) return ack({ok:true, room: publicState(st)});

    if (seat<0 || seat>=MAX_SEATS) return ack({ok:false});
    if (st.seats[seat]) return ack({ok:false});

    st.seats[seat] = {pid, nick: nick||'Spēlētājs'};
    io.to(roomId).emit('state', publicState(st));
    ack({ok:true, room: publicState(st)});
  });

  socket.on('seat:leave', (ack)=>{
    const roomId = [...socket.rooms].find(r=>rooms.has(r));
    if (!roomId) return ack?.({ok:false});
    const st = rooms.get(roomId);
    for (let i=0;i<MAX_SEATS;i++){
      if (st.seats[i] && st.seats[i].pid===pid) st.seats[i]=null;
    }
    io.to(roomId).emit('state', publicState(st));
    ack?.({ok:true});
  });

  socket.on('game:start', (ack)=>{
    const roomId = [...socket.rooms].find(r=>rooms.has(r));
    if (!roomId) return ack({ok:false});
    const st = rooms.get(roomId);
    if (st.status!=='lobby') return ack({ok:false, msg:'Jau spēlē.'});

    const players = st.seats.filter(Boolean).map(s=>s.pid);
    if (!players.length) return ack({ok:false, msg:'Nav spēlētāju.'});

    // ja 1 cilvēks – piesēdinām BOT
    if (players.length===1){
      const freeIdx = st.seats.findIndex(s=>!s);
      const botSeat = freeIdx === -1 ? 1 : freeIdx;
      st.seats[botSeat] = {pid: BOT_PID, nick: BOT_NICK};
      players.push(BOT_PID);
    }

    // uzbūvējam kavu
    const {deck, ranks} = buildDeck(st.deck36);
    st.ranks = ranks;
    shuffle(deck);
    st.trump = { r: deck[0].r, s: deck[0].s };
    st.drawPile = deck.slice(1);
    st.deck = deck;
    st.hands = {};
    st.table = [];
    st.order = st.seats.filter(Boolean).map(s=>s.pid);
    st.attacker = st.order[0];
    st.defender = st.order[1 % st.order.length];
    st.status = 'playing';
    st.throwUsed = 0;
    st.lastActionTs = Date.now();

    deal(st);

    io.to(roomId).emit('state', publicState(st));
    ack({ok:true});
  });

  socket.on('hand:get', (ack)=>{
    const roomId = [...socket.rooms].find(r=>rooms.has(r));
    if (!roomId) return ack({ok:false});
    const st = rooms.get(roomId);
    const pub = publicState(st);
    pub.myHand = (st.hands[pid]||[]).map(c=>({id:c.id, r:c.r, s:c.s}));
    ack({ok:true, room: pub, pid});
  });

  // Uzbrukums: {cards: [id,id,...]}
  socket.on('attack', ({cards}, ack)=>{
    const roomId = [...socket.rooms].find(r=>rooms.has(r));
    if (!roomId) return ack({ok:false});
    const st = rooms.get(roomId);
    if (st.attacker !== pid) return ack({ok:false, msg:'Nav tavs uzbrukums.'});
    if (!Array.isArray(cards) || !cards.length) return ack({ok:false});

    const hand = st.hands[pid]||[];
    const inHand = cards.every(id => hand.some(c=>c.id===id));
    if (!inHand) return ack({ok:false});

    // ja galdā jau ir kārtis – drīkst mest tikai esošo rangu
    const allowedRanks = new Set(st.table.flatMap(p=>[p.a?.r, p.d?.r].filter(Boolean)));
    const firstRank = hand.find(c=>c.id===cards[0])?.r;
    if (st.table.length && !allowedRanks.has(firstRank)){
      return ack({ok:false, msg:'Jāmet esošais rangs.'});
    }

    // ne vairāk par throwCap
    if (st.table.length + cards.length > st.throwCap){
      return ack({ok:false, msg:'Par daudz kāršu metienā.'});
    }

    for (const id of cards){
      const i = hand.findIndex(c=>c.id===id);
      const c = hand.splice(i,1)[0];
      st.table.push({a:c, d:null});
    }
    st.throwUsed = st.table.length;
    st.lastActionTs = Date.now();

    broadcastState(st);
    ack({ok:true});
  });

  // Aizstāvēšanās: {pairs:[{ti, cardId}]}, ti = table index
  socket.on('defend', ({pairs}, ack)=>{
    const roomId = [...socket.rooms].find(r=>rooms.has(r));
    if (!roomId) return ack({ok:false});
    const st = rooms.get(roomId);
    if (st.defender !== pid) return ack({ok:false, msg:'Nav tavs aizsardzības gājiens.'});
    const hand = st.hands[pid]||[];

    // pārbaudām
    for (const {ti, cardId} of pairs||[]){
      const pair = st.table[ti];
      if (!pair || pair.d) return ack({ok:false});
      const card = hand.find(c=>c.id===cardId);
      if (!card) return ack({ok:false});
      if (!beats(card, pair.a, st.trump, st.ranks)) return ack({ok:false, msg:'Nevar nosist.'});
    }
    // izpildām
    for (const {ti, cardId} of pairs||[]){
      const idx = hand.findIndex(c=>c.id===cardId);
      const card = hand.splice(idx,1)[0];
      st.table[ti].d = card;
    }
    st.lastActionTs = Date.now();
    broadcastState(st);
    ack({ok:true});
  });

  socket.on('defender:take', (ack)=>{
    const roomId = [...socket.rooms].find(r=>rooms.has(r));
    if (!roomId) return ack({ok:false});
    const st = rooms.get(roomId);
    if (st.defender !== pid) return ack({ok:false});
    defenderTakes(st);
    deal(st);
    st.defender = nextPid(st, st.attacker);
    st.lastActionTs = Date.now();
    checkWinners(st);
    broadcastState(st);
    ack({ok:true});
  });

  socket.on('turn:end', (ack)=>{
    const roomId = [...socket.rooms].find(r=>rooms.has(r));
    if (!roomId) return ack({ok:false});
    const st = rooms.get(roomId);
    // drīkst beigt, ja viss nosists vai uzbrucējs atsakās piemest (Neaizmest)
    if (!st.table.length) return ack({ok:false});
    endTurn(st);
    broadcastState(st);
    ack({ok:true});
  });

  socket.on('disconnect', ()=>{
    // izsēdinām, ja atvienojas
    for (const st of rooms.values()){
      let changed=false;
      for (let i=0;i<MAX_SEATS;i++){
        if (st.seats[i] && st.seats[i].pid === pid){ st.seats[i]=null; changed=true; }
      }
      if (changed) broadcastState(st);
    }
  });
});

/* ======= BOT ======= */

function botTick(st){
  if (st.status!=='playing') return;
  if (!st.order.includes(BOT_PID)) return;

  const hand = st.hands[BOT_PID] || [];
  if (!hand.length) return;

  // aizstāvis
  if (st.defender === BOT_PID){
    const openIdx = st.table.map((p,i)=>!p.d? i : -1).filter(i=>i>=0);
    if (!openIdx.length) return;
    let did=false;

    // šķiro mazākās sitamās
    for (const i of openIdx){
      const target = st.table[i].a;
      const beaters = hand.filter(c => beats(c, target, st.trump, st.ranks))
                          .sort((a,b)=> rVal(a.r,st.ranks) - rVal(b.r,st.ranks));
      if (beaters.length){
        const use = beaters[0];
        hand.splice(hand.indexOf(use),1);
        st.table[i].d = use;
        did=true;
      }
    }
    if (did){
      st.lastActionTs = Date.now();
      broadcastState(st);
      return;
    } else {
      defenderTakes(st);
      deal(st);
      st.defender = nextPid(st, st.attacker);
      checkWinners(st);
      st.lastActionTs = Date.now();
      broadcastState(st);
      return;
    }
  }

  // uzbrucējs
  if (st.attacker === BOT_PID){
    // izvēlas zemāko rangu
    const sorted = hand.slice().sort((a,b)=> rVal(a.r,st.ranks) - rVal(b.r,st.ranks));
    if (!sorted.length) return;
    const r0 = sorted[0].r;
    const allowed = st.table.length? new Set(st.table.flatMap(p=>[p.a?.r, p.d?.r].filter(Boolean))) : null;
    const play = sorted.filter(c => allowed? allowed.has(c.r) : c.r===r0);
    const cap = Math.max(1, st.throwCap - st.throwUsed);
    for (const c of play.slice(0,cap)){
      st.table.push({a:c, d:null});
      st.hands[BOT_PID].splice(st.hands[BOT_PID].indexOf(c),1);
    }
    st.throwUsed = st.table.length;
    st.lastActionTs = Date.now();
    broadcastState(st);
  }
}

/* Auto turn end + BOT tick */
setInterval(()=>{
  for (const st of rooms.values()){
    if (st.status!=='playing') continue;

    // auto "Gājiens beigts" 6s pēc pilnas aizsardzības, ja neviens nepie-met
    const idle = Date.now() - st.lastActionTs;
    if (idle >= 6000 && allDefended(st)){
      endTurn(st);
      broadcastState(st);
    }

    // BOT loģika
    botTick(st);
  }
}, 350);
