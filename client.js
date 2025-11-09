// client.js
// front-end for Duraks Online — Bugats Edition

// ================== IMPORTANT ==================
// Ieliec šeit sava Node/Socket.IO servera HTTPS adresi (Render u.c.)
const SERVER_URL = 'https://bugats-duraks-server.onrender.com'; // <-- N O M A I N I !
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
