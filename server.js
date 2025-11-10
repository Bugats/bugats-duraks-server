// server.js — Duraks + BOT ar "lēno soli" (pa vienai darbībai, ar pauzi)
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
const RANKS = ["6","7","8","9","10","J","Q","K","A"];
const SUITS = ["♣","♦","♥","♠"];
const BOT_STEP_MS   = Number(process.env.BOT_STEP_MS || 900);  // pauze starp bot soļiem (ms)
const BOT_THINK_MS  = Number(process.env.BOT_THINK_MS || 600); // pirmais “padomāšanas” brīdis (ms)

/* ===== Palīgfunkcijas ===== */
const rankValue = (r) => RANKS.indexOf(r);
const nextIndex = (i, list) => (i + 1) % list.length;

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS)
    deck.push({ r, s, id: `${r}${s}-${Math.random().toString(36).slice(2,8)}` });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function canCover(attack, defend, trump) {
  if (!attack || !defend) return false;
  if (defend.s === attack.s) return rankValue(defend.r) > rankValue(attack.r);
  if (attack.s !== trump && defend.s === trump) return true;
  if (attack.s === trump && defend.s === trump) return rankValue(defend.r) > rankValue(attack.r);
  return false;
}

/* ===== Istabas ===== */
const rooms = new Map();
/*
 room = {
  id, hostId,
  players: [{ id, nick, hand: Card[], isBot: boolean, connected: boolean }],
  deck: Card[], discard: Card[],
  trumpSuit, trumpCard,
  table: [{ attack: Card, defend?: Card }],
  attacker: number, defender: number,
  phase: "lobby"|"attack"|"end",
  passes: Set<playerId>,
  chat: string[],
  botTimer?: NodeJS.Timeout
 }
*/

function visibleState(room, sid) {
  return {
    id: room.id, phase: room.phase,
    trumpSuit: room.trumpSuit, trumpCard: room.trumpCard,
    deckCount: room.deck.length, discardCount: room.discard.length,
    attacker: room.attacker, defender: room.defender,
    table: room.table,
    players: room.players.map((p, idx) => ({
      nick: p.nick, handCount: p.hand.length, me: p.id === sid,
      index: idx, isBot: p.isBot, connected: p.connected
    })),
    myHand: room.players.find(p => p.id === sid)?.hand ?? [],
    chat: room.chat.slice(-60)
  };
}
function emitState(room) { for (const p of room.players) io.to(p.id).emit("state", visibleState(room, p.id)); }
function msg(room, text){ room.chat.push(text); io.to(room.id).emit("message", text); emitState(room); }
function tableRanks(room) {
  const ranks = new Set();
  for (const pair of room.table) { if (pair.attack) ranks.add(pair.attack.r); if (pair.defend) ranks.add(pair.defend.r); }
  return ranks;
}
function maxPairsAllowed(room) {
  const def = room.players[room.defender];
  return Math.min(6, def.hand.length);
}
function dealUpToSix(room) {
  let i = room.attacker;
  for (let k = 0; k < room.players.length; k++) {
    const p = room.players[i];
    while (p.hand.length < 6 && room.deck.length > 0) p.hand.push(room.deck.pop());
    i = nextIndex(i, room.players);
  }
}
function endBoutDefended(room) {
  for (const pair of room.table) { room.discard.push(pair.attack); if (pair.defend) room.discard.push(pair.defend); }
  room.table = [];
  dealUpToSix(room);
  room.attacker = room.defender;                    // nākamais uzbrucējs = iepriekšējais aizsargs
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.phase = "attack";
}
function endBoutTook(room) {
  const def = room.players[room.defender];
  for (const pair of room.table) { def.hand.push(pair.attack); if (pair.defend) def.hand.push(pair.defend); }
  room.table = [];
  dealUpToSix(room);
  room.attacker = nextIndex(room.defender, room.players); // nākamais uzbrucējs = pēc aizsarga
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.phase = "attack";
}
function checkGameEnd(room) {
  const active = room.players.filter(p => p.hand.length > 0);
  if (active.length <= 1) {
    room.phase = "end";
    io.to(room.id).emit("end",{ losers: active.map(p=>p.nick), winners: room.players.filter(p=>p.hand.length===0).map(p=>p.nick) });
    return true;
  }
  return false;
}

/* ===== BOT: vienas darbības solis ar pauzi ===== */
function clearBotTimer(room){ if (room.botTimer) { clearTimeout(room.botTimer); room.botTimer = undefined; } }
function schedule(room, fn, delay){ clearBotTimer(room); room.botTimer = setTimeout(fn, delay); }

function botShouldPlay(room){
  if (room.phase !== "attack") return false;
  const a = room.players[room.attacker];
  const d = room.players[room.defender];
  return (a?.isBot || d?.isBot);
}

/** Viena bot darbība (ATGRIEŽ true, ja kaut ko izdarīja) */
function botOneStep(room){
  if (room.phase !== "attack") return false;

  const aI = room.attacker, dI = room.defender;
  const A = room.players[aI], D = room.players[dI];
  const trump = room.trumpSuit;

  // 1) Aizsargam jāaizsedz viena kārts, ja var
  if (D?.isBot) {
    const open = room.table.map((p,i)=>!p.defend?i:-1).filter(i=>i>=0);
    if (open.length) {
      const i = open[0];
      const atk = room.table[i].attack;
      const cand = D.hand.filter(c=>canCover(atk,c,trump)).sort((x,y)=>rankValue(x.r)-rankValue(y.r));
      if (cand.length) {
        const card = cand[0];
        D.hand.splice(D.hand.findIndex(c=>c.id===card.id),1);
        room.table[i].defend = card;
        msg(room, `BOT aizsedz ${atk.r}${atk.s} ar ${card.r}${card.s}`);
        // pārbaude vai bouts jānoslēdz
        const allCovered = room.table.length>0 && room.table.every(p=>p.defend);
        if (allCovered && room.passes.size === room.players.length-1) {
          endBoutDefended(room);
          if (!checkGameEnd(room)) msg(room, "Viss aizsegts — pāreja uz nākamo bautu.");
        }
        return true;
      }
      // nevar aizsegt → ņem (vienā solī)
      endBoutTook(room);
      msg(room, "BOT nevar aizsegt — ņem kārtis.");
      return true;
    }
  }

  // 2) Uzbrucējs (bots) uzliek vienu kārti vai pasē
  if (A?.isBot) {
    const ranksOnTable = tableRanks(room);
    const spaceLeft = maxPairsAllowed(room) - room.table.length;
    if (spaceLeft <= 0) { room.passes.add(A.id); msg(room, "BOT pasē."); return true; }

    // sakārto roku: netrumpi (zemākie) vispirms
    const hand = A.hand.slice().sort((a,b)=>{
      const at = (a.s===trump), bt=(b.s===trump);
      if (at!==bt) return at-bt;
      return rankValue(a.r)-rankValue(b.r);
    });

    let cardToPlay = null;

    if (room.table.length === 0) {
      // izvēlas zemāko ne-trumpi (vai zemāko vispār)
      cardToPlay = hand.find(c=>c.s!==trump) || hand[0];
    } else {
      // pievienošana — tikai rangi, kas uz galda
      cardToPlay = hand.find(c => ranksOnTable.has(c.r)) || null;
    }

    if (cardToPlay) {
      A.hand.splice(A.hand.findIndex(c=>c.id===cardToPlay.id),1);
      room.table.push({ attack: cardToPlay });
      room.passes.delete(A.id);
      msg(room, `BOT uzbrūk ar ${cardToPlay.r}${cardToPlay.s}`);
      return true;
    } else {
      room.passes.add(A.id);
      msg(room, "BOT pasē.");
      const allCovered = room.table.length>0 && room.table.every(p=>p.defend);
      if (allCovered && room.passes.size === room.players.length-1) {
        endBoutDefended(room);
        if (!checkGameEnd(room)) msg(room, "Viss aizsegts — pāreja uz nākamo bautu.");
      }
      return true;
    }
  }

  return false;
}

function runBot(room){
  // izpilda vienu soli; ja vēl var — ieplāno nākamo ar pauzi
  if (room.phase !== "attack") return;
  const did = botOneStep(room);
  emitState(room);
  if (checkGameEnd(room)) return;
  if (did && botShouldPlay(room)) {
    schedule(room, () => runBot(room), BOT_STEP_MS);
  }
}

/* ===== Socket notikumi ===== */
io.on("connection", (socket) => {
  const err = (m)=>socket.emit("error", m);

  socket.on("createRoom", ({ roomId, nickname }) => {
    if (!roomId) return err("Room ID nav norādīts");
    if (rooms.has(roomId)) return err("Istaba jau eksistē");
    const deck = makeDeck();
    const trumpCard = deck[deck.length-1];
    const trumpSuit = trumpCard.s;
    const room = {
      id: roomId, hostId: socket.id,
      players: [{ id: socket.id, nick: nickname || "Spēlētājs", hand: [], isBot:false, connected:true }],
      deck, discard: [], trumpSuit, trumpCard,
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
    room.players.push({ id: socket.id, nick: nickname || "Spēlētājs", hand: [], isBot:false, connected:true });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("startGame", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (socket.id !== room.hostId) return err("Tikai host var sākt");
    // ja lobby viens spēlētājs — pievieno BOTu
    if (room.players.length === 1) {
      const botId = `bot-${Math.random().toString(36).slice(2,7)}`;
      room.players.push({ id: botId, nick: "BOT", hand: [], isBot:true, connected:true });
    }
    if (room.players.length < 2) return err("Vajag vismaz 2 spēlētājus");

    // dala līdz 6
    for (const p of room.players) while (p.hand.length < 6 && room.deck.length) p.hand.push(room.deck.pop());

    // sāk ar zemāko trumpi
    let best = { have:false, val:Infinity, idx:0 };
    room.players.forEach((p, idx) => {
      p.hand.forEach(c => { if (c.s===room.trumpSuit && rankValue(c.r) < best.val) best = { have:true, val:rankValue(c.r), idx }; });
    });
    room.attacker = best.have ? best.idx : 0;
    room.defender = nextIndex(room.attacker, room.players);
    room.phase = "attack";
    room.passes = new Set();

    msg(room, `Trumpis: ${room.trumpCard.r}${room.trumpCard.s}`);
    emitState(room);

    // iedod botam vārdu ar “padomāšanas” pauzi
    if (botShouldPlay(room)) schedule(room, () => runBot(room), BOT_THINK_MS);
  });

  // Uzbrukums ar 1 kārti
  socket.on("playAttack", ({ roomId, card }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx<0 || idx===room.defender) return err("Aizsargs nevar uzbrukt");
    if (room.table.length >= maxPairsAllowed(room)) return err("Sasniegts pāru limits");

    const ranks = tableRanks(room);
    const canAdd = room.table.length===0 || ranks.has(card.r);
    if (!canAdd) return err("Jāliek tāda paša ranga kārts");

    const p = room.players[idx];
    const hi = p.hand.findIndex(c=>c.id===card.id);
    if (hi<0) return err("Tev tādas kārts nav");

    p.hand.splice(hi,1);
    room.table.push({ attack: card });
    room.passes.delete(p.id);
    emitState(room);

    if (botShouldPlay(room)) schedule(room, () => runBot(room), BOT_STEP_MS);
  });

  // Uzbrukums ar vairākām (2–4) — no klienta izvēlētās
  socket.on("playAttackMany", ({ roomId, cards }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx<0 || idx===room.defender) return err("Aizsargs nevar uzbrukt");
    if (!Array.isArray(cards) || !cards.length) return;

    const ranks = tableRanks(room);
    for (const card of cards) {
      if (room.table.length >= maxPairsAllowed(room)) break;
      const p = room.players[idx];
      const hi = p.hand.findIndex(c=>c.id===card.id);
      if (hi<0) continue;
      const canAdd = room.table.length===0 || ranks.has(card.r);
      if (!canAdd) continue;
      p.hand.splice(hi,1);
      room.table.push({ attack: card });
      ranks.add(card.r);
      msg(room, `Uzliec ${card.r}${card.s}`);
    }
    room.passes.delete(room.players[idx].id);
    emitState(room);

    if (botShouldPlay(room)) schedule(room, () => runBot(room), BOT_STEP_MS);
  });

  // Aizsardzība
  socket.on("playDefend", ({ roomId, attackIndex, card }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx !== room.defender) return err("Tikai aizsargs drīkst aizsegt");

    const pair = room.table[attackIndex];
    if (!pair || pair.defend) return err("Nepareizs pāris");

    const p = room.players[idx];
    const hi = p.hand.findIndex(c=>c.id===card.id);
    if (hi<0) return err("Tev tādas kārts nav");
    if (!canCover(pair.attack, card, room.trumpSuit)) return err("Ar šo kārti nevar aizsegt");

    p.hand.splice(hi,1);
    pair.defend = card;
    emitState(room);

    const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
    if (allCovered && room.passes.size === room.players.length-1) {
      endBoutDefended(room);
      if (!checkGameEnd(room)) emitState(room);
    }

    if (botShouldPlay(room)) schedule(room, () => runBot(room), BOT_STEP_MS);
  });

  // Ņemt
  socket.on("takeCards", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx !== room.defender) return err("Tikai aizsargs var ņemt");

    endBoutTook(room);
    if (!checkGameEnd(room)) emitState(room);

    if (botShouldPlay(room)) schedule(room, () => runBot(room), BOT_STEP_MS);
  });

  // Pase
  socket.on("pass", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx<0 || idx===room.defender) return err("Aizsargs nevar pasēt");
    room.passes.add(room.players[idx].id);

    const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
    if (allCovered && room.passes.size === room.players.length-1) {
      endBoutDefended(room);
      if (!checkGameEnd(room)) emitState(room);
    } else {
      emitState(room);
    }

    if (botShouldPlay(room)) schedule(room, () => runBot(room), BOT_STEP_MS);
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
