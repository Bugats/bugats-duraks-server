// server.js — Duraks (podkidnoy) ar: apakšējo trumpi (nedalās rokā) + Ready lobby + auto-BOT
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());
app.get("/health", (_, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*", methods: ["GET","POST"] } });

const RANKS = ["6","7","8","9","10","J","Q","K","A"];
const SUITS = ["♣","♦","♥","♠"];
const BOT_STEP_MS  = Number(process.env.BOT_STEP_MS || 900);
const BOT_THINK_MS = Number(process.env.BOT_THINK_MS || 600);

const rankValue = (r) => RANKS.indexOf(r);
const nextIndex  = (i, list) => (i + 1) % list.length;

/* ====== KAVA: apakšējā trumpa karte netiek iekļauta dalāmajā kavā ====== */
function makeShuffled36() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ r, s, id: `${r}${s}-${Math.random().toString(36).slice(2,8)}` });
  for (let i = d.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function initDeck() {
  const d = makeShuffled36();
  const trumpCard = d[0];           // apakšējā karte (redzama)
  const deck = d.slice(1);          // dalāmā kaudze (bez trumpa)
  return { deck, trumpCard, trumpSuit: trumpCard.s, trumpAvailable: true };
}
function canCover(a, d, trump) {
  if (!a || !d) return false;
  if (d.s === a.s) return rankValue(d.r) > rankValue(a.r);
  if (a.s !== trump && d.s === trump) return true;
  if (a.s === trump && d.s === trump) return rankValue(d.r) > rankValue(a.r);
  return false;
}

const rooms = new Map();
/*
 room = {
   id, hostId,
   players: [{ id, nick, hand: Card[], isBot: boolean, ready: boolean, connected: boolean }],
   deck: Card[], discard: Card[],
   trumpCard, trumpSuit, trumpAvailable: boolean,
   table: [{ attack: Card, defend?: Card }],
   attacker, defender,
   phase: "lobby"|"attack"|"end",
   passes: Set<playerId>,
   chat: string[],
   botTimer?: NodeJS.Timeout
 }
*/

function visibleState(room, sid) {
  return {
    id: room.id, phase: room.phase,
    trumpSuit: room.trumpSuit, trumpCard: room.trumpCard, // redzama apakšējā karte
    deckCount: room.deck.length + (room.trumpAvailable ? 1 : 0), // kavas skaitā ieskaitām arī apakšējo trumpi
    discardCount: room.discard.length,
    attacker: room.attacker, defender: room.defender,
    table: room.table,
    players: room.players.map((p, i) => ({ nick: p.nick, handCount: p.hand.length, ready: p.ready, me: p.id === sid, index: i, isBot: p.isBot })),
    myHand: room.players.find(p => p.id === sid)?.hand ?? [],
    chat: room.chat.slice(-60)
  };
}
function emitState(room){ for (const p of room.players) io.to(p.id).emit("state", visibleState(room, p.id)); }
function msg(room, text){ room.chat.push(text); io.to(room.id).emit("message", text); emitState(room); }
function tableRanks(room){ const s=new Set(); for(const pr of room.table){ if(pr.attack) s.add(pr.attack.r); if(pr.defend) s.add(pr.defend.r);} return s; }
function maxPairsAllowed(room){ const def = room.players[room.defender]; return Math.min(6, def.hand.length); }

/* ņem 1 kārti no kavas; ja kava tukša un trumpAvailable=true → paņem apakšējo trumpi */
function drawOne(room){
  if (room.deck.length > 0) return room.deck.pop();
  if (room.trumpAvailable) { room.trumpAvailable = false; return room.trumpCard; }
  return null;
}
function dealUpToSix(room){
  let i = room.attacker;
  for (let k = 0; k < room.players.length; k++){
    const p = room.players[i];
    while (p.hand.length < 6) {
      const c = drawOne(room);
      if (!c) break;
      p.hand.push(c);
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
  room.phase = "attack";
}
function checkGameEnd(room){
  const active = room.players.filter(p => p.hand.length > 0);
  if (active.length <= 1){
    room.phase = "end";
    io.to(room.id).emit("end", { losers: active.map(p=>p.nick), winners: room.players.filter(p=>p.hand.length===0).map(p=>p.nick) });
    return true;
  }
  return false;
}

/* ===== BOT ar lēnu soli (bez “BOT pasē” spama) ===== */
function clearBotTimer(room){ if (room.botTimer){ clearTimeout(room.botTimer); room.botTimer = undefined; } }
function schedule(room, fn, d){ clearBotTimer(room); room.botTimer = setTimeout(fn, d); }
function botShouldPlay(room){
  if (room.phase !== "attack") return false;
  const a = room.players[room.attacker], d = room.players[room.defender];
  return a?.isBot || d?.isBot;
}
function botOneStep(room){
  if (room.phase !== "attack") return false;
  const aI = room.attacker, dI = room.defender;
  const A = room.players[aI], D = room.players[dI];
  const trump = room.trumpSuit;

  // Aizsargs — mēģina aizklāt vienu
  if (D?.isBot){
    const open = room.table.map((p,i)=>!p.defend?i:-1).filter(i=>i>=0);
    if (open.length){
      const i = open[0]; const atk = room.table[i].attack;
      const cand = D.hand.filter(c=>canCover(atk,c,trump)).sort((x,y)=>rankValue(x.r)-rankValue(y.r));
      if (cand.length){
        const card = cand[0];
        D.hand.splice(D.hand.findIndex(c=>c.id===card.id),1);
        room.table[i].defend = card;
        msg(room, `BOT aizsedz ${atk.r}${atk.s} ar ${card.r}${card.s}`);
        const allCovered = room.table.length>0 && room.table.every(p=>p.defend);
        if (allCovered && room.passes.size === room.players.length-1){ endBoutDefended(room); if (!checkGameEnd(room)) msg(room, "Viss aizsegts — nākamais bauta."); }
        return true;
      }
      // nevar aizklāt → ņem
      endBoutTook(room); msg(room, "BOT nevar aizsegt — ņem kārtis."); return true;
    }
  }

  // Uzbrucējs — uzliek vienu vai pasē (klusināts)
  if (A?.isBot){
    const ranksOnTable = tableRanks(room);
    const spaceLeft = maxPairsAllowed(room) - room.table.length;
    if (spaceLeft <= 0){ room.passes.add(A.id); return true; }

    const hand = A.hand.slice().sort((a,b)=>{
      const at=(a.s===trump), bt=(b.s===trump);
      if (at!==bt) return at-bt; // netrumpi pirms trumpiem
      return rankValue(a.r)-rankValue(b.r);
    });

    let card = null;
    if (room.table.length === 0) card = hand.find(c=>c.s!==trump) || hand[0];
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
      if (allCovered && room.passes.size === room.players.length-1){ endBoutDefended(room); if (!checkGameEnd(room)) msg(room, "Viss aizsegts — nākamais bauta."); }
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
  if (did && botShouldPlay(room)) schedule(room, ()=>runBot(room), BOT_STEP_MS);
}

/* ====== SOCKETS ====== */
io.on("connection", (socket) => {
  const err = (m)=>socket.emit("error", m);

  socket.on("createRoom", ({ roomId, nickname }) => {
    if (!roomId) return err("Room ID nav norādīts");
    if (rooms.has(roomId)) return err("Istaba jau eksistē");
    const { deck, trumpCard, trumpSuit, trumpAvailable } = initDeck();
    const room = {
      id: roomId, hostId: socket.id,
      players: [{ id: socket.id, nick: nickname || "Spēlētājs", hand: [], isBot:false, ready:false, connected:true }],
      deck, discard: [], trumpCard, trumpSuit, trumpAvailable,
      table: [], attacker:0, defender:0, phase:"lobby",
      passes: new Set(), chat:[]
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    emitState(room);
  });

  socket.on("joinRoom", ({ roomId, nickname }) => {
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (room.phase !== "lobby") return err("Spēle jau sākusies");
    if (room.players.length >= 6) return err("Istaba ir pilna");
    room.players.push({ id: socket.id, nick: nickname || "Spēlētājs", hand: [], isBot:false, ready:false, connected:true });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("toggleReady", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase !== "lobby") return;
    const p = room.players.find(pl => pl.id === socket.id);
    if (!p) return;
    p.ready = !p.ready;
    emitState(room);
  });

  socket.on("startGame", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (socket.id !== room.hostId) return err("Tikai host var sākt");

    // ja tikai viens cilvēks → pievieno BOT
    const humans = room.players.filter(p => !p.isBot);
    if (humans.length === 1) {
      const botId = `bot-${Math.random().toString(36).slice(2,7)}`;
      room.players.push({ id: botId, nick: "BOT", hand: [], isBot:true, ready:true, connected:true });
    } else {
      // citādi — pārbaude, vai visi cilvēki gatavi
      if (!humans.every(p => p.ready)) return err("Ne visi spēlētāji ir gatavi");
    }
    if (room.players.length < 2) return err("Vajag vismaz 2 spēlētājus");

    // dala līdz 6 (no deck; trumpis netiek dalīts, tikai kad izbeidzas kava)
    for (const p of room.players) while (p.hand.length < 6) { const c = drawOne(room); if (!c) break; p.hand.push(c); }

    // sāk ar zemāko trumpi
    let best = { have:false, val:Infinity, idx:0 };
    room.players.forEach((p, idx) => { p.hand.forEach(c => { if (c.s===room.trumpSuit && rankValue(c.r) < best.val) best = { have:true, val:rankValue(c.r), idx }; }); });
    room.attacker = best.have ? best.idx : 0;
    room.defender = nextIndex(room.attacker, room.players);
    room.phase = "attack";
    room.passes = new Set();

    msg(room, `Trumpis: ${room.trumpCard.r}${room.trumpCard.s}`);
    emitState(room);
    if (botShouldPlay(room)) setTimeout(()=>runBot(room), BOT_THINK_MS);
  });

  // Uzbrukums (1 vai vairākas — klientā ir atsevišķa funkcija)
  socket.on("playAttack", ({ roomId, card }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx<0 || idx===room.defender) return err("Aizsargs nevar uzbrukt");
    if (room.table.length >= maxPairsAllowed(room)) return err("Sasniegts pāru limits");

    const ranks = tableRanks(room);
    const canAdd = room.table.length===0 || ranks.has(card.r);
    if (!canAdd) return err("Jāliek tāda paša ranga kārts");

    const p = room.players[idx], hi = p.hand.findIndex(c=>c.id===card.id);
    if (hi<0) return err("Tev tādas kārts nav");
    p.hand.splice(hi,1);
    room.table.push({ attack: card });
    room.passes.delete(p.id);
    emitState(room);
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), BOT_STEP_MS);
  });

  socket.on("playAttackMany", ({ roomId, cards }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx<0 || idx===room.defender) return err("Aizsargs nevar uzbrukt");
    if (!Array.isArray(cards) || !cards.length) return;

    const ranks = tableRanks(room);
    for (const card of cards) {
      if (room.table.length >= maxPairsAllowed(room)) break;
      const p = room.players[idx], hi = p.hand.findIndex(c=>c.id===card.id);
      if (hi<0) continue;
      const canAdd = room.table.length===0 || ranks.has(card.r);
      if (!canAdd) continue;
      p.hand.splice(hi,1);
      room.table.push({ attack: card });
      ranks.add(card.r);
    }
    room.passes.delete(room.players[idx].id);
    emitState(room);
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), BOT_STEP_MS);
  });

  socket.on("playDefend", ({ roomId, attackIndex, card }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx !== room.defender) return err("Tikai aizsargs drīkst aizsegt");

    const pair = room.table[attackIndex];
    if (!pair || pair.defend) return err("Nepareizs pāris");

    const p = room.players[idx], hi = p.hand.findIndex(c=>c.id===card.id);
    if (hi<0) return err("Tev tādas kārts nav");
    if (!canCover(pair.attack, card, room.trumpSuit)) return err("Ar šo kārti nevar aizsegt");

    p.hand.splice(hi,1);
    pair.defend = card;
    emitState(room);

    const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
    if (allCovered && room.passes.size === room.players.length-1) { endBoutDefended(room); if (!checkGameEnd(room)) emitState(room); }
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), BOT_STEP_MS);
  });

  socket.on("takeCards", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx !== room.defender) return err("Tikai aizsargs var ņemt");
    endBoutTook(room);
    if (!checkGameEnd(room)) emitState(room);
    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), BOT_STEP_MS);
  });

  socket.on("pass", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx<0 || idx===room.defender) return err("Aizsargs nevar pasēt");
    room.passes.add(room.players[idx].id);

    const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
    if (allCovered && room.passes.size === room.players.length-1) { endBoutDefended(room); if (!checkGameEnd(room)) emitState(room); }
    else emitState(room);

    if (botShouldPlay(room)) schedule(room, ()=>runBot(room), BOT_STEP_MS);
  });

  socket.on("chat", ({ roomId, text }) => {
    const room = rooms.get(roomId);
    if (!room || !text) return;
    const p = room.players.find(pl=>pl.id===socket.id);
    if (!p) return;
    msg(room, `${p.nick}: ${String(text).slice(0,200)}`);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const p = room.players.find(pl=>pl.id===socket.id);
      if (p) p.connected = false;
      clearBotTimer(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log("Duraks serveris klausās uz porta " + PORT));
