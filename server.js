import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors:{origin:"*"}, transports:["websocket"] });
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));
app.get("/", (_req,res)=> res.sendFile(path.join(__dirname,"index.html")));

const rooms = new Map();
const ABC = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const rc = () => Array.from({length:4}, ()=>ABC[Math.floor(Math.random()*ABC.length)]).join("");

function buildRankOrder(deckSize){
  return deckSize===52
    ? ["2","3","4","5","6","7","8","9","10","J","Q","K","A"]
    : ["6","7","8","9","10","J","Q","K","A"];
}
function rankValFrom(room, r){ return room.rankOrder.indexOf(r); }

function createDeck(deckSize){
  const suits=["♠","♥","♦","♣"];
  const ranks36=["6","7","8","9","10","J","Q","K","A"];
  const deck=[];
  for(const s of suits) for(const r of ranks36) deck.push({r,s});
  if(deckSize===52) for(const r of ["2","3","4","5"]) for(const s of suits) deck.push({r,s});
  for(let i=deck.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [deck[i],deck[j]]=[deck[j],deck[i]]; }
  return deck;
}

function cardBeatsRoom(room,a,b){
  if(!a||!b) return false;
  if(a.s===b.s) return rankValFrom(room,a.r)>rankValFrom(room,b.r);
  if(a.s===room.trump.s && b.s!==room.trump.s) return true;
  return false;
}

function allowedAttackRanks(room){
  const rs=new Set();
  room.table.forEach(p=>{ if(p.atk) rs.add(p.atk.r); if(p.def) rs.add(p.def.r); });
  return rs;
}

function makeRoom(deckSize){
  const code=rc();
  const room={
    code, deckSize:(deckSize===52?52:36),
    players:[], phase:"wait", deck:[], trump:null, stock:0,
    table:[], attacker:null, defender:null, rankOrder:buildRankOrder(deckSize)
  };
  rooms.set(code, room);
  return room;
}

function getPlayer(room,id){ return room.players.find(p=>p.id===id); }
function getOtherId(room,pid){ const p=room.players.find(x=>x.id!==pid); return p? p.id : null; }

function dealUpTo6(room){
  const order=[room.attacker, room.defender];
  for(const pid of order){
    const p=getPlayer(room,pid); if(!p) continue;
    while(p.hand.length<6 && room.deck.length) p.hand.push(room.deck.pop());
  }
  room.stock=room.deck.length;
}

function emitState(room, revealAll=false){
  const build = (viewerId)=>({
    phase:room.phase, stock:room.stock, trump:room.trump,
    attacker:room.attacker, defender:room.defender, table:room.table,
    players:room.players.map(p=>({
      id:p.id, nick:p.nick, handCount:p.hand.length,
      hand:(revealAll||p.id===viewerId)? p.hand : []
    }))
  });
  room.players.forEach(p=> io.to(p.id).emit("game.state", build(p.id)));
}

const wait = (ms)=>new Promise(res=>setTimeout(res,ms));
const isBotId = (id)=> typeof id==="string" && id.startsWith("bot:");

async function botAttack(room){
  const atk=getPlayer(room,room.attacker);
  const def=getPlayer(room,room.defender);
  if(!atk||!def) return;

  const limit=def.hand.length;
  const ranks = room.table.length? allowedAttackRanks(room) : null;

  const pickIdx = ()=>{
    let bestI=-1, bestKey=999;
    atk.hand.forEach((c,i)=>{
      if(ranks && !ranks.has(c.r)) return;
      const key=(c.s===room.trump.s?100:0)+rankValFrom(room,c.r);
      if(key<bestKey){ bestKey=key; bestI=i; }
    });
    return bestI;
  };

  if(room.table.length>=limit) return;

  const i = pickIdx();
  if(i===-1) return;
  await wait(600);
  const card = atk.hand.splice(i,1)[0];
  room.table.push({ atk: card, def:null });
  io.to(room.code).emit("log", `BOT iemeta ${card.r}${card.s}`);
  emitState(room);

  // ja viss nosists, pabeidz (to pārbaudīs botDefend pēc brīža)
}

async function botDefend(room){
  const def=getPlayer(room,room.defender);
  if(!def) return;

  for(let idx=0; idx<room.table.length; idx++){
    const pair=room.table[idx];
    if(pair.def) continue;

    await wait(600);

    let bestI=-1, bestKey=999;
    def.hand.forEach((c,i)=>{
      if(cardBeatsRoom(room,c,pair.atk)){
        const key=(c.s===room.trump.s?100:0)+rankValFrom(room,c.r);
        if(key<bestKey){ bestKey=key; bestI=i; }
      }
    });

    if(bestI===-1){
      io.to(room.code).emit("log", `BOT paņem`);
      takeTransition(room);
      return;
    }
    const card=def.hand.splice(bestI,1)[0];
    pair.def=card;
    io.to(room.code).emit("log", `BOT nosita ar ${card.r}${card.s}`);
    emitState(room);
  }

  // viss nosists?
  if(room.table.length && room.table.every(p=>p.def)){
    await wait(600);
    endAttackTransition(room);
  }
}

function maybeBotMove(room){
  if(room.phase!=="attack") return;
  setTimeout(async ()=>{
    if(room.phase!=="attack") return;
    if(isBotId(room.attacker)) await botAttack(room);
    if(isBotId(room.defender)) await botDefend(room);
  }, 300);
}

function endAttackTransition(room){
  room.table=[];
  dealUpTo6(room);
  const oldAtk=room.attacker;
  room.attacker=room.defender;
  room.defender=oldAtk;
  room.phase="attack";
  emitState(room);
  maybeBotMove(room);
}

function takeTransition(room){
  const def=getPlayer(room,room.defender);
  room.table.forEach(p=>{ def.hand.push(p.atk); if(p.def) def.hand.push(p.def); });
  room.table=[];
  dealUpTo6(room);
  room.phase="attack";
  emitState(room);
  maybeBotMove(room);
}

// ============ Socket =============
io.on("connection",(sock)=>{
  sock.on("room.create", ({nick,deckSize},ack)=>{
    const r=makeRoom(Number(deckSize)||36);
    r.players.push({ id:sock.id, nick:nick||"Spēlētājs", hand:[] });
    sock.join(r.code);
    sock.emit("room.created",{room:r.code});
    ack?.({ok:true, room:r.code});
    io.to(r.code).emit("room.update",{players:r.players.map(p=>({id:p.id,nick:p.nick}))});
  });

  sock.on("room.join", ({nick,room},ack)=>{
    const r = rooms.get((room||"").toUpperCase());
    if(!r){ ack?.({ok:false}); io.to(sock.id).emit("error.msg","Istaba neeksistē"); return; }
    if(r.players.length>=2){ ack?.({ok:false}); io.to(sock.id).emit("error.msg","Istaba pilna"); return; }
    r.players.push({ id:sock.id, nick:nick||"Spēlētājs", hand:[] });
    sock.join(r.code);
    sock.emit("room.joined",{room:r.code});
    ack?.({ok:true, room:r.code});
    io.to(r.code).emit("room.update",{players:r.players.map(p=>({id:p.id,nick:p.nick}))});
  });

  sock.on("room.solo", ({room},ack)=>{
    const r=rooms.get((room||"").toUpperCase());
    if(!r) return ack?.({ok:false, error:"no-room"});
    if(r.players.length>=2) return ack?.({ok:true});
    r.players.push({ id:`bot:${r.code}`, nick:"BOT", hand:[] });
    io.to(r.code).emit("room.update",{players:r.players.map(p=>({id:p.id,nick:p.nick}))});
    ack?.({ok:true});
  });

  sock.on("game.start", ({room},ack)=>{
    const r=rooms.get((room||"").toUpperCase());
    if(!r || r.players.length<2){ ack?.({ok:false}); return; }
    r.rankOrder = buildRankOrder(r.deckSize);
    r.deck = createDeck(r.deckSize);
    r.trump = r.deck[0];
    r.deck.push(r.deck.shift());
    // izdala
    // izvēlas sākuma uzbrucēju: zemākais trumpis rokā
    dealUpTo6(r);
    const [p1,p2] = r.players;
    const findLowestTrump = (p)=>{
      let best=999, i=-1;
      p.hand.forEach((c,idx)=>{
        if(c.s===r.trump.s){
          const key=rankValFrom(r,c.r);
          if(key<best){ best=key; i=idx; }
        }
      });
      return i;
    };
    const i1=findLowestTrump(p1), i2=findLowestTrump(p2);
    if(i1===-1 && i2===-1) r.attacker=p1.id;
    else if(i1===-1) r.attacker=p2.id;
    else if(i2===-1) r.attacker=p1.id;
    else r.attacker = (rankValFrom(r,p1.hand[i1].r) < rankValFrom(r,p2.hand[i2].r)) ? p1.id : p2.id;

    r.defender = getOtherId(r, r.attacker);
    r.phase="attack"; r.table=[];
    emitState(r);
    ack?.({ok:true});
    maybeBotMove(r);
  });

  sock.on("play.attack", ({room,cardIndex},ack)=>{
    const r=rooms.get((room||"").toUpperCase());
    if(!r || r.phase!=="attack" || sock.id!==r.attacker){ ack?.({ok:false}); return; }
    const atk=getPlayer(r,r.attacker);
    const def=getPlayer(r,r.defender);
    if(!atk||!def){ ack?.({ok:false}); return; }
    if(r.table.length >= def.hand.length){ ack?.({ok:false}); return; }

    const card = atk.hand[cardIndex];
    if(!card){ ack?.({ok:false}); return; }

    if(r.table.length>0){
      const allow=allowedAttackRanks(r);
      if(!allow.has(card.r)){ ack?.({ok:false}); return; }
    }

    atk.hand.splice(cardIndex,1);
    r.table.push({ atk:card, def:null });
    emitState(r);
    ack?.({ok:true});
    maybeBotMove(r);
  });

  sock.on("play.defend", ({room,attackIndex,cardIndex},ack)=>{
    const r=rooms.get((room||"").toUpperCase());
    if(!r || r.phase!=="attack" || sock.id!==r.defender){ ack?.({ok:false}); return; }
    const def=getPlayer(r,r.defender);
    const pair=r.table[attackIndex];
    if(!def||!pair||pair.def){ ack?.({ok:false}); return; }

    const card=def.hand[cardIndex];
    if(!cardBeatsRoom(r, card, pair.atk)){ ack?.({ok:false}); return; }

    def.hand.splice(cardIndex,1);
    pair.def=card;
    emitState(r);
    ack?.({ok:true});
    maybeBotMove(r);
  });

  sock.on("game.endAttack", ({room},ack)=>{
    const r=rooms.get((room||"").toUpperCase());
    if(!r || sock.id!==r.attacker){ ack?.({ok:false}); return; }
    if(r.table.some(p=>!p.def)){ ack?.({ok:false}); return; }
    endAttackTransition(r);
    ack?.({ok:true});
  });

  sock.on("game.take", ({room},ack)=>{
    const r=rooms.get((room||"").toUpperCase());
    if(!r || sock.id!==r.defender){ ack?.({ok:false}); return; }
    takeTransition(r);
    ack?.({ok:true});
  });

  sock.on("chat", ({room,msg})=>{
    const r=rooms.get((room||"").toUpperCase());
    if(!r) return;
    const p=getPlayer(r,sock.id);
    io.to(r.code).emit("chat",{nick:p?p.nick:"?", msg:String(msg).slice(0,300)});
  });

  sock.on("disconnect",()=>{
    for(const [code,r] of rooms){
      const i=r.players.findIndex(p=>p.id===sock.id);
      if(i>-1){
        r.players.splice(i,1);
        io.to(code).emit("room.update",{players:r.players.map(p=>({id:p.id,nick:p.nick}))});
      }
      if(!r.players.length) rooms.delete(code);
    }
  });
});

httpServer.listen(PORT, ()=>console.log("Duraks Online listening on", PORT));
