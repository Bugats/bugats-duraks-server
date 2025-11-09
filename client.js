// client.js — Duraks Online (Bugats Edition)
// Pilns klients ar UX labojumu: pēc "Izveidot istabu" automātiski atslēdz "Pievienoties"

(() => {
  const socket = io("https://duraks-online.onrender.com", {
    path: "/socket.io",
    transports: ["websocket"]
  });

  // ===== Helpers =====
  const $ = (id) => document.getElementById(id);
  const text = (el, v) => el && (el.textContent = v);
  const byClass = (sel) => Array.from(document.querySelectorAll(sel));

  // UI references
  const roomLabel = $('roomLabel') || { textContent: '' };

  // State
  let STATE = null;
  let MY = { hand: [] };
  let ROOM_CODE = '';

  // ===== Draw =====
  function draw() {
    if (!STATE) return;

    // Header HUD
    const { code, trump, stockCount, phase, turn, players, me } = STATE;
    ROOM_CODE = code;
    text($('roomLabel'), code || '—');
    text($('trumpLabel'), trump ? trump : '—');
    text($('stockCount'), typeof stockCount==='number' ? stockCount : '—');
    text($('phase'), phase || '—');

    const myId = socket.id;
    const mePlayer = players.find(p=>p.id===myId);
    text($('turnLabel'), turn===myId ? 'Tavs gājiens' : 'Pretinieks');

    // Roka
    const meHand = (me && me.hand) ? me.hand : [];
    MY = { hand: meHand };
    const handEl = $('meHand');
    if (handEl) {
      handEl.innerHTML = '';
      meHand.forEach(c=>{
        const card = elCard(c, true);
        card.onclick = () => onCardClick(c);
        handEl.appendChild(card);
      });
    }

    // Pretinieks (karte ar muguru)
    const oppEl = $('oppHand');
    if (oppEl) {
      oppEl.innerHTML = '';
      const opp = players.find(p=>p.id!==myId);
      const n = opp ? opp.count : 0;
      for (let i=0;i<n;i++) {
        const back = document.createElement('div');
        back.className = 'card back';
        oppEl.appendChild(back);
      }
    }

    // Galds
    const stack = $('stack');
    if (stack) {
      stack.innerHTML = '';
      (STATE.field || []).forEach(pair=>{
        const col = document.createElement('div');
        col.className = 'pair';
        const a = pair.attack?.[0];
        const d = pair.defend?.[0];
        const aEl = a ? elCard(a,false) : blank();
        const dEl = d ? elCard(d,false) : blank(true);
        col.append(aEl, dEl);
        stack.appendChild(col);
      });
    }

    // Žurnāls
    const logEl = $('log');
    if (logEl) {
      logEl.innerHTML = (STATE.log||[]).map(l=>`<div>${escapeHtml(l)}</div>`).join('');
    }
  }

  function elCard(c, mine=false) {
    const d = document.createElement('div');
    d.className = 'card';
    const r = document.createElement('div');
    r.className = 'r'; r.textContent = c.r;
    const s = document.createElement('div');
    s.className = 's'; s.textContent = c.s;

    // krāsas mastiem
    if (c.s === '♥' || c.s === '♦') d.classList.add('red');

    d.appendChild(r); d.appendChild(s);
    return d;
  }
  function blank(def=false) {
    const d = document.createElement('div');
    d.className = 'card blank';
    d.textContent = def ? '×' : '';
    return d;
  }
  function escapeHtml(s){ return (s||'').replace(/[&<>"]/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])); }

  // ===== Interaktīvie notikumi =====
  let selected = [];
  function onCardClick(c) {
    // ja uzbrukuma fāze un tavs gājiens — var izvēlēties vairākas vienāda ranga
    if (STATE.phase==='attack' && STATE.turn===socket.id) {
      const already = selected.find(x=>x.r===c.r && x.s===c.s);
      if (already) {
        selected = selected.filter(x=>!(x.r===c.r && x.s===c.s));
      } else {
        // atļaujam vairākas vienāda ranga
        if (selected.length>0 && selected.some(x=>x.r!==c.r)) {
          selected = [c];
        } else {
          selected.push(c);
        }
      }
      highlightSelection();
    }
    // ja aizsardzība — izvēlamies 1 kārti
    else if (STATE.phase==='defend' && STATE.turn!==socket.id) {
      selected = [c];
      highlightSelection();
    }
  }
  function highlightSelection() {
    const handEl = $('meHand');
    if (!handEl) return;
    const all = Array.from(handEl.children);
    all.forEach(div=>{
      div.classList.remove('sel');
    });
    selected.forEach(c=>{
      const i = MY.hand.findIndex(h=>h.r===c.r && h.s===c.s);
      if (i>-1 && all[i]) all[i].classList.add('sel');
    });
  }

  $('btnAttack') && ($('btnAttack').onclick = ()=>{
    if (STATE.turn!==socket.id || STATE.phase!=='attack') return;
    if (!selected.length) return;
    socket.emit('attack', { code: ROOM_CODE, cards: selected }, (res)=>{
      if (!res?.ok) alert(res.err||'Neizdevās.');
      selected = [];
      highlightSelection();
    });
  });

  $('btnDefend') && ($('btnDefend').onclick = ()=>{
    if (STATE.turn===socket.id || STATE.phase!=='defend') return;
    if (selected.length!==1) return;
    socket.emit('defend', { code: ROOM_CODE, card: selected[0] }, (res)=>{
      if (!res?.ok) alert(res.err||'Neizdevās.');
      selected = [];
      highlightSelection();
    });
  });

  $('btnEnd') && ($('btnEnd').onclick = ()=>{
    // Beigt metienu (tikai aizstāvis, kad viss nosists)
    socket.emit('end-turn', { code: ROOM_CODE }, (res)=>{
      if (!res?.ok) alert(res.err||'Nevar beigt metienu.');
    });
  });

  $('btnTake') && ($('btnTake').onclick = ()=>{
    socket.emit('take', { code: ROOM_CODE }, (res)=>{
      if (!res?.ok) alert(res.err||'Nevar paņemt.');
    });
  });

  $('chatSend') && ($('chatSend').onclick = ()=>{
    const v = ($('chatMsg').value||'').trim();
    if (!v) return;
    socket.emit('chat', { code: ROOM_CODE, text: v });
    $('chatMsg').value = '';
  });

  // ===== Izveidot/Pievienoties =====

  // UX LABOJUMS: pēc izveides atslēdz “Pievienoties”, ja Solo režīms
  $('btnCreate') && ($('btnCreate').onclick = () => {
    socket.emit('create-room', {
      nick: $('nick').value || 'Spēlētājs',
      deckSize: +$('deckSize').value,
      soloBot: $('solo').checked
    }, resp => {
      if (!resp?.ok) return alert(resp?.err || 'Neizdevās.');

      $('room').value = resp.code;
      text(roomLabel, resp.code);

      if ($('solo').checked) {
        $('room').disabled = true;
        $('btnJoin').disabled = true;
      }
    });
  });

  $('btnJoin') && ($('btnJoin').onclick = ()=>{
    const code = ($('room').value||'').trim().toUpperCase();
    if (!code) return;
    socket.emit('join-room', {code, nick: $('nick').value||'Spēlētājs'}, (res)=>{
      if (!res?.ok) alert(res.err||'Neizdevās pievienoties.');
    });
  });

  // ===== Soketa notikumi =====
  socket.on('hello', ({id})=>{
    // console.log('hello', id);
  });

  socket.on('state', (st)=>{
    STATE = st;
    draw();
  });

})();
