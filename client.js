// Duraks Online — Bugats Edition (v1.2.9, klients)
// Pieslēdzamies serverim (Render u.c.). Ja tev serveris ir citā domēnā, aizpildi URL:
const SERVER_URL = "https://duraks-online.onrender.com"; // ← ja hostē vienā vietā ar serveri, vari nomainīt uz "".

const socket = io(SERVER_URL, {
  path: "/socket.io",
  transports: ["websocket", "polling"]
});

const $ = sel => document.querySelector(sel);
const logEl = $('#log');
const handEl = $('#meHand');
const pileEl = $('#pile');
let currentRoom = null;
let myId = null;
let myHandSel = new Set();
let lastPublic = null;

function addLog(t){
  const div = document.createElement('div');
  div.textContent = t;
  logEl.prepend(div);
  while (logEl.children.length>200) logEl.removeChild(logEl.lastChild);
}

$('#btnCreate').onclick = ()=>{
  socket.emit('createRoom',{
    nick: $('#nick').value || 'Spēlētājs',
    deckSize: +$('#deckSize').value,
    solo: $('#solo').checked
  },res=>{
    if (!res?.ok) return alert(res?.error||'Neizdevās');
    currentRoom = res.roomId;
    $('#room').value = res.roomId;
    $('#roomLabel').textContent = res.roomId;
    addLog(`Istaba izveidota: ${res.roomId}`);
  });
};

$('#btnJoin').onclick = ()=>{
  const roomId = $('#room').value.trim().toUpperCase();
  if (!roomId) return;
  socket.emit('joinRoom',{ nick: $('#nick').value || 'Spēlētājs', roomId }, res=>{
    if (!res?.ok) return alert(res?.error||'Neizdevās');
    currentRoom = roomId;
    $('#roomLabel').textContent = roomId;
    addLog(`Pievienojies: ${roomId}`);
  });
};

$('#btnAttack').onclick = ()=>{
  if (!currentRoom) return;
  const cards = [...myHandSel].map(idx=>window._meHand[idx]);
  if (!cards.length) return;
  socket.emit('attack',{ roomId: currentRoom, cards }, res=>{
    if (!res?.ok) alert(res?.error||'Neizdevās');
    myHandSel.clear(); renderMeHand(window._meHand);
  });
};

$('#btnEnd').onclick = ()=>{
  if (!currentRoom) return;
  socket.emit('endTurn',{ roomId: currentRoom }, res=>{
    if (!res?.ok) alert(res?.error||'Nevar beigt gājienu: '+(res?.error||'')); 
  });
};

$('#btnTake').onclick = ()=>{
  if (!currentRoom) return;
  socket.emit('take',{ roomId: currentRoom }, res=>{
    if (!res?.ok) alert(res?.error||'Neizdevās');
  });
};

$('#btnPass').onclick = ()=>{
  // šeit nekā nav — piemest notiek automātiski caur izvēli un servera validāciju.
  // Ja gribi var pievienot atsevišķu client-side "throwIn" pogu ar izvēlēto kārti.
  if (!currentRoom) return;
  alert('Piemest metiena laikā var uzbrucēji (nevis aizstāvis). Vienkārši uzlasi kārtis un spied “Uzbrukt”.');
};

function renderSeats(state){
  // Nulle visas
  for (let i=0;i<6;i++){
    const s = $('#seat'+i);
    s.querySelector('.seatNick').textContent = '—';
    s.querySelector('.seatCount').textContent = '(0)';
    s.classList.remove('you');
  }
  state.seats.forEach((p,i)=>{
    const s = $('#seat'+i);
    if (!s) return;
    s.querySelector('.seatNick').textContent = p.nick+(p.isBot?' (BOT)':'');
    s.querySelector('.seatCount').textContent = `(${p.count})`;
    if (p.id===state.me?.id) s.classList.add('you');
  });
}

function suitColor(s){ return (s==='♥'||s==='♦') ? 'red' : ''; }

function renderPile(state){
  pileEl.innerHTML = '';
  state.table.forEach(pair=>{
    const wrap = document.createElement('div'); wrap.className='pair';
    const a = document.createElement('div'); a.className = 'card '+suitColor(pair.attack.s);
    a.innerHTML = `<div class="r">${pair.attack.r}</div><div class="s">${pair.attack.s}</div>`;
    wrap.appendChild(a);
    if (pair.defend){
      const d = document.createElement('div'); d.className='card def '+suitColor(pair.defend.s);
      d.innerHTML = `<div class="r">${pair.defend.r}</div><div class="s">${pair.defend.s}</div>`;
      wrap.appendChild(d);
    }
    pileEl.appendChild(wrap);
  });
}

function renderMeHand(hand){
  window._meHand = hand || [];
  $('#meCount').textContent = (hand||[]).length;
  handEl.innerHTML = '';
  (hand||[]).forEach((c,idx)=>{
    const el = document.createElement('div');
    el.className = 'card '+suitColor(c.s);
    if (myHandSel.has(idx)) el.classList.add('sel');
    el.innerHTML = `<div class="r">${c.r}</div><div class="s">${c.s}</div>`;
    el.onclick = ()=>{
      if (myHandSel.has(idx)) myHandSel.delete(idx); else myHandSel.add(idx);
      renderMeHand(window._meHand);
    };
    handEl.appendChild(el);
  });
}

socket.on('connect', ()=>{ myId = socket.id; });

socket.on('state', (state)=>{
  lastPublic = state;
  $('#trumpLabel').textContent = state.trump || '—';
  $('#stockCount').textContent = state.stock ?? '—';
  $('#phase').textContent = state.phase || '—';
  $('#turnLabel').textContent = state.attacker===state.me?.id ? 'Tu' :
                                (state.defender===state.me?.id ? 'Tu aizstāvi' : 'Cits');

  renderSeats(state);
  renderPile(state);
  (state.log||[]).slice(-6).reverse().forEach((l,i)=>{
    if (i===0) addLog(l);
  });
  renderMeHand(state.me?.hand||[]);
});

socket.on('state_public', (p)=>{ /* ja vajag skatītājiem */ });

// sākotnējais stāvoklis atjaunošanai
setInterval(()=>{
  if (currentRoom){
    socket.emit('state',{ roomId: currentRoom }, ()=>{});
  }
}, 5000);
