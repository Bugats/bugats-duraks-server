// ======= KONFIGS =======
const SERVER_URL = "https://duraks-online.onrender.com";
const socket = io(SERVER_URL, { path: "/socket.io", transports: ["websocket"] });

// ======= ELEMENTI =======
const el = (id) => document.getElementById(id);

const hudRoom = el("hudRoom");
const hudTrump = el("hudTrump");
const hudStock = el("hudStock");
const hudPhase = el("hudPhase");
const hudTurn  = el("hudTurn");

const logBox = el("log");
const tableDiv = document.getElementById("table");
const playArea = document.getElementById("playArea");
const myHandDiv = document.getElementById("myHand");

const btnCreate = el("btnCreate");
const btnJoin = el("btnJoin");
const btnAttack = el("btnAttack");
const btnThrow = el("btnThrow");
const btnDefend = el("btnDefend");
const btnEnd = el("btnEnd");
const btnTake = el("btnTake");
const chatSend = el("chatSend");

// ======= STĀVOKLIS =======
let STATE = null;
let MY_ID = null;
let MY_SELECTED = [];     // izvēlētās rokas kārtis (uzbrukumam/piemest)
let DEF_TARGET = null;    // izvēlētais uzbrukuma pāris, kuru gribu nosist (index)

// ======= PALĪGI =======
function suitColor(s){
  return (s === '♥' || s === '♦') ? 'red' : 'black';
}
function cardNode(c, opts={}){
  const d = document.createElement('div');
  d.className = `card ${suitColor(c.s)} ${opts.trump ? 'trump' : ''} ${opts.selectable ? 'selectable':''} ${opts.selected ? 'selected':''}`;
  d.textContent = `${c.r}${c.s}`;
  return d;
}
function clearSelections(){
  MY_SELECTED = [];
  DEF_TARGET = null;
  render();
}
function ranksOnTable(){
  if (!STATE?.table) return new Set();
  const s = new Set();
  for (const p of STATE.table){
    if (p.attack) s.add(p.attack.r);
    if (p.defend) s.add(p.defend.r);
  }
  return s;
}
function canSelectForAttack(c){
  // Uzbrukuma fāzē: ja galds tukšs — jebkurš; citādi — tikai rangs, kas uz galda
  const hasTable = (STATE.table && STATE.table.length>0);
  if (!hasTable) return true;
  const allowed = ranksOnTable();
  return allowed.has(c.r);
}
function ensureSameRankSelected(rank){
  // vairākatkārtu uzbrukumam drīkst izvēlēties tikai to pašu rangu
  if (MY_SELECTED.length===0) return true;
  return MY_SELECTED.every(x => x.r === rank);
}
function isMyTurnToAttack(){
  if (!STATE) return false;
  const attackerId = STATE.order?.[STATE.attacker];
  return attackerId === MY_ID && STATE.phase === 'attack';
}
function iAmDefender(){
  if (!STATE) return false;
  const defenderId = STATE.order?.[STATE.defender];
  return defenderId === MY_ID && STATE.phase === 'defend';
}
function canThrowInNow(){
  if (!STATE) return false;
  // Aizsardzības fāzē var piemest, ja tavā rokā ir kāds rangs, kas atbilst galdam
  if (STATE.phase !== 'defend') return false;
  const allowed = ranksOnTable();
  const my = getMyHand();
  return my.some(c => allowed.has(c.r));
}
function getMyHand(){
  // STATE no servera nesūta manu pilno roku — bet šeit demo klientā rokas glabāšana ir vienkāršota:
  // Mēs balstāmies tikai uz izvēlēm (serveris validēs). Ja tev ir backend, kas sūta "me.hand", vari to ielasīt šeit.
  return window.MY_HAND || [];
}
function setMyHand(cards){
  window.MY_HAND = cards;
}

// ======= UI RENDERS =======
function renderState(s){
  STATE = s;
  hudRoom.textContent = s.id || '—';
  hudTrump.textContent = s.trump || '—';
  hudStock.textContent = (s.stockCount ?? '—');
  hudPhase.textContent = s.phase || '—';

  // kuram gājiens
  const attackerId = s.order?.[s.attacker];
  const defenderId = s.order?.[s.defender];
  let turnLabel = '—';
  if (attackerId && s.players?.[attackerId]){
    turnLabel = `Uzbrūk: ${s.players[attackerId].nick}`;
  }
  if (s.phase === 'defend' && defenderId && s.players?.[defenderId]){
    turnLabel += ` | Aizstāvas: ${s.players[defenderId].nick}`;
  }
  hudTurn.textContent = turnLabel;

  // sēdvietas (6)
  const seatBodies = tableDiv.querySelectorAll(".seat-body");
  seatBodies.forEach((slot, idx) => {
    slot.innerHTML = "";
    const pid = s.order?.[idx];
    if (!pid || !s.players?.[pid]) {
      slot.innerHTML = `<div class="nick">—</div><div class="count">brīvs</div>`;
      return;
    }
    const p = s.players[pid];
    const isAtt = (s.attacker === idx);
    const isDef = (s.defender === idx);
    const you = (pid === MY_ID) ? ' (Tu)' : '';
    const turnBadge = isAtt ? '<div class="turn">Uzbrucējs</div>' : (isDef ? '<div class="turn">Aizstāvis</div>' : '');
    slot.innerHTML = `
      <div class="nick">${p.nick}${you}</div>
      <div class="count">(${p.handCount})</div>
      ${turnBadge}
    `;
  });

  // galds (pāri)
  playArea.innerHTML = "";
  for (let i=0;i<s.table.length;i++){
    const pair = s.table[i];
    const wrap = document.createElement('div');
    wrap.className = 'pair';
    const atk = cardNode(pair.attack, { trump: pair.attack?.s === s.trump });
    atk.dataset.pair = i;
    // atzīmē nenosegtos kā "selectable" aizstāvja režīmā
    const canPickTarget = iAmDefender() && !pair.defend;
    if (canPickTarget) {
      atk.classList.add('selectable');
      if (DEF_TARGET===i) atk.classList.add('selected');
      atk.addEventListener('click', () => {
        DEF_TARGET = (DEF_TARGET===i ? null : i);
        render();
      });
    }
    wrap.appendChild(atk);

    if (pair.defend) {
      const def = cardNode(pair.defend, { trump: pair.defend?.s === s.trump });
      wrap.appendChild(def);
    }
    playArea.appendChild(wrap);
  }

  // roka — klientā turam lokāli tikai vizuāli (serveris validē)
  renderHand();

  // pogas
  btnAttack.disabled = !isMyTurnToAttack() || MY_SELECTED.length===0;
  btnThrow.disabled = !(STATE.phase==='defend' && canThrowInNow() && MY_SELECTED.length>0);
  btnDefend.disabled = !(iAmDefender() && DEF_TARGET!=null && MY_SELECTED.length===1);
  btnEnd.disabled = !(STATE.phase==='defend' && tableAllDefended(s));
  btnTake.disabled = !iAmDefender();
}

function renderHand(){
  myHandDiv.innerHTML = "";
  const hand = getMyHand();

  // Ja nav sinhronizētas rokas, parādi tukšu. (Pēc pirmā gājiena serveri var papildināt, lai sūtītu arī manu roku.)
  if (!hand || hand.length===0) {
    const info = document.createElement('div');
    info.style.color = "#94a3b8";
    info.textContent = "Roka nav ielādēta vai tukša. Pamēģini izveidot istabu ar BOT un sākt spēli.";
    myHandDiv.appendChild(info);
    return;
  }

  hand.forEach((c, idx) => {
    const isSel = MY_SELECTED.find(x => x.r===c.r && x.s===c.s);
    let selectable = true;

    if (isMyTurnToAttack()) {
      selectable = canSelectForAttack(c) && ensureSameRankSelected(c.r);
    } else if (STATE.phase === 'defend') {
      // aizstāvja klik notiek uz uzbrukuma kartes → pēc tam uz rokas
      selectable = iAmDefender() && DEF_TARGET!=null && canBeatLocal(c, STATE.table[DEF_TARGET]?.attack);
      // citi spēlētāji aizsardzības fāzē var piemest (ar atsevišķu pogu), šeit ļaujam izvēlēties jebkuru ar atbilstošu rangu
      if (!iAmDefender() && canThrowInNow()) {
        const allowed = ranksOnTable();
        selectable = allowed.has(c.r) && ensureSameRankSelected(c.r);
      }
    } else {
      selectable = false;
    }

    const node = cardNode(c, { trump: c.s===STATE.trump, selectable, selected: !!isSel });
    if (selectable) {
      node.addEventListener('click', () => {
        const ix = MY_SELECTED.findIndex(x => x.r===c.r && x.s===c.s);
        if (ix>=0) {
          MY_SELECTED.splice(ix,1);
        } else {
          // uzbrukumā/throw-in ļaujam tikai viena ranga komplektu
          if (MY_SELECTED.length===0 || MY_SELECTED.every(x => x.r===c.r)) {
            MY_SELECTED.push(c);
          } else {
            // nomainām uz jauno rangu
            MY_SELECTED = [c];
          }
        }
        render();
      });
    }
    myHandDiv.appendChild(node);
  });
}

function canBeatLocal(def, atk){
  if (!STATE) return false;
  const order = STATE.use52 ? ['2','3','4','5','6','7','8','9','10','J','Q','K','A'] : ['6','7','8','9','10','J','Q','K','A'];
  const v = (r)=>order.indexOf(r);
  if (!def || !atk) return false;
  if (def.s === atk.s && v(def.r) > v(atk.r)) return true;
  if (def.s === STATE.trump && atk.s !== STATE.trump) return true;
  return false;
}

function tableAllDefended(s){
  return s.table.length>0 && s.table.every(p => p.attack && p.defend);
}

// ======= SOCKET HANDLERS =======
socket.on("connect", () => { MY_ID = socket.id; });

socket.on("log", (line) => {
  const p = document.createElement('div');
  p.textContent = line;
  logBox.appendChild(p);
  logBox.scrollTop = logBox.scrollHeight;
});

socket.on("errorMsg", (m) => {
  const p = document.createElement('div');
  p.style.color = "#ef4444";
  p.textContent = m;
  logBox.appendChild(p);
  logBox.scrollTop = logBox.scrollHeight;
});

socket.on("created", ({ roomId }) => {
  hudRoom.textContent = roomId;
  el("roomCode").value = roomId;
});

socket.on("state", (st) => {
  // Piezīme: serveris nesūta reālo "me.hand".
  // Demo nolūkiem sinhronizēsim minimāli: ja logā ir “Savienots/Spēle sākta”, tu vari manuāli piešķirt rokas testam.
  // Praktiskai spēlei ieteicams paplašināt serveri, lai along ar state sūta arī "me.hand" tikai pašam socketam.
  renderState(st);
});

// ======= UI DARBI =======
btnCreate.addEventListener("click", () => {
  const nick = el("nick").value || "BUGATS";
  const deckSize = Number(el("deckSize").value) || 36;
  const soloBot = el("soloBot").checked;
  socket.emit("createRoom", { nick, deckSize, soloBot }, (res) => {
    if (!res?.ok) return;
    // Pēc izveides — resetē lokālās izvēles un roku (ja testē manuāli — vari ielikt šeit mock rokas)
    setMyHand([]);
    MY_SELECTED = [];
    DEF_TARGET = null;
  });
});

btnJoin.addEventListener("click", () => {
  const roomId = (el("roomCode").value || "").trim().toUpperCase();
  const nick = el("nick").value || "BUGATS";
  if (!roomId) return;
  socket.emit("joinRoom", { roomId, nick }, (res) => {
    if (!res?.ok) return;
    setMyHand([]);
    MY_SELECTED = [];
    DEF_TARGET = null;
  });
});

chatSend.addEventListener("click", () => {
  const t = el("chatMsg").value.trim();
  if (!t) return;
  socket.emit("chat", { text: t });
  el("chatMsg").value = "";
});

// Uzbrukt
btnAttack.addEventListener("click", () => {
  if (!STATE) return;
  if (!isMyTurnToAttack()) return;
  if (MY_SELECTED.length===0) return;
  socket.emit("attack", { cards: MY_SELECTED }, (res) => {
    if (res?.ok) {
      // No rokas izņemam izvēlētos (lokāli) — serveris orākuls
      const my = getMyHand().slice();
      for (const c of MY_SELECTED){
        const i = my.findIndex(h=>h.r===c.r && h.s===c.s);
        if (i>-1) my.splice(i,1);
      }
      setMyHand(my);
      MY_SELECTED = [];
      render();
    }
  });
});

// Piemest
btnThrow.addEventListener("click", () => {
  if (!STATE) return;
  if (STATE.phase!=='defend') return;
  if (MY_SELECTED.length===0) return;
  socket.emit("throwIn", { cards: MY_SELECTED }, (res) => {
    if (res?.ok) {
      const my = getMyHand().slice();
      for (const c of MY_SELECTED){
        const i = my.findIndex(h=>h.r===c.r && h.s===c.s);
        if (i>-1) my.splice(i,1);
      }
      setMyHand(my);
      MY_SELECTED = [];
      render();
    }
  });
});

// Nosist (aizsardzība)
btnDefend.addEventListener("click", () => {
  if (!STATE) return;
  if (!iAmDefender()) return;
  if (DEF_TARGET==null || MY_SELECTED.length!==1) return;
  const card = MY_SELECTED[0];
  socket.emit("defend", { attackIndex: DEF_TARGET, card }, (res) => {
    if (res?.ok) {
      const my = getMyHand().slice();
      const i = my.findIndex(h=>h.r===card.r && h.s===card.s);
      if (i>-1) my.splice(i,1);
      setMyHand(my);
      MY_SELECTED = [];
      // Atstāj DEF_TARGET, ja ir vēl citi nenosegti, citādi null
      DEF_TARGET = null;
      render();
    }
  });
});

// Beigt gājienu
btnEnd.addEventListener("click", () => {
  socket.emit("endTurn", {}, (res) => { /* serveris validē all-defended */ });
});

// Paņemt
btnTake.addEventListener("click", () => {
  socket.emit("take", {}, (res) => {});
});

// ======= TESTA PALĪGS (pēc vajadzības) =======
// Šī palīdzība ļauj lokāli iedot sev rokas testam vienatnē.
// Atkomentē un atjauno pēc vajadzības:
// setMyHand([
//   {r:'6',s:'♣'},{r:'6',s:'♦'},{r:'7',s:'♣'},
//   {r:'9',s:'♥'},{r:'10',s:'♠'},{r:'J',s:'♣'}
// ]);
// render();
