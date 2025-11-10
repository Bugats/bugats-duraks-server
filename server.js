// server.js — Duraks 1v1 (podkidnoy)
// - Režīms: tikai 1v1 (fiksēti 2 spēlētāji)
// - Apakšējā trumpa karte (redzama; nedalās rokās)
// - Ja lobby paliek viens → startā pievieno BOT
// - Ja spēles laikā kāds aiziet → viņa vietu pārņem BOT (ar to pašu roku)
// - “Play Again” saglabā 1v1 un kavas iestatījumu
// - 36/52 kavas opcija

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
const BOT_STEP_MS  = Number(process.env.BOT_STEP_MS || 900);
const BOT_THINK_MS = Number(process.env.BOT_THINK_MS || 600);

/* ===== Palīgi ===== */
const nextIndex = (i, list) => (i + 1) % list.length;
const rankValue = (r, ranks) => ranks.indexOf(r);

function shuffle(arr){
  for (let i=arr.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [arr[i],arr[j]]=[arr[j],arr[i]]; }
  return arr;
}
function makeDeck(mode){ // "36" | "52"
  const ranks = mode==="52" ? RANKS_52 : RANKS_36;
  const d=[]; for(const s of SUITS) for(const r of ranks) d.push({ r, s, id:`${r}${s}-${Math.random().toString(36).slice(2,8)}` });
  return shuffle(d);
}
function initDeck(mode){
  const full = makeDeck(mode);
  const trumpCard = full[0];              // apakšējā redzamā
  const deck = full.slice(1);             // dalāmā
  return { deck, trumpCard, trumpSuit: trumpCard.s, trumpAvailable: true, ranks: (mode==="52"?RANKS_52:RANKS_36) };
}
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
  players: [{ id, nick, hand: Card[], isBot: boolean, ready: boolean, connected: boolean }],
  deck, discard,
  trumpCard, trumpSuit, trumpAvailable, ranks,
  table: [{ attack: Card, defend?: Card }],
  attacker, defender,
  phase: "lobby"|"attack"|"end",
  passes: Set<playerId>,
  chat: string[],
  settings: { deckMode: "36"|"52" },
  botStepMs?: number
}
*/

function tableRanks(room){
  const s=new Set(); for(const pr of room.table){ if(pr.attack) s.add(pr.attack.r); if(pr.defend) s.add(pr.defend.r); }
  return s;
}
function maxPairsAllowed(room){
  const def = room.players[room.defender];
  return Math.min(6, def?.hand?.length || 0);
}
function drawOne(room){
  if (room.deck.length>0) return room.deck.pop();
  if (room.trumpAvailable){ room.trumpAvailable=false; return room.trumpCard; }
  return null;
}
function dealUpToSix(room){
  let i = room.attacker;
  for (let k=0;k<room.players.length;k++){
    const p = room.players[i];
    while (p.hand.length < 6) {
      const c = drawOne(room); if(!c) break;
      p.hand.push(c);
    }
    i = nextIndex(i, room.players);
  }
}
function endBoutDefended(room){
  for (const pr of room.table){ room.discard.push(pr.attack); if(pr.defend) room.discard.push(pr.defend); }
  room.table = [];
  dealUpToSix(room);
  room.attacker = room.defender;
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.phase = "attack";
}
function endBoutTook(room){
  const def = room.players[room.defender];
  for (const pr of room.table){ def.hand.push(pr.attack); if(pr.defend) def.hand.push(pr.defend); }
  room.table = [];
  dealUpToSix(room);
  room.attacker = nextIndex(room.defender, room.players);
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.phase = "attack";
}
function checkGameEnd(room){
  const still = room.players.filter(p=>p.hand.length>0);
  if (still.length <= 1){
    room.phase = "end";
    io.to(room.id).emit("end", {
      losers: still.map(p=>p.nick),
      winners: room.players.filter(p=>p.hand.length===0).map(p=>p.nick)
    });
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
function botOneStep(room){
  if (room.phase !== "attack") return false;
  const aI=room.attacker, dI=room.defender;
  const A=room.players[aI], D=room.players[dI];
  const trump = room.trumpSuit, ranks=room.ranks;

  // Aizsargs
  if (D?.isBot){
    const open = room.table.map((p,i)=>!p.defend?i:-1).filter(i=>i>=0);
    if (open.length){
      const i = open[0], atk = room.table[i].attack;
      const cand = D.hand.filter(c=>canCover(atk,c,trump,ranks)).sort((x,y)=>rankValue(x.r,ranks)-rankValue(y.r,ranks));
      if (cand.length){
        const card = cand[0];
        D.hand.splice(D.hand.findIndex(c=>c.id===card.id),1);
        room.table[i].defend = card;
        msg(room, `BOT aizsedz ${atk.r}${atk.s} ar ${card.r}${card.s}`);
        const allCovered = room.table.length>0 && room.table.every(p=>p.defend);
        if (allCovered && room.passes.size === room.players.length-1){
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
    if (spaceLeft <= 0){ room.passes.add(A.id); return true; }

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
      msg(room, `BOT uzbrūk ar ${card.r}${card.s}`);
      return true;
    } else {
      room.passes.add(A.id); // klusināts
      const allCovered = room.table.length>0 && room.table.every(p=>p.defend);
      if (allCovered && room.passes.size === room.players.length-1){
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

/* ===== Utils (redzamība, ziņas) ===== */
function visibleState(room, sid){
  const me = room.players.find(p=>p.id===sid);
  return {
    id: room.id, phase: room.phase,
    trumpSuit: room.trumpSuit, trumpCard: room.trumpCard,
    deckCount: room.deck.length + (room.trumpAvailable?1:0),
    discardCount: room.discard.length,
    attacker: room.attacker, defender: room.defender,
    table: room.table,
    players: room.players.map((p,i)=>({ nick:p.nick, handCount:p.hand.length, me:p.id===sid, index:i, isBot:p.isBot, ready:p.ready })),
    myHand: me?.hand ?? [],
    chat: room.chat.slice(-60),
    settings: room.settings
  };
}
function emitState(room){ for(const p of room.players) io.to(p.id).emit("state", visibleState(room,p.id)); }
function msg(room, text){ room.chat.push(text); io.to(room.id).emit("message", text); emitState(room); }

function chooseFirstAttacker(room){
  let best = { have:false, val:Infinity, idx:0 };
  room.players.forEach((p, idx) => {
    p.hand.forEach(c => { if (c.s===room.trumpSuit){ const v=rankValue(c.r,room.ranks); if (v<best.val) best={have:true,val:v,idx}; } });
  });
  room.attacker = best.have ? best.idx : 0;
  room.defender = nextIndex(room.attacker, room.players);
}

/* ===== Leave/Disconnect ===== */
function reassignHost(room){
  if (!room.players.length) return;
  room.hostId = room.players[0].id;
}
function replaceWithBot(room, idx){
  const left = room.players[idx];
  room.players[idx] = { id:`bot-${Math.random().toString(36).slice(2,7)}`, nick:"BOT", hand:left.hand||[], isBot:true, ready:true, connected:true };
}
function removePlayer1v1(room, socketId){
  const idx = room.players.findIndex(p=>p.id===socketId);
  if (idx<0) return;
  const leaving = room.players[idx];

  if (room.hostId === leaving.id) reassignHost(room);

  if (room.phase === "lobby"){
    room.players.splice(idx,1);
  } else {
    // 1v1 spēles laikā — aizstājam ar BOT, lai duelis turpinās
    replaceWithBot(room, idx);
  }

  if (room.players.length === 0){ rooms.delete(room.id); return; }

  room.attacker = Math.max(0, Math.min(room.attacker ?? 0, room.players.length-1));
  room.defender = Math.max(0, Math.min(room.defender ?? 0, room.players.length-1));
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
      players: [{ id: socket.id, nick: nickname || "Spēlētājs", hand: [], isBot:false, ready:false, connected:true }],
      deck, discard: [], trumpCard, trumpSuit, trumpAvailable, ranks,
      table: [], attacker:0, defender:0, phase:"lobby",
      passes: new Set(), chat:[],
      settings: { deckMode: useDeck },
      botStepMs: undefined
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    emitState(room);
  });

  socket.on("joinRoom", ({ roomId, nickname }) => {
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (room.phase !== "lobby") return err("Spēle jau sākusies");
    if (room.players.length >= 2) return err("1v1 istaba ir pilna");

    room.players.push({ id: socket.id, nick: nickname || "Spēlētājs", hand: [], isBot:false, ready:false, connected:true });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("toggleReady", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="lobby") return;
    const p = room.players.find(pl=>pl.id===socket.id);
    if (!p) return;
    p.ready = !p.ready;
    emitState(room);
  });

  function startGame(room, botStepMs){
    const humans = room.players.filter(p=>!p.isBot);
    if (humans.length === 1){
      const botId = `bot-${Math.random().toString(36).slice(2,7)}`;
      room.players.push({ id: botId, nick: "BOT", hand: [], isBot:true, ready:true, connected:true });
    } else if (humans.length === 2){
      if (!humans.every(p=>p.ready)) return "Ne visi spēlētāji ir gatavi";
    } else {
      return "1v1 režīmā atļauti max 2 spēlētāji";
    }

    // reset + kava
    const { deck, trumpCard, trumpSuit, trumpAvailable, ranks } = initDeck(room.settings.deckMode);
    room.deck = deck; room.trumpCard=trumpCard; room.trumpSuit=trumpSuit; room.trumpAvailable=trumpAvailable; room.ranks=ranks;
    room.discard=[]; room.table=[]; room.passes=new Set(); room.phase="attack";
    room.botStepMs = (botStepMs && botStepMs>=300 && botStepMs<=3000) ? botStepMs : undefined;

    // izdala līdz 6
    for (const p of room.players) while(p.hand.length<6){ const c=drawOne(room); if(!c) break; p.hand.push(c); }

    // sāk ar zemāko trumpi
    let best = { have:false, val:Infinity, idx:0 };
    room.players.forEach((p,idx)=>{ p.hand.forEach(c=>{ if(c.s===room.trumpSuit){ const v=rankValue(c.r,room.ranks); if(v<best.val) best={have:true,val:v,idx}; } }); });
    room.attacker = best.have?best.idx:0;
    room.defender = nextIndex(room.attacker, room.players);

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
    // notīrām rokas un atzīmējam readiness
    for(const p of room.players){ p.hand=[]; p.ready=true; }
    const problem = startGame(room, botStepMs);
    if (problem) return err(problem);
  });

  // Spēles darbības
  socket.on("playAttack", ({ roomId, card }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) return;
    if (idx===room.defender) return err("Aizsargs nevar uzbrukt");
    if (room.table.length >= maxPairsAllowed(room)) return err("Sasniegts pāru limits");

    const ranksOnTable = tableRanks(room);
    const canAdd = room.table.length===0 || ranksOnTable.has(card.r);
    if (!canAdd) return err("Jāliek tāda paša ranga kārts");

    const me = room.players[idx], hi=me.hand.findIndex(c=>c.id===card.id);
    if (hi<0) return err("Tev tādas kārts nav");

    me.hand.splice(hi,1);
    room.table.push({ attack: card });
    room.passes.delete(me.id);
    emitState(room);
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), room.botStepMs || BOT_STEP_MS);
  });

  socket.on("playAttackMany", ({ roomId, cards }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) return;
    if (idx===room.defender) return err("Aizsargs nevar uzbrukt");
    if (!Array.isArray(cards)||!cards.length) return;

    const me=room.players[idx];
    const ranksOnTable=tableRanks(room);
    for (const card of cards){
      if (room.table.length >= maxPairsAllowed(room)) break;
      const hi=me.hand.findIndex(c=>c.id===card.id);
      if (hi<0) continue;
      const canAdd = room.table.length===0 || ranksOnTable.has(card.r);
      if (!canAdd) continue;
      me.hand.splice(hi,1);
      room.table.push({ attack: card });
      ranksOnTable.add(card.r);
    }
    room.passes.delete(me.id);
    emitState(room);
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), room.botStepMs || BOT_STEP_MS);
  });

  socket.on("playDefend", ({ roomId, attackIndex, card }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) return;
    if (idx !== room.defender) return err("Tikai aizsargs drīkst aizsegt");

    const pair = room.table[attackIndex]; if(!pair || pair.defend) return err("Nepareizs pāris");
    const me = room.players[idx], hi=me.hand.findIndex(c=>c.id===card.id);
    if (hi<0) return err("Tev tādas kārts nav");
    if (!canCover(pair.attack, card, room.trumpSuit, room.ranks)) return err("Ar šo kārti nevar aizsegt");

    me.hand.splice(hi,1);
    pair.defend = card;
    emitState(room);

    const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
    if (allCovered && room.passes.size === room.players.length-1){
      endBoutDefended(room);
      if (!checkGameEnd(room)) emitState(room);
    }
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), room.botStepMs || BOT_STEP_MS);
  });

  socket.on("takeCards", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) return;
    if (idx !== room.defender) return err("Tikai aizsargs var ņemt");

    endBoutTook(room);
    if (!checkGameEnd(room)) emitState(room);
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), room.botStepMs || BOT_STEP_MS);
  });

  socket.on("pass", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) return;
    if (idx===room.defender) return err("Aizsargs nevar pasēt");

    room.passes.add(room.players[idx].id);
    const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
    if (allCovered && room.passes.size === room.players.length-1){
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

  // Iziet no istabas (poga)
  socket.on("leaveRoom", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room) return;
    removePlayer1v1(room, socket.id);
    if (rooms.has(roomId)) emitState(room);
  });

  // Atvienojās (x aizvērts u.tml.)
  socket.on("disconnect", () => {
    for (const room of rooms.values()){
      if (room.players.some(p=>p.id===socket.id)){
        removePlayer1v1(room, socket.id);
        if (rooms.has(room.id)) emitState(room);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log("Duraks 1v1 serveris uz porta " + PORT));
