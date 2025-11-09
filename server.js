const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.get("/", (_, res) => res.send("Duraks serveris darbojas"));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, path: "/socket.io" });

/* ====== Palīgfunkcijas un konstantes ====== */
const RANKS_36 = [6,7,8,9,10,11,12,13,14];
const RANKS_52 = [2,3,4,5,6,7,8,9,10,11,12,13,14];
const SUITS = ["C","D","H","S"];

const rooms = Object.create(null);

const shuffle = (a)=>{ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } };
const makeDeck = (n)=>{ const ranks=n===36?RANKS_36:RANKS_52; const d=[]; for(const s of SUITS){ for(const r of ranks){ d.push({rank:r,suit:s}); } } shuffle(d); return d; };

const dealToSix = (room,pid)=>{ const h=room.hands[pid]; while(h.length<6 && room.stock.length) h.push(room.stock.pop()); };
const cardBeats = (a,b,t)=> (a.suit===b.suit && a.rank>b.rank) || (a.suit===t && b.suit!==t);

const ranksOnTable = (stack)=>{
  const s=new Set();
  for(const p of stack){ s.add(p.attack.rank); if(p.defend) s.add(p.defend.rank); }
  return s;
};
const equalRankToAnyOnTable = (stack, r)=>{
  if(!stack.length) return true;
  const rs = ranksOnTable(stack);
  return rs.has(r);
};
const genCode=()=>{ const ch="ABCDEFGHJKLMNPQRTUVWXYZ23456789"; let s=""; for(let i=0;i<4;i++) s+=ch[(Math.random()*ch.length)|0]; return s; };

/* ====== Stāvokļa nosūtīšana ====== */
function pushState(room){
  const base = {
    room: room.code,
    phase: room.phase,
    trump: room.trump,
    stockCount: room.stock.length,
    stack: room.stack,
    attackerId: room.attackerId,
    defenderId: room.defenderId,
    turnId: room.turnId
  };
  const ids=Object.keys(room.players);
  ids.forEach(pid=>{
    const opp = ids.find(x=>x!==pid);
    const st = { ...base,
      meId: pid,
      hands: { [pid]: room.hands[pid] },
      opponent: opp ? { id: opp, count: room.hands[opp].length } : { id:null, count:0 }
    };
    io.to(pid).emit("state", st);
  });
}

/* ====== Raunda starts / beigas ====== */
function startRound(room){
  room.trump = room.stock[0].suit;
  const ids = Object.keys(room.players);
  // Uzbrucēju nosakam pēc zemākās trumfa kārts
  let best = null;
  for(const pid of ids){
    const minTrump = room.hands[pid].filter(c=>c.suit===room.trump).sort((a,b)=>a.rank-b.rank)[0];
    if(!best || (minTrump && minTrump.rank < best.rank)) best = { pid, rank: minTrump ? minTrump.rank : 999 };
  }
  room.attackerId = best ? best.pid : ids[0];
  room.defenderId = ids.find(x=>x!==room.attackerId) || null;
  room.turnId = room.attackerId;
  room.phase = "attack";
}

function endTrickIfPossible(room){
  if(room.stack.length && room.stack.every(p=>p.defend)){
    room.discard.push(...room.stack.flatMap(p=>[p.attack,p.defend]));
    room.stack = [];
    // iedod no kavām (sāk uzbrucējs)
    for(const pid of [room.attackerId, room.defenderId]) dealToSix(room, pid);
    // mainām lomas
    [room.attackerId, room.defenderId] = [room.defenderId, room.attackerId];
    room.turnId = room.attackerId;
    room.phase = "attack";
    pushState(room);
  }
}

function take(room, defenderId){
  const all=[]; room.stack.forEach(p=>{ all.push(p.attack); if(p.defend) all.push(p.defend); });
  room.hands[defenderId].push(...all);
  room.stack = [];
  for(const pid of [room.attackerId, defenderId]) dealToSix(room, pid);
  room.turnId = room.attackerId;
  room.phase = "attack";
  pushState(room);
}

/* ====== BOT AI ====== */
function sortCheapFirst(cards, trump){
  // ne-trumpi (augšā), tad trumpi; iekšā pēc ranga augošā
  return [...cards].sort((a,b)=>{
    const aT = a.suit===trump, bT = b.suit===trump;
    if(aT!==bT) return aT?1:-1;
    return a.rank - b.rank;
  });
}

function botAttack(room){
  const id=room.botId, hand=room.hands[id];
  if(!hand.length) return false;

  const defenderLeft = room.hands[room.defenderId].length;
  const open = room.stack.filter(p=>!p.defend).length;
  let canOpen = Math.max(0, defenderLeft - open);
  if(canOpen<=0) return false;

  const sorted = sortCheapFirst(hand, room.trump);
  const toPlay=[];

  if(room.stack.length===0){
    // Pirmais uzbrukums: izvēlas lētāko rangu un met tikai TO rangu
    const base = sorted[0];
    const sameRank = sorted.filter(c=>c.rank===base.rank);
    for(const c of sameRank){
      if(!canOpen) break;
      toPlay.push(c);
      canOpen--;
    }
  } else {
    // Turpmāk – tikai rangi, kas jau ir uz galda
    const allowed = ranksOnTable(room.stack);
    for(const c of sorted){
      if(!canOpen) break;
      if(allowed.has(c.rank)){
        toPlay.push(c);
        canOpen--;
      }
    }
  }

  if(!toPlay.length) return false;

  // izņem no rokas un iemet galdā
  for(const c of toPlay){
    const i = hand.findIndex(x=>x.rank===c.rank && x.suit===c.suit);
    if(i>-1){ hand.splice(i,1); room.stack.push({attack:c, defend:null}); }
  }
  room.phase="defend"; room.turnId=room.defenderId;
  pushState(room);
  return true;
}

function botDefend(room){
  const id=room.botId, hand=room.hands[id];
  const openIdx = room.stack.map((p,i)=>!p.defend?i:null).filter(i=>i!==null);
  // mēģinām nosist katru atvērtu uzbrukuma kārti; ja kaut vienu nevaram -> ņemam
  for(const i of openIdx){
    const atk = room.stack[i].attack;
    const beaters = sortCheapFirst(hand.filter(c=>cardBeats(c, atk, room.trump)), room.trump);
    if(!beaters.length){
      take(room, id);
      return true;
    }
    const card = beaters[0];
    const idx = hand.findIndex(x=>x.rank===card.rank && x.suit===card.suit);
    hand.splice(idx,1);
    room.stack[i].defend = card;
  }

  // ja visi pāri nosisti — uzbrucējs (iesk. BOT) var beigt
  if(room.stack.length && room.stack.every(p=>p.defend)){
    room.turnId = room.attackerId;
  }
  pushState(room);
  return true;
}

function botMaybeEnd(room){
  if(room.attackerId===room.botId && room.stack.length && room.stack.every(p=>p.defend)){
    endTrickIfPossible(room);
    return true;
  }
  return false;
}

function scheduleBot(room, delay=350){
  if(!room.botId) return;
  if(room.botBusy) return;
  if(room.turnId!==room.botId && !(room.attackerId===room.botId && room.stack.length && room.stack.every(p=>p.defend))) return;

  room.botBusy = true;
  setTimeout(()=>{
    try{
      let acted=false;
      if(room.turnId===room.botId && room.phase==="attack"){
        acted = botAttack(room);
      }else if(room.turnId===room.botId && room.phase==="defend"){
        acted = botDefend(room);
      }else{
        acted = botMaybeEnd(room);
      }
    } finally {
      room.botBusy = false;
      if(room.turnId===room.botId || (room.attackerId===room.botId && room.stack.length && room.stack.every(p=>p.defend))){
        scheduleBot(room, 450);
      }
    }
  }, delay + (Math.random()*300|0));
}

/* ====== Socket notikumi ====== */
io.on("connection",(socket)=>{
  socket.emit("info","Savienots.");

  socket.on("createRoom",({nick,deckSize,solo})=>{
    const code=genCode();
    const deck=makeDeck(deckSize||36);
    const room={
      code,
      players:{ [socket.id]:{id:socket.id,nick:nick||"Viesis"} },
      hands:{ [socket.id]:[] },
      stock:deck,
      discard:[],
      stack:[],
      phase:"wait",
      trump:null,
      attackerId:null,
      defenderId:null,
      turnId:null,
      botId: solo ? "BOT_"+code : null,
      botBusy:false,
    };
    dealToSix(room, socket.id);
    rooms[code]=room; socket.join(code); socket.data.room=code;

    if(solo){
      const bid=room.botId;
      room.players[bid]={id:bid,nick:"BOT"};
      room.hands[bid]=[]; dealToSix(room,bid);
      startRound(room); pushState(room);
      socket.emit("room",code);
      scheduleBot(room, 400);
    }else{
      pushState(room);
      socket.emit("room",code);
      socket.emit("info","Istaba izveidota: "+code);
    }
  });

  socket.on("joinRoom",({nick,room:code})=>{
    const room=rooms[code]; if(!room) return socket.emit("errorMsg","Nav istabas ar šādu kodu.");
    if(Object.keys(room.players).length>=2 && !room.botId) return socket.emit("errorMsg","Istaba pilna.");

    room.players[socket.id]={id:socket.id,nick:nick||"Viesis"};
    room.hands[socket.id]=room.hands[socket.id]||[]; dealToSix(room,socket.id);
    socket.join(code); socket.data.room=code; socket.emit("room",code);

    if(!room.attackerId && Object.keys(room.players).length>=2) startRound(room);
    pushState(room);
    scheduleBot(room, 400);
  });

  socket.on("chat",(m)=>{
    const code=socket.data.room; if(!code) return;
    const room=rooms[code]; if(!room) return;
    io.to(code).emit("chat", `${room.players[socket.id]?.nick||"Viesis"}: ${m}`);
  });

  socket.on("attack",({cards})=>{
    const code=socket.data.room; if(!code) return; const room=rooms[code]; if(!room) return;
    if(room.phase!=="attack" || room.turnId!==socket.id) return;
    const hand=room.hands[socket.id]; if(!cards?.length) return;

    // JAUNS: pirmajā uzbrukumā, ja >1 kārts, visām jābūt viena ranga
    if(room.stack.length===0 && cards.length>1){
      const r = cards[0].rank;
      if(!cards.every(c=>c.rank===r)){
        return socket.emit("errorMsg","Pirmajā uzbrukumā visas kārtis jābūt viena ranga.");
      }
    }

    // turpmāk – tikai rangi, kas ir uz galda
    if(!cards.every(c=>equalRankToAnyOnTable(room.stack, c.rank)))
      return socket.emit("errorMsg","Rangs neatbilst esošajiem uz galda.");

    const open=room.stack.filter(p=>!p.defend).length;
    const defCount=(room.hands[room.defenderId]||[]).length;
    if(open+cards.length>defCount) return socket.emit("errorMsg","Nevar uzbrukt ar vairāk kā aizstāvim ir kārtis.");

    for(const c of cards){
      const i=hand.findIndex(x=>x.rank===c.rank && x.suit===c.suit);
      if(i<0) return socket.emit("errorMsg","Kārts nav rokā.");
      hand.splice(i,1);
      room.stack.push({attack:c,defend:null});
    }
    room.phase="defend"; room.turnId=room.defenderId;
    pushState(room);
    scheduleBot(room, 400);
  });

  socket.on("defend",({pairIndex,card})=>{
    const code=socket.data.room; if(!code) return; const room=rooms[code]; if(!room) return;
    if(room.phase!=="defend" || room.defenderId!==socket.id) return;
    if(pairIndex==null || !room.stack[pairIndex] || room.stack[pairIndex].defend) return;

    const atk=room.stack[pairIndex].attack;
    const hand=room.hands[socket.id];
    const idx=hand.findIndex(x=>x.rank===card.rank && x.suit===card.suit);
    if(idx<0) return socket.emit("errorMsg","Kārts nav rokā.");
    if(!cardBeats(card, atk, room.trump)) return socket.emit("errorMsg","Šī kārts nesit uzbrukumu.");

    room.stack[pairIndex].defend = card; hand.splice(idx,1);

    if(room.stack.length && room.stack.every(p=>p.defend)){
      room.turnId = room.attackerId; // uzbrucējs var beigt
    }
    pushState(room);
    scheduleBot(room, 400);
  });

  socket.on("endTrick",()=>{
    const code=socket.data.room; if(!code) return; const room=rooms[code]; if(!room) return;
    if(room.turnId!==room.attackerId) return;
    if(!(room.stack.length && room.stack.every(p=>p.defend))) return;
    endTrickIfPossible(room);
    scheduleBot(room, 400);
  });

  socket.on("take",()=>{
    const code=socket.data.room; if(!code) return; const room=rooms[code]; if(!room) return;
    if(room.defenderId!==socket.id) return;
    take(room, socket.id);
    scheduleBot(room, 400);
  });

  socket.on("passAdd",()=>{
    const code=socket.data.room; if(!code) return; const room=rooms[code]; if(!room) return;
    pushState(room);
    scheduleBot(room, 400);
  });

  socket.on("disconnect",()=>{
    const code=socket.data.room; if(!code) return; const room=rooms[code]; if(!room) return;
    if(room.players[socket.id]){
      delete room.players[socket.id];
      delete room.hands[socket.id];
      const ids=Object.keys(room.players).filter(x=>!room.botId || x!==room.botId);
      if(ids.length===0) delete rooms[code]; else { pushState(room); scheduleBot(room, 400); }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, ()=>console.log("Duraks serveris klausās portā", PORT));
