// client.js — Duraks MVP (6 sēdvietas)

const SERVER_URL = "https://duraks-online.onrender.com"; // Render
const socket = io(SERVER_URL, {
  transports: ["websocket"],
  withCredentials: true,
  reconnection: true,
  reconnectionAttempts: Infinity
});

// UI refs
const connDot = document.getElementById("connDot");
const connText = document.getElementById("connText");
const nameInput = document.getElementById("name");
const deckSelect = document.getElementById("deck");
const soloChk = document.getElementById("solo");
const createBtn = document.getElementById("createBtn");
const joinBtn = document.getElementById("joinBtn");
const roomCodeInput = document.getElementById("roomCode");
const roomBadge = document.getElementById("roomBadge");
const seatsWrap = document.getElementById("seats");
const startBtn = document.getElementById("startBtn");
const leaveSeatBtn = document.getElementById("leaveSeatBtn");

const phaseEl = document.getElementById("phase");
const attackerEl = document.getElementById("attacker");
const defenderEl = document.getElementById("defender");
const trumpEl = document.getElementById("trump");
const deckLeftEl = document.getElementById("deckLeft");
const bf = document.getElementById("battlefield");
const handWrap = document.getElementById("hand");
const handCountEl = document.getElementById("handCount");
const logEl = document.getElementById("log");

const hintsChk = document.getElementById("hints");
const confirmChk = document.getElementById("confirm");
const hintMsg = document.getElementById("hintMsg");

// actions
const btnAttack = document.getElementById("attackBtn");
const btnAdd = document.getElementById("addBtn");
const btnDefend = document.getElementById("defendBtn");
const btnTake = document.getElementById("takeBtn");
const btnEnd = document.getElementById("endBtn");

let currentRoom = null;
let mySeat = null;
let myHand = [];
let pub = null;        // public state
let selected = [];     // selected card(s) to attack / defend / add
let defenseTarget = null; // attack card id to defend

// ====== Helpers ======
function log(msg){
  const d = document.createElement("div"); d.textContent = "• "+msg;
  logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight;
}
function setConn(ok){
  connDot.classList.toggle("dot--green", ok);
  connDot.classList.toggle("dot--red", !ok);
  connText.textContent = ok ? "Savienojums izveidots" : "Nav savienojuma";
}
function rankVal(r){
  const order = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
  return order.indexOf(r);
}
function canDefend(def, att){
  if(!def||!att||!pub) return false;
  const trump = pub.trump.suit;
  if(def.suit === att.suit) return rankVal(def.rank) > rankVal(att.rank);
  if(def.suit === trump && att.suit !== trump) return true;
  return false;
}
function canAdd(card){
  if(!pub || pub.table.length===0) return false;
  const ranks = new Set();
  pub.table.forEach(p=>{ ranks.add(p.attack.rank); if(p.defend) ranks.add(p.defend.rank); });
  return ranks.has(card.rank);
}
function isMyTurn(){
  if(!pub || !mySeat) return false;
  if(pub.phase==="attack") return pub.attackerSeat===mySeat;
  if(pub.phase==="defend") return pub.defenderSeat===mySeat;
  return false;
}

// ====== RENDER ======
function renderSeats(){
  seatsWrap.querySelectorAll(".seat").forEach(node=>{
    const seatN = Number(node.dataset.seat);
    const s = pub?.seats?.[seatN-1] || null;
    const title = node.querySelector(".seat__title");
    const btn = node.querySelector(".seat__btn");

    if(s){
      title.textContent = `${s.name} ${s.out?'(ārā)':''}`.trim();
      btn.disabled = true;
    }else{
      title.textContent = `Sēdvieta ${seatN}`;
      btn.disabled = false;
      btn.onclick = ()=>{
        if(!currentRoom) return;
        socket.emit("seat:join", { code: currentRoom, seat: seatN, name: nameInput.value || "Spēlētājs" });
      };
    }
  });
}

function cardEl(c){
  const d = document.createElement("button");
  d.className = "card";
  d.setAttribute("type","button");
  d.textContent = c.id;
  d.dataset.id = c.id;
  d.onclick = ()=>{
    const idx = selected.findIndex(x=>x.id===c.id);
    if(idx>=0){ selected.splice(idx,1); d.classList.remove("card--sel"); }
    else { selected.push(c); d.classList.add("card--sel"); }
    // uzbrukumam atļaujam tikai vienāda ranga multi-selektus
    if(pub?.phase==="attack"){
      const r = selected[0]?.rank;
      if(!selected.every(x=>x.rank===r)){
        // noturam tikai pēdējo
        selected = [c];
        document.querySelectorAll(".card--sel").forEach(x=>x.classList.remove("card--sel"));
        d.classList.add("card--sel");
      }
    }
  };
  return d;
}
function renderHand(){
  handWrap.innerHTML = "";
  myHand.forEach(c=> handWrap.appendChild(cardEl(c)) );
  handCountEl.textContent = myHand.length;
}

function renderTable(){
  bf.innerHTML = "";
  pub.table.forEach(p=>{
    const cell = document.createElement("div");
    cell.className = "pair";
    const a = document.createElement("div"); a.className="pair__a"; a.textContent = p.attack.id;
    const d = document.createElement("div"); d.className="pair__d"; d.textContent = p.defend? p.defend.id : "—";
    // atzīmējam aktīvo aizsargājamo
    if(pub.phase==="defend" && !p.defend && mySeat===pub.defenderSeat){
      a.classList.add("pair__a--target");
      a.onclick = ()=> { defenseTarget = p.attack.id; hint(`Izvēlies kārti un spied "Nosist"`); };
    }
    cell.appendChild(a); cell.appendChild(d);
    bf.appendChild(cell);
  });
}

function renderStatus(){
  roomBadge.textContent = currentRoom || "—";
  phaseEl.textContent = pub?.phase || "—";
  attackerEl.textContent = pub?.attackerSeat ? `sēdvieta ${pub.attackerSeat}`:"—";
  defenderEl.textContent = pub?.defenderSeat ? `sēdvieta ${pub.defenderSeat}`:"—";
  deckLeftEl.textContent = pub?.deckLeft ?? "—";
  trumpEl.textContent = pub?.trump?.id || "—";
}
function hint(msg){
  if(!hintsChk.checked) return;
  hintMsg.textContent = msg;
  hintMsg.hidden = false;
  setTimeout(()=> hintMsg.hidden = true, 2000);
}
function renderAll(){
  renderStatus();
  renderSeats();
  renderTable();
  renderHand();
}

// ====== SOCKET ======
socket.on("connect", ()=> setConn(true));
socket.on("disconnect", ()=> setConn(false));
socket.on("connect_error", ()=> setConn(false));

socket.on("room:code", (code)=> {
  currentRoom = code;
  roomBadge.textContent = code;
  log(`Istaba izveidota: ${code}`);
});

socket.on("state:public", (state)=>{
  pub = state;
  renderAll();
  if(!currentRoom) currentRoom = state.code;
});

socket.on("state:private", ({ seat, hand })=>{
  mySeat = seat;
  myHand = hand;
  renderAll();
});

// ====== UI EVENTS ======
createBtn.onclick = ()=>{
  const name = nameInput.value || "Spēlētājs";
  const deckType = Number(deckSelect.value);
  const solo = !!soloChk.checked;
  socket.emit("room:create", { name, deckType, solo });
};

joinBtn.onclick = ()=>{
  const code = (roomCodeInput.value||"").trim().toUpperCase();
  if(!code) return alert("Ievadi istabas kodu");
  currentRoom = code;
  roomBadge.textContent = code;
  log(`Pievienojos istabai ${code}. Izvēlies sēdvietu.`);
};

startBtn.onclick = ()=>{
  if(!currentRoom) return;
  socket.emit("game:start", { code: currentRoom });
};

leaveSeatBtn.onclick = ()=>{
  if(!currentRoom) return;
  // vienkārši pievienoties tukšai sēdvietai atpakaļ vai reload — šeit atstājam tukšu
  alert("Šobrīd atbrīvošanās no sēdvietas ar reload.");
  location.reload();
};

// ACTIONS
btnAttack.onclick = ()=>{
  if(!isMyTurn() || pub.phase!=="attack") return;
  if(selected.length===0) return hint("Izvēlies 1 vai vairāk vienāda ranga kārtis");
  if(confirmChk.checked && !confirm("Uzbrukt ar izvēlētajām kārtīm?")) return;
  socket.emit("play:attack", { code: currentRoom, cards: selected });
  selected = []; renderHand();
};

btnAdd.onclick = ()=>{
  if(pub.phase!=="defend") return;
  if(selected.length!==1) return hint("Izvēlies vienu kārti, ko piemest");
  const c = selected[0];
  if(!canAdd(c)) return hint("Šo rangu nevar piemest");
  if(confirmChk.checked && !confirm(`Piemest ${c.id}?`)) return;
  socket.emit("play:add", { code: currentRoom, card: c });
  selected = []; renderHand();
};

btnDefend.onclick = ()=>{
  if(!isMyTurn() || pub.phase!=="defend") return;
  if(!defenseTarget) return hint("Uzklikšķini uz uzbrūkošās kārts (galda augšā), ko gribi nosist");
  if(selected.length!==1) return hint("Izvēlies vienu aizsargkārti");
  const c = selected[0];
  if(!canDefend(c, pub.table.find(p=>p.attack.id===defenseTarget)?.attack)) return hint("Ar šo karti nevar nosist");
  if(confirmChk.checked && !confirm(`Nosist ${defenseTarget} ar ${c.id}?`)) return;

  socket.emit("play:defend", { code: currentRoom, attackId: defenseTarget, defend: c });
  defenseTarget = null;
  selected = []; renderHand();
};

btnTake.onclick = ()=>{
  if(!isMyTurn() || pub.phase!=="defend") return;
  if(confirmChk.checked && !confirm("Paņemt visas kārtis?")) return;
  socket.emit("turn:take", { code: currentRoom });
};

btnEnd.onclick = ()=>{
  if(confirmChk.checked && !confirm("Beigt gājienu?")) return;
  socket.emit("turn:end", { code: currentRoom });
};
