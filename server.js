// server.js
// Duraks Online — Bugats Edition (v1.2.5)
// 2 spēlētāji vai 1 spēlētājs + BOT. 36/52 kāršu kavas. Trumpis, multi-uzbrukums, aizsardzība.
// CORS ļauj thezone.lv un onrender.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);

const allowed = [
  "https://thezone.lv",
  "https://www.thezone.lv",
  "https://duraks-online.onrender.com"
];

app.use(cors({
  origin: (o, cb) => {
    if (!o) return cb(null, true);
    if (allowed.some(a => o.startsWith(a))) return cb(null, true);
    cb(new Error("Not allowed by CORS: " + o));
  }
}));

app.get("/", (_, res) => res.send("Duraks server OK"));
app.get("/healthz", (_, res) => res.json({ ok: true }));

const io = new Server(server, {
  cors: { origin: allowed, credentials: true },
  path: "/socket.io",
  transports: ["websocket"]
});

const ROOMS = new Map(); // roomCode -> { deckSize, deck, trump, stock, table, phase, turn, players:[{id,nick,hand,isBot}], logs:[] }

function log(room, msg){
  room.logs.push(msg);
  io.to(room.code).emit("log", msg);
}

function makeDeck(deckSize=52){
  const suits = ["♠","♥","♦","♣"];
  const ranks52 = ["6","7","8","9","10","J","Q","K","A","2","3","4","5"]; // 52
  const ranks36 = ["6","7","8","9","10","J","Q","K","A"]; // 36
  const ranks = deckSize===36 ? ranks36 : ranks52;
  const deck = [];
  for(const s of suits){
    for(const r of ranks){
      deck.push({r,s});
    }
  }
  // sajaukšana
  for(let i=deck.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [deck[i],deck[j]]=[deck[j],deck[i]];
  }
  return deck;
}
function rankOrder(deckSize){
  return deckSize===36 ? ["6","7","8","9","10","J","Q","K","A"] :
                         ["6","7","8","9","10","J","Q","K","A","2","3","4","5"];
}
function beats(a,b,trump,order){
  // a pārspēj b?
  if(b==null) return false;
  if(a.s===b.s){
    return order.indexOf(a.r) > order.indexOf(b.r);
  }
  if(b.s===trump) return false;
  if(a.s===trump) return true;
  return false;
}

function lowestCard(hand, trump, order){
  // mazākā pēc stipruma (netrumpi priekšā)
  const nonTrump = hand.filter(c=>c.s!==trump).sort((x,y)=>order.indexOf(x.r)-order.indexOf(y.r));
  if(nonTrump.length) return nonTrump[0];
  return [...hand].sort((x,y)=>{
    const tx=x.s===trump?1:0, ty=y.s===trump?1:0;
    if(tx!==ty) return tx-ty;
    return order.indexOf(x.r)-order.indexOf(y.r);
  })[0];
}

function deal(room){
  for(const p of room.players){
    while(p.hand.length<6 && room.stock.length){
      p.hand.push(room.stock.pop());
    }
  }
}

function openRoom({code, deckSize}){
  const deck=makeDeck(deckSize);
  const trumpCard=deck[0];
  const trump=trumpCard.s; // trumpa masts
  const stock = deck.slice(0);
  const order = rankOrder(deckSize);
  const room = {
    code, deckSize, deck:deck, trump, stock,
    order,
    table: [], // {attack:card, defend:card|null}
    phase: "waiting", // waiting | attack | defend | cleanup | finished
    turn: 0, // kurš uzbrūk
    players: [],
    logs:[]
  };
  ROOMS.set(code, room);
  return room;
}

function stateFor(room){
  return {
    code: room.code,
    deckSize: room.deckSize,
    trump: room.trump,
    stockCount: room.stock.length,
    table: room.table,
    phase: room.phase,
    turn: room.turn,
    players: room.players.map(p=>({id:p.id, nick:p.nick, handCount:p.hand.length, isBot:p.isBot}))
  };
}

function broadcast(room){
  io.to(room.code).emit("state", stateFor(room));
}

function ensureTwo(room){
  if(room.players.length===1){
    // pievieno BOT
    room.players.push({id:"BOT",nick:"BOT",hand:[],isBot:true});
    log(room,"Solo režīms: BOT pievienots.");
  }
}

function startRound(room){
  // izdala 6 katram, definē uzbrucēju (zemākā trumps)
  deal(room);
  // atrast zemāko trumpi
  const trump = room.trump, order=room.order;
  let lowest = {idx:0, rank:999};
  room.players.forEach((p,i)=>{
    p.hand.forEach(c=>{
      if(c.s===trump){
        const r = order.indexOf(c.r);
        if(r<lowest.rank){ lowest={idx:i,rank:r}; }
      }
    });
  });
  room.turn = lowest.rank===999 ? 0 : lowest.idx; // ja nevienam trumpis nav rokā (var gadīties 52) — sāk 0
  room.phase="attack";
  room.table=[];
}

function canAddAttacks(room, attackerIdx){
  const defenderIdx = (attackerIdx+1)%room.players.length;
  const defender = room.players[defenderIdx];
  // max kārtis uz galda = min(6, defender.hand)
  const limit = Math.min(6, defender.hand.length);
  return room.table.filter(t=>!t.defend).length < limit;
}

function ranksOnTable(room){
  const set = new Set();
  room.table.forEach(t=>{
    if(t.attack) set.add(t.attack.r);
    if(t.defend) set.add(t.defend.r);
  });
  return set;
}

function botAct(room){
  // vienkāršs bots — pēc fāzes
  const attackerIdx = room.turn;
  const defenderIdx = (attackerIdx+1)%room.players.length;
  const attacker = room.players[attackerIdx];
  const defender = room.players[defenderIdx];

  if(room.phase==="attack" && attacker.isBot){
    // izvēlas zemāko kārti, vai atbilst esošajiem rangu ierobežojumiem
    if(!canAddAttacks(room, attackerIdx)) { // nevar vairāk
      room.phase="defend";
      broadcast(room);
      return;
    }
    const ranks = ranksOnTable(room);
    let choice = null;
    const sorted=[...attacker.hand].sort((x,y)=>{
      const tx=x.s===room.trump?1:0, ty=y.s===room.trump?1:0;
      if(tx!==ty) return tx-ty; // netrumpi vispirms
      return room.order.indexOf(x.r)-room.order.indexOf(y.r);
    });
    for(const c of sorted){
      if(ranks.size===0 || ranks.has(c.r)){ choice=c; break; }
    }
    if(choice){
      attacker.hand.splice(attacker.hand.indexOf(choice),1);
      room.table.push({attack:choice,defend:null});
      log(room,`BOT iemet ${choice.r}${choice.s}`);
      broadcast(room);
      if(!canAddAttacks(room, attackerIdx)){
        room.phase="defend";
        broadcast(room);
      }
    } else {
      // nevar — pāriet uz aizstāvēšanos
      room.phase="defend";
      broadcast(room);
    }
  } else if(room.phase==="defend" && defender.isBot){
    // mēģina nosist katru
    let allBeaten=true;
    for(const t of room.table){
      if(!t.defend){
        // atrod mazāko nositamo
        const opts = defender.hand.filter(c=>beats(c,t.attack,room.trump,room.order))
          .sort((x,y)=>{
            const tx=x.s===room.trump?1:0, ty=y.s===room.trump?1:0;
            if(tx!==ty) return tx-ty;
            return room.order.indexOf(x.r)-room.order.indexOf(y.r);
          });
        if(opts.length){
          const use=opts[0];
          defender.hand.splice(defender.hand.indexOf(use),1);
          t.defend=use;
          log(room,`BOT nosit ${use.r}${use.s}`);
        } else {
          allBeaten=false;
          break;
        }
      }
    }
    broadcast(room);
    if(allBeaten){
      room.phase="cleanup";
      broadcast(room);
    } else {
      // paņem
      const toTake=[];
      room.table.forEach(t=>{
        if(t.attack) toTake.push(t.attack);
        if(t.defend) toTake.push(t.defend);
      });
      defender.hand.push(...toTake);
      room.table=[];
      log(room,"BOT paņem kārtis.");
      deal(room);
      // uzbrucējs saglabājas tas pats
      room.phase="attack";
      broadcast(room);
    }
  } else if(room.phase==="cleanup"){
    // savākt no galda un pabeigt metienu
    room.table=[];
    deal(room);
    // nākamais uzbrucējs = aizstāvis
    room.turn = (room.turn+1)%room.players.length;
    room.phase="attack";
    broadcast(room);
  }
}

io.on("connection", (socket)=>{
  socket.emit("hello","Savienots ar serveri.");

  socket.on("create", ({nick, deckSize})=>{
    const code = (Math.random().toString(36).slice(2,6)).toUpperCase();
    const room = openRoom({code, deckSize: deckSize===36?36:52});
    room.players.push({id: socket.id, nick: nick||"Spēlētājs", hand:[], isBot:false});
    socket.join(code);
    log(room, `Istaba izveidota: ${code}`);
    ensureTwo(room);
    startRound(room);
    broadcast(room);
  });

  socket.on("join", ({nick, code})=>{
    const room = ROOMS.get((code||"").toUpperCase());
    if(!room){ socket.emit("err","Nav istabas."); return; }
    if(room.players.length>=2 && !room.players.some(p=>p.id===socket.id)){
      socket.emit("err","Istaba pilna."); return;
    }
    if(!room.players.some(p=>p.id===socket.id)){
      room.players = room.players.filter(p=>!p.isBot); // ja bija solo, noņem BOT — cilvēks ienāca
      room.players.push({id: socket.id, nick: nick||"Spēlētājs", hand:[], isBot:false});
      deal(room);
    }
    socket.join(room.code);
    log(room, `${nick||"Spēlētājs"} pievienojas istabai ${room.code}.`);
    broadcast(room);
  });

  socket.on("chat", ({code,msg,nick})=>{
    const room = ROOMS.get((code||"").toUpperCase());
    if(!room) return;
    io.to(room.code).emit("chat",{nick: nick||"Spēlētājs", msg});
  });

  socket.on("attack", ({code, cards})=>{
    const room = ROOMS.get((code||"").toUpperCase());
    if(!room) return;
    const attackerIdx = room.turn;
    const attacker = room.players[attackerIdx];
    if(attacker.id!==socket.id) return;
    if(room.phase!=="attack") return;

    if(!cards || !cards.length) return;
    if(!canAddAttacks(room, attackerIdx)) return;

    const ranks = ranksOnTable(room);
    const allowedMulti = room.table.length===0 ? cards : cards.filter(c=>ranks.has(c.r));
    for(const c of allowedMulti){
      // izņem no rokas
      const idx = attacker.hand.findIndex(h=>h.r===c.r && h.s===c.s);
      if(idx>=0){
        attacker.hand.splice(idx,1);
        room.table.push({attack:c,defend:null});
      }
    }
    log(room, `${attacker.nick} iemet ${allowedMulti.map(c=>c.r+c.s).join(", ")}`);
    broadcast(room);

    if(!canAddAttacks(room, attackerIdx)){
      room.phase="defend";
      broadcast(room);
    }
  });

  socket.on("endAttack", ({code})=>{
    const room = ROOMS.get((code||"").toUpperCase());
    if(!room) return;
    const attackerIdx = room.turn;
    if(room.players[attackerIdx].id!==socket.id) return;
    if(room.phase!=="attack") return;
    room.phase="defend";
    broadcast(room);
  });

  socket.on("defend", ({code, card, targetIndex})=>{
    const room = ROOMS.get((code||"").toUpperCase());
    if(!room) return;
    const attackerIdx = room.turn;
    const defenderIdx = (attackerIdx+1)%room.players.length;
    const defender = room.players[defenderIdx];
    if(defender.id!==socket.id) return;
    if(room.phase!=="defend") return;
    const pile = room.table[targetIndex];
    if(!pile || pile.defend) return;

    // meklē karti rokā
    const i = defender.hand.findIndex(h=>h.r===card.r && h.s===card.s);
    if(i<0) return;
    const c = defender.hand[i];
    if(!beats(c,pile.attack,room.trump,room.order)) return;
    defender.hand.splice(i,1);
    pile.defend=c;
    log(room,`${defender.nick} nosit ${c.r}${c.s}`);
    broadcast(room);

    // ja viss nosists -> cleanup
    if(room.table.every(t=>t.defend)){
      room.phase="cleanup";
      broadcast(room);
    }
  });

  socket.on("take", ({code})=>{
    const room = ROOMS.get((code||"").toUpperCase());
    if(!room) return;
    const attackerIdx = room.turn;
    const defenderIdx = (attackerIdx+1)%room.players.length;
    const defender = room.players[defenderIdx];
    if(defender.id!==socket.id) return;
    if(room.phase!=="defend") return;

    const toTake=[];
    room.table.forEach(t=>{
      if(t.attack) toTake.push(t.attack);
      if(t.defend) toTake.push(t.defend);
    });
    defender.hand.push(...toTake);
    room.table=[];
    log(room,`${defender.nick} paņem kārtis.`);
    deal(room);
    room.phase="attack"; // uzbrucējs tas pats
    broadcast(room);
  });

  socket.on("cleanup", ({code})=>{
    const room = ROOMS.get((code||"").toUpperCase());
    if(!room) return;
    const attackerIdx = room.turn;
    if(room.players[attackerIdx].id!==socket.id) return;
    if(room.phase!=="cleanup") return;

    room.table=[];
    deal(room);
    room.turn=(room.turn+1)%room.players.length;
    room.phase="attack";
    broadcast(room);
  });

  socket.on("requestState", ({code})=>{
    const room = ROOMS.get((code||"").toUpperCase());
    if(!room) return;
    socket.emit("state", stateFor(room));
  });

  socket.on("disconnect", ()=>{
    // no room cleanup (vienkārši)
    for(const room of ROOMS.values()){
      const before = room.players.length;
      room.players = room.players.filter(p=>p.id!==socket.id);
      if(room.players.length!==before){
        log(room,"Spēlētājs atvienojās.");
        ensureTwo(room);
        deal(room);
        broadcast(room);
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, ()=>console.log("Server listening on", PORT));
