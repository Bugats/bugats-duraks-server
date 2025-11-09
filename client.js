const socket = io();

const nickEl = document.getElementById('nick');
const deckSel = document.getElementById('deckSel');
const roomsEl = document.getElementById('rooms');

const btnCreate = document.getElementById('btnCreate');
const btnStart = document.getElementById('btnStart');

const seatBtns = [...document.querySelectorAll('.seatBtn')];
const seatNickEls = [...document.querySelectorAll('.seat .seatNick')];

const roomIdEl = document.getElementById('roomId');
const trumpEl  = document.getElementById('trump');
const phaseEl  = document.getElementById('phase');
const turnEl   = document.getElementById('turn');

const tableEl  = document.getElementById('table');
const handEl   = document.getElementById('hand');

const btnAttack = document.getElementById('btnAttack');
const btnDefend = document.getElementById('btnDefend');
const btnTake   = document.getElementById('btnTake');
const btnEnd    = document.getElementById('btnEnd');

const logEl = document.getElementById('log');
const toastEl = document.getElementById('toast');

let curRoom = null;
let myPid   = null;

let selectedHand = new Set(); // uzbrukumam
let defendPairs  = [];        // [{ti, cardId}]

/* ========== util ========== */
function showToast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(()=> toastEl.classList.remove('show'), 1200);
}

function colorClass(suit){
  return (suit==='♥' || suit==='♦') ? 'red' : '';
}

function cardHtml(c){
  return `<div class="card ${colorClass(c.s)}"><div class="small">${c.r}${c.s}</div>${c.r}</div>`;
}
/* ========== Lobby ========== */

function refreshRooms(){
  socket.emit('room:list', (res)=>{
    if (!res.ok) return;
    roomsEl.innerHTML = '';
    for (const r of res.rooms){
      const el = document.createElement('div');
      el.className = 'roomItem';
      el.innerHTML = `
        <div><strong>${r.id}</strong> — ${r.seats}/6 — ${r.status}</div>
        <button class="join">Pievienoties</button>
      `;
      el.querySelector('.join').onclick = ()=> joinRoom(r.id);
      roomsEl.appendChild(el);
    }
  });
}

btnCreate.onclick = ()=>{
  const deck36 = deckSel.value === '36';
  socket.emit('room:create', {deck36}, (r)=>{
    if (r.ok) joinRoom(r.id);
  });
};

btnStart.onclick = ()=>{
  socket.emit('game:start', (r)=>{
    if (!r.ok) showToast(r.msg || 'Neizdevās sākt.');
  });
};

function joinRoom(id){
  socket.emit('room:join', {roomId:id}, (res)=>{
    if(!res.ok){ showToast('Istaba nav pieejama.'); return; }
    curRoom = res.room;
    roomIdEl.textContent = curRoom.id;
    renderSeats(curRoom);
    pullState(); // lai dabūtu manu roku

    // Auto-sēdināšana pirmajā brīvajā
    const already = (curRoom.seats||[]).some(s=>s && s.pid===myPid);
    if (!already) {
      const free = (curRoom.seats||[]).findIndex(s=>!s);
      if (free !== -1){
        socket.emit('seat:join', { nick: (nickEl.value||'Spēlētājs').trim(), seat: free }, (r)=>{
          if(!r.ok) showToast('Neizdevās sēdēt');
          else { curRoom = r.room; renderSeats(curRoom); pullState(); }
        });
      }
    }
  });
}

seatBtns.forEach(b=>{
  b.onclick = ()=>{
    if (!curRoom) return;
    const seat = +b.dataset.seat;
    socket.emit('seat:join', {nick:(nickEl.value||'Spēlētājs').trim(), seat}, (r)=>{
      if(!r.ok) showToast('Vieta aizņemta');
      else { curRoom = r.room; renderSeats(curRoom); pullState(); }
    });
  };
});

function renderSeats(st){
  (st.seats||[]).forEach((s,i)=>{
    seatNickEls[i].textContent = s? s.nick : '—';
    seatBtns[i].disabled = !!s;
  });
}

/* ========== Spēles stāvoklis ========== */

socket.on('connect', ()=>{
  myPid = socket.id;
  refreshRooms();
  pullState();
});

socket.on('state', (pub)=>{
  // “push” atjauninājums — vajag arī manu roku
  curRoom = pub;
  renderSeats(pub);
  pullState(); // atjauno tekstus + roku + galdu
});

function pullState(){
  socket.emit('hand:get', (r)=>{
    if (!r.ok) return;
    myPid = r.pid;
    curRoom = r.room;
    updateTop(curRoom);
    renderTable(curRoom);
    renderHand(curRoom.myHand || []);
    updateButtons(curRoom);
  });
}

function updateTop(st){
  roomIdEl.textContent = st.id || '—';
  phaseEl.textContent = st.status || '—';
  trumpEl.textContent = st.trump ? `${st.trump.r}${st.trump.s}` : '—';
  turnEl.textContent  = st.attacker ? (st.attacker===myPid?'Tu (uzbrūc)': st.defender===myPid?'Tu (aizstāvi)':'Pretinieks') : '—';
}

function renderTable(st){
  tableEl.innerHTML = '';
  (st.table||[]).forEach((p,i)=>{
    const el = document.createElement('div');
    el.className = 'pair';
    el.innerHTML = `<div class="base">${p.a? cardHtml(p.a):''}</div>${p.d? `<div class="cover">${cardHtml(p.d)}</div>`:''}`;
    el.onclick = ()=>{
      // aizstāvis izvēlas mērķi (ti)
      if (st.defender === myPid && p.a && !p.d){
        // iezīmē logā, nākamais klikšķis uz rokas kartes saliks pāri
        defendPairs = defendPairs.filter(x=>x.ti!==i);
        defendPairs.push({ti:i, cardId:null});
        showToast('Izvēlies nositamo kārti no rokas');
      }
    };
    tableEl.appendChild(el);
  });
}

function renderHand(hand){
  handEl.innerHTML='';
  selectedHand.clear();
  hand.forEach(c=>{
    const d = document.createElement('div');
    d.className = `card ${colorClass(c.s)}`;
    d.innerHTML = `<div class="small">${c.r}${c.s}</div>${c.r}`;
    d.dataset.id = c.id;
    d.onclick = ()=>{
      const st = curRoom;
      if (st.defender === myPid){
        // aizstāvis – ja ir izvēlēts mērķis, mēģinām salikt pāri
        const target = defendPairs.find(x=>x.cardId===null);
        if (target){
          target.cardId = c.id;
          // tūlīt sūtam aizsardzību
          socket.emit('defend', {pairs:defendPairs.filter(x=>x.cardId)}, (r)=>{
            if (!r.ok) showToast(r.msg || 'Neizdevās nosist');
            defendPairs = defendPairs.filter(x=>!x.cardId); // iztīrām ieliktos
            pullState();
          });
          return;
        }
      }
      // citādi – uzbrucēja atlase
      if (selectedHand.has(c.id)) { selectedHand.delete(c.id); d.classList.remove('sel'); }
      else { selectedHand.add(c.id); d.classList.add('sel'); }
    };
    handEl.appendChild(d);
  });
}

function updateButtons(st){
  const iAmAtt = st.attacker === myPid;
  const iAmDef = st.defender === myPid;

  btnAttack.disabled = !iAmAtt;
  btnDefend.disabled = !iAmDef;
  btnTake.disabled   = !iAmDef;
  btnEnd.disabled    = !(iAmAtt || allDefendedLocal(st));
}

function allDefendedLocal(st){
  return (st.table||[]).length && (st.table||[]).every(p => !!p.d);
}

/* ========== Pogas ========== */

btnAttack.onclick = ()=>{
  if (!selectedHand.size) return showToast('Iezīmē kārtis uzbrukumam');
  socket.emit('attack', {cards:[...selectedHand]}, (r)=>{
    if (!r.ok) showToast(r.msg || 'Neizdevās uzbrukt');
    selectedHand.clear();
    pullState();
  });
};

btnDefend.onclick = ()=>{
  if (!defendPairs.length) return showToast('Uzklikšķini uz mērķa kartes uz galda, pēc tam uz rokas kārts');
  const ready = defendPairs.filter(x=>x.cardId);
  if (!ready.length) return showToast('Izvēlies nositamo kārti');
  socket.emit('defend', {pairs:ready}, (r)=>{
    if (!r.ok) showToast(r.msg || 'Neizdevās nosist');
    defendPairs = defendPairs.filter(x=>!x.cardId);
    pullState();
  });
};

btnTake.onclick = ()=>{
  socket.emit('defender:take', (r)=>{ if (!r.ok) showToast('Neizdevās paņemt'); pullState(); });
};

btnEnd.onclick = ()=>{
  socket.emit('turn:end', (r)=>{ if (!r.ok) showToast(r.msg || 'Neizdevās beigt gājienu'); pullState(); });
};

/* ======== sākumā ======== */
refreshRooms();
setInterval(refreshRooms, 4000);
