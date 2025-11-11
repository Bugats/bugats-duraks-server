// server.js — Duraks (podkidnoy) ar Rooms, Leaderboard, Reconnect, Undo limitu,
// BOT soft-delay, drošības slāņiem + Turnīri ar LOBBY sēdvietām (sit/ready),
// random seeding (pretinieku izvēli neietekmē spēlētāji) un spectator režīmu.

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
const BOT_STEP_MIN = 600;
const BOT_STEP_MAX = 1200;
const RECONNECT_GRACE_MS = 30_000;

/* ===== Palīgi ===== */
const nextIndex = (i, list) => (i + 1) % list.length;
const rankValue = (r, ranks) => ranks.indexOf(r);
const now = () => Date.now();
const rand = (a,b)=>Math.floor(a + Math.random()*(b-a+1));
const uid = (p="id") => `${p}-${Math.random().toString(36).slice(2,10)}`;
function shuffle(arr){ for (let i=arr.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }

/* ===== Kavas ===== */
function makeDeck(mode){ const ranks = mode==="52" ? RANKS_52 : RANKS_36; const d=[]; for(const s of SUITS) for(const r of ranks) d.push({ r,s,id:`${r}${s}-${Math.random().toString(36).slice(2,8)}` }); return shuffle(d); }
function initDeck(mode){ const full=makeDeck(mode); const trumpCard=full[full.length-1]; const deck=full.slice(0, full.length-1); return { deck, trumpCard, trumpSuit: trumpCard.s, trumpAvailable:true, ranks:(mode==="52"?RANKS_52:RANKS_36) }; }

/* ===== Noteikumi ===== */
function canCover(attack, defend, trump, ranks){
  if (!attack || !defend) return false;
  if (defend.s === attack.s) return rankValue(defend.r, ranks) > rankValue(attack.r, ranks);
  if (attack.s !== trump && defend.s === trump) return true;
  if (attack.s === trump && defend.s === trump) return rankValue(defend.r, ranks) > rankValue(attack.r, ranks);
  return false;
}
function tableRanks(room){
  const s=new Set(); for (const pr of room.table){ if (pr.attack) s.add(pr.attack.r); if (pr.defend) s.add(pr.defend.r); } return s;
}
function maxPairsAllowed(room){ const def = room.players[room.defender]; return Math.min(6, def?.hand?.length || 0); }

/* ===== DROŠĪBA ===== */
function withRoomLock(room, fn) {
  room._lock = room._lock || Promise.resolve();
  room._lock = room._lock.then(async () => {
    try { await fn(); } catch (e) { console.error("Room action error:", e); }
  });
  return room._lock;
}
function validateAttackAllowed(room, attackerIdx, card) {
  if (attackerIdx === room.defender) throw new Error("Aizsargs nevar uzbrukt");
  const limit = maxPairsAllowed(room);
  if (room.table.length >= limit) throw new Error("Sasniegts pāru limits");
  const ranksOnTable = tableRanks(room);
  const canAdd = room.table.length === 0 || ranksOnTable.has(card.r);
  if (!canAdd) throw new Error("Jāliek tāda paša ranga kārts");
}
function enforceInvariants(room) {
  const limit = maxPairsAllowed(room);
  if (room.table.length > limit) {
    const la = room.lastAction;
    if (la && (la.type === "attack" || la.type === "attackMany")) {
      const actor = room.players.find(p => p.id === la.playerId);
      if (actor) {
        let over = room.table.length - limit;
        for (let i = room.table.length - 1; i >= 0 && over > 0; i--) {
          const pr = room.table[i];
          if (!pr.defend) {
            actor.hand.push(pr.attack);
            room.table.splice(i, 1);
            over--;
          }
        }
      }
    }
  }
  const trump = room.trumpSuit, ranks = room.ranks;
  for (const pr of room.table) {
    if (pr.defend && !canCover(pr.attack, pr.defend, trump, ranks)) {
      pr.defend = undefined;
      endBoutTook(room);
      break;
    }
  }
}
const lastActionTs = new Map();
function allowAction(socketId) {
  const t = Date.now();
  const arr = lastActionTs.get(socketId) || [];
  const recent = arr.filter(x => t - x < 1000);
  if (recent.length >= 3) return false;
  recent.push(t);
  lastActionTs.set(socketId, recent);
  return true;
}

/* ===== Globālais stāvoklis ===== */
const rooms = new Map();
const sessions = new Map(); // cid -> { socketId, roomId }
const tournaments = new Map(); // skat. zemāk struktūru

/* ===== Leaderboard (kā iepriekš) ===== */
const leaderboard = {
  all: new Map(),
  daily: new Map(),
  weekly: new Map(),
  lastRotateDay: new Date().toISOString().slice(0,10),
  lastRotateWeek: getWeekKey(new Date())
};
function getWeekKey(d){
  const dt = new Date(d.getTime());
  dt.setHours(0,0,0,0);
  const first = new Date(dt.getFullYear(),0,1);
  const diff = Math.floor((dt-first)/86400000);
  const week = Math.floor((diff + first.getDay()+6)/7)+1;
  return `${dt.getFullYear()}-W${String(week).padStart(2,"0")}`;
}
function rotateBoardsIfNeeded(){
  const today = new Date().toISOString().slice(0,10);
  if (leaderboard.lastRotateDay !== today){ leaderboard.daily = new Map(); leaderboard.lastRotateDay = today; }
  const wk = getWeekKey(new Date());
  if (leaderboard.lastRotateWeek !== wk){ leaderboard.weekly = new Map(); leaderboard.lastRotateWeek = wk; }
}
function bumpStats(cid, nick, updater){
  rotateBoardsIfNeeded();
  for (const scope of ["all","daily","weekly"]){
    const map = leaderboard[scope];
    const cur = map.get(cid) || { cid, lastNick: nick, wins:0, cleanDefends:0, fastestMs:null };
    updater(cur);
    cur.lastNick = nick || cur.lastNick;
    map.set(cid, cur);
  }
}
function asSortedArray(map, key){
  return [...map.values()].sort((a,b)=>{
    if (key==="fastestMs"){
      if (a.fastestMs==null && b.fastestMs==null) return 0;
      if (a.fastestMs==null) return 1;
      if (b.fastestMs==null) return -1;
      return a.fastestMs - b.fastestMs;
    }
    return (b[key]||0) - (a[key]||0);
  }).slice(0,50);
}

/* ===== Room plūsma ===== */
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
function activePlayers(room){ return room.players.filter(p=>!p.spectator); }
function endBoutDefended(room){
  for (const pr of room.table){ room.discard.push(pr.attack); if (pr.defend) room.discard.push(pr.defend); }
  room.table = [];
  dealUpToSix(room);
  room.attacker = room.defender;
  room.defender = nextIndex(room.attacker, room.players);
  while (room.players[room.defender]?.spectator) room.defender = nextIndex(room.defender, room.players);
  room.passes = new Set();
  room.undoUsed = new Set();
  room.lastAction = undefined;
  room.phase = "attack";
  room.boutCount++;
}
function endBoutTook(room){
  const def = room.players[room.defender];
  for (const pr of room.table){ def.hand.push(pr.attack); if (pr.defend) def.hand.push(pr.defend); }
  room.table = [];
  dealUpToSix(room);
  room.attacker = nextIndex(room.defender, room.players);
  room.defender = nextIndex(room.attacker, room.players);
  while (room.players[room.defender]?.spectator) room.defender = nextIndex(room.defender, room.players);
  room.passes = new Set();
  room.undoUsed = new Set();
  room.lastAction = undefined;
  room.phase = "attack";
  room.boutCount++;
}
function checkGameEnd(room){
  const act = activePlayers(room);
  const still = act.filter(p=>p.hand.length>0);
  if (still.length <= 1){
    room.phase = "end";
    const winners = act.filter(p=>p.hand.length===0);
    io.to(room.id).emit("end", { losers: still.map(p=>p.nick), winners: winners.map(p=>p.nick) });

    const dur = now() - (room.startedAt||now());
    for (const w of winners){
      bumpStats(w.cid||w.id, w.nick, (s)=>{ s.wins = (s.wins||0)+1; if (s.fastestMs==null || dur < s.fastestMs) s.fastestMs = dur; });
    }
    if (room.tournament) onTournamentMatchEnd(room, winners.map(w=>w.cid||w.id), still.map(l=>l.cid||l.id));
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
function botThinkDelay(room){ return room.botStepMs || rand(BOT_STEP_MIN, BOT_STEP_MAX); }

/* ===== Redzamība & emit ===== */
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
    meCanUndo: !!room.lastAction && room.lastAction.playerId===sid && room.phase==="attack",
    undoLeftThisBout: me ? (room.undoUsed?.has(me.id)?0:1) : 0
  };
}
function emitState(room){ for (const p of room.players) io.to(p.id).emit("state", visibleState(room,p.id)); }

/* ===== Host reassignment / leave ===== */
function reassignHost(room){
  const next = room.players.find(p=>!p.spectator) || room.players[0];
  if (next) room.hostId = next.id;
}
function replaceWithBot(room, idx){
  const left = room.players[idx];
  room.players[idx] = { id:`bot-${Math.random().toString(36).slice(2,7)}`, cid:`bot-${Math.random().toString(36).slice(2,5)}`, nick:"BOT", hand:left.hand||[], isBot:true, ready:true, connected:true, spectator:false, lastSeen:now() };
}

/* ===== API: Rooms & Leaderboard ===== */
app.get("/api/rooms", (_, res)=>{
  const list = [...rooms.values()].map(r=>{
    const playing = r.players.filter(p=>!p.spectator);
    return {
      id: r.id,
      status: r.phase,
      players: playing.length,
      spectators: r.players.length - playing.length,
      deckMode: r.settings.deckMode,
      trump: `${r.trumpCard?.r||""}${r.trumpSuit||""}`
    };
  });
  res.json({ rooms: list });
});
app.get("/api/leaderboard", (req,res)=>{
  rotateBoardsIfNeeded();
  const period = (req.query.period||"all").toString();
  const type   = (req.query.type||"wins").toString();
  const src = leaderboard[period]||leaderboard.all;
  let key = "wins"; if (type==="clean") key="cleanDefends"; if (type==="fastest") key="fastestMs";
  const rows = asSortedArray(src, key).map(s=>({ cid:s.cid, nick:s.lastNick, wins:s.wins||0, clean:s.cleanDefends||0, fastestMs:s.fastestMs })).slice(0,50);
  res.json({ period, type, rows });
});

/* ===== TURNĪRI: struktūra =====
tournament = {
  id,title,size:4|8|16,deckMode:"36"|"52",state:"lobby"|"running"|"done",
  seats:[ {cid,nick,ready:false} | null, ... size ],
  spectators:Set<cid>,
  createdAt:number,
  matches:[{id,round,name,p1,p2,winner,loser,roomId,status}],
  subs:Set<socketId>
}
*/
function safeTournamentView(t){
  return {
    id:t.id, title:t.title, size:t.size, deckMode:t.deckMode, state:t.state, createdAt:t.createdAt,
    seats: t.seats.map(s=> s ? { cid:s.cid, nick:s.nick, ready:!!s.ready } : null ),
    spectators: Array.from(t.spectators||[]),
    matches:t.matches.map(m=>({ id:m.id, round:m.round, name:m.name, p1:m.p1, p2:m.p2, winner:m.winner, loser:m.loser, roomId:m.roomId, status:m.status }))
  };
}

/* ===== TURNĪRI: HTTP ===== */
app.get("/api/tournaments", (_, res)=>{
  const list = [...tournaments.values()].map(t=>({ id:t.id, title:t.title, size:t.size, state:t.state, players: t.seats.filter(Boolean).length, createdAt:t.createdAt }));
  res.json({ tournaments: list });
});
app.get("/api/tournament/:id", (req,res)=>{
  const t = tournaments.get(req.params.id);
  if (!t) return res.status(404).json({error:"Not found"});
  res.json(safeTournamentView(t));
});

/* ===== TURNĪRU skeleton/brackets ===== */
function buildBracketSkeleton(t){
  const rounds = Math.log2(t.size);
  t.matches = [];
  for (let r=1; r<=rounds; r++){
    const count = t.size / Math.pow(2, r);
    for (let i=0;i<count;i++){
      const name = (r===rounds ? (count===1?"Final":"SF") : `R${r}-${i+1}`);
      t.matches.push({ id: uid("M"), round:r, name, p1:null, p2:null, winner:null, loser:null, roomId:null, status:"pending" });
    }
  }
  t.matches.push({ id: uid("M"), round: Math.log2(t.size), name:"Bronze", p1:null, p2:null, winner:null, loser:null, roomId:null, status:"pending" });
}
function seedBracketFromList(t, players){
  // players: [{cid,nick}, ...] garums = t.size; jauktums — ārpusē.
  const r1 = t.matches.filter(m=>m.round===1 && m.name.startsWith("R1"));
  for (let i=0;i<r1.length;i++){
    r1[i].p1 = players[i*2] || null;
    r1[i].p2 = players[i*2+1] || null;
  }
}
function launchRoundRooms(t, round){
  const ms = t.matches.filter(m=>m.round===round && m.name!=="Bronze");
  for (const m of ms){
    if (!m.p1 || !m.p2) continue;
    if (!m.roomId){
      const roomId = `${t.id}-${m.name}`.replace(/\s+/g,"");
      m.roomId = roomId;
      m.status = "live";
      const { deck, trumpCard, trumpSuit, trumpAvailable, ranks } = initDeck(t.deckMode);
      const room = {
        id: roomId, hostId: null,
        players: [
          { id: uid("sock"), cid: m.p1.cid, nick: m.p1.nick, hand: [], isBot:false, ready:true, connected:false, spectator:false, lastSeen:now() },
          { id: uid("sock"), cid: m.p2.cid, nick: m.p2.nick, hand: [], isBot:false, ready:true, connected:false, spectator:false, lastSeen:now() }
        ],
        deck, discard: [], trumpCard, trumpSuit, trumpAvailable, ranks,
        table: [], attacker:0, defender:1, phase:"attack",
        passes: new Set(), chat:[],
        settings: { deckMode: t.deckMode },
        botStepMs: undefined,
        lastAction: undefined,
        undoUsed: new Set(),
        createdAt: now(), startedAt: now(), boutCount: 0,
        tournament: { tid: t.id, matchId: m.id }
      };
      rooms.set(roomId, room);
      for (const p of room.players) while (p.hand.length<6){ const c=drawOne(room); if(!c) break; p.hand.push(c); }
      chooseFirstAttackerForRoom(room);
    }
  }
}
function chooseFirstAttackerForRoom(room){
  let best = { have:false, val:Infinity, idx:0 };
  room.players.forEach((p, idx) => {
    p.hand.forEach(c => { if (c.s===room.trumpSuit){ const v=rankValue(c.r,room.ranks); if (v<best.val) best={have:true,val:v,idx}; } });
  });
  room.attacker = best.have ? best.idx : 0;
  room.defender = nextIndex(room.attacker, room.players);
}
function onTournamentMatchEnd(room, winnerCIDs, loserCIDs){
  const ref = room.tournament; if (!ref) return;
  const t = tournaments.get(ref.tid); if (!t) return;
  const m = t.matches.find(x=>x.id===ref.matchId); if (!m || m.status==="done") return;

  const winCid = winnerCIDs[0], loseCid = loserCIDs[0] || null;
  const pRef = (cid)=> t.seats.find(s=>s && s.cid===cid) || { cid, nick:"Spēlētājs" };
  m.winner = pRef(winCid);
  m.loser  = loseCid ? pRef(loseCid) : null;
  m.status = "done";

  const rounds = Math.log2(t.size);
  const isLastRound = (m.round === rounds);

  if (isLastRound){
    if (m.name === "Final"){ t.state = "done"; }
    else if (m.name === "SF" || m.name.startsWith("R"+(rounds))){
      feedToByName(t, m, "Final", true);
      feedToByName(t, m, "Bronze", false);
      maybeLaunchByName(t, "Final");
      maybeLaunchByName(t, "Bronze");
    }
  } else {
    feedToRound(t, m, m.round+1, true);
    launchReadyInRound(t, m.round+1);
  }
  ioToTournament(t, "t:update", safeTournamentView(t));
}
function feedToRound(t, match, targetRound, asWinner){
  const list = t.matches.filter(x=>x.round===targetRound && x.name!=="Bronze");
  const spot = list.find(x=>!x.p1 || !x.p2); if (!spot) return;
  const pl = asWinner ? match.winner : match.loser; if (!pl) return;
  if (!spot.p1) spot.p1 = pl; else if (!spot.p2) spot.p2 = pl;
}
function feedToByName(t, match, name, asWinner){
  const spot = t.matches.find(x=>x.name===name); if (!spot) return;
  const pl = asWinner ? match.winner : match.loser; if (!pl) return;
  if (!spot.p1) spot.p1 = pl; else if (!spot.p2) spot.p2 = pl;
}
function maybeLaunchByName(t, name){
  const m = t.matches.find(x=>x.name===name);
  if (m && m.p1 && m.p2 && !m.roomId) launchRoundRooms(t, m.round);
}
function launchReadyInRound(t, round){
  const list = t.matches.filter(m=>m.round===round && m.name!=="Bronze");
  for (const m of list){ if (m.p1 && m.p2 && !m.roomId) launchRoundRooms(t, round); }
}

/* ===== TURNĪRU sockets ===== */
io.on("connection", (socket) => {
  const err = (m)=>socket.emit("error", m);
  const cid = socket.handshake.auth?.cid || socket.handshake.query?.cid || null;

  // Reconnect uz room, ja ir
  if (cid && sessions.has(cid)){
    const sess = sessions.get(cid);
    const room = rooms.get(sess.roomId);
    if (room){
      const p = room.players.find(pl=>pl.id===sess.socketId || pl.cid===cid);
      if (p){
        p.id = socket.id; p.connected = true; p.lastSeen = now();
        sessions.set(cid, { socketId: socket.id, roomId: room.id });
        socket.join(room.id);
        emitState(room);
      }
    }
  }

  /* ==== Istabas ==== */
  socket.on("createRoom", ({ roomId, nickname, deckMode }) => {
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    if (!roomId) return err("Room ID nav norādīts");
    if (rooms.has(roomId)) return err("Istaba jau eksistē");

    const useDeck = deckMode==="52" ? "52" : "36";
    const { deck, trumpCard, trumpSuit, trumpAvailable, ranks } = initDeck(useDeck);
    const room = {
      id: roomId, hostId: socket.id,
      players: [{ id: socket.id, cid: cid||socket.id, nick: nickname || "Spēlētājs", hand: [], isBot:false, ready:false, connected:true, spectator:false, lastSeen:now() }],
      deck, discard: [], trumpCard, trumpSuit, trumpAvailable, ranks,
      table: [], attacker:0, defender:0, phase:"lobby",
      passes: new Set(), chat:[],
      settings: { deckMode: useDeck },
      botStepMs: undefined,
      lastAction: undefined,
      undoUsed: new Set(),
      createdAt: now(), startedAt: null, boutCount: 0,
      tournament: null
    };
    rooms.set(roomId, room);
    if (cid) sessions.set(cid, { socketId: socket.id, roomId: roomId });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("joinRoom", ({ roomId, nickname, spectator }) => {
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (room.phase !== "lobby" && spectator!==true) return err("Spēle jau sākusies");

    const playing = room.players.filter(p=>!p.spectator).length;
    const asSpect = spectator===true || playing >= MAX_PLAYERS;
    room.players.push({ id: socket.id, cid: cid||socket.id, nick: nickname || "Spēlētājs", hand: [], isBot:false, ready:false, connected:true, spectator:asSpect, lastSeen:now() });
    if (cid) sessions.set(cid, { socketId: socket.id, roomId });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("toggleReady", ({ roomId }) => {
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
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
      room.players.push({ id: botId, cid: botId, nick: "BOT", hand: [], isBot:true, ready:true, connected:true, spectator:false, lastSeen:now() });
    } else if (!humans.every(p=>p.ready)) return "Ne visi spēlētāji ir gatavi";
    if (room.players.filter(p=>!p.spectator).length < 2) return "Vajag vismaz 2 spēlētājus";

    const { deck, trumpCard, trumpSuit, trumpAvailable, ranks } = initDeck(room.settings.deckMode);
    room.deck=deck; room.trumpCard=trumpCard; room.trumpSuit=trumpSuit; room.trumpAvailable=trumpAvailable; room.ranks=ranks;
    room.discard=[]; room.table=[]; room.passes=new Set(); room.phase="attack";
    room.botStepMs = (botStepMs && botStepMs>=400 && botStepMs<=2000) ? botStepMs : undefined;
    room.lastAction = undefined;
    room.undoUsed = new Set();
    room.startedAt = now();
    room.boutCount = 0;

    for (const p of room.players) if (!p.spectator) while (p.hand.length<6){ const c=drawOne(room); if(!c) break; p.hand.push(c); }
    chooseFirstAttacker(room);

    io.to(room.id).emit("message", `Trumpis: ${room.trumpCard.r}${room.trumpCard.s} | Kava: ${room.settings.deckMode}`);
    emitState(room);
    if (botShouldPlay(room)) setTimeout(()=>runBot(room), botThinkDelay(room));
    return null;
  }

  socket.on("startGame", ({ roomId, botStepMs }) => {
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (socket.id !== room.hostId) return err("Tikai host var sākt");
    const problem = startGame(room, botStepMs);
    if (problem) return err(problem);
  });

  socket.on("playAgain", ({ roomId, botStepMs }) => {
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (socket.id !== room.hostId) return err("Tikai host var sākt");
    for (const p of room.players) { p.hand=[]; if(!p.spectator) p.ready=true; }
    const problem = startGame(room, botStepMs);
    if (problem) return err(problem);
  });

  /* ===== Spēles events (attack/defend/undo/pass/take/chat/leave) — kā iepriekš ===== */
  socket.on("playAttack", ({ roomId, card }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    withRoomLock(room, () => {
      try {
        const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
        const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar uzbrukt");
        validateAttackAllowed(room, idx, card);
        const hi=me.hand.findIndex(c=>c.id===card.id); if (hi<0) throw new Error("Tev tādas kārts nav");
        me.hand.splice(hi,1);
        room.table.push({ attack: card });
        room.passes.delete(me.id);
        room.lastAction = { type:"attack", playerId: me.id, cards:[card], pairIndices:[room.table.length-1] };
        enforceInvariants(room);
        emitState(room);
        if (botShouldPlay(room)) schedule(room, ()=>runBot(room), botThinkDelay(room));
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
  });

  socket.on("playAttackMany", ({ roomId, cards }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    withRoomLock(room, () => {
      try {
        const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
        const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar uzbrukt");
        if (!Array.isArray(cards)||!cards.length) throw new Error("Nav kāršu");
        const ranksOnTable = tableRanks(room);
        const addedCards=[], addedPairs=[];
        for (const card of cards){
          if (room.table.length >= maxPairsAllowed(room)) break;
          const hi=me.hand.findIndex(c=>c.id===card.id); if (hi<0) continue;
          const canAdd = room.table.length===0 || ranksOnTable.has(card.r);
          if (!canAdd) continue;
          me.hand.splice(hi,1);
          room.table.push({ attack: card });
          ranksOnTable.add(card.r);
          addedCards.push(card);
          addedPairs.push(room.table.length-1);
        }
        if (!addedCards.length) throw new Error("Nevarēja pievienot izvēlētās kārtis");
        room.passes.delete(me.id);
        room.lastAction = { type:"attackMany", playerId: me.id, cards: addedCards, pairIndices: addedPairs };
        enforceInvariants(room);
        emitState(room);
        if (botShouldPlay(room)) schedule(room, ()=>runBot(room), botThinkDelay(room));
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
  });

  socket.on("playDefend", ({ roomId, attackIndex, card }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    withRoomLock(room, () => {
      try {
        const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
        const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar aizsegt");
        if (idx !== room.defender) throw new Error("Tikai aizsargs drīkst aizsegt");
        const pair = room.table[attackIndex]; if(!pair || pair.defend) throw new Error("Nepareizs pāris");
        const hi=me.hand.findIndex(c=>c.id===card.id); if(hi<0) throw new Error("Tev tādas kārts nav");
        if (!canCover(pair.attack, card, room.trumpSuit, room.ranks)) throw new Error("Ar šo kārti nevar aizsegt");
        me.hand.splice(hi,1);
        pair.defend = card;
        room.lastAction = { type:"defend", playerId: me.id, cards:[card], pairIndex: attackIndex };
        enforceInvariants(room);
        const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
        if (allCovered && room.passes.size === activePlayers(room).length-1){
          const defender = room.players[room.defender];
          bumpStats(defender.cid||defender.id, defender.nick, (s)=>{ s.cleanDefends = (s.cleanDefends||0)+1; });
          endBoutDefended(room);
          if (!checkGameEnd(room)) emitState(room);
        } else {
          emitState(room);
        }
        if (botShouldPlay(room)) schedule(room, ()=>runBot(room), botThinkDelay(room));
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
  });

  socket.on("undoLast", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    withRoomLock(room, () => {
      try {
        const la = room.lastAction; 
        if (!la || la.playerId !== socket.id) throw new Error("Nevari atsaukt");
        if (room.undoUsed?.has(socket.id)) throw new Error("Atsaukums jau izmantots šajā bautā");
        const me = room.players.find(p=>p.id===socket.id);
        if (!me || me.spectator) throw new Error("Nevari atsaukt");
        if (la.type === "defend"){
          const i = la.pairIndex; const pair = room.table[i];
          if (!pair || !pair.defend || pair.defend.id !== la.cards[0].id) throw new Error("Vairs nevar atsaukt");
          me.hand.push(pair.defend); pair.defend = undefined; room.lastAction = undefined;
        } else if (la.type === "attack"){
          const i = la.pairIndices?.[0]; const pair = room.table[i];
          if (!pair || pair.defend) throw new Error("Vairs nevar atsaukt");
          me.hand.push(pair.attack); room.table.splice(i,1); room.lastAction = undefined;
        } else if (la.type === "attackMany"){
          const indices = (la.pairIndices||[]).slice().sort((a,b)=>b-a);
          let restored=0;
          for (const i of indices){ const pair = room.table[i]; if (pair && !pair.defend){ me.hand.push(pair.attack); room.table.splice(i,1); restored++; } }
          if (!restored) throw new Error("Vairs nevar atsaukt");
          room.lastAction = undefined;
        }
        room.undoUsed.add(socket.id);
        enforceInvariants(room);
        emitState(room);
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
  });

  socket.on("takeCards", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    withRoomLock(room, () => {
      try {
        const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
        const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar ņemt");
        if (idx !== room.defender) throw new Error("Tikai aizsargs var ņemt");
        room.lastAction = undefined;
        endBoutTook(room);
        if (!checkGameEnd(room)) emitState(room);
        if (botShouldPlay(room)) schedule(room, ()=>runBot(room), botThinkDelay(room));
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
  });

  socket.on("pass", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    withRoomLock(room, () => {
      try {
        const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
        const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar pasēt");
        if (idx===room.defender) throw new Error("Aizsargs nevar pasēt");
        room.passes.add(me.id);
        room.lastAction = undefined;
        const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
        if (allCovered && room.passes.size === activePlayers(room).length-1){
          const defender = room.players[room.defender];
          bumpStats(defender.cid||defender.id, defender.nick, (s)=>{ s.cleanDefends = (s.cleanDefends||0)+1; });
          endBoutDefended(room);
          if (!checkGameEnd(room)) emitState(room);
        } else {
          emitState(room);
        }
        if (botShouldPlay(room)) schedule(room, ()=>runBot(room), botThinkDelay(room));
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
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
      if (!leaving.spectator) replaceWithBot(room, idx);
      else room.players.splice(idx,1);
      room.lastAction = undefined;
    }
    if (activePlayers(room).length === 0){ rooms.delete(room.id); return; }
    emitState(room);
  });

  socket.on("disconnect", () => {
    const dcTime = now();
    for (const room of rooms.values()){
      const i = room.players.findIndex(p=>p.id===socket.id);
      if (i>=0){
        const p = room.players[i];
        p.connected = false; p.lastSeen = dcTime;
        setTimeout(()=>{
          if (!rooms.has(room.id)) return;
          const still = room.players[i];
          if (!still || still.connected) return;
          if (room.phase === "lobby"){
            room.players.splice(i,1);
          } else {
            if (!still.spectator) replaceWithBot(room, i);
            else room.players.splice(i,1);
          }
          emitState(room);
        }, RECONNECT_GRACE_MS);
      }
    }
  });

  /* ===== TURNĪRA sockets: LOBBY sēdvietas ===== */
  socket.on("t:create", ({ title, size, deckMode })=>{
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    const s = Number(size)||4; if (![4,8,16].includes(s)) return err("Atļauti izmēri: 4/8/16");
    const dm = (deckMode==="52")?"52":"36";
    const t = {
      id: uid("T"), title: title||`Turnīrs ${s}-spēlētāji`, size:s, deckMode:dm,
      state:"lobby", seats: Array.from({length:s}, ()=>null), spectators:new Set(),
      createdAt: now(), matches:[], subs:new Set()
    };
    buildBracketSkeleton(t);
    tournaments.set(t.id, t);
    socket.emit("t:update", safeTournamentView(t));
  });

  socket.on("t:subscribe", ({ tid })=>{
    const t = tournaments.get(tid); if (!t) return err("Turnīrs nav atrasts");
    t.subs.add(socket.id);
    socket.emit("t:update", safeTournamentView(t));
  });
  socket.on("t:unsubscribe", ({ tid })=>{
    const t = tournaments.get(tid); if (!t) return;
    t.subs.delete(socket.id);
  });

  socket.on("t:sit", ({ tid, seat, nick })=>{
    const t = tournaments.get(tid); if (!t) return err("Turnīrs nav atrasts");
    if (t.state !== "lobby") return err("Turnīrs jau startēts");
    if (seat==null || seat<0 || seat>=t.size) return err("Nav tādas sēdvietas");
    if (t.seats[seat]) return err("Vieta aizņemta");
    const entry = { cid: cid||socket.id, nick: nick||"Spēlētājs", ready:false };
    // ja jau sēž citur, pārsēdinām
    const old = t.seats.findIndex(s=>s && s.cid===entry.cid);
    if (old>=0) t.seats[old] = null;
    t.seats[seat] = entry;
    ioToTournament(t, "t:update", safeTournamentView(t));
  });

  socket.on("t:stand", ({ tid })=>{
    const t = tournaments.get(tid); if (!t) return;
    if (t.state !== "lobby") return err("Turnīrs jau startēts");
    const i = t.seats.findIndex(s=>s && s.cid===(cid||socket.id));
    if (i>=0) t.seats[i] = null;
    ioToTournament(t, "t:update", safeTournamentView(t));
  });

  socket.on("t:toggleReady", ({ tid })=>{
    const t = tournaments.get(tid); if (!t) return;
    if (t.state !== "lobby") return err("Turnīrs jau startēts");
    const i = t.seats.findIndex(s=>s && s.cid===(cid||socket.id));
    if (i<0) return err("Tev jāapsēžas");
    t.seats[i].ready = !t.seats[i].ready;
    ioToTournament(t, "t:update", safeTournamentView(t));
  });

  socket.on("t:spectateLobby", ({ tid })=>{
    const t = tournaments.get(tid); if (!t) return;
    t.spectators.add(cid||socket.id);
    ioToTournament(t, "t:update", safeTournamentView(t));
  });
  socket.on("t:leaveLobbySpectate", ({ tid })=>{
    const t = tournaments.get(tid); if (!t) return;
    t.spectators.delete(cid||socket.id);
    ioToTournament(t, "t:update", safeTournamentView(t));
  });

  socket.on("t:start", ({ tid })=>{
    const t = tournaments.get(tid); if (!t) return err("Turnīrs nav atrasts");
    if (t.state!=="lobby") return err("Jau startēts");
    // pārbaude — visām vietām jābūt aizņemtām un Ready
    if (t.seats.some(s=>!s)) return err("Nav pilns sastāvs");
    if (t.seats.some(s=>!s.ready)) return err("Ne visi ir 'Gatavs'");
    // Random seeding
    const ordered = shuffle(t.seats.slice().map(s=>({ cid:s.cid, nick:s.nick })));
    seedBracketFromList(t, ordered);
    // Palaist 1. raundu
    launchRoundRooms(t, 1);
    t.state = "running";
    ioToTournament(t, "t:update", safeTournamentView(t));
  });

});

/* ===== Turnīru util ===== */
function ioToTournament(t, event, payload){ for (const sid of t.subs) io.to(sid).emit(event, payload); }

/* ===== RUN ===== */
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log("Duraks serveris klausās uz porta " + PORT));
