import express from 'express';
import http from 'http';
import cors from 'cors';
import { Server } from 'socket.io';

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  path: '/socket.io',
  transports: ['websocket']
});

const PORT = process.env.PORT || 3001;

/* -------------------- Spēles datu struktūras -------------------- */

const RANKS_36 = ['6','7','8','9','10','J','Q','K','A'];
const RANKS_52 = ['2','3','4','5', ...RANKS_36]; // 52 versijā pievienojam 2..5
const SUITS = ['♠','♥','♦','♣']; // parādām kā simbolus

// rank vērtības salīdzināšanai:
const ORDER_36 = Object.fromEntries(RANKS_36.map((r,i)=>[r,i]));
const ORDER_52 = Object.fromEntries(RANKS_52.map((r,i)=>[r,i]));

// istabas (atmiņā)
const rooms = new Map(); // roomCode -> room

function newRoom(code, deckSize=52) {
  const ranks = deckSize===36 ? RANKS_36 : RANKS_52;
  const order = deckSize===36 ? ORDER_36 : ORDER_52;
  const deck = [];
  for (const s of SUITS) for (const r of ranks) deck.push(makeCard(r,s));
  shuffle(deck);

  const trump = deck[deck.length-1].suit; // pēdējās kārts masts
  return {
    code,
    ranks,
    order,
    deckSize,
    deck,
    trumpSuit: trump,
    stock: deck,        // kopējam, bet mutējami – ok
    players: {},        // id -> {id,nick,hand:[],isBot?:bool}
    sockets: {},        // id -> socket
    playerOrder: [],    // spēlētāju kārtība
    attackerId: null,
    defenderId: null,
    turnId: null,       // kurš tagad kustas (uzbrucējs vai aizstāvis)
    phase: 'attack',    // 'attack' | 'defend'
    table: [],          // [{attack:Card, defend?:Card}]
    log: [],
    started: false
  };
}

function makeCard(rank, suit) {
  const id = `${rank}${suit}${Math.random().toString(36).slice(2,8)}`;
  return { id, rank, suit };
}

function shuffle(a){
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
}

function pushLog(room, msg){
  room.log.push(msg);
  if (room.log.length>300) room.log.shift();
}

function roomState(room){
  // klientam nedrīkst sūtīt pretinieku kāršu saturu – tikai skaitu
  const players = Object.fromEntries(Object.entries(room.players).map(([id,p])=>[
    id,
    { id, nick: p.nick, handCount: p.hand.length, isBot: !!p.isBot }
  ]));
  return {
    code: room.code,
    started: room.started,
    ranks: room.ranks,
    trumpSuit: room.trumpSuit,
    deckSize: room.deckSize,
    stockCount: room.stock.length,
    players,
    playerOrder: room.playerOrder,
    attackerId: room.attackerId,
    defenderId: room.defenderId,
    turnId: room.turnId,
    phase: room.phase,
    table: room.table.map(r=>({
      attack: r.attack ? {rank:r.attack.rank, suit:r.attack.suit, id:r.attack.id}:null,
      defend: r.defend ? {rank:r.defend.rank, suit:r.defend.suit, id:r.defend.id}:null
    })),
    log: room.log
  };
}

function handOf(room, playerId){ return room.players[playerId].hand; }
function visibleTableCount(room){ return room.table.filter(r=>r.attack).length; }
function ranksOnTable(room){
  const s = new Set();
  room.table.forEach(r=>{
    if (r.attack) s.add(r.attack.rank);
    if (r.defend) s.add(r.defend.rank);
  });
  return s;
}

function beats(card, attacked, trump){
  if (!attacked) return false;
  // trump beats any non-trump
  if (card.suit===trump && attacked.suit!==trump) return true;
  if (card.suit!==attacked.suit) return false;
  // same suit: higher rank
  const order = attacked.rank in ORDER_52 ? ORDER_52 : ORDER_36;
  return order[card.rank] > order[attacked.rank];
}

function removeFromHand(room, pid, cardId){
  const h = handOf(room, pid);
  const i = h.findIndex(c=>c.id===cardId);
  if (i>=0) h.splice(i,1);
}

function dealUpTo6(room, pid){
  while(handOf(room,pid).length<6 && room.stock.length>0){
    handOf(room,pid).push(room.stock.shift());
  }
}

/* -------------------- Lifecycle helpers -------------------- */

function startGame(room){
  if (room.started || room.playerOrder.length<1) return;
  // ja solo ar BOT -> spēlētāju būs 2 (cilvēks + bot)
  // ja abi – arī 2
  for (const pid of room.playerOrder) dealUpTo6(room, pid);
  // izvēlamies sākuma uzbrucēju (mazākā trumpja īpašnieks) – vienkāršoti: tas, kuram viszemākais trumpis
  let startId = room.playerOrder[0];
  let lowRankIdx = 9999;
  for (const pid of room.playerOrder){
    const idx = lowestTrumpIndex(room, pid);
    if (idx<lowRankIdx){ lowRankIdx=idx; startId=pid; }
  }
  room.attackerId = startId;
  room.defenderId = room.playerOrder.find(id=>id!==startId);
  room.turnId = room.attackerId;
  room.phase = 'attack';
  room.started = true;
  pushLog(room, `Spēle sākta. Trumpis: ${room.trumpSuit}`);
}

function lowestTrumpIndex(room, pid){
  const hand = handOf(room,pid);
  const trump = room.trumpSuit;
  const order = room.deckSize===36?ORDER_36:ORDER_52;
  let best = 9999;
  hand.forEach(c=>{
    if (c.suit===trump) best = Math.min(best, order[c.rank] ?? 9999);
  });
  return best;
}

function clearTableToBurn(room){
  room.table = [];
}

function nextRolesAfterDefended(room){
  // viss nosists -> bumba atpakaļ uzbrucējam, bet lomas apmainās
  // (klasika: ja aizstāvējās, uzbrucējs paliek uzbrucējs nākamajam pa solim – bet Durakā lomas mainās; šeit: aizstāvējās => uzbrucējs kļūst par nākamo aizstāvi)
  const oldAtt = room.attackerId;
  const oldDef = room.defenderId;

  // nodedzinām
  clearTableToBurn(room);

  // iedodam līdz 6 – vispirms uzbrucējam, tad aizstāvim
  dealUpTo6(room, oldAtt);
  dealUpTo6(room, oldDef);

  // lomas mainās
  room.attackerId = oldDef;
  room.defenderId = oldAtt;
  room.turnId = room.attackerId;
  room.phase = 'attack';
}

/* -------------------- BOT loģika -------------------- */

function isBot(room, pid){ return !!room.players[pid]?.isBot; }

function botAct(room){
  if (!room.started) return;
  const pid = room.turnId;
  if (!isBot(room,pid)) return;

  const hand = [...handOf(room,pid)]; // copy
  const trump = room.trumpSuit;
  const order = room.deckSize===36?ORDER_36:ORDER_52;

  if (room.phase==='attack'){
    // Ja galdā ir ranks, drīkst mest tikai tos rankus; citādi – jebkuru (low)
    const ranks = ranksOnTable(room);
    const defenderCards = handOf(room, room.defenderId).length;
    const lim = Math.max(0, Math.min(defenderCards - visibleTableCount(room), 6));
    if (lim<=0) { endAttack(room,pid,true); return; }

    // izvēlamies ranku: ja nav rangu uz galda – zemākais no rokas (izņemot trumpus, ja iespējams)
    let allowed = hand;
    if (ranks.size>0) allowed = hand.filter(c=>ranks.has(c.rank));

    if (allowed.length===0){ endAttack(room,pid,true); return; }

    allowed.sort((a,b)=>{
      const at = (a.suit===trump), bt=(b.suit===trump);
      if (at!==bt) return at-bt; // netrumpi pirms trumpiem
      return (order[a.rank]??99) - (order[b.rank]??99);
    });

    const rank = allowed[0].rank;
    const sameRank = hand.filter(c=>c.rank===rank)
                         .sort((a,b)=>{
                           const at = a.suit===trump, bt=b.suit===trump;
                           if (at!==bt) return at-bt;
                           return (order[a.rank]??99)-(order[b.rank]??99);
                         })
                         .slice(0, Math.max(1, Math.min(lim, sameRankCount(hand,rank))));
    doAttack(room, pid, sameRank.map(c=>c.id));
    return;
  }

  if (room.phase==='defend'){
    // atrodam katram uzbrukumam lētāko sitienu
    const pairs = [];
    const mine = handOf(room,pid);
    for (let i=0;i<room.table.length;i++){
      const row = room.table[i];
      if (!row.attack || row.defend) continue;
      const candidates = mine.filter(c=>beats(c,row.attack,trump))
                             .sort((a,b)=>{
                               // netrumps < trumps, zemākais pirmais
                               const at=a.suit===trump, bt=b.suit===trump;
                               if (at!==bt) return at-bt;
                               return (order[a.rank]??99)-(order[b.rank]??99);
                             });
      if (candidates.length){
        pairs.push({ attackIndex:i, cardId:candidates[0].id });
      } else {
        // nevar nosist -> ņemam
        take(room, pid);
        return;
      }
    }
    if (pairs.length){
      doDefend(room, pid, pairs);
      return;
    }
  }
}

function sameRankCount(hand, rank){ return hand.reduce((n,c)=>n+(c.rank===rank),0); }

/* -------------------- Auto-throw check -------------------- */

function canAttackerThrowMore(room) {
  const limit = Math.max(0, Math.min(handOf(room, room.defenderId).length - visibleTableCount(room), 6));
  if (limit <= 0) return false;

  if (room.table.length === 0) return handOf(room, room.attackerId).length > 0;

  const ranksSet = ranksOnTable(room);
  return handOf(room, room.attackerId).some(c => ranksSet.has(c.rank));
}

/* -------------------- Spēles darbības -------------------- */

function doAttack(room, playerId, cardIds){
  if (!room.started || room.turnId!==playerId || room.phase!=='attack') return;
  // pārbaude uz limitu
  const lim = Math.max(0, Math.min(handOf(room, room.defenderId).length - visibleTableCount(room), 6));
  if (cardIds.length<1 || cardIds.length>lim) return;

  // ja galdā ir rangi – drīkst tikai tos
  const ranks = ranksOnTable(room);
  const hand = handOf(room, playerId);
  const chosen = cardIds.map(id=>hand.find(c=>c.id===id)).filter(Boolean);
  const allRank = new Set(chosen.map(c=>c.rank));
  if (allRank.size!==1) return; // tikai viena ranga
  if (ranks.size>0 && !ranks.has(chosen[0].rank)) return;

  chosen.forEach(c=>{
    removeFromHand(room, playerId, c.id);
    room.table.push({attack:c});
  });

  pushLog(room, `${room.players[playerId].nick} uzbrūk ar ${chosen.map(c=>c.rank).join(',')}.`);
  room.turnId = room.defenderId;
  room.phase = 'defend';
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
    if (!beats(c, row.attack, trump)) continue;
    removeFromHand(room, playerId, c.id);
    row.defend = c;
  }

  pushLog(room, `${room.players[playerId].nick} aizstāvas.`);
  pushState(room);

  // Ja viss nosists
  if (room.table.every(r=>r.attack && r.defend)) {
    room.turnId = room.attackerId;
    room.phase  = "defend"; // uzbrucējs vēl var piemest (ja drīkst)

    // AUTO END, ja uzbrucējs ir BOT un vairs nevar piemest
    if (isBot(room, room.attackerId)) {
      if (!canAttackerThrowMore(room)) {
        pushLog(room, `BOT beidz metienu.`);
        nextRolesAfterDefended(room);
        pushState(room);
        botAct(room);
        return;
      }
    }

    pushState(room);
    botAct(room);
  }
}

function endAttack(room, playerId, force=false){
  if (!room.started) return;
  if (!force){
    if (room.turnId!==playerId) return;
    if (playerId!==room.attackerId) return;
    // drīkst beigt tikai ja nav nenosistu uzbrukumu
    if (room.table.some(r=>r.attack && !r.defend)) return;
  }
  pushLog(room, `${room.players[playerId].nick} beidz metienu.`);

  // nodedzinām
  clearTableToBurn(room);

  // pildām līdz 6 (vispirms uzbrucējs, tad aizstāvis — pēc “beigts metiens” noteikuma)
  dealUpTo6(room, room.attackerId);
  dealUpTo6(room, room.defenderId);

  // lomas apmainās
  const oldAtt = room.attackerId, oldDef = room.defenderId;
  room.attackerId = oldDef;
  room.defenderId = oldAtt;
  room.turnId = room.attackerId;
  room.phase = 'attack';

  pushState(room);
  botAct(room);
}

function take(room, playerId){
  if (room.turnId!==playerId || room.phase!=='defend') return;
  const mine = handOf(room, playerId);
  for (const row of room.table){
    if (row.attack) mine.push(row.attack);
    if (row.defend) mine.push(row.defend);
  }
  pushLog(room, `${room.players[playerId].nick} paņem metienu.`);
  clearTableToBurn(room);

  // iedodam līdz 6 uzbrucējam (jo aizstāvis ņēma)
  dealUpTo6(room, room.attackerId);
  // aizstāvis nesaņem, jo paņēma
  // lomas: uzbrucējs paliek uzbrucējs, aizstāvis nākamajam gājienam paliek aizstāvis
  room.turnId = room.attackerId;
  room.phase = 'attack';
  pushState(room);
  botAct(room);
}

/* -------------------- Socket notikumi -------------------- */

io.on('connection', (socket)=>{
  socket.on('create-room', ({nick, deckSize=52, soloBot=false}, cb)=>{
    const code = randomCode();
    const room = newRoom(code, deckSize);
    rooms.set(code, room);

    const pid = socket.id;
    room.players[pid] = { id: pid, nick: nick||'Spēlētājs', hand: [] };
    room.sockets[pid] = socket;
    room.playerOrder.push(pid);

    socket.join(code);

    pushLog(room, `${nick} izveido istabu ${code}.`);
    if (soloBot){
      const botId = `bot_${Math.random().toString(36).slice(2,7)}`;
      room.players[botId] = { id: botId, nick: 'BOT', hand: [], isBot: true };
      room.playerOrder.push(botId);
    }
    startGame(room);
    pushState(room);
    cb?.({ ok:true, code });
    botAct(room);
  });

  socket.on('join-room', ({code, nick}, cb)=>{
    const room = rooms.get(code);
    if (!room){ cb?.({ok:false, err:'Nav istabas.'}); return; }
    if (room.started && Object.keys(room.players).length>=2){
      cb?.({ok:false, err:'Istaba pilna.'}); return;
    }
    const pid = socket.id;
    room.players[pid] = { id: pid, nick: nick||'Spēlētājs', hand: [] };
    room.sockets[pid] = socket;
    room.playerOrder.push(pid);
    socket.join(code);
    pushLog(room, `${nick} pievienojas.`);
    if (!room.started && room.playerOrder.length>=2) startGame(room);
    pushState(room);
    cb?.({ ok:true });
    botAct(room);
  });

  socket.on('attack', ({code, cardIds})=>{
    const room = rooms.get(code); if (!room) return;
    doAttack(room, socket.id, cardIds||[]);
  });

  // aizstāvība: pairs = [{attackIndex, cardId}]
  socket.on('defend', ({code, pairs})=>{
    const room = rooms.get(code); if (!room) return;
    doDefend(room, socket.id, pairs||[]);
  });

  socket.on('end-attack', ({code})=>{
    const room = rooms.get(code); if (!room) return;
    endAttack(room, socket.id, false);
  });

  socket.on('take', ({code})=>{
    const room = rooms.get(code); if (!room) return;
    take(room, socket.id);
  });

  socket.on('disconnect', ()=>{
    for (const [code, room] of rooms.entries()){
      if (room.players[socket.id]){
        pushLog(room, `${room.players[socket.id].nick} atvienojās.`);
        delete room.players[socket.id];
        delete room.sockets[socket.id];
        room.playerOrder = room.playerOrder.filter(id=>id!==socket.id);
        // ja palika tikai BOT vai tukšs – istabu varētu pēc laika iztīrīt
        pushState(room);
      }
    }
  });
});

function pushState(room){
  io.to(room.code).emit('state', roomState(room));
}

function randomCode(){
  return Math.random().toString(36).slice(2,6).toUpperCase();
}

server.listen(PORT, ()=> console.log('Duraks server running on', PORT));
