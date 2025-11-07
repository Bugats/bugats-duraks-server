// Duraks Online — serveris (v1.2.6)
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.get("/", (_,res)=>res.send("Duraks serveris darbojas"));
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*"},
  path: "/socket.io"
});

// util
const RANKS_36 = [6,7,8,9,10,11,12,13,14];
const RANKS_52 = [2,3,4,5,6,7,8,9,10,11,12,13,14];
const SUITS = ["C","D","H","S"]; // ♣ ♦ ♥ ♠

function makeDeck(deckSize){
  const ranks = deckSize===36 ? RANKS_36 : RANKS_52;
  const deck = [];
  for(const s of SUITS){
    for(const r of ranks){
      deck.push({rank:r, suit:s});
    }
  }
  shuffle(deck);
  return deck;
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()* (i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } }
function dealToSix(state, pid){
  const hand = state.hands[pid];
  while(hand.length<6 && state.stock.length>0) hand.push(state.stock.pop());
}
function cardBeats(a,b,trump){
  if(!b) return false;
  if(a.suit===b.suit) return a.rank>b.rank;
  if(a.suit===trump && b.suit!==trump) return true;
  return false;
}
function equalRankToAnyOnTable(cardsOnTable, r){
  if(cardsOnTable.length===0) return true;
  const ranks = new Set();
  for(const p of cardsOnTable){
    ranks.add(p.attack.rank);
    if(p.defend) ranks.add(p.defend.rank);
  }
  return [...ranks].some(x=>x===r);
}
function genCode(){
  const chars="ABCDEFGHJKLMNPQRTUVWXYZ23456789";
  let s=""; for(let i=0;i<4;i++) s+=chars[(Math.random()*chars.length)|0];
  return s;
}
function ensureTwoPlayers(room){
  const ids = Object.keys(room.players);
  return ids.length===2;
}

// istabu stāvoklis
const rooms = Object.create(null);

// sūtīt state tikai “savējo” roku katram
function pushState(room){
  const base = {
    room: room.code,
    phase: room.phase,
    trump: room.trump,
    stockCount: room.stock.length,
    stack: room.stack,
    attackerId: room.attackerId,
    defenderId: room.defenderId,
    turnId: room.turnId,
  };

  const ids = Object.keys(room.players);
  ids.forEach(pid=>{
    const oppId = ids.find(x=>x!==pid);
    const st = {
      ...base,
      meId: pid,
      hands: { [pid]: room.hands[pid] }, // tikai savējo roku
      opponent: oppId ? { id: oppId, count: room.hands[oppId].length } : { id:null, count:0 }
    };
    io.to(pid).emit("state", st);
  });
}

// BOT (ļoti vienkāršs)
function maybeBotMove(room){
  // ja nav BOTa vai nav viņa kārta — nekā nedara
  if(!room.botId) return;
  if(room.turnId!==room.botId) return;

  const hand = room.hands[room.botId].slice().sort((a,b)=>a.rank-b.rank);
  const trump = room.trump;

  setTimeout(()=>{
    if(room.phase==="attack"){
      // bot uzbrūk ar zemāko pēc galda noteikumiem
      let chosen = null;
      for(const c of hand){
        if(equalRankToAnyOnTable(room.stack, c.rank)){ chosen=c; break; }
      }
      if(!chosen) { // nevar uzbrukt — beidz
        room.turnId = room.defenderId; // atdod gājienu aizstāvim (lai aizstāvos nav jēgas)
        pushState(room);
        return;
      }
      // veic uzbrukumu ar 1 kārti
      room.stack.push({attack:chosen, defend:null});
      room.hands[room.botId] = room.hands[room.botId].filter(x=>!(x.rank===chosen.rank && x.suit===chosen.suit));
      room.phase = "defend";
      room.turnId = room.defenderId;
      pushState(room);
    } else if(room.phase==="defend"){
      // aizstāvas ar mazāko sitamo
      let pairIndex = room.stack.findIndex(p=>!p.defend);
      if(pairIndex<0){ // viss nosists
        // paziņo uzbrucējam, ka var beigt metienu/pielikt
        pushState(room);
        return;
      }
      const atk = room.stack[pairIndex].attack;
      let chosen = null;
      for(const c of hand){
        if(cardBeats(c, atk, trump)) { chosen=c; break; }
      }
      if(!chosen){
        // paņem
        take(room, room.botId);
      }else{
        room.stack[pairIndex].defend = chosen;
        room.hands[room.botId] = room.hands[room.botId].filter(x=>!(x.rank===chosen.rank && x.suit===chosen.suit));
        // ja visi pāri nosisti — uzbrucējs var beigt
        pushState(room);
      }
    }
  }, 500);
}

// core loģika
function startRound(room){
  // iestrādā trumbi
  room.trump = room.stock[0].suit;
  // sāk uzbrucējs — mazākā trumbi rokā
  const ids = Object.keys(room.players);
  let best = null;
  for(const pid of ids){
    const minTrump = room.hands[pid].filter(c=>c.suit===room.trump).sort((a,b)=>a.rank-b.rank)[0];
    if(!best || (minTrump && minTrump.rank < best.rank)) best = {pid, rank: minTrump ? minTrump.rank : 999};
  }
  room.attackerId = best ? best.pid : ids[0];
  room.defenderId = ids.find(x=>x!==room.attackerId) || null;
  room.turnId = room.attackerId;
  room.phase = "attack";
}

function endTrickIfPossible(room){
  // Aizsargs nositis VISUS uzbruktos? Tad drīkst beigt
  if(room.stack.length>0 && room.stack.every(p=>p.defend)){
    // izmest kartes, iedalīt līdz 6 (sāk ar uzbrucēju), samainīt lomas
    room.discard.push(...room.stack.flatMap(p=>[p.attack, p.defend]));
    room.stack = [];

    const order = [room.attackerId, room.defenderId];
    for(const pid of order){
      dealToSix(room, pid);
    }
    // lomas mainās
    const oldAtk = room.attackerId;
    room.attackerId = room.defenderId;
    room.defenderId = oldAtk;
    room.turnId = room.attackerId;
    room.phase = "attack";

    pushState(room);
    maybeBotMove(room);
  }
}

function take(room, defenderId){
  // aizstāvam nav ar ko sist — paņem visas uzbruktās + nosistās
  const all = [];
  room.stack.forEach(p=>{
    all.push(p.attack);
    if(p.defend) all.push(p.defend);
  });
  room.hands[defenderId].push(...all);
  room.stack = [];

  // iedalīt līdz 6 sākot ar uzbrucēju
  const order = [room.attackerId, defenderId];
  for(const pid of order){
    dealToSix(room, pid);
  }
  // lomas NEMAINĀS — pēc paņemšanas uzbrucējs uzbrūk atkal
  room.turnId = room.attackerId;
  room.phase = "attack";
  pushState(room);
  maybeBotMove(room);
}

// socket
io.on("connection", (socket)=>{
  socket.emit("info","Savienots.");

  socket.on("createRoom", ({nick, deckSize, solo})=>{
    const code = genCode();
    const deck = makeDeck(deckSize||36);
    const room = {
      code,
      players: { [socket.id]: {id:socket.id, nick:nick||"Viesis"} },
      hands: { [socket.id]: [] },
      stock: deck,
      discard: [],
      stack: [],
      phase:"wait",
      trump:null,
      attackerId:null,
      defenderId:null,
      turnId:null,
      botId: solo ? "BOT_"+code : null
    };
    dealToSix(room, socket.id);
    rooms[code] = room;
    socket.join(code);
    socket.data.room = code;

    if(solo){
      // izveido BOTu
      const botId = room.botId;
      room.players[botId] = {id:botId, nick:"BOT"};
      room.hands[botId] = [];
      dealToSix(room, botId);
      startRound(room);
      pushState(room);
      io.to(socket.id).emit("room", code);
      maybeBotMove(room);
    }else{
      pushState(room);
      io.to(socket.id).emit("room", code);
      io.to(socket.id).emit("info", "Istaba izveidota: "+code);
    }
  });

  socket.on("joinRoom", ({nick, room:code})=>{
    const room = rooms[code];
    if(!room) return socket.emit("errorMsg","Nav istabas ar šādu kodu.");
    if(room.botId && Object.keys(room.players).length>=2) return socket.emit("errorMsg","Istaba pilna (solo).");
    if(!room.botId && Object.keys(room.players).length>=2) return socket.emit("errorMsg","Istaba pilna.");
    room.players[socket.id] = {id:socket.id, nick:nick||"Viesis"};
    room.hands[socket.id] = room.hands[socket.id] || [];
    dealToSix(room, socket.id);

    socket.join(code);
    socket.data.room = code;
    socket.emit("room", code);

    if(!room.attackerId && ensureTwoPlayers(room)) startRound(room);
    pushState(room);
  });

  socket.on("chat",(msg)=>{
    const code = socket.data.room; if(!code) return;
    const room = rooms[code]; if(!room) return;
    io.to(code).emit("chat", `${room.players[socket.id]?.nick||"Viesis"}: ${msg}`);
  });

  socket.on("attack", ({cards})=>{
    const code = socket.data.room; if(!code) return;
    const room = rooms[code]; if(!room) return;
    if(room.phase!=="attack" || room.turnId!==socket.id) return;
    const hand = room.hands[socket.id];
    if(!cards || !cards.length) return;

    // pārbauda: visi rangi der uz galda
    if(!cards.every(c=>equalRankToAnyOnTable(room.stack, c.rank))) return socket.emit("errorMsg","Rangs neatbilst esošajiem uz galda.");
    // nepārsniedz aizstāvja rokas lielumu
    const openPairs = room.stack.filter(p=>!p.defend).length;
    if(openPairs+cards.length > (room.hands[room.defenderId]||[]).length)
      return socket.emit("errorMsg","Nevar uzbrukt ar vairāk kā aizstāvis var nosist.");

    // izņem no rokas, pievieno pāros kā uzbrukumu
    for(const c of cards){
      const idx = hand.findIndex(x=>x.rank===c.rank && x.suit===c.suit);
      if(idx<0) return socket.emit("errorMsg","Kārts nav rokā.");
      hand.splice(idx,1);
      room.stack.push({attack:c, defend:null});
    }
    room.phase = "defend";
    room.turnId = room.defenderId;

    pushState(room);
    maybeBotMove(room);
  });

  socket.on("defend", ({pairIndex, card})=>{
    const code = socket.data.room; if(!code) return;
    const room = rooms[code]; if(!room) return;
    if(room.phase!=="defend" || room.defenderId!==socket.id) return;
    if(pairIndex==null || !room.stack[pairIndex] || room.stack[pairIndex].defend) return;

    const atk = room.stack[pairIndex].attack;
    const hand = room.hands[socket.id];
    const idx = hand.findIndex(x=>x.rank===card.rank && x.suit===card.suit);
    if(idx<0) return socket.emit("errorMsg","Kārts nav rokā.");
    const trump = room.trump;
    if(!cardBeats(card, atk, trump)) return socket.emit("errorMsg","Šī kārts nesit uzbrukumu.");

    // ieliek aizsardzību
    room.stack[pairIndex].defend = card;
    hand.splice(idx,1);

    // ja visi nosisti — atkal uzbrucēja kārta (var beigt/pielikt)
    room.turnId = room.attackerId;

    pushState(room);
    maybeBotMove(room);
  });

  socket.on("endTrick", ()=>{
    const code = socket.data.room; if(!code) return;
    const room = rooms[code]; if(!room) return;
    // beigt drīkst tikai uzbrucējs, ja VISS nosists
    if(room.turnId!==room.attackerId) return;
    if(!(room.stack.length>0 && room.stack.every(p=>p.defend))) return;
    endTrickIfPossible(room);
  });

  socket.on("take", ()=>{
    const code = socket.data.room; if(!code) return;
    const room = rooms[code]; if(!room) return;
    if(room.defenderId!==socket.id) return;
    take(room, socket.id);
  });

  socket.on("passAdd", ()=>{
    const code = socket.data.room; if(!code) return;
    const room = rooms[code]; if(!room) return;
    // vienkāršā interpretācija: uzbrucējs nepapildina — poga bez darbības (kontroles)
    pushState(room);
  });

  socket.on("disconnect", ()=>{
    const code = socket.data.room; if(!code) return;
    const room = rooms[code]; if(!room) return;
    if(room.players[socket.id]){
      delete room.players[socket.id];
      delete room.hands[socket.id];
      // ja palika tikai BOT vai tukša istaba — sakopt
      const ids = Object.keys(room.players).filter(x=> !room.botId || x!==room.botId);
      if(ids.length===0){ delete rooms[code]; }
      else pushState(room);
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, ()=> console.log("Duraks serveris klausās portā", PORT));
