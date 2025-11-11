// server.js — Duraks (podkidnoy): 2–6 spēlētāji + Spectators + Undo + Leave + Play Again
// - Uz galda max 6 pāri; pievienošana tikai pēc jau uzlikto kāršu rangiem
// - Apakšējais trumpis (redzams; nedalās)
// - Undo: atļauts atgūt savu PĒDĒJO gājienu (attack/attackMany/defend), ja neviens cits nav rīkojies pa vidu
// - BOT pievienojas, ja lobby ir 1 cilvēks; ja spēles laikā kāds aiziet — var saglabāt BOT loģiku pēc vajadzības
// - Spectators: >6 pievienojas kā skatītāji

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
const RANKS_36 = ["6","7","8","9","10","J","Q","K","A"];
const RANKS_52 = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const SUITS = ["♣","♦","♥","♠"];
const MAX_PLAYERS = 6;
const BOT_STEP_MS  = Number(process.env.BOT_STEP_MS || 900);
const BOT_THINK_MS = Number(process.env.BOT_THINK_MS || 600);

/* ===== Palīgi ===== */
const nextIndex = (i, list) => (i + 1) % list.length;
const rankValue = (r, ranks) => ranks.indexOf(r);
function shuffle(arr){ for (let i=arr.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
function makeDeck(mode){ const ranks = mode==="52" ? RANKS_52 : RANKS_36; const d=[]; for(const s of SUITS) for(const r of ranks) d.push({ r,s,id:`${r}${s}-${Math.random().toString(36).slice(2,8)}` }); return shuffle(d); }
function initDeck(mode){ const full=makeDeck(mode); const trumpCard=full[0]; const deck=full.slice(1); return { deck, trumpCard, trumpSuit: trumpCard.s, trumpAvailable:true, ranks:(mode==="52"?RANKS_52:RANKS_36) }; }
function canCover(attack, defend, trump, ranks){
  if (!attack || !defend) return false;
  if (defend.s === attack.s) return rankValue(defend.r, ranks) > rankValue(attack.r, ranks);
  if (attack.s !== trump && defend.s === trump) return true;
  if (attack.s === trump && defend.s === trump) return rankValue(defend.r, ranks) > rankValue(attack.r, ranks);
  return false;
}

/* ===== Istabas ===== */
const rooms = new Map();
/*
room = {
  id, hostId,
  players: [{ id, nick, hand: Card[], isBot, ready, connected, spectator }],
  deck, discard,
  trumpCard, trumpSuit, trumpAvailable, ranks,
  table: [{ attack: Card, defend?: Card }],
  attacker, defender,
  phase: "lobby"|"attack"|"end",
  passes: Set<playerId>,
  chat: string[],
  settings: { deckMode: "36"|"52" },
  botStepMs?: number,
  lastAction?: { type:"attack"|"attackMany"|"defend", playerId:string, cards:Card[], pairIndex?:number, pairIndices?:number[] }
}
*/

function tableRanks(room){
  const s=new Set(); for (const pr of room.table){ if (pr.attack) s.add(pr.attack.r); if (pr.defend) s.add(pr.defend.r); } return s;
}
function maxPairsAllowed(room){ const def = room.players[room.defender]; return Math.min(6, def?.hand?.length || 0); }
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
      while (p.hand.length < 6) { const c = drawOne(room); if(!c) break; p.hand.push(c); }
    }
    i = nextIndex(i, room.players);
  }
}
function endBoutDefended(room){
  for (const pr of room.table){ room.discard.push(pr.attack); if (pr.defend) room.discard.push(pr.defend); }
  room.table = [];
  dealUpToSix(room);
  room.attacker = room.defender;
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.lastAction = undefined;
  room.phase = "attack";
}
function endBoutTook(room){
  const def = room.players[room.defender];
  for (const pr of room.table){ def.hand.push(pr.attack); if (pr.defend) def.hand.push(pr.defend); }
  room.table = [];
  dealUpToSix(room);
  room.attacker = nextIndex(room.defender, room.players);
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.lastAction = undefined;
  room.phase = "attack";
}
function activePlayers(room){ return room.players.filter(p=>!p.spectator); }
function checkGameEnd(room){
  const act = activePlayers(room);
  const still = act.filter(p=>p.hand.length>0);
  if (still.length <= 1){
    room.phase = "end";
    io.to(room.id).emit("end", {
      losers: still.map(p=>p.nick),
      winners: act.filter(p=>p.hand.length===0).map(p=>p.nick)
    });
    room.lastAction = undefined;
    return true;
  }
  return false;
}

/* ===== BOT ===== */
function clearBotTimer(room){ if (room.botTimer){ clearTimeout(room.botTimer); room.botTimer = undefined; } }
function schedule(room, fn, d){ clearBotTimer(room); room.botTimer = setTimeout(fn, d); }
function botShouldPlay(room){
  if (room.phase !== "attack") return false;
  const a=room.players[room.attacker], d=room.players[room.defender];
  return (a?.isBot || d?.isBot);
}
function msg(room, text){ room.chat.push(text); io.to(room.id).emit("message", text); emitState(room); }
function botOneStep(room){
  if (room.phase !== "attack") return false;
  const aI=room.attacker, dI=room.defender;
  const A=room.players[aI], D=room.players[dI];
  const trump = room.trumpSuit, ranks=room.ranks;

  // Aizsargs
  if (D?.isBot){
    const open = room.table.map((p,i)=>!p.defend?i:-1).filter(i=>i>=0);
    if (open.length){
      const i=open[0], atk=room.table[i].attack;
      const cand = D.hand.filter(c=>canCover(atk,c,trump,ranks)).sort((x,y)=>rankValue(x.r,ranks)-rankValue(y.r,ranks));
      if (cand.length){
        const card=cand[0];
        D.hand.splice(D.hand.findIndex(c=>c.id===card.id),1);
        room.table[i].defend=card;
        room.lastAction = { type:"defend", playerId:D.id, cards:[card], pairIndex:i };
        msg(room, `BOT aizsedz ${atk.r}${atk.s} ar ${card.r}${card.s}`);
        const allCovered = room.table.length>0 && room.table.every(p=>p.defend);
        if (allCovered && room.passes.size === activePlayers(room).length-1){
          endBoutDefended(room);
          if (!checkGameEnd(room)) msg(room, "Viss aizsegts — nākamais bauta.");
        }
        return true;
      }
      endBoutTook(room);
      msg(room, "BOT nevar aizsegt — ņem kārtis.");
      return true;
    }
  }

  // Uzbrucējs
  if (A?.isBot){
    const ranksOnTable = tableRanks(room);
    const spaceLeft = maxPairsAllowed(room) - room.table.length;
    if (spaceLeft <= 0){ room.passes.add(A.id); room.lastAction=undefined; return true; }

    const hand = A.hand.slice().sort((a,b)=>{
      const at=(a.s===trump), bt=(b.s===trump);
      if (at!==bt) return at-bt;
      return rankValue(a.r,ranks)-rankValue(b.r,ranks);
    });

    let card=null;
    if (room.table.length===0) card = hand.find(c=>c.s!==trump) || hand[0];
    else card = hand.find(c=>ranksOnTable.has(c.r)) || null;

    if (card){
      A.hand.splice(A.hand.findIndex(c=>c.id===card.id),1);
      room.table.push({ attack: card });
      room.passes.delete(A.id);
      room.lastAction = { type:"attack", playerId:A.id, cards:[card], pairIndices:[room.table.length-1] };
      msg(room, `BOT uzbrūk ar ${card.r}${card.s}`);
      return true;
    } else {
      room.passes.add(A.id);
      room.lastAction=undefined;
      const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
      if (allCovered && room.passes.size === activePlayers(room).length-1){
        endBoutDefended(room);
        if (!checkGameEnd(room)) msg(room, "Viss aizsegts — nākamais bauta.");
      }
      return true;
    }
  }
  return false;
}
function runBot(room){
  if (room.phase !== "attack") return;
  const did = botOneStep(room);
  emitState(room);
  if (checkGameEnd(room)) return;
  if (did && botShouldPlay(room)) schedule(room, ()=>runBot(room), room.botStepMs || BOT_STEP_MS);
}

/* ===== Redzamība ===== */
function visibleState(room, sid){
  const me = room.players.find(p=>p.id===sid);
  return {
    id: room.id, phase: room.phase,
    trumpSuit: room.trumpSuit, trumpCard: room.trumpCard,
    deckCount: room.deck.length + (room.trumpAvailable?1:0),
    discardCount: room.discard.length,
    attacker: room.attacker, defender: room.defender,
    table: room.table,
    players: room.players.map((p,i)=>({ nick:p.nick, handCount:p.hand.length, me:p.id===sid, index:i, isBot:p.isBot, ready:p.ready, spectator:p.spectator })),
    myHand: (me && !me.spectator) ? me.hand : [],
    chat: room.chat.slice(-60),
    settings: room.settings,
    youSpectator: !!me?.spectator,
    meCanUndo: !!room.lastAction && room.lastAction.playerId===sid && room.phase==="attack"
  };
}
function emitState(room){ for (const p of room.players) io.to(p.id).emit("state", visibleState(room,p.id)); }

/* ===== Leave / host reassignment ===== */
function reassignHost(room){
  const next = room.players.find(p=>!p.spectator) || room.players[0];
  if (next) room.hostId = next.id;
}
function replaceWithBot(room, idx){
  const left = room.players[idx];
  room.players[idx] = { id:`bot-${Math.random().toString(36).slice(2,7)}`, nick:"BOT", hand:left.hand||[], isBot:true, ready:true, connected:true, spectator:false };
}

/* ===== Sockets ===== */
io.on("connection", (socket) => {
  const err = (m)=>socket.emit("error", m);

  socket.on("createRoom", ({ roomId, nickname, deckMode }) => {
    if (!roomId) return err("Room ID nav norādīts");
    if (rooms.has(roomId)) return err("Istaba jau eksistē");

    const useDeck = deckMode==="52" ? "52" : "36";
    const { deck, trumpCard, trumpSuit, trumpAvailable, ranks } = initDeck(useDeck);

    const room = {
      id: roomId, hostId: socket.id,
      players: [{ id: socket.id, nick: nickname || "Spēlētājs", hand: [], isBot:false, ready:false, connected:true, spectator:false }],
      deck, discard: [], trumpCard, trumpSuit, trumpAvailable, ranks,
      table: [], attacker:0, defender:0, phase:"lobby",
      passes: new Set(), chat:[],
      settings: { deckMode: useDeck },
      botStepMs: undefined,
      lastAction: undefined
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    emitState(room);
  });

  socket.on("joinRoom", ({ roomId, nickname }) => {
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (room.phase !== "lobby") return err("Spēle jau sākusies");

    const playing = room.players.filter(p=>!p.spectator).length;
    const spectator = playing >= MAX_PLAYERS;
    room.players.push({ id: socket.id, nick: nickname || "Spēlētājs", hand: [], isBot:false, ready:false, connected:true, spectator });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("toggleReady", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="lobby") return;
    const p = room.players.find(pl=>pl.id===socket.id);
    if (!p || p.spectator) return;
    p.ready = !p.ready;
    emitState(room);
  });

  function chooseFirstAttacker(room){
    let best = { have:false, val:Infinity, idx:0 };
    room.players.forEach((p, idx) => {
      if (p.spectator) return;
      p.hand.forEach(c => { if (c.s===room.trumpSuit){ const v=rankValue(c.r,room.ranks); if (v<best.val) best={have:true,val:v,idx}; } });
    });
    room.attacker = best.have ? best.idx : room.players.findIndex(p=>!p.spectator);
    if (room.attacker < 0) room.attacker = 0;
    room.defender = nextIndex(room.attacker, room.players);
    while (room.players[room.defender]?.spectator) room.defender = nextIndex(room.defender, room.players);
  }

  function startGame(room, botStepMs){
    const humans = room.players.filter(p=>!p.isBot && !p.spectator);
    if (humans.length === 1){
      const botId = `bot-${Math.random().toString(36).slice(2,7)}`;
      room.players.push({ id: botId, nick: "BOT", hand: [], isBot:true, ready:true, connected:true, spectator:false });
    } else if (!humans.every(p=>p.ready)) return "Ne visi spēlētāji ir gatavi";
    if (room.players.filter(p=>!p.spectator).length < 2) return "Vajag vismaz 2 spēlētājus";

    const { deck, trumpCard, trumpSuit, trumpAvailable, ranks } = initDeck(room.settings.deckMode);
    room.deck=deck; room.trumpCard=trumpCard; room.trumpSuit=trumpSuit; room.trumpAvailable=trumpAvailable; room.ranks=ranks;
    room.discard=[]; room.table=[]; room.passes=new Set(); room.phase="attack";
    room.botStepMs = (botStepMs && botStepMs>=300 && botStepMs<=3000) ? botStepMs : undefined;
    room.lastAction = undefined;

    for (const p of room.players) if (!p.spectator) while (p.hand.length<6){ const c=drawOne(room); if(!c) break; p.hand.push(c); }
    chooseFirstAttacker(room);

    msg(room, `Trumpis: ${room.trumpCard.r}${room.trumpCard.s} | Kava: ${room.settings.deckMode}`);
    emitState(room);
    if (botShouldPlay(room)) setTimeout(()=>runBot(room), BOT_THINK_MS);
    return null;
  }

  socket.on("startGame", ({ roomId, botStepMs }) => {
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (socket.id !== room.hostId) return err("Tikai host var sākt");
    const problem = startGame(room, botStepMs);
    if (problem) return err(problem);
  });

  socket.on("playAgain", ({ roomId, botStepMs }) => {
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (socket.id !== room.hostId) return err("Tikai host var sākt");
    for (const p of room.players) { p.hand=[]; if(!p.spectator) p.ready=true; }
    const problem = startGame(room, botStepMs);
    if (problem) return err(problem);
  });

  /* ===== Spēles darbības ===== */
  function invalidateUndoIfOther(room, actorId){
    if (room.lastAction && room.lastAction.playerId !== actorId) room.lastAction = undefined;
  }

  socket.on("playAttack", ({ roomId, card }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) return;
    const me = room.players[idx]; if (me.spectator) return;
    if (idx===room.defender) return err("Aizsargs nevar uzbrukt");
    if (room.table.length >= maxPairsAllowed(room)) return err("Sasniegts pāru limits");

    invalidateUndoIfOther(room, socket.id);

    const ranksOnTable = tableRanks(room);
    const canAdd = room.table.length===0 || ranksOnTable.has(card.r);
    if (!canAdd) return err("Jāliek tāda paša ranga kārts");

    const hi=me.hand.findIndex(c=>c.id===card.id);
    if (hi<0) return err("Tev tādas kārts nav");

    me.hand.splice(hi,1);
    room.table.push({ attack: card });
    room.passes.delete(me.id);
    room.lastAction = { type:"attack", playerId: me.id, cards:[card], pairIndices:[room.table.length-1] };
    emitState(room);
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), room.botStepMs || BOT_STEP_MS);
  });

  socket.on("playAttackMany", ({ roomId, cards }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) return;
    const me = room.players[idx]; if (me.spectator) return;
    if (idx===room.defender) return err("Aizsargs nevar uzbrukt");
    if (!Array.isArray(cards)||!cards.length) return;

    invalidateUndoIfOther(room, socket.id);

    const ranksOnTable = tableRanks(room);
    const addedCards=[], addedPairs=[];
    for (const card of cards){
      if (room.table.length >= maxPairsAllowed(room)) break;
      const hi=me.hand.findIndex(c=>c.id===card.id);
      if (hi<0) continue;
      const canAdd = room.table.length===0 || ranksOnTable.has(card.r);
      if (!canAdd) continue;
      me.hand.splice(hi,1);
      room.table.push({ attack: card });
      ranksOnTable.add(card.r);
      addedCards.push(card);
      addedPairs.push(room.table.length-1);
    }
    if (!addedCards.length) return;
    room.passes.delete(me.id);
    room.lastAction = { type:"attackMany", playerId: me.id, cards: addedCards, pairIndices: addedPairs };
    emitState(room);
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), room.botStepMs || BOT_STEP_MS);
  });

  socket.on("playDefend", ({ roomId, attackIndex, card }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) return;
    const me = room.players[idx]; if (me.spectator) return;
    if (idx !== room.defender) return err("Tikai aizsargs drīkst aizsegt");

    invalidateUndoIfOther(room, socket.id);

    const pair = room.table[attackIndex]; if(!pair || pair.defend) return err("Nepareizs pāris");
    const hi=me.hand.findIndex(c=>c.id===card.id); if(hi<0) return err("Tev tādas kārts nav");
    if (!canCover(pair.attack, card, room.trumpSuit, room.ranks)) return err("Ar šo kārti nevar aizsegt");

    me.hand.splice(hi,1);
    pair.defend = card;
    room.lastAction = { type:"defend", playerId: me.id, cards:[card], pairIndex: attackIndex };
    emitState(room);

    const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
    if (allCovered && room.passes.size === activePlayers(room).length-1){
      endBoutDefended(room);
      if (!checkGameEnd(room)) emitState(room);
    }
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), room.botStepMs || BOT_STEP_MS);
  });

  socket.on("undoLast", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    const la = room.lastAction; if (!la || la.playerId !== socket.id) return err("Nevari atsaukt");

    const me = room.players.find(p=>p.id===socket.id);
    if (!me || me.spectator) return;

    if (la.type === "defend"){
      const i = la.pairIndex;
      const pair = room.table[i];
      if (!pair || !pair.defend || pair.defend.id !== la.cards[0].id) return err("Vairs nevar atsaukt");
      me.hand.push(pair.defend);
      pair.defend = undefined;
      room.lastAction = undefined;
      emitState(room);
      return;
    }

    if (la.type === "attack"){
      const i = la.pairIndices?.[0];
      const pair = room.table[i];
      if (!pair || pair.defend) return err("Vairs nevar atsaukt");
      me.hand.push(pair.attack);
      room.table.splice(i,1);
      room.lastAction = undefined;
      emitState(room);
      return;
    }

    if (la.type === "attackMany"){
      // atgriežam tikai tās, kuras vēl nav aizklātas
      const indices = (la.pairIndices||[]).slice().sort((a,b)=>b-a); // no gala
      for (const i of indices){
        const pair = room.table[i];
        if (pair && !pair.defend){
          me.hand.push(pair.attack);
          room.table.splice(i,1);
        }
      }
      room.lastAction = undefined;
      emitState(room);
      return;
    }
  });

  socket.on("takeCards", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) return;
    const me = room.players[idx]; if (me.spectator) return;
    if (idx !== room.defender) return err("Tikai aizsargs var ņemt");

    room.lastAction = undefined;
    endBoutTook(room);
    if (!checkGameEnd(room)) emitState(room);
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), room.botStepMs || BOT_STEP_MS);
  });

  socket.on("pass", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) return;
    const me = room.players[idx]; if (me.spectator) return;
    if (idx===room.defender) return err("Aizsargs nevar pasēt");

    room.passes.add(me.id);
    room.lastAction = undefined;
    const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
    if (allCovered && room.passes.size === activePlayers(room).length-1){
      endBoutDefended(room);
      if (!checkGameEnd(room)) emitState(room);
    } else emitState(room);

    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), room.botStepMs || BOT_STEP_MS);
  });

  socket.on("chat", ({ roomId, text }) => {
    const room = rooms.get(roomId); if(!room || !text) return;
    const p = room.players.find(pl=>pl.id===socket.id); if(!p) return;
    room.chat.push(`${p.nick}: ${String(text).slice(0,200)}`);
    io.to(room.id).emit("message", room.chat[room.chat.length-1]);
    emitState(room);
  });

  socket.on("leaveRoom", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room) return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx<0) return;
    const leaving = room.players[idx];

    if (room.hostId === leaving.id) reassignHost(room);

    if (room.phase === "lobby"){
      room.players.splice(idx,1);
    } else {
      if (!leaving.spectator){
        // aizstāj ar BOT, lai spēle turpinās
        replaceWithBot(room, idx);
      } else {
        room.players.splice(idx,1);
      }
      room.lastAction = undefined;
    }
    if (activePlayers(room).length === 0){ rooms.delete(room.id); return; }
    emitState(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()){
      const idx = room.players.findIndex(p=>p.id===socket.id);
      if (idx>=0){
        const leaving = room.players[idx];
        if (room.hostId === leaving.id) reassignHost(room);
        if (room.phase === "lobby"){
          room.players.splice(idx,1);
        } else {
          if (!leaving.spectator) replaceWithBot(room, idx);
          else room.players.splice(idx,1);
          room.lastAction = undefined;
        }
        if (activePlayers(room).length === 0){ rooms.delete(room.id); continue; }
        emitState(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log("Duraks serveris klausās uz porta " + PORT));
