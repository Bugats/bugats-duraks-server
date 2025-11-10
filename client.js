// client.js
// front-end for Duraks Online — Bugats Edition
/* client.js – Duraks Online (Hostinger klients -> Render WS serverim)
   Autors: Bugats projekts
   -> Klients hostējas: thezone.lv/rps
   -> Serveris (socket.io): wss://duraks-online.onrender.com
*/

/* ===================== KONFIGURĀCIJA ===================== */
const SERVER_URL = 'wss://duraks-online.onrender.com'; // ← ja vajag, nomaini
const USE_WEBSOCKET_ONLY = true; // stabilitātei liekam tikai WebSocket transportu

/* ===================== SOCKET SAVIENOJUMS ===================== */
const socket = io(SERVER_URL, {
  transports: USE_WEBSOCKET_ONLY ? ['websocket'] : undefined,
});

/* ===================== UI ELEM. SAITES ===================== */
// Header
const elName        = document.querySelector('input[name="vards"]')        || document.getElementById('vards')        || document.querySelector('#vards');
const elDeckSelect  = document.querySelector('select[name="kava"]')         || document.getElementById('kava');
const elSolo        = document.querySelector('input[name="solo"]')          || document.querySelector('#solo');
const elCreateBtn   = document.querySelector('#izveidot')                   || document.querySelector('button[data-action="create"]');
const elJoinCode    = document.querySelector('#kodss')                      || document.querySelector('input[name="istabas_kods"]');
const elJoinBtn     = document.querySelector('#pievienoties')               || document.querySelector('button[data-action="join"]');

// Sēdvietas
const seatButtons   = Array.from(document.querySelectorAll('[data-seat]'));
// Poga atstāt sēdvietu
const elLeaveSeat   = document.querySelector('[data-action="leave-seat"]');

// Spēles zona
const elBoard       = document.querySelector('#board')        || document.querySelector('[data-area="board"]');
const elHand        = document.querySelector('#hand')         || document.querySelector('[data-area="hand"]');
const elLog         = document.querySelector('#log')          || document.querySelector('[data-area="log"]');

// Kontroles
const btnAttack     = document.querySelector('[data-action="attack"]');
const btnAdd        = document.querySelector('[data-action="add"]');
const btnDefend     = document.querySelector('[data-action="defend"]');
const btnTake       = document.querySelector('[data-action="take"]');
const btnEnd        = document.querySelector('[data-action="end-turn"]');

// Iestatījumi
const chkHints      = document.querySelector('input[name="hints"]')         || document.querySelector('#hints');
const chkConfirm    = document.querySelector('input[name="confirm"]')       || document.querySelector('#confirm');

/* ===================== KLIENTA STĀVOKLIS ===================== */
let currentRoom     = null;       // { code, deckType, trump, phase, ... }
let myId            = null;
let mySeat          = null;       // 1..6 vai null
let state           = null;       // pilnais servera stāvoklis
let selectedCards   = [];         // lietotāja pašlaik atzīmētās kārtis (uzbrukumam/aizsardzībai)
let handIndexMap    = [];         // karšu indeksu saite ar UI
let confirming      = true;       // apstiprinājuma režīms
let hintsOn         = true;

/* ===================== PALĪGFUNKCIJAS ===================== */
function log(msg) {
  if (!elLog) return;
  const line = document.createElement('div');
  line.textContent = '• ' + msg;
  elLog.appendChild(line);
  elLog.scrollTop = elLog.scrollHeight;
}
function q(v) { return (v ?? '').toString().trim(); }
function getDeckType() {
  // select vērtības – "36 kārtis (2–4)" vai "52 kārtis (2–4)" u.tml.
  const raw = (elDeckSelect && elDeckSelect.value) ? elDeckSelect.value : '36';
  const m = raw.match(/\d+/);
  return m ? Number(m[0]) : 36;
}
function mustConfirm() {
  return (chkConfirm && chkConfirm.checked) ?? confirming;
}
function withConfirm(message, cb) {
  if (mustConfirm()) {
    if (confirm(message)) cb();
  } else cb();
}
function resetSelection() {
  selectedCards = [];
  // noņem vizuālo iezīmējumu
  elHand?.querySelectorAll('.card.selected')?.forEach(c => c.classList.remove('selected'));
}
function renderSeats(st) {
  // Sēdvietas – viens spēlētājs var sēdēt tikai vienā vietā
  // paredzēts, ka seatButtons ir 6 gab. ar data-seat="1..6"
  if (!seatButtons?.length) return;
  seatButtons.forEach(btn => {
    const idx = Number(btn.getAttribute('data-seat'));
    const taken = st.seats?.[idx]?.taken;
    const isMine = (st.seats?.[idx]?.playerId === myId);
    btn.disabled = !!taken && !isMine;
    btn.textContent = isMine ? 'Tava sēdvieta' : (taken ? 'Aizņemts' : 'Pievienoties');
  });
}

function cardText(card) {
  // {rank:'A', suit:'♣', trump:false}
  return `${card.rank}${card.suit}`;
}
function renderHand(st) {
  if (!elHand) return;
  elHand.innerHTML = '';
  handIndexMap = [];
  const mine = st.players?.[myId]?.hand || [];
  mine.forEach((c, i) => {
    const div = document.createElement('button');
    div.className = 'card';
    div.textContent = cardText(c);
    div.title = 'Klikšķini, lai iezīmētu/atiezīmētu';
    div.addEventListener('click', () => {
      const pos = selectedCards.indexOf(i);
      if (pos >= 0) {
        selectedCards.splice(pos, 1);
        div.classList.remove('selected');
      } else {
        selectedCards.push(i);
        div.classList.add('selected');
      }
    });
    elHand.appendChild(div);
    handIndexMap.push(i);
  });
}

function renderBoard(st) {
  if (!elBoard) return;
  elBoard.innerHTML = '';
  // Rāda metiena pārus (uzbrukums/aizsardzība)
  const pairs = st.battlefield || [];
  pairs.forEach(p => {
    const slot = document.createElement('div');
    slot.className = 'pair';
    const up = document.createElement('div');
    up.className = 'card up';
    up.textContent = p.attack ? cardText(p.attack) : '—';

    const down = document.createElement('div');
    down.className = 'card down ' + (p.defense ? '' : 'empty');
    down.textContent = p.defense ? cardText(p.defense) : '—';

    slot.appendChild(up);
    slot.appendChild(down);
    elBoard.appendChild(slot);
  });
}

function applyHints(st) {
  if (!hintsOn || !elHand) return;
  // elementārs hints: ja aizstāvis – iezīmē kartes, kuras var sist;
  // ja uzbrucējs – iezīmē kartes, kuras drīkst mest (pēc rankiem uz galda)
  elHand.querySelectorAll('.card')?.forEach(c => c.classList.remove('hint'));
  try {
    if (st.phase === 'defend' && st.turn?.defender === myId) {
      const need = (st.battlefield || [])
        .filter(p => p.attack && !p.defense)
        .map(p => p.attack);
      const myHand = st.players?.[myId]?.hand || [];
      myHand.forEach((c, idx) => {
        const ok = need.some(a => (
          (c.suit === a.suit && c.power > a.power) || (c.trump && !a.trump)
        ));
        if (ok) elHand.children[idx]?.classList.add('hint');
      });
    } else if (st.phase === 'attack' && st.turn?.attacker === myId) {
      const ranksOnTable = new Set((st.battlefield || [])
        .flatMap(p => [p.attack?.rank, p.defense?.rank].filter(Boolean)));
      const myHand = st.players?.[myId]?.hand || [];
      myHand.forEach((c, idx) => {
        if (ranksOnTable.size === 0 || ranksOnTable.has(c.rank)) {
          elHand.children[idx]?.classList.add('hint');
        }
      });
    }
  } catch (_) { /* klusām */ }
}

function renderAll(st) {
  state = st;
  currentRoom = st.room;
  renderSeats(st);
  renderBoard(st);
  renderHand(st);
  applyHints(st);

  // Pogas aktivizēšana/atspējošana
  const isAtt = st.turn?.attacker === myId;
  const isDef = st.turn?.defender === myId;

  if (btnAttack) btnAttack.disabled = !isAtt || (st.phase !== 'attack');
  if (btnAdd)    btnAdd.disabled    = !isAtt || (st.phase !== 'attack');
  if (btnDefend) btnDefend.disabled = !isDef || (st.phase !== 'defend');
  if (btnTake)   btnTake.disabled   = !isDef || (st.phase !== 'defend');
  if (btnEnd)    btnEnd.disabled    = !!(st.phase !== 'attack' && st.phase !== 'defend');

  // virsraksta info (ja tev lapā ir vieta – piemērā tikai logā)
  log(`Fāze: ${st.phase} • Kava: ${st.deckLeft} • Trumps: ${st.trump || '—'}`);
}

/* ===================== SOCKET NOTIKUMI ===================== */
socket.on('connect', () => {
  myId = socket.id;
  log('Savienojums izveidots.');
});
socket.on('disconnect', () => {
  log('Savienojums zudis.');
});

socket.on('room:created', (payload) => {
  // { code, state }
  currentRoom = { code: payload.code };
  log(`Istaba izveidota: ${payload.code}`);
  if (payload.state) renderAll(payload.state);
});

socket.on('room:joined', (payload) => {
  // { code, state }
  currentRoom = { code: payload.code };
  log(`Pievienojies istabai: ${payload.code}`);
  if (payload.state) renderAll(payload.state);
});

socket.on('seat:accepted', (payload) => {
  // { seat, state }
  mySeat = payload.seat;
  log(`Sēdvieta pieņemta: ${mySeat}`);
  if (payload.state) renderAll(payload.state);
});

socket.on('state', (st) => {
  renderAll(st);
});

socket.on('error:msg', (m) => {
  alert(m || 'Kļūda.');
});

/* ===================== UI -> SERVER ===================== */
function createRoom() {
  const name = q(elName?.value) || 'BUGATS';
  const deckType = getDeckType();  // 36 vai 52
  const solo = !!(elSolo?.checked);
  const code = null; // serveris pats ģenerēs

  socket.emit('room:create', { code, name, deckType, solo });
}

function joinRoom() {
  const code = q(elJoinCode?.value).toUpperCase();
  if (!code) return alert('Ievadi istabas kodu!');
  socket.emit('room:join', { code });
}

function takeSeat(seat) {
  if (!currentRoom?.code) return alert('Vispirms izveido vai pievienojies istabai.');
  socket.emit('seat:take', { code: currentRoom.code, seat });
}

function leaveSeat() {
  if (!currentRoom?.code) return;
  socket.emit('seat:leave', { code: currentRoom.code });
  mySeat = null;
}

function emitAttack() {
  if (!currentRoom?.code) return;
  const indices = [...selectedCards];
  if (indices.length < 1) return alert('Izvēlies karti(-es) uzbrukumam.');
  withConfirm('Uzbrukt ar iezīmētajām kārtīm?', () => {
    socket.emit('play:attack', { code: currentRoom.code, indices });
    resetSelection();
  });
}
function emitAdd() {
  if (!currentRoom?.code) return;
  const indices = [...selectedCards];
  if (indices.length < 1) return alert('Izvēlies, ko piemest.');
  withConfirm('Piemest iezīmētās kārtis?', () => {
    socket.emit('play:add', { code: currentRoom.code, indices });
    resetSelection();
  });
}
function emitDefend() {
  if (!currentRoom?.code) return;
  const indices = [...selectedCards];
  if (indices.length < 1) return alert('Izvēlies, ar ko sist.');
  withConfirm('Nosist ar iezīmētajām kārtīm?', () => {
    socket.emit('play:defend', { code: currentRoom.code, indices });
    resetSelection();
  });
}
function emitTake() {
  if (!currentRoom?.code) return;
  withConfirm('Paņemt galda kārtis?', () => {
    socket.emit('play:take', { code: currentRoom.code });
  });
}
function emitEnd() {
  if (!currentRoom?.code) return;
  socket.emit('turn:end', { code: currentRoom.code });
}

/* ===================== LISTENERU REĢISTRĀCIJA ===================== */
// Istabas vadība
elCreateBtn?.addEventListener('click', createRoom);
elJoinBtn?.addEventListener('click', joinRoom);

// Sēdvietas
seatButtons?.forEach(btn => {
  btn.addEventListener('click', () => {
    const seat = Number(btn.getAttribute('data-seat'));
    takeSeat(seat);
  });
});
elLeaveSeat?.addEventListener('click', leaveSeat);

// Spēles pogas
btnAttack?.addEventListener('click', emitAttack);
btnAdd?.addEventListener('click', emitAdd);
btnDefend?.addEventListener('click', emitDefend);
btnTake?.addEventListener('click', emitTake);
btnEnd?.addEventListener('click', emitEnd);

// Iestatījumi
if (chkHints) {
  hintsOn = !!chkHints.checked;
  chkHints.addEventListener('change', () => {
    hintsOn = !!chkHints.checked;
    if (state) applyHints(state);
  });
}
if (chkConfirm) {
  confirming = !!chkConfirm.checked;
  chkConfirm.addEventListener('change', () => {
    confirming = !!chkConfirm.checked;
  });
}

/* ===================== UI UZLABOJUMI ===================== */
// Viena sēdvieta uz spēlētāju – serveris jau validē, bet klients arī bloķē
socket.on('seat:busy', (seat) => {
  log(`Sēdvieta ${seat} ir aizņemta.`);
});

// Vienkāršs “status” loga pieraksts par fāzēm/maiņām
socket.on('turn:info', (msg) => log(msg));

/* ===================== STARTUP ===================== */
log('Klients ielādēts. Ievadi vārdu, izvēlies kavu, izveido/pievienojies istabai, paņem sēdvietu un startē!');

// ================== IMPORTANT ==================
// Ieliec šeit sava Node/Socket.IO servera HTTPS adresi (Render u.c.)
const SERVER_URL = 'https://duraks-online.onrender.com' // <-- N O M A I N I !
// Ja serveris ir tieši šajā pašā originā (piem. lokāli), vari atstāt '' un lietot io() bez URL.
// =================================================

const socket = SERVER_URL
  ? io(SERVER_URL, { transports: ['websocket', 'polling'], reconnection: true })
  : io();

// Vienkārša konekcijas diagnostika
socket.on('connect', () => toast('Savienots ar serveri ✓ (' + socket.id + ')'));
socket.on('connect_error', (e) => toast('Savienojuma kļūda: ' + (e?.message || e)));
socket.on('disconnect', (r) => toast('Atvienots: ' + r));

let currentRoom = null;
let mySeatId = null;
let state = { room:null, game:null };
let selected = []; // selected cards from hand
let hintsOn = true;
let confirmOn = true;

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

$('#toggle-hints').addEventListener('change', e => hintsOn = e.target.checked);
$('#toggle-confirm').addEventListener('change', e => confirmOn = e.target.checked);

$('#createRoom').onclick = () => {
  socket.emit('room:create', null, resp => {
    if (!resp?.ok) return toast(resp?.error || 'Neizdevās izveidot istabu');
    currentRoom = resp.code;
    $('#roomCode').textContent = 'Istaba: ' + currentRoom;
    socket.emit('room:join', currentRoom, ()=>{});
  });
};

$('#joinRoom').onclick = () => {
  const code = $('#joinCode').value.trim();
  if (!code) return;
  socket.emit('room:join', code, resp=>{
    if (!resp?.ok) return toast(resp.error || 'Neizdevās pievienoties');
    currentRoom = code;
    $('#roomCode').textContent = 'Istaba: ' + currentRoom;
  });
};

$('#startGame').onclick = () => {
  if (!currentRoom) return toast('Nav istabas');
  const deckSize = +$('#deckSel').value;
  const solo = $('#solo').checked;
  socket.emit('game:start', { roomCode: currentRoom, deckSize, solo }, resp=>{
    if (!resp?.ok) toast(resp.error || 'Nevar startēt');
  });
};

$('#leaveSeat').onclick = () => {
  if (!currentRoom || !mySeatId) return;
  socket.emit('seat:leave', { roomCode: currentRoom }, ()=>{ mySeatId=null; });
};

function askConfirm(msg) {
  return !confirmOn || confirm(msg);
}

function toast(msg) {
  const log = $('#log');
  const p = document.createElement('div');
  p.textContent = '• ' + msg;
  log.prepend(p);
}

function showHint(kind, msg) {
  if (!hintsOn) return;
  toast(`[${kind}] ${msg}`);
}

// ===== render seats =====
socket.on('seat:update', st => {
  renderSeats(st.seats);
});

socket.on('room:joined', code => {
  currentRoom = code;
  $('#roomCode').textContent = 'Istaba: ' + code;
});

function renderSeats(seats) {
  const wrap = $('#seats');
  wrap.innerHTML = '';
  Object.values(seats).forEach(s => {
    const b = document.createElement('button');
    b.className = 'seat';
    b.disabled = !!s.busy || (mySeatId && mySeatId !== s.id);
    b.textContent = `${s.name} ${s.busy ? ' (aizņemta)' : ''} ${s.isBot?'[BOT]':''}`;
    b.onclick = () => {
      if (mySeatId && mySeatId !== s.id) return toast('Tu jau sēdi!');
      socket.emit('seat:join', { roomCode: currentRoom, seatId: s.id }, resp=>{
        if (resp?.ok) {
          mySeatId = s.id;
          showHint('seat', `Ieņemta vieta ${s.id}`);
        } else toast(resp?.error || 'Neizdevās');
      });
    };
    wrap.appendChild(b);
  });
}

// ====== full state ======
socket.on('state', s => {
  state = s;
  renderAll();
});

socket.on('public', pg => {
  // ignore; we receive full personal 'state' anyway
});

socket.on('game:winnerProgress', list => {
  $('#winners').textContent = 'Uzvarējušo secība: ' + list.join(' → ');
});
socket.on('game:finish', list => {
  $('#winners').textContent = 'Spēle beigusies! ' + list.join(' → ');
});

// ====== RENDER ======
function renderAll() {
  const g = state.game;
  const r = state.room;

  if (r) renderSeats(r.seats);

  if (!g) {
    $('#phase').textContent = '—';
    $('#turnInfo').textContent = '';
    $('#deckCount').textContent = '';
    $('#trump').textContent = '';
    $('#hand').innerHTML = '';
    $('#tablePairs').innerHTML = '';
    $('#handCount').textContent = '0';
    return;
  }

  $('#phase').textContent = g.turnPhase === 'attack' ? 'Fāze: uzbrukums' : 'Fāze: aizstāvēšanās';
  $('#turnInfo').textContent = `Uzbrucējs sēdvieta ${g.attackerSeat} · Aizstāvis sēdvieta ${g.defenderSeat}`;
  $('#deckCount').textContent = `Kavā: ${g.deckCount}`;
  $('#trump').textContent = `Trumps: ${g.trumpSuit} (${g.trumpCard.rank}${g.trumpCard.suit})`;

  const pairs = $('#tablePairs');
  pairs.innerHTML = '';
  g.table.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = 'pair';
    const a = cardEl(p.attack);
    a.classList.add('onTable');
    const d = p.defense ? cardEl(p.defense) : blankEl();
    div.append(a, d);
    pairs.appendChild(div);
  });

  const hand = $('#hand');
  hand.innerHTML = '';
  const H = g.yourHand || [];
  $('#handCount').textContent = H.length;
  H.forEach(c => {
    const el = cardEl(c);
    const sel = selected.find(x => x.rank===c.rank && x.suit===c.suit);
    if (sel) el.classList.add('selected');
    el.onclick = () => toggleSelect(c);
    hand.appendChild(el);
  });
}

function toggleSelect(c) {
  const i = selected.findIndex(x => x.rank===c.rank && x.suit===c.suit);
  if (i>-1) selected.splice(i,1);
  else selected.push(c);
  renderAll();
}

function cardEl(c) {
  const d = document.createElement('div');
  d.className = 'card';
  d.dataset.suit = c.suit;
  d.innerHTML = `<div class="r">${c.rank}</div><div class="s">${c.suit}</div>`;
  return d;
}
function blankEl() {
  const d = document.createElement('div');
  d.className = 'card blank';
  d.innerHTML = '—';
  return d;
}

// ===== Buttons =====
$('#attackBtn').onclick = () => {
  if (!currentRoom) return;
  if (!selected.length) return toast('Atlasiet uzbrukuma kārtis');
  if (!askConfirm('Sākt uzbrukumu ar atlasītajām kārtīm?')) return;
  socket.emit('attack', { roomCode: currentRoom, cards: selected }, resp=>{
    if (!resp?.ok) toast('Nav tavs uzbrukums vai neatļautas kārtis');
    selected = [];
  });
};

$('#addBtn').onclick = () => {
  if (!currentRoom) return;
  if (!selected.length) return toast('Atlasiet kārtis piemestšanai');
  if (!askConfirm('Piemest atlasītās kārtis?')) return;
  socket.emit('attacker:add', { roomCode: currentRoom, cards: selected }, resp=>{
    if (!resp?.ok) toast('Nevar piemest šīs kārtis');
    selected = [];
  });
};

$('#defendBtn').onclick = () => {
  if (!currentRoom) return;
  if (selected.length !== 1) return toast('Aizsardzībai izvēlieties 1 kārti');
  if (!askConfirm('Nosist ar atlasīto kārti?')) return;

  const g = state.game; if (!g) return;
  const pairIndex = g.table.findIndex(p => !p.defense);
  if (pairIndex === -1) return toast('Nav ko sist');
  socket.emit('defend', { roomCode: currentRoom, pairIndex, card: selected[0] }, resp=>{
    if (!resp?.ok) toast('Ar šo kārti nevar nosist');
    selected = [];
  });
};

$('#takeBtn').onclick = () => {
  if (!currentRoom) return;
  if (!askConfirm('Paņemt visas galda kārtis?')) return;
  socket.emit('take', { roomCode: currentRoom }, resp=>{
    if (!resp?.ok) toast('Paņemšana nav pieejama');
  });
};

$('#endBtn').onclick = () => {
  if (!currentRoom) return;
  if (!askConfirm('Beigt gājienu?')) return;
  socket.emit('endTurn', { roomCode: currentRoom }, resp=>{
    if (!resp?.ok) toast('Nevar beigt (ir neaizsistas kārtis?)');
  });
};
