// server.js — Duraks Online (Bugats Edition)
// Pilns Socket.IO serveris ar "atkārtotas pievienošanās tai pašai istabai" labojumu

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
  path: '/socket.io',
  cors: { origin: '*', methods: ['GET','POST'] }
});

// ====== Util ======
const rand = (n) => Math.floor(Math.random() * n);
const shuffle = (arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const short = () => Math.random().toString(36).slice(2,6).toUpperCase();

function makeDeck(size) {
  // size = 36 vai 52
  const suits = ['♠','♥','♦','♣'];
  // Rindu secība (3..A durakā; 2 nav 36 kāršu kolodā)
  const ranks36 = ['6','7','8','9','10','J','Q','K','A'];
  const ranks52 = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const ranks = size === 36 ? ranks36 : ranks52;
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({r, s});
  return shuffle(deck);
}

function rankValue(r) {
  const order = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  return order.indexOf(r);
}

function canBeat(a, b, trump) {
  // vai kārts a sit kārti b
  if (a.s === b.s && rankValue(a.r) > rankValue(b.r)) return true;
  if (a.s !== b.s && a.s === trump) return true;
  return false;
}

// ====== Istabu glabātuve ======
/**
room = {
  code, deckSize, started,
  deck, trump, stockCount,
  field: [ {attack:[card,...], defend:[card,...]} ... ],
  players: { socketId: {id,nick,hand: [card,...]} },
  sockets: { socketId: Socket },
  playerOrder: [socketId,...],
  turn: socketId,        // kurš uzbrūk / sāk
  phase: 'attack'|'defend'|'clean',
  log: []
}
*/
const rooms = new Map();

// ====== Palīgfunkcijas istabām ======
function pushLog(room, line) {
  room.log.unshift(line);
  room.log = room.log.slice(0,50);
}

function roomPublicState(room) {
  const players = Object.values(room.players).map(p => ({
    id: p.id,
    nick: p.nick,
    count: p.hand.length
  }));
  const meStates = {};
  for (const id of Object.keys(room.players)) {
    meStates[id] = {
      hand: room.players[id].hand
    };
  }

  // Vienkāršota galda reprezentācija (attack/defend pāri)
  const field = room.field.map(pair => ({
    attack: pair.attack,
    defend: pair.defend
  }));

  return {
    code: room.code,
    started: room.started,
    trump: room.trump,
    stockCount: room.stockCount,
    turn: room.turn,
    phase: room.phase,
    players,
    meStates,    // katram klientam sūtam, bet UI rādīs tikai savas rokas
    field,
    log: room.log
  };
}

function pushState(room) {
  const st = roomPublicState(room);
  for (const [id, sock] of Object.entries(room.sockets)) {
    // katram pieliekam viņa roku “me” iekšā
    const my = { ...st, me: st.meStates[id] || {hand: []} };
    sock.emit('state', my);
  }
}

function deal(room, pid, n) {
  const p = room.players[pid];
  while (p && p.hand.length < n && room.deck.length) {
    p.hand.push(room.deck.pop());
  }
}

function startGame(room) {
  if (room.started) return;
  room.started = true;

  // Izveidojam kolodu
  room.deck = makeDeck(room.deckSize);
  // Trumpi nosakām pēc pēdējās kārts masta
  const last = room.deck[room.deck.length - 1];
  room.trump = last.s;
  room.stockCount = room.deck.length;

  // Izdalām pa 6 kārtīm
  for (const id of room.playerOrder) deal(room, id, 6);

  // Sāk tas, kam mazākā trumpis (duraka klasika – šeit vienkāršoti: pirmais)
  room.turn = room.playerOrder[0];
  room.phase = 'attack';
  room.field = [];
  pushLog(room, `Spēle sākta. Trumps: ${room.trump}`);
}

function endRound(room, beaten) {
  // beaten = true => aizstāvis nosita, safiksē galds; false => aizstāvis ņem
  if (beaten) {
    room.field = [];
    // papildinām rokas līdz 6 – vispirms uzbrucējs, tad aizstāvis
    const order = [room.turn].concat(room.playerOrder.filter(x=>x!==room.turn));
    for (const id of order) deal(room, id, 6);
    // pārejam gājienu uz nākamo
    const idx = room.playerOrder.indexOf(room.turn);
    room.turn = room.playerOrder[(idx+1)%room.playerOrder.length];
    room.phase = 'attack';
  } else {
    // aizstāvis paņem visas kārtis no galda
    const defenderId = room.playerOrder.find(x => x !== room.turn);
    const takeCards = [];
    for (const pair of room.field) {
      takeCards.push(...pair.attack);
      if (pair.defend) takeCards.push(...pair.defend);
    }
    room.players[defenderId].hand.push(...takeCards);
    room.field = [];
    // papildinām rokas: vispirms uzbrucējs, tad aizstāvis
    const order = [room.turn, defenderId];
    for (const id of order) deal(room, id, 6);
    // uzbrucējs paliek tas pats
    room.phase = 'attack';
  }
  room.stockCount = room.deck.length;
}

// Vienkāršs BOTs (minimāli – demonstrācijai)
function botAct(room) {
  // ja nav BOTa vai nav sākts – nedarām neko
  const ids = room.playerOrder;
  const botId = ids.find(id => (room.players[id].nick||'').toUpperCase()==='BOT');
  if (!botId) return;

  const humanId = ids.find(id => id !== botId);
  if (!humanId) return;
  if (!room.started) return;

  setTimeout(()=> {
    if (room.phase === 'attack' && room.turn === botId) {
      // uzbrūk ar zemāko kārti
      const hand = room.players[botId].hand.slice().sort((a,b)=>rankValue(a.r)-rankValue(b.r));
      const card = hand[0];
      if (!card) return;
      // noņemam no rokas
      const idx = room.players[botId].hand.findIndex(c=>c.r===card.r && c.s===card.s);
      room.players[botId].hand.splice(idx,1);
      room.field.push({ attack:[card], defend:null });
      pushLog(room, `BOT uzbrūk ar ${card.r}${card.s}`);
      pushState(room);
    } else if (room.phase === 'defend' && room.turn !== botId) {
      // BOT aizstāvas, mēģina nosist pirmo nenosisto pāri
      const pair = room.field.find(p=>!p.defend);
      if (!pair) return;
      const hand = room.players[botId].hand;
      const beatable = hand.find(c=>canBeat(c, pair.attack[0], room.trump));
      if (beatable) {
        // no rokas ārā
        const idx = hand.findIndex(c=>c.r===beatable.r && c.s===beatable.s);
        hand.splice(idx,1);
        pair.defend = [beatable];
        pushLog(room, `BOT nosit ar ${beatable.r}${beatable.s}`);
        pushState(room);
      } else {
        // nevar nosist — paņem
        pushLog(room, `BOT paņem.`);
        endRound(room, false);
        pushState(room);
      }
    }
  }, 400);
}

// ====== Socket notikumi ======
io.on('connection', (socket)=>{
  socket.emit('hello', {id: socket.id});

  socket.on('create-room', ({nick, deckSize, soloBot}, cb)=>{
    try{
      const code = short();
      const room = {
        code,
        deckSize: (deckSize===36?36:52),
        started: false,
        deck: [],
        trump: null,
        stockCount: 0,
        field: [],
        players: {},
        sockets: {},
        playerOrder: [],
        turn: null,
        phase: 'attack',
        log: []
      };
      rooms.set(code, room);

      // pievieno radītāju
      room.players[socket.id] = { id: socket.id, nick: nick||'Spēlētājs', hand: [] };
      room.sockets[socket.id] = socket;
      room.playerOrder.push(socket.id);
      socket.join(code);

      // ja solo, pievieno BOT
      if (soloBot) {
        const botId = `bot-${code}`;
        room.players[botId] = { id: botId, nick: 'BOT', hand: [] };
        room.sockets[botId] = { emit: ()=>{} }; // BOTam nav tieša socketa
        room.playerOrder.push(botId);
      }

      pushLog(room, `${nick||'Spēlētājs'} izveido istabu ${code}.`);
      cb?.({ ok:true, code });
      pushState(room);

      // ja ir vismaz 2 spēlētāji — startē
      if (room.playerOrder.length >= 2) {
        startGame(room);
        pushState(room);
        botAct(room);
      }
    }catch(e){
      cb?.({ ok:false, err: 'Neizdevās izveidot istabu.'});
    }
  });

  // ======== LABOJUMS: atkārtota pievienošanās atļauta =========
  socket.on('join-room', ({code, nick}, cb)=>{
    const room = rooms.get(code);
    if (!room){ cb?.({ok:false, err:'Nav istabas.'}); return; }

    const pid = socket.id;

    // ✅ Ja šis pats klients jau ir istabā, uzskatām par veiksmīgu pievienošanos
    if (room.players[pid]) {
      cb?.({ ok:true, info:'Jau istabā' });
      pushState(room);
      return;
    }

    // Jau pilna istaba?
    if (room.started && Object.keys(room.players).length >= 2){
      cb?.({ok:false, err:'Istaba pilna.'}); return;
    }

    room.players[pid] = { id: pid, nick: nick||'Spēlētājs', hand: [] };
    room.sockets[pid] = socket;
    room.playerOrder.push(pid);
    socket.join(code);
    pushLog(room, `${nick||'Spēlētājs'} pievienojas.`);
    cb?.({ ok:true });

    // startē, ja divi
    if (!room.started && room.playerOrder.length>=2) startGame(room);

    pushState(room);
    botAct(room);
  });
  // =============================================================

  socket.on('attack', ({code, cards}, cb)=>{
    const room = rooms.get(code);
    if (!room){ cb?.({ok:false, err:'Nav istabas.'}); return; }
    if (room.turn !== socket.id || room.phase!=='attack'){
      cb?.({ok:false, err:'Nav tavs uzbrukuma gājiens.'}); return;
    }
    const p = room.players[socket.id];
    if (!p) { cb?.({ok:false, err:'Nav spēlētājs.'}); return; }
    // izņemam kārtis no rokas
    const use = [];
    for (const c of cards) {
      const i = p.hand.findIndex(h=>h.r===c.r && h.s===c.s);
      if (i!==-1) { use.push(p.hand[i]); p.hand.splice(i,1); }
    }
    if (!use.length) { cb?.({ok:false, err:'Nav ko likt.'}); return; }
    room.field.push({ attack: use, defend: null });
    pushLog(room, `${room.players[socket.id].nick} uzbrūk: ${use.map(x=>x.r+x.s).join(' ')}`);
    room.phase = 'defend';
    pushState(room);
    cb?.({ok:true});
    botAct(room);
  });

  socket.on('defend', ({code, card}, cb)=>{
    const room = rooms.get(code);
    if (!room){ cb?.({ok:false, err:'Nav istabas.'}); return; }
    if (room.turn === socket.id || room.phase!=='defend'){
      cb?.({ok:false, err:'Nav tavs aizsardzības gājiens.'}); return;
    }
    const p = room.players[socket.id];
    if (!p) { cb?.({ok:false, err:'Nav spēlētājs.'}); return; }
    const open = room.field.find(pair=>!pair.defend);
    if (!open){ cb?.({ok:false, err:'Nav ko sist.'}); return; }

    const i = p.hand.findIndex(h=>h.r===card.r && h.s===card.s);
    if (i===-1) { cb?.({ok:false, err:'Kārts nav rokā.'}); return; }
    const c = p.hand[i];

    if (!canBeat(c, open.attack[0], room.trump)) {
      cb?.({ok:false, err:'Ar šo kārti nosist nevar.'});
      return;
    }

    p.hand.splice(i,1);
    open.defend = [c];
    pushLog(room, `${room.players[socket.id].nick} nosit ar ${c.r}${c.s}`);
    pushState(room);
    cb?.({ok:true});
    botAct(room);
  });

  socket.on('end-turn', ({code}, cb)=>{
    const room = rooms.get(code);
    if (!room){ cb?.({ok:false, err:'Nav istabas.'}); return; }
    // aizstāvis beidz metienu, ja visas uzliktās uzbr. kārtis ir nosistas
    const allBeaten = room.field.length>0 && room.field.every(p=>p.defend && p.defend.length>0);
    if (!allBeaten) { cb?.({ok:false, err:'Nav nosists viss.'}); return; }
    pushLog(room, `Metiens beigts.`);
    endRound(room, true);
    pushState(room);
    cb?.({ok:true});
    botAct(room);
  });

  socket.on('take', ({code}, cb)=>{
    const room = rooms.get(code);
    if (!room){ cb?.({ok:false, err:'Nav istabas.'}); return; }
    pushLog(room, `${room.players[socket.id]?.nick||'Aizstāvis'} paņem.`);
    endRound(room, false);
    pushState(room);
    cb?.({ok:true});
    botAct(room);
  });

  socket.on('chat', ({code, text})=>{
    const room = rooms.get(code);
    if (!room) return;
    pushLog(room, `💬 ${room.players[socket.id]?.nick||'???'}: ${text}`);
    pushState(room);
  });

  socket.on('disconnect', ()=>{
    // var atstāt vienkāršu — istaba paliek, cilvēks vnk pazūd
    for (const [code, room] of rooms){
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        delete room.sockets[socket.id];
        room.playerOrder = room.playerOrder.filter(x=>x!==socket.id);
        pushLog(room, `Spēlētājs atvienojās.`);
        pushState(room);
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, ()=> console.log('Server on', PORT));
