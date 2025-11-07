import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
  path: "/socket.io"
});

app.use(express.static("."));

const SUITS = ["♠","♥","♦","♣"];
const COLORS = { "♠":"black","♣":"black","♥":"red","♦":"red" };
const RANKS36 = ["6","7","8","9","10","J","Q","K","A"];
const RANKS52 = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const RVAL = { "6":1, "7":2, "8":3, "9":4, "10":5, "J":6, "Q":7, "K":8, "A":9,
               "2":1, "3":2, "4":3, "5":4 };

const rooms = new Map();

function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function newDeck(size){
  const ranks = size===36 ? RANKS36 : RANKS52;
  const deck = [];
  for(const s of SUITS) for(const r of ranks) deck.push({r,s,c:COLORS[s]});
  return shuffle(deck);
}

function dealTo6(player, room){
  while(player.hand.length<6 && room.stock.length>0){
    player.hand.push(room.stock.pop());
  }
}

function getPlayer(room, id){ return room.players.find(p=>p.id===id); }
function nextIdx(arr, id){ const i=arr.findIndex(p=>p.id===id); return (i+1)%arr.length; }

function allowedAttackRanks(room){
  const set = new Set();
  for(const pair of room.table){
    if(pair.atk) set.add(pair.atk.r);
    if(pair.def) set.add(pair.def.r);
  }
  return set;
}

function canDefendWith(defCard, atkCard, trump){
  if(!atkCard || !defCard) return false;
  if(defCard.s===atkCard.s && RVAL[defCard.r]>RVAL[atkCard.r]) return true;
  if(defCard.s===trump && atkCard.s!==trump) return true;
  return false;
}

function everyoneDefended(table){
  if(table.length===0) return false;
  return table.every(p=>p.atk && p.def);
}

function clearTableToDiscard(room){
  room.discard.push(...room.table.flatMap(p=>[p.atk,p.def].filter(Boolean)));
  room.table = [];
}

function emitState(room){
  const payload = {
    room: room.code,
    deckSize: room.deckSize,
    trump: room.trump,
    trumpSuit: room.trump,
    stock: room.stock.length,
    phase: room.phase,
    attacker: room.attacker,
    defender: room.defender,
    table: room.table.map(p=>({atk:p.atk,def:p.def})),
    players: room.players.map(p=>({
      id:p.id,
      name:p.name,
      me:false,
      handCount:p.hand.length
    }))
  };
  for(const p of room.players){
    const meHand = getPlayer(room,p.id).hand;
    const mine = JSON.parse(JSON.stringify(payload));
    mine.players = mine.players.map(pp=> pp.id===p.id? {...pp, me:true } : pp);
    mine.hand = meHand;
    io.to(p.id).emit("state", mine);
  }
}

function setNextRolesAfterDefended(room){
  const nextAttIdx = nextIdx(room.players, room.attacker);
  room.attacker = room.players[nextAttIdx].id;
  room.defender = room.players[(nextAttIdx+1)%room.players.length].id;
  room.phase = "attack";
}

function setRolesAfterTake(room){
  // ja aizstāvis paņem, uzbrukums paliek tam pašam uzbrucējam
  room.phase = "attack";
  // uzbrucējs un aizstāvis nemainās
}

function refillHands(room){
  // pēc metiena vispirms pildām uzbrucēju (no nākamā pa pulksteni), tad pārējos, klasiskā durak kārta
  const order = [];
  let idx = room.players.findIndex(p=>p.id===room.attacker);
  for(let i=0;i<room.players.length;i++){ order.push(room.players[(idx+i)%room.players.length]); }
  for(const p of order) dealTo6(p,room);
}

async function wait(ms){ return new Promise(res=>setTimeout(res,ms)); }

// Vienkāršs BOT
async function botMaybePlay(room){
  const bot = room.players.find(p=>p.isBot);
  if(!bot) return;

  // tikai ja viņa kārta
  if(room.attacker===bot.id && room.phase==="attack"){
    await wait(700);
    // pirmais gājiens — met viszemāko netrumpi (vai zemāko trumpi)
    const hand = bot.hand;
    let choice = null;
    const allow = room.table.length>0 ? allowedAttackRanks(room) : null;

    const candidates = room.table.length>0
      ? hand.filter(c=>allow.has(c.r))
      : [...hand];

    if(candidates.length===0) return;

    // izvēlamies netrumpi ar zemāko rangu; ja nav — zemāko trumpi
    const nonTrump = candidates.filter(c=>c.s!==room.trump).sort((a,b)=>RVAL[a.r]-RVAL[b.r]);
    if(nonTrump.length>0) choice = nonTrump[0];
    else choice = candidates.sort((a,b)=>RVAL[a.r]-RVAL[b.r])[0];

    const idx = hand.indexOf(choice);
    if(idx>=0){
      hand.splice(idx,1);
      room.table.push({atk:choice,def:null});
      emitState(room);
    }
  } else if(room.defender===bot.id && room.phase==="attack"){
    await wait(700);
    // aizstāvis mēģina nosist visas kārtis
    const hand = bot.hand;
    for(let i=0;i<room.table.length;i++){
      const pair = room.table[i];
      if(pair.def) continue;
      // meklē vislētāko nositamo
      const options = hand
        .filter(c=>canDefendWith(c, pair.atk, room.trump))
        .sort((a,b)=>{
          const trumpA = a.s===room.trump, trumpB = b.s===room.trump;
          if(trumpA!==trumpB) return trumpA?1:-1; // netrumpi pirms trumpjiem
          return RVAL[a.r]-RVAL[b.r];
        });
      if(options.length){
        const c = options[0];
        hand.splice(hand.indexOf(c),1);
        pair.def = c;
        emitState(room);
        await wait(300);
      }else{
        // nevar nosist — paņems vēlāk ar “take”
      }
    }
  }
}

io.on("connection", (sock)=>{

  sock.on("create", ({name, deckSize}, ack)=>{
    const code = Math.random().toString(36).slice(2,6).toUpperCase();
    const room = {
      code,
      deckSize: Number(deckSize)===52 ? 52 : 36,
      players: [],
      attacker: null,
      defender: null,
      phase: "lobby",
      stock: [],
      trump: null,
      table: [],
      discard: []
    };
    rooms.set(code, room);
    ack?.({ok:true, code});
  });

  sock.on("join", ({code, name, solo}, ack)=>{
    const r = rooms.get((code||"").toUpperCase());
    if(!r){ ack?.({ok:false,msg:"Nav istabas"}); return; }

    sock.join(r.code);
    r.players.push({ id:sock.id, name:name||"Spēlētājs", hand:[], isBot:false });
    if(solo && !r.players.find(p=>p.isBot)){
      // pievieno BOT
      const botId = r.code+"-BOT";
      r.players.push({ id:botId, name:"BOT", hand:[], isBot:true });
      io.socketsJoin(botId); // nav reāla sock, bet stāvoklim pietiek
    }
    ack?.({ok:true});
    emitState(r);
  });

  sock.on("start", ({room}, ack)=>{
    const r = rooms.get((room||"").toUpperCase());
    if(!r){ ack?.({ok:false}); return; }
    if(r.phase!=="lobby") { ack?.({ok:false}); return; }

    r.stock = newDeck(r.deckSize);
    // apgriez pēdējo kā trumpi
    const trumpCard = r.stock[0];
    r.trump = trumpCard.s;

    // pirmais uzbrucējs — ar zemāko trumpi
    for(const p of r.players) p.hand = [];
    for(let i=0;i<6;i++) for(const p of r.players) if(r.stock.length) p.hand.push(r.stock.pop());

    let first = 0, best = {rank:999, idx:0};
    for(let i=0;i<r.players.length;i++){
      const p=r.players[i];
      const tr = p.hand.filter(c=>c.s===r.trump).sort((a,b)=>RVAL[a.r]-RVAL[b.r])[0];
      const val = tr?RVAL[tr.r]:999;
      if(val<best.rank){ best={rank:val, idx:i}; }
    }
    first = best.rank===999 ? 0 : best.idx;

    r.attacker = r.players[first].id;
    r.defender = r.players[(first+1)%r.players.length].id;
    r.phase = "attack";
    emitState(r);
    ack?.({ok:true});
    botMaybePlay(r);
  });

  sock.on("play.attack", ({room, cardIndex}, ack)=>{
    const r = rooms.get((room||"").toUpperCase());
    if(!r || r.phase!=="attack" || sock.id!==r.attacker){ ack?.({ok:false}); return; }
    const atk = getPlayer(r,r.attacker);
    const def = getPlayer(r,r.defender);
    if(!atk||!def){ ack?.({ok:false}); return; }

    const limit = def.hand.length;
    if(r.table.length >= limit){ ack?.({ok:false}); return; }

    const card = atk.hand[cardIndex];
    if(!card){ ack?.({ok:false}); return; }

    // tikai JA galdā jau ir kārtis — tad pārbaudām ranku saskaņošanu
    if(r.table.length>0){
      const allow = allowedAttackRanks(r);
      if(!allow.has(card.r)){ ack?.({ok:false}); return; }
    }

    atk.hand.splice(cardIndex,1);
    r.table.push({atk:card, def:null});
    emitState(r);
    ack?.({ok:true});
    botMaybePlay(r);
  });

  sock.on("play.defend", ({room, attackIndex, cardIndex}, ack)=>{
    const r = rooms.get((room||"").toUpperCase());
    if(!r || r.phase!=="attack" || sock.id!==r.defender){ ack?.({ok:false}); return; }
    const def = getPlayer(r,r.defender);
    const pair = r.table[attackIndex];
    if(!def || !pair || pair.def){ ack?.({ok:false}); return; }

    const card = def.hand[cardIndex];
    if(!card || !canDefendWith(card, pair.atk, r.trump)){ ack?.({ok:false}); return; }

    def.hand.splice(cardIndex,1);
    pair.def = card;
    emitState(r);
    ack?.({ok:true});
    botMaybePlay(r);
  });

  sock.on("endTurn", ({room}, ack)=>{
    const r = rooms.get((room||"").toUpperCase());
    if(!r || r.phase!=="attack" || sock.id!==r.attacker){ ack?.({ok:false}); return; }
    // beigt metienu drīkst tikai tad, ja viss nosists
    if(!everyoneDefended(r.table)){ ack?.({ok:false}); return; }

    clearTableToDiscard(r);
    refillHands(r);
    setNextRolesAfterDefended(r);
    emitState(r);
    ack?.({ok:true});
    botMaybePlay(r);
  });

  sock.on("take", ({room}, ack)=>{
    const r = rooms.get((room||"").toUpperCase());
    if(!r || r.phase!=="attack" || sock.id!==r.defender){ ack?.({ok:false}); return; }

    const def = getPlayer(r,r.defender);
    for(const p of r.table){
      if(p.atk) def.hand.push(p.atk);
      if(p.def) def.hand.push(p.def);
    }
    r.table=[];
    refillHands(r);
    setRolesAfterTake(r);
    emitState(r);
    ack?.({ok:true});
    botMaybePlay(r);
  });

  sock.on("disconnect", ()=>{
    for(const r of rooms.values()){
      const i=r.players.findIndex(p=>p.id===sock.id);
      if(i>=0){
        r.players.splice(i,1);
        if(r.players.length===0){ rooms.delete(r.code); }
        else emitState(r);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, ()=> console.log("Duraks serveris klausās", PORT));
