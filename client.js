// ====== Savienojums ======
const socket = io(); // tas pats hostings

// ====== UI elementi ======
const elNick = document.getElementById('nick');
const elRoom = document.getElementById('room');
const elBtnCreate = document.getElementById('btnCreate');
const elBtnJoin = document.getElementById('btnJoin');
const elRoomLabel = document.getElementById('roomLabel');
const elTurnLabel = document.getElementById('turnLabel');
const elSeats = document.getElementById('seats');
const elLog = document.getElementById('log');
const elBtnLeave = document.getElementById('btnLeave');

function log(x) {
  elLog.textContent += x + '\n';
  elLog.scrollTop = elLog.scrollHeight;
}

// ====== Lokālais stāvoklis ======
let roomId = null;
let playerId = null;
let mySeatId = null;
let joinPending = false;
let lastSeats = [];

// ====== UI ģenerēšana ======
/**
 * Novieto 6 sēdvietas pa apli (stabilas koordinātas)
 * secība: 0 augšā, tad pulksteņrād. virzienā.
 */
const circlePos = (() => {
  const cx = 50, cy = 50, R = 36; // %
  const ang = [270, 330, 30, 90, 150, 210]; // grādi
  return ang.map(a => {
    const rad = a * Math.PI / 180;
    return { left: cx + R * Math.cos(rad), top: cy + R * Math.sin(rad) };
  });
})();

function renderSeats(seats) {
  elSeats.innerHTML = '';
  seats.forEach((s, i) => {
    const pos = circlePos[i];
    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.style.left = pos.left + '%';
    seat.style.top = pos.top + '%';

    if (s.occupied) seat.classList.add('taken');
    if (mySeatId === s.id) seat.classList.add('you');

    const place = document.createElement('div');
    place.className = 'place';
    place.textContent = `Vieta ${i + 1}`;

    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = s.occupied ? (mySeatId === s.id ? 'Tu' : (s.nick || 'Spēlētājs')) : 'Brīvs';

    const cnt = document.createElement('div');
    cnt.className = 'count';
    cnt.textContent = s.occupied ? '(rokā: ?)' : '';

    const btn = document.createElement('button');
    btn.className = 'join';
    btn.textContent = 'Pievienoties';
    btn.onclick = () => joinSeat(s.id);

    seat.append(place, who, cnt);
    // rādām "Pievienoties" tikai, ja nav aizņemts un es vēl nesēžu
    if (!s.occupied && mySeatId === null) seat.appendChild(btn);
    elSeats.appendChild(seat);
  });
}

/** UX debouncer + server-ACK */
function joinSeat(seatId) {
  if (joinPending || mySeatId !== null || !roomId) return;
  joinPending = true;

  socket.emit('seat:join', { roomId, seatId }, (res) => {
    joinPending = false;
    if (res.ok) {
      mySeatId = res.seatId;
      log(`🪑 Iekārtojies vietā ${res.seatId + 1}.`);
      renderSeats(lastSeats);
    } else {
      if (res.err === 'taken') alert('Sēdvieta jau aizņemta.');
      else if (res.err === 'already-seated') {
        mySeatId = res.seatId; // idempotence
        renderSeats(lastSeats);
      } else if (res.err === 'too-fast') {
        alert('Mēģini pēc mirkļa vēlreiz.');
      } else {
        alert('Neizdevās pievienoties vietai.');
      }
    }
  });
}

// ====== Pogas ======
elBtnCreate.onclick = () => {
  const nick = (elNick.value || 'BUGATS').trim();
  socket.emit('room:create', { nick }, (res) => {
    if (!res.ok) return alert('Neizdevās izveidot istabu.');
    roomId = res.roomId;
    playerId = res.playerId;
    mySeatId = null;
    elRoomLabel.textContent = roomId;
    lastSeats = res.seats;
    log(`🧪 Izveidota istaba ${roomId}`);
    renderSeats(lastSeats);
  });
};

elBtnJoin.onclick = () => {
  const nick = (elNick.value || 'BUGATS').trim();
  const code = (elRoom.value || '').trim().toUpperCase();
  if (!code) return alert('Ievadi istabas kodu.');

  socket.emit('room:join', { roomId: code, nick }, (res) => {
    if (!res.ok) return alert('Istaba nav atrasta.');
    roomId = code;
    playerId = res.playerId;
    mySeatId = null;
    elRoomLabel.textContent = roomId;
    lastSeats = res.seats;
    log(`➡️ Pievienojies ${roomId}`);
    renderSeats(lastSeats);
  });
};

// (demo) atstāt sēdvietu — UI pusē tikai vizuāli
elBtnLeave.onclick = () => {
  if (mySeatId === null) return;
  log('🚪 (demo) Atstāji sēdvietu (serveris saglabāēs, kad veikli pēc tam pārkāpsi citur vai atvienosies).');
  mySeatId = null;
  renderSeats(lastSeats);
};

// ====== Socket klausītāji ======
socket.on('connect', () => log('✅ Savienots ar serveri.'));
socket.on('disconnect', () => {
  log('⛔ Atvienots no servera.');
  roomId = null;
  playerId = null;
  mySeatId = null;
  renderSeats([]);
  elRoomLabel.textContent = '—';
});

socket.on('seat:update', ({ seats }) => {
  lastSeats = seats;
  renderSeats(seats);
});
