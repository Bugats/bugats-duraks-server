// Duraks Multiplayer 2–6 spēlētāji ar Loby (CommonJS)
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

/* ===== Kāršu util ===== */
const SUITS = ['♣','♦','♥','♠'];
const RANKS36 = ['6','7','8','9','10','J','Q','K','A'];
const RANKS52 = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

const rank = c => c.slice(0,-1);
const suit = c => c.slice(-1);
const rVal = (r, ranks) => ranks.indexOf(r);

function makeDeck(mode='36'){
  const ranks = mode==='52' ? RANKS52 : RANKS36;
  const d=[];
  for (const s of SUITS) for (const r of ranks) d.push(r+s);
  for (let i=d.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [d[i],d[j]]=[d[j],d[i]]; }
  return { deck:d, ranks };
}
function beats(card, target, trump, ranks){
  const s1=suit(card), s2=suit(target);
  if (s1===s2) return rVal(rank(card),ranks)>rVal(rank(target),ranks);
  return s1===trump && s2!==trump;
}

/* ===== Loby/istabas ===== */
const rooms = new Map(); // roomId -> state

function newRoomId(){ return (Math.random().toString(36).slice(2,6)).toUpperCase(); }

function createRoom(roomName, deckMode='36'){
  const id = newRoomId();
  const st = {
    id, name: roomName || `Istaba ${id}`, deckMode,
    status: 'lobby',            // 'lobby' | 'playing' | 'finished'
    seats: [null,null,null,null,null,null], // {pid, nick} or null
    host: null,                 // pid
    ranks: deckMode==='52' ? RANKS52 : RANKS36,
    deck: [], trump: null,
    hands: {},                  // pid -> [cards]
    order: [],                  // spēlētāju pid rindā (pulksteņa virzienā)
    attacker: null,             // pid
    defender: null,             // pid
    table: [],                  // [{a, d:null|card}]
    throwCap: 0, throwUsed: 0, defenderStartCount: 0,
    lastActionTs: 0,
    winners: [],                // pidi secībā, kad izkrīt (nav kāršu un kava tukša)
  };
  rooms.set(id, st);
  return st;
}

function lobbyList(){
  const arr=[];
  for (const st of rooms.values()){
    arr.push({
      id: st.id,
      name: st.name,
      players: st.seats.filter(Boolean).length,
      status: st.status
    });
  }
  return arr;
}

function publicLobby(st){
  return {
    id: st.id, name: st.name, status: st.status,
    seats: st.seats.map(s => s ? { nick:s.nick, pid:s.pid } : null),
    host: st.host
  };
}

function seatIndexOf(st, pid){
  return st.seats.findIndex(s => s && s.pid===pid);
}

/* ===== Spēles gaitas util ===== */
function ranksOnTable(st){
  const s=new Set();
  st.table.forEach(p=>{ s.add(rank(p.a)); if(p.d) s.add(rank(p.d)); });
  return s;
}
function allDefended(st){
  return st.table.length>0 && st.table.every(p=>p.d);
}
function fillTo6(st, pid){
  while (st.hands[pid] && st.hands[pid].length<6 && st.deck.length){
    st.hands[pid].push(st.deck.shift());
  }
}
function advanceOrder(st, pid){
  const idx = st.order.indexOf(pid);
  if (idx<0) return null;
  return st.order[(idx+1)%st.order.length];
}
function removePlayerFromOrder(st, pid){
  st.order = st.order.filter(x=>x!==pid);
  delete st.hands[pid];
  // iztīrām no sēdvietas
  const i = seatIndexOf(st, pid);
  if (i>=0) st.seats[i] = null;
}
function checkWinners(st){
  // uzvarētāji izkrīt tad, kad kava tukša un viņu roka tukša
  let changed=false;
  for (const pid of st.order.slice()){
    if (!st.hands[pid]) continue;
    if (st.deck.length===0 && st.hands[pid].length===0 && !st.winners.includes(pid)){
      st.winners.push(pid);
      removePlayerFromOrder(st, pid);
      changed=true;
    }
  }
  if (st.order.length<=1 && st.status==='playing'){
    st.status='finished';
  }
  return changed;
}
function setThrowCap(st){
  st.defenderStartCount = st.hands[st.defender]?.length || 0;
  st.throwCap = st.defenderStartCount;
  st.throwUsed = st.table.length;
}
function endTurn(st){
  // viss nosists
  st.table = [];
  // došana
  for (const pid of turnDrawOrder(st)){ fillTo6(st, pid); }
  // nākamais uzbrucējs = aizstāvis (klasika)
  st.attacker = st.defender;
  st.defender = advanceOrder(st, st.attacker);
  st.lastActionTs = Date.now();
  setThrowCap(st);
}
function defenderTakes(st){
  const all=[]; st.table.forEach(p=>{ all.push(p.a); if(p.d) all.push(p.d); });
  st.hands[st.defender].push(...all);
  st.table = [];
  // došana
  for (const pid of turnDrawOrder(st)){ fillTo6(st, pid); }
  // nākamais uzbrucējs = aiz aizstāvja
  st.attacker = advanceOrder(st, st.defender);
  st.defender = advanceOrder(st, st.attacker);
  st.lastActionTs = Date.now();
  setThrowCap(st);
}
function turnDrawOrder(st){
  // klasika: vispirms uzbrucējs, tad pārējie pulksteņa virzienā
  const res=[];
  let cur = st.attacker;
  for (let i=0;i<st.order.length;i++){
    res.push(cur);
    cur = advanceOrder(st, cur);
  }
  return res;
}

function publicState(st, viewerPid){
  return {
    room: { id: st.id, name: st.name, status: st.status },
    trump: st.trump,
    deckCount: st.deck.length,
    ranks: st.ranks,
    seats: st.seats.map(s => s ? { pid:s.pid, nick:s.nick, count: st.hands[s.pid]?.length ?? 0 } : null),
    you: { pid: viewerPid, hand: st.hands[viewerPid] || [] },
    attacker: st.attacker,
    defender: st.defender,
    phase: st.table.length && !allDefended(st) ? 'defend' : 'attack',
    table: st.table,                 // [{a, d}]
    throwCap: st.throwCap,
    throwUsed: st.throwUsed,
    canAdd: st.throwUsed < st.throwCap,
    winners: st.winners
  };
}

/* ===== Auto “Gājiens beigts” 6s ===== */
setInterval(()=>{
  for (const st of rooms.values()){
    if (st.status!=='playing') continue;
    const idle = Date.now()-st.lastActionTs;
    if (idle>=6000 && allDefended(st)){
      endTurn(st);
      broadcastState(st);
    }
    if (st.status==='finished'){
      // neko papildus
    }
  }
}, 350);

function broadcastState(st){
  io.to(st.id).emit('state', publicState(st, null)); // skatītājiem var izmantot null
  // katram spēlētājam – ar viņa roku
  for (const s of st.seats){
    if (!s) continue;
    io.to(s.pid).emit('state', publicState(st, s.pid));
  }
}

/* ===== Sockets ===== */
io.on('connection', (socket)=>{
  socket.on('lobby:list', (ack)=> ack?.(lobbyList()));

  socket.on('room:create', ({name, deckMode='36'}, ack)=>{
    const st = createRoom(name, deckMode);
    ack?.({ok:true, room: publicLobby(st)});
    io.emit('lobby', lobbyList());
  });

  socket.on('room:join', ({roomId}, ack)=>{
    const st = rooms.get(roomId);
    if (!st) return ack?.({ok:false, err:'no-room'});
    socket.join(st.id);
    socket.roomId = st.id;
    ack?.({ok:true, room: publicLobby(st)});
  });

  socket.on('seat:join', ({nick, seat}, ack)=>{
    const st = rooms.get(socket.roomId);
    if (!st) return ack?.({ok:false, err:'no-room'});
    if (st.status!=='lobby') return ack?.({ok:false, err:'started'});
    if (seat<0 || seat>5) return ack?.({ok:false, err:'bad-seat'});
    if (seatIndexOf(st, socket.id)>=0) return ack?.({ok:false, err:'already-seated'});
    if (st.seats[seat]) return ack?.({ok:false, err:'occupied'});

    st.seats[seat] = { pid: socket.id, nick: (nick||'Spēlētājs').toString().slice(0,24) };
    if (!st.host) st.host = socket.id;

    io.to(st.id).emit('room', publicLobby(st));
    io.emit('lobby', lobbyList());
    ack?.({ok:true, room: publicLobby(st)});
  });

  socket.on('seat:leave', (ack)=>{
    const st = rooms.get(socket.roomId);
    if (!st) return ack?.({ok:false});
    const i = seatIndexOf(st, socket.id);
    if (i>=0) st.seats[i]=null;
    if (st.host===socket.id){
      // pāradresē hostu uz nākamo
      const first = st.seats.find(s=>s);
      st.host = first ? first.pid : null;
    }
    io.to(st.id).emit('room', publicLobby(st));
    io.emit('lobby', lobbyList());
    ack?.({ok:true});
  });

  socket.on('game:start', (ack)=>{
    const st = rooms.get(socket.roomId);
    if (!st) return ack?.({ok:false, err:'no-room'});
    if (st.host!==socket.id) return ack?.({ok:false, err:'not-host'});
    const players = st.seats.filter(Boolean).map(s=>s.pid);
    if (players.length<2) return ack?.({ok:false, err:'need-2'});

    const { deck, ranks } = makeDeck(st.deckMode);
    st.deck = deck;
    st.ranks = ranks;
    st.trump = suit(st.deck[st.deck.length-1]);

    st.hands = {};
    st.order = players.slice();                   // secība = sēdvietu secība
    for (const pid of st.order){ st.hands[pid] = st.deck.splice(0,6); }
    st.table = [];
    st.winners = [];
    st.status = 'playing';

    // pirmais uzbrucējs = sēdvietā #0 esošais (vienkārši noteikumi; var mainīt uz "zemākā trumpja īpašnieks")
    st.attacker = st.order[0];
    st.defender = advanceOrder(st, st.attacker);
    st.lastActionTs = Date.now();
    setThrowCap(st);

    io.to(st.id).emit('room', publicLobby(st));
    broadcastState(st);
    ack?.({ok:true});
  });

  // Uzbrukums – tikai uzbrucējs, var mest vairākas vienāda ranga
  socket.on('attack', ({cards}, ack)=>{
    const st = rooms.get(socket.roomId);
    if (!st || st.status!=='playing') return ack?.({ok:false});
    if (st.attacker!==socket.id) return ack?.({ok:false, err:'not-attacker'});
    const hand = st.hands[socket.id]; if (!hand) return ack?.({ok:false});

    if (!Array.isArray(cards) || cards.length===0) return ack?.({ok:false, err:'no-cards'});
    const r0 = rank(cards[0]);
    if (!cards.every(c => rank(c)===r0)) return ack?.({ok:false, err:'same-rank-only'});
    if (!cards.every(c => hand.includes(c))) return ack?.({ok:false, err:'no-ownership'});

    if (st.table.length){
      const rS = ranksOnTable(st);
      if (!rS.has(r0)) return ack?.({ok:false, err:'bad-rank'});
    }
    if (st.throwUsed + cards.length > st.throwCap) return ack?.({ok:false, err:'throw-cap'});

    for (const c of cards){
      st.table.push({a:c, d:null});
      hand.splice(hand.indexOf(c),1);
    }
    st.throwUsed = st.table.length;
    st.lastActionTs = Date.now();

    broadcastState(st);
    ack?.({ok:true});
  });

  // Aizsardzība – aizstāvis nosūta pārus: [{target:{rank,suit}, cardId}]
  socket.on('defend', ({pairs}, ack)=>{
    const st = rooms.get(socket.roomId);
    if (!st || st.status!=='playing') return ack?.({ok:false});
    if (st.defender!==socket.id) return ack?.({ok:false, err:'not-defender'});
    if (!Array.isArray(pairs) || !pairs.length) return ack?.({ok:false, err:'no-pairs'});
    const hand = st.hands[socket.id];

    for (const p of pairs){
      const pair = st.table.find(x => !x.d && rank(x.a)===p?.target?.rank && suit(x.a)===p?.target?.suit);
      if (!pair) return ack?.({ok:false, err:'bad-target'});
      if (!hand.includes(p.cardId)) return ack?.({ok:false, err:'no-card'});
      if (!beats(p.cardId, pair.a, st.trump, st.ranks)) return ack?.({ok:false, err:'cant-beat'});
      pair.d = p.cardId;
      hand.splice(hand.indexOf(p.cardId),1);
    }
    st.lastActionTs = Date.now();

    if (allDefended(st)){
      // gaidām vai uzbrucējs piemest (šajā versijā piemest drīkst tikai uzbrucējs)
      // UI auto end pēc 6s vai manual endTurn
    }
    broadcastState(st);
    ack?.({ok:true});
  });

  socket.on('take', (ack)=>{
    const st = rooms.get(socket.roomId);
    if (!st || st.status!=='playing') return ack?.({ok:false});
    if (st.defender!==socket.id) return ack?.({ok:false, err:'not-defender'});
    if (!st.table.length) return ack?.({ok:false, err:'nothing'});

    defenderTakes(st);
    checkWinners(st);
    broadcastState(st);
    ack?.({ok:true});
  });

  socket.on('endTurn', (ack)=>{
    const st = rooms.get(socket.roomId);
    if (!st || st.status!=='playing') return ack?.({ok:false});
    if (!allDefended(st)) return ack?.({ok:false, err:'not-all-defended'});
    endTurn(st);
    checkWinners(st);
    broadcastState(st);
    ack?.({ok:true});
  });

  socket.on('disconnect', ()=>{
    const rid = socket.roomId;
    if (!rid) return;
    const st = rooms.get(rid);
    if (!st) return;
    // ja lobby statusā – vienkārši izņem no sēdvietas
    const i = seatIndexOf(st, socket.id);
    if (i>=0) st.seats[i] = null;
    if (st.host===socket.id){
      const first = st.seats.find(s=>s);
      st.host = first ? first.pid : null;
    }
    // ja playing – spēlētājs aiziet: viņa kārtis noliekam zem kavas (vienkāršība) un viņš izkrīt
    if (st.status==='playing' && st.hands[socket.id]){
      st.deck.push(...st.hands[socket.id]);
      st.hands[socket.id]=[];
      removePlayerFromOrder(st, socket.id);
      if (st.attacker===socket.id) st.attacker = advanceOrder(st, st.attacker);
      if (st.defender===socket.id) st.defender = advanceOrder(st, st.defender);
      checkWinners(st);
    }
    io.to(st.id).emit('room', publicLobby(st));
    broadcastState(st);
    io.emit('lobby', lobbyList());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log(`Duraks MP server on http://localhost:${PORT}`));
