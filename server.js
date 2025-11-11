// server.js — Duraks (podkidnoy) parastie mači (2–6 spēlētāji) ar leave fix,
// reconnect ≤30s, undo 1×/bauts, BOT soft-delay, spectator.

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.get("/health", (_, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*", methods: ["GET","POST"] } });

/* ===== Konstantes ===== */
const R36 = ["6","7","8","9","10","J","Q","K","A"];
const R52 = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const SUITS = ["♣","♦","♥","♠"];
const MAX_PLAYERS = 6;
const RECONN_MS = 30_000;
const BOT_MIN = 600, BOT_MAX = 1200;

/* ===== Palīgi ===== */
const next = (i, arr) => (i + 1) % arr.length;
const rVal = (r, ranks) => ranks.indexOf(r);
const rand = (a,b)=>Math.floor(a + Math.random()*(b-a+1));
const uid = (p="id") => `${p}-${Math.random().toString(36).slice(2,10)}`;
function now(){ return Date.now(); }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }

/* ===== Kavas ===== */
function makeDeck(mode){ const ranks = mode==="52"?R52:R36; const d=[]; for (const s of SUITS) for (const r of ranks) d.push({r,s,id:`${r}${s}-${Math.random().toString(36).slice(2,8)}`}); return shuffle(d); }
function initDeck(mode){
  const full = makeDeck(mode);
  const trumpCard = full[full.length-1];
  return { deck: full.slice(0,-1), trumpCard, trumpSuit: trumpCard.s, trumpAvailable:true, ranks: mode==="52"?R52:R36 };
}

/* ===== Noteikumi ===== */
function canCover(a,d,trump,ranks){
  if (!a||!d) return false;
  if (d.s===a.s) return rVal(d.r,ranks)>rVal(a.r,ranks);
  if (a.s!==trump && d.s===trump) return true;
  if (a.s===trump && d.s===trump) return rVal(d.r,ranks)>rVal(a.r,ranks);
  return false;
}
function tableRanks(room){ const s=new Set(); for (const p of room.table){ if(p.attack) s.add(p.attack.r); if(p.defend) s.add(p.defend.r); } return s; }
function maxPairs(room){ const def = room.players[room.defender]; return Math.min(6, def?.hand?.length||0); }

/* ===== Globālais stāvoklis ===== */
const rooms = new Map(); // id -> room
const sessions = new Map(); // cid -> { socketId, roomId }

/* ===== Room helpers ===== */
function activePlayers(room){ return room.players.filter(p=>!p.spectator); }
function drawOne(room){
  if (room.deck.length>0) return room.deck.pop();
  if (room.trumpAvailable){ room.trumpAvailable=false; return room.trumpCard; }
  return null;
}
function dealUpToSix(room){
  let i = room.attacker;
  for (let k=0;k<room.players.length;k++){
    const p = room.players[i];
    if (!p.spectator){
      while (p.hand.length<6){ const c=drawOne(room); if(!c) break; p.hand.push(c); }
    }
    i = next(i, room.players);
  }
}
function enforceInvariants(room){
  // nelaiž pāri limitam
  const limit = maxPairs(room);
  if (room.table.length > limit){
    const la = room.lastAction;
    if (la && (la.type==="attack"||la.type==="attackMany")){
      const actor = room.players.find(p=>p.id===la.playerId);
      if (actor){
        let over = room.table.length-limit;
        for (let i=room.table.length-1; i>=0 && over>0; i--){
          const pr = room.table[i];
          if (!pr.defend){ actor.hand.push(pr.attack); room.table.splice(i,1); over--; }
        }
      }
    }
  }
  // nepieļaujam nelegālu aizklāšanu
  const t = room.trumpSuit, ranks = room.ranks;
  for (const pr of room.table){
    if (pr.defend && !canCover(pr.attack, pr.defend, t, ranks)){
      pr.defend = undefined;
    }
  }
}
function endBoutDefended(room){
  for (const pr of room.table){ room.discard.push(pr.attack); if(pr.defend) room.discard.push(pr.defend); }
  room.table=[];
  dealUpToSix(room);
  room.attacker = room.defender;
  room.defender = next(room.attacker, room.players);
  while (room.players[room.defender]?.spectator) room.defender = next(room.defender, room.players);
  room.passes=new Set(); room.undoUsed=new Set(); room.lastAction=undefined; room.phase="attack";
}
function endBoutTook(room){
  const def = room.players[room.defender];
  for (const pr of room.table){ def.hand.push(pr.attack); if(pr.defend) def.hand.push(pr.defend); }
  room.table=[];
  dealUpToSix(room);
  room.attacker = next(room.defender, room.players);
  room.defender = next(room.attacker, room.players);
  while (room.players[room.defender]?.spectator) room.defender = next(room.defender, room.players);
  room.passes=new Set(); room.undoUsed=new Set(); room.lastAction=undefined; room.phase="attack";
}
function checkGameEnd(room){
  const act = activePlayers(room);
  const still = act.filter(p=>p.hand.length>0);
  if (still.length<=1){
    room.phase="end";
    const winners = act.filter(p=>p.hand.length===0).map(p=>p.nick);
    io.to(room.id).emit("end", { winners, losers: still.map(p=>p.nick) });
    room.lastAction = undefined;
    return true;
  }
  return false;
}
function chooseFirstAttacker(room){
  let best={have:false,val:Infinity,idx:0};
  room.players.forEach((p,i)=>{
    if (p.spectator) return;
    p.hand.forEach(c=>{ if(c.s===room.trumpSuit){ const v=rVal(c.r,room.ranks); if(v<best.val) best={have:true,val:v,idx:i}; } });
  });
  room.attacker = best.have?best.idx:room.players.findIndex(p=>!p.spectator);
  if (room.attacker<0) room.attacker = 0;
  room.defender = next(room.attacker, room.players);
  while (room.players[room.defender]?.spectator) room.defender = next(room.defender, room.players);
}

/* ===== BOT ===== */
function botDelay(room){ return room.botStepMs || rand(BOT_MIN, BOT_MAX); }
function botTurn(room){
  if (room.phase!=="attack") return false;
  const A = room.players[room.attacker], D=room.players[room.defender];
  return (A?.isBot || D?.isBot);
}
function runBot(room){
  if (!rooms.has(room.id)) return;
  if (room.phase!=="attack") return;
  const A = room.players[room.attacker], D=room.players[room.defender];
  const trump = room.trumpSuit, ranks=room.ranks;

  if (A?.isBot){
    // vienkāršs uzbrukums — mazākā ne-trump kārts, ko drīkst pievienot
    const ranksOnTable = tableRanks(room);
    const candidates = A.hand.filter(c=> room.table.length===0 || ranksOnTable.has(c.r));
    candidates.sort((x,y)=> (x.s===trump)-(y.s===trump) || rVal(x.r,ranks)-rVal(y.r,ranks));
    const limit = maxPairs(room);
    if (candidates.length && room.table.length<limit){
      const card = candidates[0];
      const hi = A.hand.findIndex(x=>x.id===card.id);
      if (hi>=0){
        A.hand.splice(hi,1);
        room.table.push({ attack: card });
        room.passes.delete(A.id);
        room.lastAction = { type:"attack", playerId:A.id, cards:[card], pairIndices:[room.table.length-1] };
        enforceInvariants(room);
        io.to(room.id).emit("message", "BOT uzbrūk");
        emitState(room);
        setTimeout(()=> runBot(room), botDelay(room));
        return;
      }
    }
    // citādi — pasē
    room.passes.add(A.id);
    io.to(room.id).emit("message","BOT pasē");
    const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
    if (allCovered && room.passes.size === activePlayers(room).length-1){
      endBoutDefended(room);
      if (!checkGameEnd(room)) emitState(room);
    } else emitState(room);
    setTimeout(()=> runBot(room), botDelay(room));
    return;
  }

  if (D?.isBot){
    // aizsardzība — lētākais derīgais
    const open = room.table.findIndex(x=>!x.defend);
    if (open>=0){
      const atk = room.table[open].attack;
      const opts = D.hand.filter(c => canCover(atk,c,trump,ranks))
                         .sort((x,y)=> (x.s===trump)-(y.s===trump) || rVal(x.r,ranks)-rVal(y.r,ranks));
      if (opts.length){
        const card = opts[0];
        const hi = D.hand.findIndex(x=>x.id===card.id);
        D.hand.splice(hi,1);
        room.table[open].defend = card;
        room.lastAction = { type:"defend", playerId:D.id, cards:[card], pairIndex:open };
        enforceInvariants(room);
        io.to(room.id).emit("message","BOT aizsedz");
        const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
        if (allCovered && room.passes.size === activePlayers(room).length-1){
          endBoutDefended(room);
          if (!checkGameEnd(room)) emitState(room);
        } else emitState(room);
        setTimeout(()=> runBot(room), botDelay(room));
        return;
      }
    }
    // ņem
    endBoutTook(room);
    io.to(room.id).emit("message","BOT ņem");
    if (!checkGameEnd(room)) emitState(room);
    setTimeout(()=> runBot(room), botDelay(room));
  }
}

/* ===== Redzamība ===== */
function stateFor(room, sid){
  const me = room.players.find(p=>p.id===sid);
  return {
    id: room.id, phase: room.phase,
    trumpCard: room.trumpCard, trumpSuit: room.trumpSuit,
    deckCount: room.deck.length + (room.trumpAvailable?1:0), discardCount: room.discard.length,
    attacker: room.attacker, defender: room.defender,
    table: room.table,
    players: room.players.map((p,i)=>({ nick:p.nick, handCount:p.hand.length, me:p.id===sid, index:i, isBot:p.isBot, spectator:p.spectator })),
    myHand: (me && !me.spectator) ? me.hand : [],
    settings: room.settings,
    meCanUndo: !!room.lastAction && room.lastAction.playerId===sid && room.phase==="attack",
    undoLeftThisBout: me ? (room.undoUsed?.has(me.id)?0:1) : 0
  };
}
function emitState(room){ for (const p of room.players) io.to(p.id).emit("state", stateFor(room,p.id)); }

/* ===== Host reassignment & leave ===== */
function reassignHost(room){
  const nextHost = room.players.find(p=>!p.spectator) || room.players[0];
  if (nextHost) room.hostId = nextHost.id;
}
function replaceWithBot(room, idx){
  const left = room.players[idx];
  room.players[idx] = { id:`bot-${Math.random().toString(36).slice(2,7)}`, cid:`bot-${Math.random().toString(36).slice(2,5)}`, nick:"BOT", hand:left.hand||[], isBot:true, ready:true, connected:true, spectator:false, lastSeen:now() };
}

/* ===== Sockets ===== */
io.on("connection", (socket)=>{
  const err = m=>socket.emit("error", m);
  const cid = socket.handshake.auth?.cid || socket.handshake.query?.cid || null;

  // Reconnect
  if (cid && sessions.has(cid)){
    const s = sessions.get(cid);
    const room = rooms.get(s.roomId);
    if (room){
      const p = room.players.find(pl=>pl.id===s.socketId || pl.cid===cid);
      if (p){
        p.id = socket.id; p.connected = true; p.lastSeen = now();
        sessions.set(cid, { socketId: socket.id, roomId: room.id });
        socket.join(room.id);
        emitState(room);
      }
    }
  }

  socket.on("createRoom", ({ roomId, nickname, deckMode })=>{
    if (!roomId) return err("Room ID nav norādīts");
    if (rooms.has(roomId)) return err("Istaba jau eksistē");
    const use = deckMode==="52" ? "52" : "36";
    const { deck, trumpCard, trumpSuit, trumpAvailable, ranks } = initDeck(use);
    const room = {
      id: roomId, hostId: socket.id,
      players: [{ id: socket.id, cid: cid||socket.id, nick: nickname||"Spēlētājs", hand: [], isBot:false, ready:false, connected:true, spectator:false, lastSeen:now() }],
      deck, discard:[], trumpCard, trumpSuit, trumpAvailable, ranks,
      table:[], attacker:0, defender:0, phase:"lobby",
      passes:new Set(), chat:[], settings:{ deckMode: use }, botStepMs: undefined,
      lastAction: undefined, undoUsed: new Set(), startedAt:null
    };
    rooms.set(roomId, room);
    if (cid) sessions.set(cid, { socketId: socket.id, roomId });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("joinRoom", ({ roomId, nickname, spectator })=>{
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (room.phase!=="lobby" && spectator!==true) return err("Spēle jau sākusies");
    const playing = room.players.filter(p=>!p.spectator).length;
    const asSpec = spectator===true || playing>=MAX_PLAYERS;
    room.players.push({ id: socket.id, cid: cid||socket.id, nick: nickname||"Spēlētājs", hand:[], isBot:false, ready:false, connected:true, spectator:asSpec, lastSeen:now() });
    if (cid) sessions.set(cid, { socketId: socket.id, roomId });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("toggleReady", ({ roomId })=>{
    const room = rooms.get(roomId); if (!room || room.phase!=="lobby") return;
    const p = room.players.find(pl=>pl.id===socket.id); if(!p || p.spectator) return;
    p.ready = !p.ready; emitState(room);
  });

  socket.on("startGame", ({ roomId, botStepMs })=>{
    const room = rooms.get(roomId); if(!room) return err("Istaba nav atrasta");
    if (socket.id !== room.hostId) return err("Tikai host var sākt");
    // auto BOT, ja tikai viens cilvēks
    const humans = room.players.filter(p=>!p.isBot && !p.spectator);
    if (humans.length === 1){
      const id = `bot-${Math.random().toString(36).slice(2,7)}`;
      room.players.push({ id, cid:id, nick:"BOT", hand:[], isBot:true, ready:true, connected:true, spectator:false, lastSeen:now() });
    } else if (!humans.every(p=>p.ready)) return err("Ne visi ir Gatavs");
    if (room.players.filter(p=>!p.spectator).length<2) return err("Vajag vismaz 2 spēlētājus");

    const { deck, trumpCard, trumpSuit, trumpAvailable, ranks } = initDeck(room.settings.deckMode);
    room.deck=deck; room.trumpCard=trumpCard; room.trumpSuit=trumpSuit; room.trumpAvailable=trumpAvailable; room.ranks=ranks;
    room.discard=[]; room.table=[]; room.passes=new Set(); room.phase="attack";
    room.botStepMs = (botStepMs>=400 && botStepMs<=2000) ? botStepMs : undefined;
    room.lastAction=undefined; room.undoUsed=new Set(); room.startedAt=now();

    for (const p of room.players) if (!p.spectator) while (p.hand.length<6){ const c=drawOne(room); if(!c) break; p.hand.push(c); }
    chooseFirstAttacker(room);
    io.to(room.id).emit("message", `Trumpis: ${room.trumpCard.r}${room.trumpSuit}`);
    emitState(room);
    if (botTurn(room)) setTimeout(()=>runBot(room), botDelay(room));
  });

  /* ===== Spēle ===== */
  socket.on("playAttack", ({ roomId, card })=>{
    const room = rooms.get(roomId); if(!room||room.phase!=="attack") return;
    try{
      const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
      const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar uzbrukt");
      if (idx===room.defender) throw new Error("Aizsargs nevar uzbrukt");
      const limit = maxPairs(room); if (room.table.length>=limit) throw new Error("Sasniegts pāru limits");
      const canAdd = room.table.length===0 || tableRanks(room).has(card.r); if (!canAdd) throw new Error("Jāliek tāda paša ranga kārts");
      const hi = me.hand.findIndex(c=>c.id===card.id); if (hi<0) throw new Error("Tev tādas kārts nav");
      me.hand.splice(hi,1); room.table.push({ attack: card }); room.passes.delete(me.id);
      room.lastAction = { type:"attack", playerId: me.id, cards:[card], pairIndices:[room.table.length-1] };
      enforceInvariants(room); emitState(room);
      if (botTurn(room)) setTimeout(()=>runBot(room), botDelay(room));
    } catch(e){ socket.emit("error", e.message||"Kļūda"); emitState(room); }
  });

  socket.on("playAttackMany", ({ roomId, cards })=>{
    const room = rooms.get(roomId); if(!room||room.phase!=="attack") return;
    try{
      const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
      const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar uzbrukt");
      if (!Array.isArray(cards)||!cards.length) throw new Error("Nav kāršu");
      const ranksOn = tableRanks(room);
      const added=[], idxs=[];
      while (cards.length && room.table.length<maxPairs(room)){
        const c = cards.shift();
        const hi = me.hand.findIndex(x=>x.id===c.id); if (hi<0) continue;
        const ok = room.table.length===0 || ranksOn.has(c.r); if (!ok) continue;
        me.hand.splice(hi,1); room.table.push({ attack:c }); added.push(c); idxs.push(room.table.length-1); ranksOn.add(c.r);
      }
      if (!added.length) throw new Error("Nevar pievienot izvēlētās kārtis");
      room.passes.delete(me.id); room.lastAction={ type:"attackMany", playerId: me.id, cards:added, pairIndices:idxs };
      enforceInvariants(room); emitState(room);
      if (botTurn(room)) setTimeout(()=>runBot(room), botDelay(room));
    } catch(e){ socket.emit("error", e.message||"Kļūda"); emitState(room); }
  });

  socket.on("playDefend", ({ roomId, attackIndex, card })=>{
    const room = rooms.get(roomId); if(!room||room.phase!=="attack") return;
    try{
      const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
      if (idx!==room.defender) throw new Error("Tikai aizsargs drīkst aizsegt");
      const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar aizsegt");
      const pair = room.table[attackIndex]; if (!pair || pair.defend) throw new Error("Nepareizs pāris");
      const hi = me.hand.findIndex(c=>c.id===card.id); if (hi<0) throw new Error("Tev tādas kārts nav");
      if (!canCover(pair.attack, card, room.trumpSuit, room.ranks)) throw new Error("Ar šo kārti nevar aizsegt");
      me.hand.splice(hi,1); pair.defend = card;
      room.lastAction = { type:"defend", playerId: me.id, cards:[card], pairIndex: attackIndex };
      enforceInvariants(room);

      const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
      if (allCovered && room.passes.size === activePlayers(room).length-1){
        endBoutDefended(room); if (!checkGameEnd(room)) emitState(room);
      } else emitState(room);
      if (botTurn(room)) setTimeout(()=>runBot(room), botDelay(room));
    } catch(e){ socket.emit("error", e.message||"Kļūda"); emitState(room); }
  });

  socket.on("undoLast", ({ roomId })=>{
    const room = rooms.get(roomId); if(!room||room.phase!=="attack") return;
    try{
      const la = room.lastAction; if (!la || la.playerId!==socket.id) throw new Error("Nevari atsaukt");
      const me = room.players.find(p=>p.id===socket.id); if (!me || me.spectator) throw new Error("Nevari atsaukt");
      if (room.undoUsed?.has(socket.id)) throw new Error("Atsaukums jau izmantots");
      if (la.type==="defend"){
        const pair = room.table[la.pairIndex]; if (!pair || !pair.defend || pair.defend.id!==la.cards[0].id) throw new Error("Vairs nevar atsaukt");
        me.hand.push(pair.defend); pair.defend=undefined; room.lastAction=undefined;
      } else if (la.type==="attack"){
        const i = la.pairIndices[0]; const pair = room.table[i]; if(!pair || pair.defend) throw new Error("Vairs nevar atsaukt");
        me.hand.push(pair.attack); room.table.splice(i,1); room.lastAction=undefined;
      } else if (la.type==="attackMany"){
        const ids = la.pairIndices.slice().sort((a,b)=>b-a);
        let restored=0; for (const i of ids){ const pair = room.table[i]; if (pair && !pair.defend){ me.hand.push(pair.attack); room.table.splice(i,1); restored++; } }
        if (!restored) throw new Error("Vairs nevar atsaukt");
        room.lastAction=undefined;
      }
      room.undoUsed.add(socket.id);
      enforceInvariants(room); emitState(room);
    } catch(e){ socket.emit("error", e.message||"Kļūda"); emitState(room); }
  });

  socket.on("takeCards", ({ roomId })=>{
    const room = rooms.get(roomId); if(!room||room.phase!=="attack") return;
    try{
      const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
      if (idx!==room.defender) throw new Error("Tikai aizsargs var ņemt");
      endBoutTook(room); if (!checkGameEnd(room)) emitState(room);
      if (botTurn(room)) setTimeout(()=>runBot(room), botDelay(room));
    } catch(e){ socket.emit("error", e.message||"Kļūda"); emitState(room); }
  });

  socket.on("pass", ({ roomId })=>{
    const room = rooms.get(roomId); if(!room||room.phase!=="attack") return;
    try{
      const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
      if (idx===room.defender) throw new Error("Aizsargs nevar pasēt");
      room.passes.add(room.players[idx].id);
      const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
      if (allCovered && room.passes.size === activePlayers(room).length-1){
        endBoutDefended(room); if (!checkGameEnd(room)) emitState(room);
      } else emitState(room);
      if (botTurn(room)) setTimeout(()=>runBot(room), botDelay(room));
    } catch(e){ socket.emit("error", e.message||"Kļūda"); emitState(room); }
  });

  socket.on("leaveRoom", ({ roomId })=>{
    const room = rooms.get(roomId); if (!room) return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx<0) return;
    const leaving = room.players[idx];

    if (room.hostId === leaving.id) reassignHost(room);

    if (room.phase === "lobby"){
      room.players.splice(idx,1);
    } else {
      // spēles laikā: spēlētāju vietā ieliekam BOT, skatītāju – prom
      if (!leaving.spectator) replaceWithBot(room, idx);
      else room.players.splice(idx,1);
      room.lastAction = undefined; // lai neatlīmējas undo stāvoklis
    }

    // ja istaba tukša — dzēšam
    if (activePlayers(room).length===0){ rooms.delete(room.id); return; }

    emitState(room);
  });

  socket.on("disconnect", ()=>{
    const t = now();
    for (const room of rooms.values()){
      const i = room.players.findIndex(p=>p.id===socket.id);
      if (i>=0){
        const p = room.players[i];
        p.connected=false; p.lastSeen=t;
        setTimeout(()=>{
          if (!rooms.has(room.id)) return;
          const still = room.players[i];
          if (!still || still.connected) return;
          if (room.phase==="lobby"){
            room.players.splice(i,1);
          } else {
            if (!still.spectator) replaceWithBot(room, i);
            else room.players.splice(i,1);
          }
          emitState(room);
        }, RECONN_MS);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, ()=> console.log("Duraks serveris klausās uz porta " + PORT));
