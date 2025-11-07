// client.js — Duraks Online front-end (v1.2.5)

const SERVER_URL = "https://duraks-online.onrender.com"; // <- ja maini Render URL, nomaini šeit
const socket = io(SERVER_URL, { path: "/socket.io", transports: ["websocket"] });

/* ---- UI ------- */
const nickEl = document.getElementById("nick");
const deckSizeEl = document.getElementById("deckSize");
const btnCreate = document.getElementById("btnCreate");
const roomEl = document.getElementById("room");
const btnJoin = document.getElementById("btnJoin");
const logEl = document.getElementById("log");
const chatMsg = document.getElementById("chatMsg");
const chatSend = document.getElementById("chatSend");

const roomLabel = document.getElementById("roomLabel");
const trumpLabel = document.getElementById("trumpLabel");
const stockCount = document.getElementById("stockCount");
const phaseEl = document.getElementById("phase");
const turnLabel = document.getElementById("turnLabel");

const stackEl = document.getElementById("stack");
const oppName = document.getElementById("oppName");
const oppHand = document.getElementById("oppHand");
const oppCount = document.getElementById("oppCount");
const meHand = document.getElementById("meHand");
const meCount = document.getElementById("meCount");

const btnAttack = document.getElementById("btnAttack");
const btnEnd = document.getElementById("btnEnd");
const btnTake = document.getElementById("btnTake");

let ROOM_CODE = null;
let SELF_ID = null;
let LAST_STATE = null;
let SELECTED = new Set(); // "r|s" atslēgas

function log(msg){
  const div = document.createElement("div");
  div.textContent = msg;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

socket.on("connect", ()=>{ SELF_ID = socket.id; });
socket.on("hello", (m)=> log(m));
socket.on("err", (m)=> log("⚠ " + m));
socket.on("log", (m)=> log(m));

socket.on("chat", ({nick,msg})=>{
  log(`💬 ${nick}: ${msg}`);
});

socket.on("state", (st)=>{
  LAST_STATE = st;
  renderState(st);
});

function key(c){ return `${c.r}|${c.s}`; }

function renderCard(c, opts={}){
  const el = document.createElement("div");
  el.className = "card";
  const red = (c.s==="♥" || c.s==="♦");
  el.classList.add(red?"red":"black");
  if(opts.selectable) el.addEventListener("click", ()=>toggleSelect(c, el));
  if(opts.selected) el.classList.add("selected");
  const r = document.createElement("div");
  r.className="rank"; r.textContent=c.r;
  const s = document.createElement("div");
  s.className="suit"; s.textContent=c.s;
  el.append(r,s);
  return el;
}

function toggleSelect(c, el){
  const k=key(c);
  if(SELECTED.has(k)){ SELECTED.delete(k); el.classList.remove("selected"); }
  else { SELECTED.add(k); el.classList.add("selected"); }
}

function clearSelect(){ SELECTED.clear(); [...meHand.querySelectorAll(".card")].forEach(e=>e.classList.remove("selected")); }

function renderState(st){
  roomLabel.textContent = st.code || "—";
  trumpLabel.textContent = st.trump || "—";
  stockCount.textContent = st.stockCount ?? "—";
  phaseEl.textContent = st.phase ?? "—";

  const me = st.players.find(p=>p.id===SELF_ID) || st.players[0];
  const opp = st.players.find(p=>p.id!==SELF_ID) || st.players[1] || {nick:"—",handCount:0};

  oppName.textContent = opp?.nick || "—";
  oppCount.textContent = opp?.handCount || 0;
  turnLabel.innerHTML = (st.players[st.turn]?.id===SELF_ID) ? `<span class="ok">Tavs gājiens</span>` : `Tu aizstāvi`;

  // Metiens
  stackEl.innerHTML="";
  st.table.forEach((p,i)=>{
    const pile = document.createElement("div");
    pile.className = "pile";
    const a = renderCard(p.attack);
    pile.append(a);
    if(p.defend){
      const d = renderCard(p.defend);
      d.classList.add("defend");
      pile.append(d);
    } else if(st.phase==="defend" && opp.id!==SELF_ID) {
      // aizstāvēšanās — ļaujam klikšķināt uz pāra, lai izvēlētos targetIndex
      pile.style.outline = "1px dashed #264a85";
      pile.style.cursor = "pointer";
      pile.title = "Klikšķini, lai izvēlētos, ko nosist; pēc tam izvēlies kārti no rokas.";
      pile.addEventListener("click", ()=>{
        // vizuāli atzīmē
        [...stackEl.querySelectorAll(".pile")].forEach(x=>x.style.boxShadow="");
        pile.style.boxShadow = "0 0 0 3px rgba(69,177,255,.3) inset";
        pile.dataset.target = i;
        stackEl.dataset.target = i;
      });
    }
    stackEl.append(pile);
  });

  // Rokas
  meHand.innerHTML="";
  (me._hand || []).forEach(c=>{
    const selected = SELECTED.has(key(c));
    const el = renderCard(c, {selectable:true, selected});
    meHand.append(el);
  });
  meCount.textContent = me?.handCount || (me._hand?me._hand.length:0);

  // Pretinieka roka (aizklāta)
  oppHand.innerHTML="";
  for(let i=0;i<(opp.handCount||0);i++){
    const back = document.createElement("div");
    back.className="card";
    back.style.opacity=".4";
    oppHand.append(back);
  }
}

// Poļa rokas saglabāšanai frontā (serveris nesūta reālās kārtis)
function setMyHand(cards){
  if(!LAST_STATE) return;
  const me = LAST_STATE.players.find(p=>p.id===SELF_ID);
  if(me){
    me._hand = cards;
    renderState(LAST_STATE);
  }
}

/* ---- UI actions ---- */
btnCreate.onclick = ()=>{
  const nick = nickEl.value.trim() || "BUGATS";
  const deckSize = parseInt(deckSizeEl.value,10) || 52;
  socket.emit("create",{nick, deckSize});
  setTimeout(()=> socket.emit("requestState",{code: ROOM_CODE}), 200);
};
btnJoin.onclick = ()=>{
  const nick = nickEl.value.trim() || "BUGATS";
  const code = roomEl.value.trim().toUpperCase();
  if(!code){ log("Ievadi istabas kodu."); return; }
  socket.emit("join",{nick, code});
  ROOM_CODE = code;
  setTimeout(()=> socket.emit("requestState",{code}), 200);
};
chatSend.onclick = ()=>{
  const msg = chatMsg.value.trim();
  if(!msg || !ROOM_CODE) return;
  socket.emit("chat",{code: ROOM_CODE, msg, nick: nickEl.value.trim()||"BUGATS"});
  chatMsg.value="";
};

btnAttack.onclick = ()=>{
  if(!LAST_STATE) return;
  if(LAST_STATE.players[LAST_STATE.turn]?.id!==SELF_ID){
    log("Nav uzbrukuma gājiens."); return;
  }
  if(LAST_STATE.phase!=="attack"){ log("Nav uzbrukuma fāze."); return; }
  // savāc atlasītās kārtis no fronta rokas
  const my = LAST_STATE.players.find(p=>p.id===SELF_ID);
  const hand = my._hand||[];
  const chosen = hand.filter(c=>SELECTED.has(key(c)));
  if(!chosen.length){ log("Atlasīt kārtis uzbrukumam."); return; }
  socket.emit("attack",{code: ROOM_CODE, cards: chosen});
  // lokāli noņem
  setMyHand(hand.filter(c=>!SELECTED.has(key(c))));
  clearSelect();
};

btnEnd.onclick = ()=>{
  if(!LAST_STATE) return;
  if(LAST_STATE.players[LAST_STATE.turn]?.id!==SELF_ID){ log("Nevari beigt — nav tavs uzbrukums."); return; }
  socket.emit("endAttack",{code: ROOM_CODE});
};
btnTake.onclick = ()=>{
  if(!LAST_STATE) return;
  const attacker = LAST_STATE.players[LAST_STATE.turn];
  const defender = LAST_STATE.players[(LAST_STATE.turn+1)%LAST_STATE.players.length];
  if(defender.id!==SELF_ID){ log("Paņemt var tikai aizstāvis."); return; }
  socket.emit("take",{code: ROOM_CODE});
};

// Aizstāvēšanās: izvēlies pāri uz galda (klikšķis), tad klikšķis uz kārts rokā
meHand.addEventListener("click", (e)=>{
  if(!LAST_STATE || LAST_STATE.phase!=="defend") return;
  const attacker = LAST_STATE.players[LAST_STATE.turn];
  const defender = LAST_STATE.players[(LAST_STATE.turn+1)%LAST_STATE.players.length];
  if(defender.id!==SELF_ID) return; // tikai aizstāvis
  const target = parseInt(stackEl.dataset.target||"-1",10);
  if(isNaN(target) || target<0){ return; }
  const i = [...meHand.children].indexOf(e.target.closest(".card"));
  const my = LAST_STATE.players.find(p=>p.id===SELF_ID);
  const hand = my._hand||[];
  const card = hand[i];
  if(!card) return;
  socket.emit("defend",{code: ROOM_CODE, card, targetIndex: target});
  // lokāli noņem, ja aizgāja
  setTimeout(()=> socket.emit("requestState",{code: ROOM_CODE}), 150);
});

// Servera valsts sinhronizācija — frontam glabā manu roku lokāli demonstrācijai.
// Pirmreizējs rokas piešķīrums notiek no žurnāla notikumiem. Šeit tikai “ping” atjauninājums.
socket.on("state", (st)=>{
  // piešuj fronta rokas, ja trūkst (demo nolūkiem)
  const me = st.players.find(p=>p.id===SELF_ID);
  if(me && !me._hand){
    // Pirmajā reizē front-end vēl nezina rokas. Paliek 0 (serveris drošības dēļ roku nesūta).
    // Rokas vizualizācijai mēs paļaujamies uz lokāliem notikumiem (atlasīto karšu atņemšanu).
    me._hand = me._hand || [];
  }
});

// Pēc istabas izveides/ienākšanas nepieciešams uzprasīt stāvokli
socket.on("state", (st)=>{
  if(st.code && !ROOM_CODE) ROOM_CODE = st.code;
});

// Palīdzība, kad serveris izliek BOT vai izdala — mēs atjaunojam roku rādījumu, ja nepieciešams
socket.on("log", (m)=>{
  if(/izd(ala|evis)/i.test(m) || /BOT/i.test(m) || /iemet|nosit|Paņem/.test(m)){
    if(ROOM_CODE) socket.emit("requestState",{code: ROOM_CODE});
  }
});
