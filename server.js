// server.js — Duraks + BOT (1v1) + multi-attack, podkidnoy, līdz 6 spēlētājiem
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
const rankValue = (r) => RANKS.indexOf(r);
const nextIndex = (i, list) => (i + 1) % list.length;

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ r, s, id: `${r}${s}-${Math.random().toString(36).slice(2,8)}` });
  for (let i = deck.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [deck[i], deck[j]] = [deck[j], deck[i]]; }
  return deck;
}
function canCover(attack, defend, trump) {
  if (!attack || !defend) return false;
  if (defend.s === attack.s) return rankValue(defend.r) > rankValue(attack.r);
  if (attack.s !== trump && defend.s === trump) return true;
  if (attack.s === trump && defend.s === trump) return rankValue(defend.r) > rankValue(attack.r);
  return false;
}

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
  passes: Set<socketId>,
  chat: string[]
 }
*/

function visibleState(room, sid) {
  return {
    id: room.id, phase: room.phase,
    trumpSuit: room.trumpSuit, trumpCard: room.trumpCard,
    deckCount: room.deck.length, discardCount: room.discard.length,
    attacker: room.attacker, defender: room.defender,
    table: room.table,
    players: room.players.map((p, idx) => ({ nick: p.nick, handCount: p.hand.length, me: p.id === sid, index: idx, isBot: p.isBot, connected: p.connected })),
    myHand: room.players.find(p => p.id === sid)?.hand ?? [],
    chat: room.chat.slice(-60)
  };
}
function emitState(room) { for (const p of room.players) io.to(p.id).emit("state", visibleState(room, p.id)); }
function msg(room, text){ room.chat.push(text); io.to(room.id).emit("message", text); }
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
  room.attacker = room.defender;
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.phase = "attack";
}
function endBoutTook(room) {
  const def = room.players[room.defender];
  for (const pair of room.table) { def.hand.push(pair.attack); if (pair.defend) def.hand.push(pair.defend); }
  room.table = [];
  dealUpToSix(room);
  room.attacker = nextIndex(room.defender, room.players);
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

/* ===== BOT loģika (vienkāršota, bet gudra pietiekami) ===== */
function botAct(room) {
  // izpilda vairākus soļus, līdz bots beidz savu gājienu
  let guard = 0;
  while (guard++ < 40) {
    const attacker = room.attacker, defender = room.defender;
    const ap = room.players[attacker], dp = room.players[defender];
    const isAttackerBot = ap.isBot, isDefenderBot = dp.isBot;

    // Aizsarga gājiens – aizsedz visas neaizsegtās vai ņem
    if (isDefenderBot && room.phase === "attack") {
      const openIdx = room.table.map((p,i)=>!p.defend?i:-1).filter(i=>i>=0);
      if (openIdx.length) {
        // mēģina aizsegt katru pēc vienas stratēģijas: vislētākais derīgais
        const trump = room.trumpSuit;
        let acted = false;
        for (const i of openIdx) {
          const atk = room.table[i].attack;
          // izvēlamies zemāko segtspējīgo
          const candidates = dp.hand.filter(c=>canCover(atk,c,trump)).sort((a,b)=>rankValue(a.r)-rankValue(b.r));
          if (candidates.length) {
            const card = candidates[0];
            dp.hand.splice(dp.hand.findIndex(x=>x.id===card.id),1);
            room.table[i].defend = card;
            acted = true;
          }
        }
        if (acted) { emitState(room); continue; }
      }
      // ja ir neaizsegti un nav ar ko – ņem
      if (room.table.length>0 && room.table.some(p=>!p.defend)) {
        endBoutTook(room);
        if (checkGameEnd(room)) return;
        emitState(room);
        continue;
      }
      // ja viss aizsegts – uzbrucējiem jānopasē; bots nopasē
      room.passes.add(dp.id); // aizsargam nav jāpasē, bet lai noslēdzas bouts, uzbrucējiem jāpasē — to zemāk apstrādāsim
      if (room.table.length>0 && room.table.every(p=>p.defend) && room.passes.size===room.players.length-1) {
        endBoutDefended(room);
        if (checkGameEnd(room)) return;
        emitState(room);
        continue;
      }
    }

    // Uzbrucēja gājiens – uzbrūk vai pievieno
    if (isAttackerBot && room.phase === "attack") {
      // var uzlikt 1–3 kārtis: vai nu vienāda ranga komplektu, vai pa vienai atbilstoši galda rangiem
      const trump = room.trumpSuit;
      const ranksOnTable = tableRanks(room);
      const hand = ap.hand.slice().sort((a,b)=> {
        const at = (a.s===trump), bt=(b.s===trump);
        if (at!==bt) return at-bt; // netrumpi pirms trumpiem
        return rankValue(a.r)-rankValue(b.r);
      });

      const spaceLeft = maxPairsAllowed(room) - room.table.length;
      if (spaceLeft <= 0) { room.passes.add(ap.id); emitState(room); continue; }

      let toPlay = [];
      if (room.table.length === 0) {
        // izvēlies zemāko rangu (ne trumpi), un mēģini uzlikt 1–2 tā paša ranga
        const groups = {};
        for (const c of hand) { groups[c.r] = groups[c.r] || []; groups[c.r].push(c); }
        const order = RANKS.slice(); // 6..A
        for (const r of order) {
          const g = (groups[r]||[]).filter(c=>c.s!==trump);
          if (g.length) { toPlay = g.slice(0, Math.min(2, spaceLeft)); break; }
        }
        if (!toPlay.length) {
          // ja nav — ņem zemāko no visiem
          toPlay = [hand[0]].slice(0,1);
        }
      } else {
        // pievienošana — tikai rangi, kas uz galda
        for (const c of hand) if (ranksOnTable.has(c.r)) toPlay.push(c);
        toPlay = toPlay.slice(0, Math.min(2, spaceLeft));
      }

      if (toPlay.length) {
        for (const c of toPlay) {
          ap.hand.splice(ap.hand.findIndex(x=>x.id===c.id),1);
          room.table.push({ attack: c });
        }
        room.passes.delete(ap.id);
        emitState(room);
        continue;
      } else {
        // nekas neder — pase
        room.passes.add(ap.id);
        // ja viss aizsegts un visi uzbrucēji pasējuši → beigt bout
        if (room.table.length>0 && room.table.every(p=>p.defend) && room.passes.size===room.players.length-1) {
          endBoutDefended(room);
          if (checkGameEnd(room)) return;
          emitState(room);
          continue;
        }
      }
    }

    // ja neviens bot vairs nav pie gājiena — stop
    break;
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
    // Ja tikai viens cilvēks, pievieno BOT
    if (room.players.length === 1) {
      const botId = `bot-${Math.random().toString(36).slice(2,7)}`;
      room.players.push({ id: botId, nick: "BOT", hand: [], isBot:true, connected:true });
      // pieslēdzam botu istabai (virtuāli)
      io.socketsJoin?.(room.id);
    }
    if (room.players.length < 2) return err("Vajag vismaz 2 spēlētājus");

    // Dala līdz 6
    for (const p of room.players) while (p.hand.length < 6 && room.deck.length) p.hand.push(room.deck.pop());

    // Sāk ar zemāko trumpi
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
    // dod vārdu botam, ja viņš ir gājienā
    botAct(room);
  });

  // Uzbrukums ar VIENU karti
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
    botAct(room);
  });

  // Uzbrukums ar VAIRĀKĀM kartīm (2–4)
  socket.on("playAttackMany", ({ roomId, cards }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx<0 || idx===room.defender) return err("Aizsargs nevar uzbrukt");
    if (!Array.isArray(cards) || !cards.length) return;

    const ranks = tableRanks(room);
    for (const card of cards) {
      if (room.table.length >= maxPairsAllowed(room)) break;
      const canAdd = room.table.length===0 || ranks.has(card.r);
      const p = room.players[idx];
      const hi = p.hand.findIndex(c=>c.id===card.id);
      if (hi>=0 && canAdd) {
        p.hand.splice(hi,1);
        room.table.push({ attack: card });
        ranks.add(card.r);
      }
    }
    room.passes.delete(room.players[idx].id);
    emitState(room);
    botAct(room);
  });

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

    const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
    if (allCovered && room.passes.size === room.players.length-1) {
      endBoutDefended(room);
      if (!checkGameEnd(room)) emitState(room);
      botAct(room);
      return;
    }
    emitState(room);
    botAct(room);
  });

  socket.on("takeCards", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.phase!=="attack") return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx !== room.defender) return err("Tikai aizsargs var ņemt");
    endBoutTook(room);
    if (!checkGameEnd(room)) emitState(room);
    botAct(room);
  });

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
      botAct(room);
      return;
    }
    emitState(room);
    botAct(room);
  });

  socket.on("chat", ({ roomId, text }) => {
    const room = rooms.get(roomId);
    if (!room || !text) return;
    const p = room.players.find(pl=>pl.id===socket.id);
    if (!p) return;
    msg(room, `${p.nick}: ${String(text).slice(0,200)}`);
    emitState(room);
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const p = room.players.find(pl=>pl.id===socket.id);
      if (p) p.connected = false;
    }
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log("Duraks serveris klausās uz porta " + PORT));
