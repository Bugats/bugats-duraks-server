// Duraks (podkidnoy) – Bugats baseline serveris
// Features: Rooms, 6 seats, Ready/Start, soft-BOT, reconnect ≤30s, 1x undo/bauts, mutex, rate-limit, vienkāršs leaderboard.

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.static('public'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

// ====== Util ======
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['6','7','8','9','10','J','Q','K','A'];
const RANK_VAL = Object.fromEntries(RANKS.map((r,i)=>[r,i]));
const now = () => Date.now();

// Leaderboard (vienkāršs atmiņā)
const leaderboard = { total:{}, day:{}, week:{} };
function lbAddWin(nick){
  const add = (obj)=> obj[nick] = (obj[nick]||0)+1;
  add(leaderboard.total); add(leaderboard.day); add(leaderboard.week);
}
let lastDay = new Date().toDateString();
let lastWeek = weekKey();
function weekKey(){
  const d = new Date(); const onejan = new Date(d.getFullYear(),0,1);
  const week = Math.ceil((((d - onejan)/86400000) + onejan.getDay()+1)/7);
  return d.getFullYear()+'-W'+week;
}
function rolloverLB(){
  const dStr = new Date().toDateString();
  const wStr = weekKey();
  if (dStr !== lastDay){ leaderboard.day={}; lastDay = dStr; }
  if (wStr !== lastWeek){ leaderboard.week={}; lastWeek = wStr; }
}
setInterval(rolloverLB, 60000);

// ====== Rooms ======
const rooms = new Map(); // roomId -> state

function freshDeck(){
  const deck = [];
  for (const s of SUITS){
    for (const r of RANKS){ deck.push({r,s}); }
  }
  // Fisher–Yates shuffle
  for(let i=deck.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [deck[i],deck[j]]=[deck[j],deck[i]];
  }
  return deck;
}

function createRoom(roomId){
  const room = {
    id: roomId,
    players: [], // {id,sid,cid,nick,seat,isReady,isBot,hand:[],connected:true,lastSeen}
    spectators: new Set(),
    status: 'lobby', // lobby | playing
    createdAt: now(),
    deck: [],
    discard: [],
    trump: null, // {suit, cardBottom}
    attackerIdx: null,
    defenderIdx: null,
    table: [], // [{attack,defense}]
    lastAction: null,
    undoUsedForBout: new Set(),
    mutex: false,
    rate: new Map(), // sid -> {ts}
    removeTimers: new Map(), // cid -> timeoutId
  };
  rooms.set(roomId, room);
  return room;
}

function getRoom(roomId){ return rooms.get(roomId) || createRoom(roomId); }

function seatFree(room, seat){
  return !room.players.some(p=>p.seat===seat);
}

function sendRoom(room){
  const payload = {
    id: room.id,
    status: room.status,
    players: room.players.map(p=>({
      id: p.id, nick: p.nick, seat: p.seat, isReady: p.isReady, isBot: p.isBot, connected: p.connected, cards: p.hand.length
    })),
    table: room.table,
    trump: room.trump,
    deckCount: room.deck.length,
    discardCount: room.discard.length,
    attackerIdx: room.attackerIdx,
    defenderIdx: room.defenderIdx,
    leaderboard: {
      total: topList(leaderboard.total),
      day: topList(leaderboard.day),
      week: topList(leaderboard.week),
    }
  };
  io.to(room.id).emit('room:update', payload);
}

function topList(obj){
  return Object.entries(obj).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([nick,score])=>({nick,score}));
}

// ====== Game Logic (simplified but correct core) ======
function sameCard(a,b){ return a && b && a.r===b.r && a.s===b.s; }
function beats(card, target, trumpSuit){
  if (!target) return false;
  if (card.s === target.s) return RANK_VAL[card.r] > RANK_VAL[target.r];
  if (card.s === trumpSuit && target.s !== trumpSuit) return true;
  return false;
}
function canAddAttack(ranksOnTable, card){
  // Papilduzbrukumu drīkst tikai ar rankiem, kas jau uz galda
  return ranksOnTable.size===0 || ranksOnTable.has(card.r);
}
function collectRanks(table){ const set = new Set(); for(const p of table){ if(p.attack) set.add(p.attack.r); if(p.defense) set.add(p.defense.r); } return set; }

function startGame(room){
  room.status='playing';
  room.deck = freshDeck();
  room.discard = [];
  room.table = [];
  room.undoUsedForBout.clear();

  // trump = deck bottom card suit (skatāms apakšā)
  const bottom = room.deck[room.deck.length-1];
  room.trump = { suit: bottom.s, cardBottom: bottom };

  // Deal 6 each
  for (let i=0;i<6;i++){
    for (const p of room.players){
      p.hand.push(room.deck.pop());
    }
  }
  // First attacker = player with lowest trump
  let lowest = {idx:0, val:999};
  room.players.forEach((p,idx)=>{
    const tr = p.hand.filter(c=>c.s===room.trump.suit).sort((a,b)=>RANK_VAL[a.r]-RANK_VAL[b.r])[0];
    if (tr){
      const v = RANK_VAL[tr.r];
      if (v<lowest.val){ lowest={idx, val:v}; }
    }
  });
  room.attackerIdx = lowest.val===999 ? 0 : lowest.idx;
  room.defenderIdx = (room.attackerIdx+1)%room.players.length;
  room.lastAction = null;
}

function drawUpToSix(room, startIdx){
  // Pēc bau­ta: velk kārtis līdz 6, sākot no uzbrucēja
  for (let k=0;k<room.players.length;k++){
    const idx = (startIdx+k)%room.players.length;
    const p = room.players[idx];
    while (p.hand.length<6 && room.deck.length){
      p.hand.push(room.deck.pop());
    }
  }
}

function cleanupDefended(room){
  // Aizsargājās veiksmīgi: viss uz discarda
  for (const pair of room.table){
    if (pair.attack) room.discard.push(pair.attack);
    if (pair.defense) room.discard.push(pair.defense);
  }
  room.table = [];
  room.undoUsedForBout.clear();
}

function someoneOut(room){
  // izmet spēlētājus ar tukšu roku no “aktīvajiem” – Durak beidzas, kad paliek 1 ar kārtīm
  // Šeit vienkāršoti: atstājam rindā, bet ar 0 kārtīm viņi nepiedalās nākamajos bautos.
}

function nextBoutAfterDefend(room){
  cleanupDefended(room);
  drawUpToSix(room, room.attackerIdx);
  // Ja aizsargs izturēja – nākamais uzbrucējs ir aizsargs
  room.attackerIdx = room.defenderIdx;
  room.defenderIdx = (room.attackerIdx+1)%room.players.length;
}

function nextBoutAfterTake(room, defender){
  // Aizsargs paņēma kārtis
  const taking = [];
  for (const pair of room.table){
    if (pair.attack) taking.push(pair.attack);
    if (pair.defense) taking.push(pair.defense);
  }
  defender.hand.push(...taking);
  room.table = [];
  room.undoUsedForBout.clear();
  drawUpToSix(room, room.attackerIdx);
  // Ja aizsargs ņēma, uzbrucējs paliek tas pats, aizsargs = nākamais
  room.defenderIdx = (room.attackerIdx+1)%room.players.length;
}

function checkGameEnd(room){
  const inGame = room.players.filter(p=>p.hand.length>0);
  if (room.deck.length===0 && inGame.length<=1){
    room.status='lobby';
    // Uzvarētāji: tie, kam 0; Duraks: pēdējais ar kārtīm
    const durak = room.players.find(p=>p.hand.length>0);
    const winners = room.players.filter(p=>p.hand.length===0);
    if (winners.length){
      for(const w of winners){ lbAddWin(w.nick); }
    }
    io.to(room.id).emit('game:ended', {
      durak: durak ? {nick:durak.nick, seat:durak.seat} : null,
      winners: winners.map(w=>({nick:w.nick, seat:w.seat}))
    });
    // reset ready flags
    for (const p of room.players){ p.isReady=false; }
    return true;
  }
  return false;
}

// ====== BOT ======
function isBot(p){ return p && p.isBot; }
function scheduleBot(room, p){
  setTimeout(()=> botAct(room, p), 1100 + Math.floor(Math.random()*700));
}
function botAct(room, p){
  if (room.status!=='playing') return;
  const idx = room.players.indexOf(p);
  if (idx===-1) return;
  const trump = room.trump.suit;

  const attacker = room.players[room.attackerIdx];
  const defender = room.players[room.defenderIdx];

  if (idx===room.defenderIdx){
    // BOT aizsargs: mēģina nosegt lētāko
    for (let i=0;i<room.table.length;i++){
      const pair = room.table[i];
      if (!pair.defense){
        const win = p.hand.filter(c=>beats(c, pair.attack, trump))
                          .sort((a,b)=>RANK_VAL[a.r]-RANK_VAL[b.r])[0];
        if (win){
          playDefense(room, p, win, i);
          return;
        }else{
          // nevar nosegt – ņem
          takeCards(room, p);
          return;
        }
      }
    }
    // ja viss nosegts – pabeidz bout
    endBoutIfAllDefended(room);
  } else if (idx===room.attackerIdx){
    // BOT uzbrucējs: uzmet zemāko pieļaujamo
    const ranksOnTable = collectRanks(room.table);
    const valid = p.hand.filter(c=>canAddAttack(ranksOnTable, c));
    if (valid.length===0){ endBoutIfAllDefended(room); return; }
    const card = valid.sort((a,b)=>{
      const av = (a.s===trump?100:0)+RANK_VAL[a.r];
      const bv = (b.s===trump?100:0)+RANK_VAL[b.r];
      return av-bv;
    })[0];
    playAttack(room, p, card);
  } else {
    // Citi spēlētāji vienkāršoti neko nepievieno šajā baseline
  }
}

// ====== Actions ======
function withMutex(room, fn){
  if (room.mutex) return false;
  room.mutex = true;
  try { fn(); } finally { room.mutex = false; }
  return true;
}
function rateOk(room, sid){
  const last = room.rate.get(sid)||0;
  if (now()-last < 250) return false; // ~4 ops/s
  room.rate.set(sid, now());
  return true;
}
function findPlayerBySid(room, sid){ return room.players.find(p=>p.sid===sid); }
function findPlayerByCid(room, cid){ return room.players.find(p=>p.cid===cid); }

function playAttack(room, p, card){
  // no rope
  const attacker = room.players[room.attackerIdx];
  const defender = room.players[room.defenderIdx];
  if (p!==attacker) return;
  const ranksOnTable = collectRanks(room.table);
  if (!canAddAttack(ranksOnTable, card)) return;
  if (!p.hand.find(c=>sameCard(c,card))) return;
  if (room.table.length >= Math.min(6, defender.hand.length)) return;

  // noņem no rokas
  p.hand = p.hand.filter(c=>!sameCard(c,card));
  room.table.push({attack: card, defense: null});
  room.lastAction = {type:'attack', by:p.id, card};
}
function playDefense(room, p, card, pairIdx){
  const defender = room.players[room.defenderIdx];
  if (p!==defender) return;
  if (!p.hand.find(c=>sameCard(c,card))) return;
  const pair = room.table[pairIdx];
  if (!pair || pair.defense) return;
  if (!beats(card, pair.attack, room.trump.suit)) return;

  p.hand = p.hand.filter(c=>!sameCard(c,card));
  pair.defense = card;
  room.lastAction = {type:'defense', by:p.id, card, pairIdx};
}
function endBoutIfAllDefended(room){
  // Ja visi uzbrukumi nosekti – bout beidzas
  if (room.table.length && room.table.every(p=>p.defense)){
    nextBoutAfterDefend(room);
    if (!checkGameEnd(room)){
      sendRoom(room);
      maybeScheduleBot(room);
    }
  }
}
function takeCards(room, defender){
  nextBoutAfterTake(room, defender);
  if (!checkGameEnd(room)){
    sendRoom(room);
    maybeScheduleBot(room);
  }
}
function undoOnce(room, p){
  if (room.undoUsedForBout.has(p.id)) return;
  if (!room.lastAction) return;
  if (room.lastAction.type!=='attack') return; // tikai pēdējo uzbrukumu
  // atceļ pēdējo uzbrukuma kārti
  const idx = room.table.length-1;
  const last = room.table[idx];
  if (!last || last.defense) return; // nevar ja jau nosegts
  p.hand.push(last.attack);
  room.table.pop();
  room.undoUsedForBout.add(p.id);
}
function maybeScheduleBot(room){
  const at = room.players[room.attackerIdx];
  const df = room.players[room.defenderIdx];
  if (isBot(at)) scheduleBot(room, at);
  else if (isBot(df)) scheduleBot(room, df);
}

// ====== IO ======
io.on('connection', (socket)=>{
  // query: room, nick, cid (reconnect id)
  const { room:roomIdQ, nick:nickQ, cid:cidQ } = socket.handshake.query || {};
  let currentRoomId = null;

  socket.on('room:join', ({roomId, nick, cid, spectator})=>{
    if (!roomId) roomId = roomIdQ || 'duraks';
    if (!nick) nick = nickQ || ('Guest-'+(Math.random()*1000|0));
    if (!cid) cid = cidQ || uuidv4();

    const room = getRoom(roomId);
    currentRoomId = roomId;
    socket.join(roomId);

    // reconnect?
    let player = findPlayerByCid(room, cid);
    if (player){
      // atjauno sesiju
      player.sid = socket.id;
      player.connected = true;
      player.lastSeen = now();
      if (room.removeTimers.has(cid)){
        clearTimeout(room.removeTimers.get(cid));
        room.removeTimers.delete(cid);
      }
      socket.emit('session', { cid, seat: player.seat });
    } else if (!spectator){
      // pievieno kā spēlētāju bez sēdvietas
      player = {
        id: uuidv4(),
        sid: socket.id,
        cid,
        nick,
        seat: null,
        isReady: false,
        isBot: false,
        hand: [],
        connected: true,
        lastSeen: now()
      };
      room.players.push(player);
      socket.emit('session', { cid, seat: null });
    } else {
      room.spectators.add(socket.id);
      socket.emit('session', { cid, seat: null });
    }

    sendRoom(room);
  });

  socket.on('room:leaveSeat', ()=>{
    const room = getRoom(currentRoomId); if (!room) return;
    const p = findPlayerBySid(room, socket.id); if (!p) return;
    if (room.status==='lobby') p.seat = null;
    sendRoom(room);
  });

  socket.on('room:takeSeat', (seat)=>{
    const room = getRoom(currentRoomId); if (!room) return;
    if (room.status!=='lobby') return;
    if (seat<1 || seat>6) return;
    if (!seatFree(room, seat)) return;
    const p = findPlayerBySid(room, socket.id); if (!p) return;
    p.seat = seat;
    sendRoom(room);
  });

  socket.on('room:setNick', (nick)=>{
    const room = getRoom(currentRoomId); if (!room) return;
    const p = findPlayerBySid(room, socket.id); if (!p) return;
    p.nick = String(nick||'').slice(0,20) || p.nick;
    sendRoom(room);
  });

  socket.on('room:addBot', ()=>{
    const room = getRoom(currentRoomId); if (!room) return;
    if (room.status!=='lobby') return;
    // ieliekam BOT bez sēdvietas – aizņems pirmo brīvo
    const seat = [1,2,3,4,5,6].find(s=>seatFree(room,s));
    if (!seat) return;
    room.players.push({
      id: uuidv4(), sid: null, cid: 'BOT-'+uuidv4(),
      nick: 'BOT', seat, isReady: true, isBot: true,
      hand: [], connected: true, lastSeen: now()
    });
    sendRoom(room);
  });

  socket.on('room:ready', (flag)=>{
    const room = getRoom(currentRoomId); if (!room) return;
    if (room.status!=='lobby') return;
    const p = findPlayerBySid(room, socket.id); if (!p) return;
    if (p.seat==null) return;
    p.isReady = !!flag;
    // auto-start ja ≥2 spēlētāji ar sēdvietām un visi “seated” ir gatavi
    const seated = room.players.filter(x=>x.seat!=null);
    if (seated.length>=2 && seated.every(x=>x.isReady)){
      withMutex(room, ()=> startGame(room));
    }
    sendRoom(room);
    if (room.status==='playing') maybeScheduleBot(room);
  });

  socket.on('game:attack', (card)=>{
    const room = getRoom(currentRoomId); if (!room) return;
    if (!rateOk(room, socket.id)) return;
    if (room.status!=='playing') return;
    withMutex(room, ()=>{
      const p = findPlayerBySid(room, socket.id); if (!p) return;
      playAttack(room, p, card);
      sendRoom(room);
      maybeScheduleBot(room);
    });
  });

  socket.on('game:defend', ({card, pairIdx})=>{
    const room = getRoom(currentRoomId); if (!room) return;
    if (!rateOk(room, socket.id)) return;
    if (room.status!=='playing') return;
    withMutex(room, ()=>{
      const p = findPlayerBySid(room, socket.id); if (!p) return;
      playDefense(room, p, card, pairIdx);
      sendRoom(room);
      endBoutIfAllDefended(room);
      maybeScheduleBot(room);
    });
  });

  socket.on('game:take', ()=>{
    const room = getRoom(currentRoomId); if (!room) return;
    if (!rateOk(room, socket.id)) return;
    if (room.status!=='playing') return;
    withMutex(room, ()=>{
      const p = findPlayerBySid(room, socket.id); if (!p) return;
      if (room.players[room.defenderIdx]!==p) return;
      takeCards(room, p);
    });
  });

  socket.on('game:endBout', ()=>{
    const room = getRoom(currentRoomId); if (!room) return;
    if (!rateOk(room, socket.id)) return;
    if (room.status!=='playing') return;
    withMutex(room, ()=>{
      // tikai uzbrucējs var pabeigt bout, ja vairāk nav ko uzbrukt
      const at = room.players[room.attackerIdx];
      if (at.sid!==socket.id) return;
      endBoutIfAllDefended(room);
    });
  });

  socket.on('game:undoOnce', ()=>{
    const room = getRoom(currentRoomId); if (!room) return;
    if (!rateOk(room, socket.id)) return;
    if (room.status!=='playing') return;
    withMutex(room, ()=>{
      const p = findPlayerBySid(room, socket.id); if (!p) return;
      undoOnce(room, p);
      sendRoom(room);
    });
  });

  socket.on('disconnect', ()=>{
    const room = getRoom(currentRoomId); if (!room) return;
    // atzīmē kā pagaidu atslēdzies; ja 30s neatslēdzas, izņem
    const p = findPlayerBySid(room, socket.id);
    if (p){
      p.connected = false;
      p.lastSeen = now();
      const timer = setTimeout(()=>{
        // ja joprojām nav atpakaļ – neatmet no room, bet atstājam slotu (vienkāršoti)
        // ja lobby – var izsēdināt
      }, 30000);
      room.removeTimers.set(p.cid, timer);
    } else {
      room.spectators.delete(socket.id);
    }
    sendRoom(room);
  });

  // Sūti privāti rokas kārtis
  const handInterval = setInterval(()=>{
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId); if (!room) return;
    const p = findPlayerBySid(room, socket.id);
    if (p) socket.emit('hand', {hand: p.hand});
  }, 400);

  socket.on('disconnect', ()=> clearInterval(handInterval));
});

server.listen(PORT, ()=> console.log('Duraks server running on', PORT));
