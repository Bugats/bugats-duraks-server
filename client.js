// Klients Duraks Online — Bugats Edition (v1.3.1)
// Saņem privāto roku caur 'me' eventu (tikai sev), galds centrā redzams visiem.

const SERVER_URL = "https://duraks-online.onrender.com";
const socket = io(SERVER_URL, { path: "/socket.io", transports: ["websocket"] });

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

let STATE = null;
let MY_ID = null;
let MY_HAND = [];
let MY_SELECTED = [];
let DEF_TARGET = null;

function suitColor(s){ return (s==='♥'||s==='♦') ? 'red' : 'black'; }
function cardNode(c, opts={}){
  const d = document.createElement('div');
  d.className = `card ${suitColor(c.s)} ${opts.trump ? 'trump' : ''} ${opts.selectable ? 'selectable':''} ${opts.selected ? 'selected':''}`;
  d.textContent = `${c.r}${c.s}`;
  return d;
}
function ranksOnTable(){
  if (!STATE?.table) return new Set();
  const s = new Set();
  for (const p of STATE.table){ if (p.attack) s.add(p.attack.r); if (p.defend) s.add(p.defend.r); }
  return s;
}
function canSelectForAttack(c){
  const hasTable = (STATE.table && STATE.table.length>0);
  if (!hasTable) return true;
  const allowed = ranksOnTable();
  return allowed.has(c.r);
}
function ensureSameRankSelected(rank){ return MY_SELECTED.length===0 || MY_SELECTED.every(x=>x.r===rank); }
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
  if (!STATE || STATE.phase!=='defend') return false;
  const allowed = ranksOnTable();
  return MY_HAND.some(c => allowed.has(c.r));
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
function tableAllDefended(s){ return s.table.length>0 && s.table.every(p=>p.attack && p.defend); }

function render(){
  if (!STATE) return;

  hudRoom.textContent = STATE.id || '—';
  hudTrump.textContent = STATE.trump || '—';
  hudStock.textContent = (STATE.stockCount ?? '—');
  hudPhase.textContent = STATE.phase || '—';

  const attackerId = STATE.order?.[STATE.attacker];
  const defenderId = STATE.order?.[STATE.defender];
  let turnLabel = '—';
  if (attackerId && STATE.players?.[attackerId]) turnLabel = `Uzbrūk: ${STATE.players[attackerId].nick}`;
  if (STATE.phase === 'defend' && defenderId && STATE.players?.[defenderId]) turnLabel += ` | Aizstāvas: ${STATE.players[defenderId].nick}`;
  hudTurn.textContent = turnLabel;

  // sēdvietas
  const seatBodies = tableDiv.querySelectorAll(".seat-body");
  seatBodies.forEach((slot, idx) => {
    slot.innerHTML = "";
    const pid = STATE.order?.[idx];
    if (!pid || !STATE.players?.[pid]) {
      slot.innerHTML = `<div class="nick">—</div><div class="count">brīvs</div>`;
      return;
    }
    const p = STATE.players[pid];
    const isAtt = (STATE.attacker === idx);
    const isDef = (STATE.defender === idx);
    const you = (pid === MY_ID) ? ' (Tu)' : '';
    const turnBadge = isAtt ? '<div class="turn">Uzbrucējs</div>' : (isDef ? '<div class="turn">Aizstāvis</div>' : '');
    slot.innerHTML = `<div class="nick">${p.nick}${you}</div><div class="count">(${p.handCount})</div>${turnBadge}`;
  });

  // galds centrā (metiens/uzliktās kārtis)
  playArea.innerHTML = "";
  for (let i=0;i<STATE.table.length;i++){
    const pair = STATE.table[i];
    const wrap = document.createElement('div'); wrap.className = 'pair';
    const atk = cardNode(pair.attack, { trump: pair.attack?.s === STATE.trump });
    atk.dataset.pair = i;
    const canPickTarget = iAmDefender() && !pair.defend;
    if (canPickTarget) {
      atk.classList.add('selectable');
      if (DEF_TARGET===i) atk.classList.add('selected');
      atk.addEventListener('click', () => { DEF_TARGET = (DEF_TARGET===i ? null : i); render(); });
    }
    wrap.appendChild(atk);
    if (pair.defend){
      const def = cardNode(pair.defend, { trump: pair.defend?.s === STATE.trump });
      wrap.appendChild(def);
    }
    playArea.appendChild(wrap);
  }

  // mana roka (privāti no servera)
  renderHand();

  btnAttack.disabled = !isMyTurnToAttack() || MY_SELECTED.length===0;
  btnThrow.disabled = !(STATE.phase==='defend' && canThrowInNow() && MY_SELECTED.length>0);
  btnDefend.disabled = !(iAmDefender() && DEF_TARGET!=null && MY_SELECTED.length===1);
  btnEnd.disabled = !(STATE.phase==='defend' && tableAllDefended(STATE));
  btnTake.disabled = !iAmDefender();
}

function renderHand(){
  myHandDiv.innerHTML = "";
  if (!MY_HAND || MY_HAND.length===0){
    const info = document.createElement('div');
    info.style.color = "#94a3b8";
    info.textContent = "Tev šobrīd nav kāršu (vai kava izdalīta vēl nav).";
    myHandDiv.appendChild(info);
    return;
  }
  MY_HAND.forEach((c) => {
    const isSel = MY_SELECTED.find(x => x.r===c.r && x.s===c.s);
    let selectable = true;

    if (isMyTurnToAttack()) {
      selectable = canSelectForAttack(c) && ensureSameRankSelected(c.r);
    } else if (STATE.phase === 'defend') {
      selectable = iAmDefender() && DEF_TARGET!=null && canBeatLocal(c, STATE.table[DEF_TARGET]?.attack);
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
        if (ix>=0) MY_SELECTED.splice(ix,1);
        else {
          if (MY_SELECTED.length===0 || MY_SELECTED.every(x => x.r===c.r)) MY_SELECTED.push(c);
          else MY_SELECTED = [c];
        }
        render();
      });
    }
    myHandDiv.appendChild(node);
  });
}

/* ===== Sockets ===== */
socket.on("connect", ()=>{ MY_ID = socket.id; });

socket.on("log", (line) => {
  const p = document.createElement('div'); p.textContent = line;
  logBox.appendChild(p); logBox.scrollTop = logBox.scrollHeight;
});
socket.on("errorMsg", (m) => {
  const p = document.createElement('div'); p.style.color = "#ef4444"; p.textContent = m;
  logBox.appendChild(p); logBox.scrollTop = logBox.scrollHeight;
});
socket.on("created", ({ roomId }) => {
  hudRoom.textContent = roomId;
  el("roomCode").value = roomId;
});
socket.on("state", (st) => { STATE = st; render(); });
socket.on("me", ({ hand }) => { MY_HAND = hand || []; syncSelected(); render(); });

function syncSelected(){
  if (!MY_SELECTED.length) return;
  MY_SELECTED = MY_SELECTED.filter(sel => !!MY_HAND.find(h=>h.r===sel.r && h.s===sel.s));
}

/* ===== UI ===== */
btnCreate.addEventListener("click", () => {
  const nick = el("nick").value || "BUGATS";
  const deckSize = Number(el("deckSize").value) || 36;
  const soloBot = el("soloBot").checked;
  MY_SELECTED = []; DEF_TARGET = null; MY_HAND = [];
  socket.emit("createRoom", { nick, deckSize, soloBot }, ()=>{});
});

btnJoin.addEventListener("click", () => {
  const roomId = (el("roomCode").value || "").trim().toUpperCase();
  const nick = el("nick").value || "BUGATS";
  if (!roomId) return;
  MY_SELECTED = []; DEF_TARGET = null; MY_HAND = [];
  socket.emit("joinRoom", { roomId, nick }, ()=>{});
});

chatSend.addEventListener("click", () => {
  const t = el("chatMsg").value.trim();
  if (!t) return;
  socket.emit("chat", { text: t });
  el("chatMsg").value = "";
});

btnAttack.addEventListener("click", () => {
  if (!STATE || !isMyTurnToAttack() || MY_SELECTED.length===0) return;
  socket.emit("attack", { cards: MY_SELECTED }, (res) => {
    if (res?.ok){
      // serveris emitēs jauno manu roku ar 'me'
      MY_SELECTED = [];
    }
  });
});

btnThrow.addEventListener("click", () => {
  if (!STATE || STATE.phase!=='defend' || MY_SELECTED.length===0) return;
  socket.emit("throwIn", { cards: MY_SELECTED }, (res) => {
    if (res?.ok){ MY_SELECTED = []; }
  });
});

btnDefend.addEventListener("click", () => {
  if (!STATE || !iAmDefender() || DEF_TARGET==null || MY_SELECTED.length!==1) return;
  const card = MY_SELECTED[0];
  socket.emit("defend", { attackIndex: DEF_TARGET, card }, (res) => {
    if (res?.ok){ MY_SELECTED = []; DEF_TARGET = null; }
  });
});

btnEnd.addEventListener("click", () => { socket.emit("endTurn", {}, ()=>{}); });
btnTake.addEventListener("click", () => { socket.emit("take", {}, ()=>{}); });
