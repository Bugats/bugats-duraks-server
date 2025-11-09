// Duraks Online — Bugats Edition (server v1.3.1)
// CommonJS; Express + Socket.IO
// 6 spēlētāji, auto “Gājiens beigts” (6s), eliminācija ar finishOrder,
// PRIVĀTĀS ROKAS: katram socketam sūtām tikai viņa paša hand caur 'me' eventu.

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.get('/', (_req, res) => res.send('Duraks Online server v1.3.1 running'));

const server = http.createServer(app);
const io = new Server(server, {
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET','POST'] }
});

/* ===== Konstantes ===== */
const MAX_PLAYERS = 6;
const RANKS36 = ['6','7','8','9','10','J','Q','K','A'];
const RANKS52 = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SUITS = ['♣','♦','♥','♠'];

/* ===== Util ===== */
const rand = (n)=>Math.floor(Math.random()*n);
const shuffle = (a)=>{ for(let i=a.length-1;i>0;i--){const j=rand(i+1);[a[i],a[j]]=[a[j],a[i]];} return a; };
const rankValue = (r, use52)=> (use52 ? RANKS52 : RANKS36).indexOf(r);

function makeDeck(use52){
  const ranks = use52 ? RANKS52 : RANKS36;
  const d=[]; for(const s of SUITS) for(const r of ranks) d.push({r,s});
  return shuffle(d);
}
function canBeat(def, atk, trump, use52){
  if (!def || !atk) return false;
  if (def.s === atk.s && rankValue(def.r,use52) > rankValue(atk.r,use52)) return true;
  if (def.s === trump && atk.s !== trump) return true;
  return false;
}
function takeTop(deck){ return deck.shift(); }

/* ===== Rooms ===== */
/*
room = {
  id, use52, deck, trump, faceDownTrump,
  order:[socketId...], players:{ id:{nick,hand:Card[],isBot:boolean} },
  attacker:number, table:[{attack:{r,s,by}, defend?:{r,s,by}}], phase:'attack'|'defend',
  autoEndTimer, log:string[], finishOrder:string[], closed:boolean
}
*/
const ROOMS = new Map();

/* ===== Helpers ===== */
function pushLog(room, line){ room.log.push(line); io.to(room.id).emit('log', line); }
function publicState(room){
  const stockCount = room.deck.length + (room.faceDownTrump ? 1 : 0);
  const defender = (room.order.length ? (room.attacker + 1) % room.order.length : 0);
  return {
    id: room.id,
    use52: room.use52,
    trump: room.trump,
    stockCount,
    phase: room.phase,
    attacker: room.attacker,
    defender,
    order: room.order,
    players: Object.fromEntries(room.order.map(pid => [pid, { nick: room.players[pid]?.nick || '??', handCount: room.players[pid]?.hand.length||0 }])),
    table: room.table,
    log: room.log.slice(-120),
    finishOrder: room.finishOrder,
    closed: !!room.closed
  };
}
function pushState(room){
  io.to(room.id).emit('state', publicState(room));
  pushHands(room); // ← sūtām privātās rokas visiem dalībniekiem
}
function pushHands(room){
  for (const pid of room.order){
    const p = room.players[pid];
    if (!p) continue;
    // katram spēlētājam — tikai viņa roka
    io.to(pid).emit('me', { hand: p.hand });
  }
}
function nextIdx(room, idx){ const n = room.order.length; return (idx + 1) % n; }
function currentDefenderId(room){ return room.order[nextIdx(room, room.attacker)]; }
function drawToSix(room, pid){
  const p = room.players[pid]; if (!p) return;
  while (p.hand.length < 6) {
    if (room.deck.length) p.hand.push(takeTop(room.deck));
    else if (room.faceDownTrump) { p.hand.push(room.faceDownTrump); room.faceDownTrump = null; }
    else break;
  }
}
function refillAfterTurn(room){
  const start = room.attacker;
  for (let k=0;k<room.order.length;k++){
    const idx = (start + k) % room.order.length;
    drawToSix(room, room.order[idx]);
  }
}
function removeFromOrder(room, pid){
  room.order = room.order.filter(x=>x!==pid);
  if (room.attacker >= room.order.length) room.attacker = 0;
}
function tableAllDefended(room){ return room.table.length>0 && room.table.every(p => p.attack && p.defend); }
function maxAttackCardsAllowed(room){
  const defId = currentDefenderId(room);
  const defenderHand = room.players[defId]?.hand?.length || 0;
  return Math.min(6, defenderHand);
}
function countCurrentAttacks(room){ return room.table.filter(p=>p.attack).length; }
function ranksOnTable(room){
  const s = new Set();
  for (const p of room.table){ if (p.attack) s.add(p.attack.r); if (p.defend) s.add(p.defend.r); }
  return s;
}
function canThrowRanks(room, ranks){ if (room.table.length===0) return true; const allowed=ranksOnTable(room); return ranks.every(r=>allowed.has(r)); }

/* ===== Game Flow ===== */
function startGame(room){
  room.deck = makeDeck(room.use52);
  room.faceDownTrump = room.deck[room.deck.length-1];
  room.trump = room.faceDownTrump.s;
  for (const pid of room.order) drawToSix(room, pid);

  // izvēlas sākuma uzbrucēju (zemākais trumpis, citādi zemākā)
  let bestIdx = 0, bestCard = lowestStarter(room.players[room.order[0]].hand, room.trump, room.use52);
  for (let i=1;i<room.order.length;i++){
    const pid = room.order[i];
    const c = lowestStarter(room.players[pid].hand, room.trump, room.use52);
    if (compareStarter(c, bestCard, room.trump, room.use52) < 0) { bestIdx = i; bestCard = c; }
  }
  room.attacker = bestIdx;
  room.phase = 'attack';
  room.table = [];
  room.log = [];
  room.finishOrder = [];
  room.closed = false;
  pushLog(room, `Spēle sākta. Trumpis: ${room.trump}`);
  pushState(room);
}
function lowestStarter(hand, trump, use52){
  const tr = hand.filter(c=>c.s===trump).sort((a,b)=>rankValue(a.r,use52)-rankValue(b.r,use52));
  if (tr.length) return tr[0];
  return hand.slice().sort((a,b)=>rankValue(a.r,use52)-rankValue(b.r,use52))[0] || null;
}
function compareStarter(a,b,trump,use52){
  if (!a && !b) return 0; if (!a) return 1; if (!b) return -1;
  if (a.s===trump && b.s!==trump) return -1;
  if (a.s!==trump && b.s===trump) return 1;
  return rankValue(a.r,use52) - rankValue(b.r,use52);
}
function clearAutoEnd(room){ if (room.autoEndTimer){ clearTimeout(room.autoEndTimer); room.autoEndTimer=null; } }
function scheduleAutoEnd(room){
  clearAutoEnd(room);
  if (room.phase!=='defend' || !tableAllDefended(room)) return;
  room.autoEndTimer = setTimeout(()=>{
    if (room.phase==='defend' && tableAllDefended(room)) {
      pushLog(room, 'Gājiens beigts automātiski (6 s bez darbībām).');
      endTurn(room, false);
    }
  }, 6000);
}
function endTurn(room, defenderTook){
  clearAutoEnd(room);

  if (defenderTook){
    const defId = currentDefenderId(room);
    const pile = [];
    for (const p of room.table){ if (p.attack) pile.push(p.attack); if (p.defend) pile.push(p.defend); }
    room.players[defId]?.hand.push(...pile);
    pushLog(room, `${room.players[defId]?.nick||'Aizstāvis'} paņēma kārtis.`);
  } else {
    pushLog(room, 'Gājiens beigts.');
  }
  room.table = [];

  refillAfterTurn(room);

  checkEliminations(room);
  if (room.closed){ pushState(room); return; }

  if (!defenderTook) room.attacker = nextIdx(room, room.attacker);
  room.phase = 'attack';
  pushState(room);
  botMaybeAct(room);
}
function checkEliminations(room){
  let removed = false;
  for (const pid of [...room.order]){
    const p = room.players[pid]; if (!p) continue;
    if (p.hand.length===0){
      room.finishOrder.push(pid);
      pushLog(room, `${p.nick} pabeidza (nav kāršu).`);
      delete room.players[pid];
      removeFromOrder(room, pid);
      removed = true;
    }
  }
  if (room.order.length===1){
    const last = room.order[0];
    if (last){
      pushLog(room, `Spēle beigusies. Duraks: ${room.players[last]?.nick||'???'}`);
      room.closed = true;
    }
  }
  if (removed && room.order.length>0){
    room.attacker = room.attacker % room.order.length;
  }
}

/* ===== BOT ===== */
function botMaybeAct(room){
  if (room.closed) return;
  const attackerId = room.order[room.attacker];
  const defenderId = currentDefenderId(room);
  if (room.phase==='attack' && room.players[attackerId]?.isBot) setTimeout(()=>botAttack(room, attackerId), 700 + rand(500));
  if (room.phase==='defend' && room.players[defenderId]?.isBot) setTimeout(()=>botDefend(room, defenderId), 700 + rand(500));
}
function botAttack(room, botId){
  if (room.closed || room.phase!=='attack') return;
  const me = room.players[botId]; if (!me) return;
  const sorted = me.hand.slice().sort((a,b)=>{
    const at = a.s===room.trump, bt = b.s===room.trump;
    if (at!==bt) return at - bt;
    return rankValue(a.r, room.use52) - rankValue(b.r, room.use52);
  });
  let toPlay = null;
  for (const c of sorted){ if (canThrowRanks(room, [c.r])) { toPlay = c; break; } }
  if (!toPlay){ endTurn(room, false); return; }

  const limit = maxAttackCardsAllowed(room);
  const currentAtk = countCurrentAttacks(room);
  if (currentAtk >= limit){ endTurn(room, false); return; }

  removeCard(me.hand, toPlay);
  room.table.push({ attack: { ...toPlay, by: botId } });
  room.phase = 'defend';
  pushLog(room, `${me.nick} uzbrūk ar ${toPlay.r}${toPlay.s}`);
  pushState(room);
  scheduleAutoEnd(room);
  botMaybeAct(room);
}
function botDefend(room, botId){
  if (room.closed || room.phase!=='defend') return;
  const me = room.players[botId]; if (!me) return;
  const idx = room.table.findIndex(p=>p.attack && !p.defend);
  if (idx===-1){ scheduleAutoEnd(room); return; }
  const atk = room.table[idx].attack;
  const can = me.hand.filter(c=>canBeat(c, atk, room.trump, room.use52))
                     .sort((a,b)=>rankValue(a.r,room.use52)-rankValue(b.r,room.use52))[0];
  if (can){
    removeCard(me.hand, can);
    room.table[idx].defend = { ...can, by: botId };
    pushLog(room, `${me.nick} nosit ar ${can.r}${can.s}`);
    pushState(room);
    scheduleAutoEnd(room);
  } else {
    endTurn(room, true);
  }
}
function removeCard(hand, c){
  const i = hand.findIndex(x=>x.r===c.r && x.s===c.s);
  if (i>-1) hand.splice(i,1);
}

/* ===== Socket.IO ===== */
io.on('connection', (socket)=>{
  socket.data.nick = 'Spēlētājs';

  const emitError = (m)=>socket.emit('errorMsg', m);

  const onCreateRoom = ({ nick, deckSize=36, soloBot=false }, cb) => {
    try{
      const id = genCode();
      const room = {
        id,
        use52: Number(deckSize) === 52,
        deck: [],
        trump: null,
        faceDownTrump: null,
        order: [],
        players: {},
        attacker: 0,
        table: [],
        phase: 'attack',
        autoEndTimer: null,
        log: [],
        finishOrder: [],
        closed: false
      };
      ROOMS.set(id, room);

      room.players[socket.id] = { nick: nick||'Spēlētājs', hand: [], isBot:false };
      room.order.push(socket.id);
      socket.join(id);
      socket.data.roomId = id;
      socket.data.nick = nick||'Spēlētājs';

      if (soloBot){
        const botId = `BOT_${id}`;
        room.players[botId] = { nick: 'BOT', hand: [], isBot:true };
        room.order.push(botId);
      }

      if (room.order.length>=2) startGame(room);

      cb?.({ ok:true, roomId:id });
      socket.emit('created', { roomId:id });
      pushState(room);
      botMaybeAct(room);
    }catch(e){
      cb?.({ ok:false, error:'Neizdevās izveidot istabu' });
      emitError('Neizdevās izveidot istabu');
    }
  };

  const onJoinRoom = ({ roomId, code, nick }, cb) => {
    const id = (roomId||code||'').toUpperCase();
    const room = ROOMS.get(id);
    if (!room) { cb?.({ok:false,error:'Nav istabas.'}); return emitError('Nav istabas.'); }
    if (room.closed) { cb?.({ok:false,error:'Spēle jau beigusies.'}); return emitError('Spēle jau beigusies.'); }
    if (room.order.length >= MAX_PLAYERS) { cb?.({ok:false,error:'Istaba pilna.'}); return emitError('Istaba pilna.'); }
    if (room.players[socket.id]) { cb?.({ok:true}); pushState(room); return; }

    room.players[socket.id] = { nick: nick||'Spēlētājs', hand: [], isBot:false };
    room.order.push(socket.id);
    socket.join(id);
    socket.data.roomId = id;
    socket.data.nick = nick||'Spēlētājs';
    pushLog(room, `${socket.data.nick} pievienojās. (${room.order.length}/${MAX_PLAYERS})`);

    // Ja spēle jau sākta — pievelkam līdz 6 (vienkāršots late-join)
    if (room.deck.length || room.faceDownTrump){ drawToSix(room, socket.id); }

    cb?.({ok:true});
    pushState(room);
  };

  const onLeave = (_data, cb)=>{
    const room = getRoom(socket);
    if (!room) return cb?.({ok:true});
    pushLog(room, `${socket.data.nick} atvienojās.`);
    delete room.players[socket.id];
    removeFromOrder(room, socket.id);
    socket.leave(room.id);
    checkEliminations(room);
    pushState(room);
    cb?.({ok:true});
  };

  const onAttack = ({ cards, code, roomId }, cb)=>{
    const room = roomByCodeOrCurrent(socket, roomId||code);
    if (!room) { cb?.({ok:false,error:'Nav istabas.'}); return; }
    if (room.closed) return;
    const attackerId = room.order[room.attacker];
    if (socket.id !== attackerId || room.phase!=='attack'){
      cb?.({ok:false,error:'Nav tavs uzbrukuma gājiens.'}); return;
    }
    if (!Array.isArray(cards) || cards.length<1) { cb?.({ok:false,error:'Nav ko likt.'}); return; }

    const ranks = cards.map(c=>c.r);
    if (!canThrowRanks(room, ranks)) { cb?.({ok:false,error:'Var piemest tikai ar rangu, kas jau uz galda.'}); return; }
    const limit = maxAttackCardsAllowed(room);
    const currentAtk = countCurrentAttacks(room);
    if (currentAtk + cards.length > limit) { cb?.({ok:false,error:'Pārsniedz metiena limitu.'}); return; }

    const me = room.players[socket.id];
    const approved = [];
    for (const c of cards){
      const i = me.hand.findIndex(h=>h.r===c.r && h.s===c.s);
      if (i>-1){ approved.push(me.hand[i]); me.hand.splice(i,1); }
    }
    if (!approved.length){ cb?.({ok:false,error:'Kārtis nav rokā.'}); return; }

    for (const c of approved){ room.table.push({ attack: { ...c, by: socket.id } }); }
    room.phase = 'defend';
    pushLog(room, `${me.nick} uzbrūk ar ${approved.map(c=>c.r+c.s).join(', ')}`);
    pushState(room);
    scheduleAutoEnd(room);
    cb?.({ok:true});
    botMaybeAct(room);
  };

  const onThrowIn = ({ cards }, cb)=>{
    const room = getRoom(socket); if (!room) return;
    if (room.closed) return;
    if (room.phase!=='defend'){ cb?.({ok:false,error:'Piemest drīkst aizsardzības fāzē.'}); return; }
    if (!Array.isArray(cards) || cards.length<1) { cb?.({ok:false,error:'Nav ko piemest.'}); return; }

    const limit = maxAttackCardsAllowed(room);
    const currentAtk = countCurrentAttacks(room);
    if (currentAtk >= limit){ cb?.({ok:false,error:'Sasniegts metiena limits.'}); return; }
    const ranks = cards.map(c=>c.r);
    if (!canThrowRanks(room, ranks)) { cb?.({ok:false,error:'Var piemest tikai ar rangu, kas jau uz galda.'}); return; }

    const me = room.players[socket.id]; if (!me) { cb?.({ok:false,error:'Nav spēlētājs.'}); return; }
    const toAdd = [];
    for (const c of cards){
      if (countCurrentAttacks(room)+toAdd.length >= limit) break;
      const i = me.hand.findIndex(h=>h.r===c.r && h.s===c.s);
      if (i>-1){ toAdd.push(me.hand[i]); me.hand.splice(i,1); }
    }
    if (!toAdd.length) { cb?.({ok:false,error:'Kārtis nav rokā.'}); return; }

    for (const c of toAdd){ room.table.push({ attack: { ...c, by: socket.id } }); }
    pushLog(room, `${me.nick} piemeta ${toAdd.map(c=>c.r+c.s).join(', ')}`);
    pushState(room);
    scheduleAutoEnd(room);
    cb?.({ok:true});
    botMaybeAct(room);
  };

  const onDefend = ({ attackIndex, card }, cb)=>{
    const room = getRoom(socket); if (!room) return;
    if (room.closed) return;
    const defenderId = currentDefenderId(room);
    if (socket.id !== defenderId || room.phase!=='defend'){
      cb?.({ok:false,error:'Nav tavs aizsardzības gājiens.'}); return;
    }
    let idx = typeof attackIndex==='number' ? attackIndex : room.table.findIndex(p=>p.attack && !p.defend);
    if (idx<0 || !room.table[idx] || room.table[idx].defend){ cb?.({ok:false,error:'Nav ko sist.'}); return; }
    const atk = room.table[idx].attack;

    const me = room.players[socket.id];
    const i = me.hand.findIndex(h=>h.r===card.r && h.s===card.s);
    if (i===-1){ cb?.({ok:false,error:'Kārts nav rokā.'}); return; }
    const c = me.hand[i];
    if (!canBeat(c, atk, room.trump, room.use52)){ cb?.({ok:false,error:'Ar šo kārti nosist nevar.'}); return; }

    me.hand.splice(i,1);
    room.table[idx].defend = { ...c, by: socket.id };
    pushLog(room, `${me.nick} nosit ${atk.r}${atk.s} ar ${c.r}${c.s}`);
    pushState(room);
    scheduleAutoEnd(room);
    cb?.({ok:true});
    botMaybeAct(room);
  };

  const onTake = (_data, cb)=>{
    const room = getRoom(socket); if (!room) return;
    if (room.closed) return;
    const defenderId = currentDefenderId(room);
    if (socket.id !== defenderId || room.phase!=='defend'){
      cb?.({ok:false,error:'Paņemt drīkst tikai aizstāvis.'}); return;
    }
    endTurn(room, true);
    cb?.({ok:true});
  };

  const onEndTurn = (_data, cb)=>{
    const room = getRoom(socket); if (!room) return;
    if (room.closed) return;
    const attackerId = room.order[room.attacker];
    if (socket.id !== attackerId){ cb?.({ok:false,error:'Beigt gājienu drīkst tikai uzbrucējs.'}); return; }
    if (room.phase!=='defend' || !tableAllDefended(room)){ cb?.({ok:false,error:'Visām uzbrukuma kārtīm jābūt nosegtām.'}); return; }
    endTurn(room, false);
    cb?.({ok:true});
  };

  const onChat = ({ text })=>{
    const room = getRoom(socket); if (!room) return;
    pushLog(room, `💬 ${socket.data.nick}: ${String(text||'').slice(0,160)}`);
    pushState(room);
  };

  socket.on('disconnect', ()=>{
    const room = getRoom(socket);
    if (!room) return;
    pushLog(room, `${socket.data.nick} atvienojās.`);
    delete room.players[socket.id];
    removeFromOrder(room, socket.id);
    checkEliminations(room);
    pushState(room);
  });

  // Abi nosaukumi
  socket.on('createRoom', onCreateRoom);
  socket.on('create-room', onCreateRoom);
  socket.on('joinRoom', onJoinRoom);
  socket.on('join-room', onJoinRoom);
  socket.on('leaveRoom', onLeave);
  socket.on('leave-room', onLeave);
  socket.on('attack', onAttack);
  socket.on('throwIn', onThrowIn);
  socket.on('throw-in', onThrowIn);
  socket.on('defend', onDefend);
  socket.on('take', onTake);
  socket.on('endTurn', onEndTurn);
  socket.on('end-turn', onEndTurn);
  socket.on('chat', onChat);
});

/* ===== Palīgi ===== */
function genCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<4;i++) s+=chars[rand(chars.length)];
  if (ROOMS.has(s)) return genCode();
  return s;
}
function getRoom(socket){
  const id = socket.data.roomId;
  if (!id) return null;
  return ROOMS.get(id)||null;
}
function roomByCodeOrCurrent(socket, code){
  if (code) return ROOMS.get(code)||null;
  return getRoom(socket);
}

/* ===== Start ===== */
const PORT = process.env.PORT || 3001;
server.listen(PORT, ()=>console.log('Duraks server v1.3.1 listening on', PORT));
