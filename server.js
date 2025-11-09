// Duraks Online — Bugats Edition (v1.2.9)
// Galvenie labojumi: fiksēts metiena limits, aizstāvis nedrīkst piemest,
// BOT aizsardzība sedz visas atvērtās kārtis vai paņem, auto "Gājiens beigts" pēc 6s.

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(cors());
app.get('/', (_req, res) => res.send('Duraks serveris darbojas.'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST'] },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 3001;

// ────────────────────────────────────────────────────────────────────────────────
// Util

const SUITS_36 = ['♠','♥','♦','♣'];
const RANKS_36 = ['6','7','8','9','10','J','Q','K','A'];
const RANKS_52 = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function buildDeck(use52) {
  const ranks = use52 ? RANKS_52 : RANKS_36;
  const d = [];
  for (const s of SUITS_36) for (const r of ranks) d.push({ r, s });
  // sajaukt
  for (let i=d.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function rankValue(r, use52) {
  const arr = use52 ? RANKS_52 : RANKS_36;
  return arr.indexOf(r);
}
function cardEq(a,b){ return a.r===b.r && a.s===b.s; }

function removeCard(hand, c){
  const i = hand.findIndex(x=>cardEq(x,c));
  if (i>=0) hand.splice(i,1);
}

function canBeat(def, atk, trump, use52) {
  if (def.s === atk.s && rankValue(def.r,use52)>rankValue(atk.r,use52)) return true;
  if (def.s === trump && atk.s !== trump) return true;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────────
// Spēles telpas

const rooms = new Map();
/*
room = {
  id, use52, deck, stock:[], trump,
  players: { [id]: { id, nick, hand:[], isBot:boolean, seat:number, online:boolean } },
  order: [socketIds],   // sēdvietu secība pie apaļā galda
  attacker: 0,          // index iekš order
  phase: 'attack'|'defend',
  table: [ { attack:{r,s,by}, defend:{r,s,by}? } ],
  attackLimit: null,    // fiksēts metiena limits šim metienam
  closed: false,
  timers: { autoEnd:null },
  log: []
}
*/

function createRoom(deckSize=36) {
  const id = genCode();
  const use52 = (deckSize==52);
  const deck = buildDeck(use52);
  const trump = deck[deck.length-1].s;
  return {
    id, use52, deck, trump,
    stock: [...deck],
    players: {},
    order: [],
    attacker: 0,
    phase: 'attack',
    table: [],
    attackLimit: null,
    closed: false,
    timers: { autoEnd:null },
    log:[]
  };
}

function genCode() {
  const A='ABCDEFGHJKLMNPQRSTUVXYZ0123456789';
  let s=''; for(let i=0;i<4;i++) s+=A[Math.floor(Math.random()*A.length)];
  return s;
}

function currentDefenderId(room){
  if (!room.order.length) return null;
  const defIndex = (room.attacker+1)%room.order.length;
  return room.order[defIndex];
}

function dealUpTo6(room, pid){
  const p = room.players[pid]; if (!p) return;
  while (p.hand.length<6 && room.stock.length){
    p.hand.push(room.stock.shift());
  }
}

function pushLog(room, msg){
  room.log.push(msg);
  if (room.log.length>200) room.log.shift();
}

function publicState(room){
  const seats = room.order.map(id=>{
    const pl = room.players[id];
    return { id, nick:pl.nick, seat:pl.seat, count:pl.hand.length, isBot:pl.isBot };
  });
  return {
    id: room.id,
    trump: room.trump,
    use52: room.use52,
    stock: room.stock.length,
    phase: room.phase,
    attacker: room.order[room.attacker]||null,
    defender: currentDefenderId(room),
    table: room.table,
    seats,
    log: room.log,
    attackLimit: room.attackLimit
  };
}

function privateState(room, pid){
  const base = publicState(room);
  return { ...base, me: { id:pid, hand: room.players[pid]?.hand || [] } };
}

function broadcast(room){
  room.order.forEach(id=>{
    const s = io.sockets.sockets.get(id);
    if (s) s.emit('state', privateState(room, id));
  });
  // skatītāji/atkaitējušies?
  io.to(room.id).emit('state_public', publicState(room));
}

function scheduleAutoEnd(room){
  clearTimeout(room.timers.autoEnd);
  room.timers.autoEnd = setTimeout(()=>{
    // ja visas uzbr. kārtis nosegtas un fāze 'defend' – auto end
    const open = room.table.find(p=>p.attack && !p.defend);
    if (!open && room.phase==='defend'){
      endTurn(room,false);
    }
  }, 6000); // 6s kā prasīts
}

function endTurn(room, defenderTook){
  // aizvērt metienu, izdalīt kārtis, pārbīdīt uzbrucēju/ aizstāvi
  clearTimeout(room.timers.autoEnd);
  room.attackLimit = null;

  const defId = currentDefenderId(room);
  const atkId = room.order[room.attacker];

  if (defenderTook){
    // aizstāvis paņem visas kārtis
    const take = [];
    for (const p of room.table){
      if (p.attack) take.push(p.attack);
      if (p.defend) take.push(p.defend);
    }
    room.players[defId].hand.push(...take);
    pushLog(room, `${room.players[defId].nick} paņem.`);
    // uzbrucējs paliek tas pats
  } else {
    // metiens notīrās, gājiens beidzies – nākamais uzbrucējs ir aizstāvis
    room.attacker = (room.attacker+1)%room.order.length;
  }

  // notīra galdu
  room.table = [];

  // izdalām kārtis secībā: no uzbrucēja pulksteņrād. virzienā
  const drawOrder = [];
  for (let i=0;i<room.order.length;i++){
    drawOrder.push((room.attacker+i)%room.order.length);
  }
  for (const oi of drawOrder){
    const pid = room.order[oi];
    dealUpTo6(room, pid);
  }

  // izmest spēlētājus bez kārtīm (viņi uzvar)
  const toKick = room.order.filter(id=>room.players[id].hand.length===0);
  if (toKick.length){
    for (const id of toKick){
      pushLog(room, `${room.players[id].nick} pabeidza (bez kārtīm)!`);
      room.order = room.order.filter(x=>x!==id);
    }
    if (room.order.length<=1){
      // spēle galā
      room.closed = true;
      pushLog(room, `Spēle beigusies.`);
      broadcast(room);
      return;
    }
    // noregulējam uzbrucēju, lai nepārsniegtu
    room.attacker = room.attacker % room.order.length;
  }

  // nākamais cikls
  room.phase = 'attack';
  broadcast(room);
}

// ────────────────────────────────────────────────────────────────────────────────
// Socket notikumi

io.on('connection', (socket)=>{
  socket.on('createRoom', ({nick, deckSize=36, solo=false}, cb)=>{
    const room = createRoom(deckSize);
    rooms.set(room.id, room);
    socket.join(room.id);
    room.players[socket.id] = { id:socket.id, nick:nick||'Spēlētājs', hand:[], isBot:false, seat:0, online:true };
    room.order = [socket.id];
    // pievienojam BOT, ja solo
    if (solo){
      const botId = `bot-${genCode()}`;
      room.players[botId] = { id:botId, nick:'BOT', hand:[], isBot:true, seat:1, online:true };
      room.order.push(botId);
    }
    // sākam spēli (izdalām 6, trumps jau ir)
    for (const id of room.order) dealUpTo6(room, id);
    pushLog(room, `Istaba izveidota: ${room.id}`);
    cb?.({ ok:true, roomId: room.id });
    broadcast(room);
  });

  socket.on('joinRoom', ({nick, roomId}, cb)=>{
    const room = rooms.get(roomId);
    if (!room){ cb?.({ok:false, error:'Nav šādas istabas.'}); return; }
    if (room.order.length>=6){ cb?.({ok:false, error:'Istaba pilna.'}); return; }
    room.players[socket.id] = { id:socket.id, nick:nick||'Spēlētājs', hand:[], isBot:false, seat:room.order.length, online:true };
    room.order.push(socket.id);
    socket.join(room.id);
    if (room.stock.length) dealUpTo6(room, socket.id);
    pushLog(room, `${room.players[socket.id].nick} pievienojās.`);
    cb?.({ok:true});
    broadcast(room);
  });

  socket.on('state', ({roomId}, cb)=>{
    const room = rooms.get(roomId);
    if (!room){ cb?.({ok:false}); return; }
    cb?.({ ok:true, state: privateState(room, socket.id) });
  });

  // UZBRUKT — var likt vienu vai vairākas savas kārtis (ranks jābūt esošajiem uz galda, ja nav tukšs).
  socket.on('attack', ({roomId, cards}, cb)=>{
    const room = rooms.get(roomId);
    if (!room || room.closed){ cb?.({ok:false}); return; }
    if (room.order[room.attacker] !== socket.id){ cb?.({ok:false, error:'Nav tavs uzbrukums.'}); return; }

    const me = room.players[socket.id]; if (!me){ cb?.({ok:false}); return; }
    if (!Array.isArray(cards) || !cards.length){ cb?.({ok:false}); return; }

    // validācija: man šīs kārtis ir, un ranks (ja ne pirmais) ir uz galda
    // fiksēsim, vai galds bija tukšs pirms
    const wasEmpty = room.table.length===0;

    const ranksOnTable = new Set(room.table.flatMap(p=>[p.attack?.r, p.defend?.r]).filter(Boolean));
    const toPlace = [];
    for (const c of cards){
      if (!me.hand.find(h=>cardEq(h,c))) { cb?.({ok:false, error:'Nav tādas kārts rokā.'}); return; }
      if (!wasEmpty && !ranksOnTable.has(c.r)) { cb?.({ok:false, error:'Rangs nav uz galda.'}); return; }
      toPlace.push(c);
    }

    // limitējam pēc maksimālā atļautā metienā
    const limit = maxAttackCardsAllowed(room);
    const open = room.table.filter(p=>!p.defend).length;
    const canAdd = Math.max(0, limit - open);
    if (toPlace.length>canAdd){ cb?.({ok:false, error:'Par daudz kāršu šim metienam.'}); return; }

    for (const c of toPlace){
      removeCard(me.hand, c);
      room.table.push({ attack: { ...c, by: socket.id } });
    }

    // ja pirmais uzbrukums – fāze 'defend' un FIKSĒJAM LIMITU
    if (wasEmpty){
      room.phase = 'defend';
      const defId = currentDefenderId(room);
      room.attackLimit = Math.min(6, room.players[defId]?.hand?.length || 0);
    }

    pushLog(room, `${me.nick} uzbrūk ar ${toPlace.map(x=>x.r+x.s).join(', ')}`);
    broadcast(room);
    scheduleAutoEnd(room);
    cb?.({ok:true});
  });

  // PIEMEST — tikai citi uzbrucēji, aizstāvis nedrīkst
  socket.on('throwIn', ({roomId, cards}, cb)=>{
    const room = rooms.get(roomId);
    if (!room || room.phase!=='defend'){ cb?.({ok:false}); return; }
    const defIdNow = currentDefenderId(room);
    if (socket.id === defIdNow){ cb?.({ok:false, error:'Aizstāvis nedrīkst piemest metiena laikā.'}); return; }

    const me = room.players[socket.id]; if (!me){ cb?.({ok:false}); return; }
    const wasEmpty = room.table.length===0;
    if (wasEmpty){ cb?.({ok:false}); return; }

    const ranksOnTable = new Set(room.table.flatMap(p=>[p.attack?.r, p.defend?.r]).filter(Boolean));
    const limit = maxAttackCardsAllowed(room);
    const open = room.table.filter(p=>!p.defend).length;
    let canAdd = Math.max(0, limit - open);

    const add = [];
    for (const c of (cards||[])){
      if (!me.hand.find(h=>cardEq(h,c))) continue;
      if (!ranksOnTable.has(c.r)) continue;
      if (canAdd<=0) break;
      add.push(c); canAdd--;
    }
    if (!add.length){ cb?.({ok:false, error:'Nav ko piemest.'}); return; }

    for (const c of add){
      removeCard(me.hand, c);
      room.table.push({ attack: { ...c, by: socket.id } });
    }
    pushLog(room, `${me.nick} piemeta ${add.map(x=>x.r+x.s).join(', ')}`);
    broadcast(room);
    scheduleAutoEnd(room);
    cb?.({ok:true});
  });

  // AIZSARDZĪBA — nosist konkrētu uzbrukuma kārti
  socket.on('defend', ({roomId, attackIndex, card}, cb)=>{
    const room = rooms.get(roomId);
    if (!room || room.phase!=='defend'){ cb?.({ok:false}); return; }
    const defId = currentDefenderId(room);
    if (socket.id !== defId){ cb?.({ok:false, error:'Nav tavs aizsardzības gājiens.'}); return; }

    const me = room.players[socket.id];
    const slot = room.table[attackIndex];
    if (!slot || !slot.attack || slot.defend){ cb?.({ok:false}); return; }
    if (!me.hand.find(h=>cardEq(h,card))){ cb?.({ok:false}); return; }
    if (!canBeat(card, slot.attack, room.trump, room.use52)){ cb?.({ok:false, error:'Nevar nosist.'}); return; }

    removeCard(me.hand, card);
    slot.defend = { ...card, by: socket.id };

    pushLog(room, `${me.nick} nosit ${slot.attack.r}${slot.attack.s} ar ${card.r}${card.s}`);
    broadcast(room);

    // ja visas nosegtas – gaidām piemest vai auto-end
    scheduleAutoEnd(room);
    cb?.({ok:true});
  });

  // PAŅEMT
  socket.on('take', ({roomId}, cb)=>{
    const room = rooms.get(roomId);
    if (!room || room.phase!=='defend'){ cb?.({ok:false}); return; }
    const defId = currentDefenderId(room);
    if (socket.id !== defId){ cb?.({ok:false}); return; }
    endTurn(room, true);
    cb?.({ok:true});
  });

  // “Gājiens beigts” — tikai ja viss nosegs
  socket.on('endTurn', ({roomId}, cb)=>{
    const room = rooms.get(roomId);
    if (!room){ cb?.({ok:false}); return; }
    const open = room.table.find(p=>p.attack && !p.defend);
    if (open){ cb?.({ok:false, error:'Nav viss nosists.'}); return; }
    endTurn(room, false);
    cb?.({ok:true});
  });

  socket.on('disconnect', ()=>{
    // Nepilnīga logika skatītājiem/ātri nāks atpakaļ — šeit nepilnībā neatvienojam no spēles,
    // bet ja vajag – var noņemt.
  });
});

// ────────────────────────────────────────────────────────────────────────────────
// BOT loģika — vienkāršoti: uzbrukumā liek zemāko rangu, aizsardzībā sedz visu vai paņem

setInterval(()=>{
  for (const room of rooms.values()){
    if (room.closed || !room.order.length) continue;

    const atkId = room.order[room.attacker];
    const defId = currentDefenderId(room);
    const attacker = room.players[atkId];
    const defender = room.players[defId];

    // BOT uzbrukums
    if (room.phase==='attack' && attacker?.isBot){
      const ranksOnTable = new Set(room.table.flatMap(p=>[p.attack?.r, p.defend?.r]).filter(Boolean));
      // izvēlamies zemāko
      const hand = [...attacker.hand].sort((a,b)=>rankValue(a.r,room.use52)-rankValue(b.r,room.use52));
      const wasEmpty = room.table.length===0;
      let candidate = null;
      for (const c of hand){
        if (wasEmpty || ranksOnTable.has(c.r)) { candidate=c; break; }
      }
      if (candidate){
        const open = room.table.filter(p=>!p.defend).length;
        const limit = maxAttackCardsAllowed(room);
        if (open<limit){
          removeCard(attacker.hand,candidate);
          room.table.push({ attack:{...candidate, by: atkId} });
          if (wasEmpty){
            room.phase='defend';
            room.attackLimit = Math.min(6, defender?.hand?.length||0);
          }
          pushLog(room, `${attacker.nick} uzbrūk ar ${candidate.r}${candidate.s}`);
          broadcast(room);
          scheduleAutoEnd(room);
        } else {
          // vairs nevar — mēģinām beigt metienu (ja nekas nav atvērts)
          const openNow = room.table.find(p=>p.attack && !p.defend);
          if (!openNow) endTurn(room,false);
        }
      } else {
        const openNow = room.table.find(p=>p.attack && !p.defend);
        if (!openNow) endTurn(room,false);
      }
    }

    // BOT aizsardzība
    if (room.phase==='defend' && defender?.isBot){
      let progressed = false;
      while (true){
        const idx = room.table.findIndex(p=>p.attack && !p.defend);
        if (idx===-1) break;
        // izvēlamies lētāko, kas sedz
        const atk = room.table[idx].attack;
        const choice = defender.hand
          .filter(c=>canBeat(c, atk, room.trump, room.use52))
          .sort((a,b)=>rankValue(a.r,room.use52)-rankValue(b.r,room.use52))[0];
        if (choice){
          removeCard(defender.hand, choice);
          room.table[idx].defend = { ...choice, by: defId };
          pushLog(room, `${defender.nick} nosit ${atk.r}${atk.s} ar ${choice.r}${choice.s}`);
          progressed = true;
        } else {
          endTurn(room, true);
          progressed = true;
          break;
        }
      }
      if (progressed){
        broadcast(room);
        scheduleAutoEnd(room);
      }
    }
  }
}, 400);

// ────────────────────────────────────────────────────────────────────────────────

function maxAttackCardsAllowed(room){
  const defId = currentDefenderId(room);
  const fallback = Math.min(6, room.players[defId]?.hand?.length || 0);
  return room.attackLimit ?? fallback;
}

// ────────────────────────────────────────────────────────────────────────────────
server.listen(PORT, ()=>console.log('Duraks serveris klausās uz', PORT));
