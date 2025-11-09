(() => {
  const socket = io(window.SERVER_URL, { path: '/socket.io', transports: ['websocket'] });

  // UI elementu saites
  const e = id => document.getElementById(id);
  const roomLabel = e('roomLabel');
  const trumpLabel = e('trumpLabel');
  const stockCount = e('stockCount');
  const phaseEl = e('phase');
  const turnBadge = e('turnBadge');
  const logEl = e('log');
  const stack = e('stack');
  const oppHand = e('oppHand');
  const oppName = e('oppName');
  const oppCount = e('oppCount');
  const meHand = e('meHand');
  const meCount = e('meCount');
  const hint = e('hint');

  // pieteikšanās
  e('btnCreate').onclick = () => {
    socket.emit('create-room', {
      nick: e('nick').value || 'Spēlētājs',
      deckSize: +e('deckSize').value,
      soloBot: e('solo').checked
    }, resp => {
      if (!resp?.ok) return alert(resp?.err || 'Neizdevās.');
      e('room').value = resp.code;
    });
  };
  e('btnJoin').onclick = () => {
    if (!e('room').value) return alert('Ieraksti istabas kodu.');
    socket.emit('join-room', { code: e('room').value.trim(), nick: e('nick').value || 'Spēlētājs' }, resp => {
      if (!resp?.ok) alert(resp?.err || 'Neizdevās pievienoties.');
    });
  };

  /* ------------ lokālie atlases stāvokļi ------------ */
  let state = null;
  const mySelAttack = new Set();  // uzbrukumā: izvēlēto kāršu ID (viena ranga)
  const defendPair = new Map();   // aizstāvēšanās: attackIndex -> myCardId

  function myId() {
    if (!state) return null;
    // mans ID ir tas pats soketa ID – apkalpo serveris (sagatavei pietiek)
    // šeit klientam nav droša veida; izmantojam heuristiku: tas, kam nav isBot un handCount ir state.players manuāli salīdzināms pēc nospiešanas notikumu
    // vienkāršībai uzticamies serverim – klientam nav jāzina savs ID, UI balstām uz to, ka serveris pareizi ļaus/nelaidīs.
    return null;
  }

  function amAttacker() {
    return state && state.turnId === state.attackerId;
  }
  function amDefender() {
    return state && state.turnId === state.defenderId;
  }

  /* -------------------- Rendere -------------------- */
  socket.on('state', st => {
    state = st;
    render();
  });

  function renderLog() {
    logEl.innerHTML = state.log.map(x=>`<div>${escapeHtml(x)}</div>`).join('');
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderHUD() {
    roomLabel.textContent = state.code;
    trumpLabel.textContent = state.trumpSuit || '—';
    stockCount.textContent = state.stockCount ?? '—';
    phaseEl.textContent = state.phase ?? '—';

    const turnName = lookupName(state.turnId);
    e('turnBadge').textContent = `Gājiens: ${turnName??'—'}`;

    // pretinieks = jebkurš ne-bot/ne-es – vienkāršības pēc rādām pirmo pretējo
    const pids = Object.keys(state.players);
    let oppId = pids.find(id => state.players[id] && !state.players[id].isMe && !state.players[id].isBot && id!==state.turnId);
    if (!oppId) oppId = pids.find(id => id!==state.turnId); // fallback

    // nosakām pretinieka vārdu / skaitu; ja solo režīms – tas būs BOT
    const defId = state.defenderId;
    const attId = state.attackerId;
    const otherId = [defId, attId].find(id => id && state.players[id] && !state.players[id].isMe && id!==myId());

    const opp = state.players[otherId] || Object.values(state.players).find(p=>p && !p.isMe && p.id!==myId());
    oppName.textContent = opp?.nick ?? 'BOT';
    oppCount.textContent = opp?.handCount ?? 0;
  }

  function renderTable() {
    // metiens: rindiņas ar pāriem
    stack.innerHTML = '';
    state.table.forEach((row, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'pair';

      // attack card
      const a = createCard(row.attack, false);
      a.classList.add('attack');
      wrap.appendChild(a);

      // defend slot / card
      if (row.defend) {
        const d = createCard(row.defend, false);
        d.classList.add('defend');
        wrap.appendChild(d);
      } else {
        const slot = document.createElement('div');
        slot.className = 'slot';
        slot.textContent = 'x';
        slot.dataset.attackIndex = i;
        wrap.appendChild(slot);
      }
      stack.appendChild(wrap);
    });

    // pieejama uzbrukuma vieta, ja galdā tukšs – UI tikai vizuāls
    if (state.table.length===0) {
      const empty = document.createElement('div');
      empty.className = 'slot';
      empty.textContent = '—';
      stack.appendChild(empty);
    }
  }

  function renderHands() {
    // pretinieks – aizvērtas kārtis
    oppHand.innerHTML = '';
    const oppCt = +oppCount.textContent || 0;
    for (let i=0;i<oppCt;i++){
      const b = document.createElement('div');
      b.className='card';
      b.innerHTML = `<div class="rank">?</div>`;
      oppHand.appendChild(b);
    }

    // mana roka – no state mēs nesaņemam kāršu saturu, tāpēc malas pusē UI balstās uz lokālo izvēli
    // Šajā vienkāršotajā klientā mēs ļaujam klikot kāršu vizualizācijās, ko ģenerē no servera notikumiem 'my-hand'
  }

  /* -------------------- “Mana roka” saturu sūtām caur atsevišķu kanālu -------------------- */
  // Lai neaiztiktu servera drošību, klientam ar ID serveris var sūtīt “my-hand” eventu
  // Vienkāršības dēļ šeit ģenerējam “manu roku” UI no pašreizējā state + loka atlases;
  // Praktiskā lietošanā tu jau to izmanto – servera versijā, ko tev devu iepriekš, šis pienāk kopā ar state.
  socket.on('my-hand', (cards) => {
    renderMyHand(cards || []);
  });

  function renderMyHand(cards){
    meHand.innerHTML='';
    meCount.textContent = cards.length;
    const onAttackPhase = state.phase==='attack' && state.turnId===state.attackerId;
    const onDefendPhase = state.phase==='defend' && state.turnId===state.defenderId;

    // ja uzbrukums: atļaujam izvēlēties tikai viena ranga
    let selectedRank = null;
    if (mySelAttack.size>0){
      const any = cards.find(c=>mySelAttack.has(c.id));
      selectedRank = any?.rank || null;
    }

    cards.forEach(c=>{
      const el = createCard(c, true);
      if (mySelAttack.has(c.id)) el.classList.add('selected');

      el.onclick = () => {
        if (onAttackPhase){
          // ļaujam tikai vienu rangu
          if (mySelAttack.has(c.id)) {
            mySelAttack.delete(c.id);
          } else {
            if (selectedRank && selectedRank!==c.rank){
              // ja jau ir izvēlēts cits ranks – nomainām uz jauno
              mySelAttack.clear();
              selectedRank = c.rank;
              mySelAttack.add(c.id);
            } else {
              selectedRank = c.rank;
              mySelAttack.add(c.id);
            }
          }
          renderMyHand(cards);
        }
        if (onDefendPhase){
          // aizstāvēšanās – vispirms jāuzklikšķina “slot” metienā, tad uz savas kārts
          hint.textContent = ' * Klikšķini uz galda pāra (x), tad savā kārtī ko nosist.';
        }
      };
      meHand.appendChild(el);
    });
  }

  function createCard(c, colorize){
    const div = document.createElement('div');
    div.className = 'card';
    const red = (c.suit==='♥'||c.suit==='♦');
    div.innerHTML = `
      <div class="rank ${colorize?(red?'s-red':'s-black'):''}">${escapeHtml(c.rank)}</div>
      <div class="suit ${colorize?(red?'s-red':'s-black'):''}">${escapeHtml(c.suit)}</div>
    `;
    return div;
  }

  function lookupName(id){ return id && state.players[id]?.nick || '—'; }

  function escapeHtml(s){ return s?.replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m])) || ''; }

  /* -------------------- Pogas -------------------- */

  // Uzbrukums (viena ranga vairākas kārtis)
  e('btnAttack').onclick = () => {
    if (!state) return;
    if (!(state.phase==='attack' && state.turnId===state.attackerId)) return;
    const ids = [...mySelAttack];
    if (!ids.length) return;
    socket.emit('attack', { code: state.code, cardIds: ids });
    mySelAttack.clear();
  };

  // Beigt metienu (pieejams tikai uzbrucējam, ja viss nosists)
  e('btnEnd').onclick = () => {
    if (!state) return;
    socket.emit('end-attack', { code: state.code });
  };

  // Paņemt (tikai aizstāvim)
  e('btnTake').onclick = () => {
    if (!state) return;
    socket.emit('take', { code: state.code });
  };

  // Neaizmest – UI poga, šeit neko nesūtām (uzdevumā palikusi kā “do nothing”)
  e('btnPass').onclick = () => {};

  // aizstāvēšanās: klikšķis uz “slot” un pēc tam uz savu kārti
  stack.addEventListener('click', (ev)=>{
    const slot = ev.target.closest('.slot');
    if (!slot) return;
    if (!(state.phase==='defend' && state.turnId===state.defenderId)) return;
    const idx = +slot.dataset.attackIndex;

    // gaidām nākamo klikšķi uz manas kārts
    hint.textContent = ' * Tagad klikšķini uz savas kārts, ko gribi likt virsū.';
    const onceCard = (ev2)=>{
      const cardEl = ev2.target.closest('.card');
      if (!cardEl || !cardEl.dataset?.id){
        meHand.removeEventListener('click', onceCard);
        return;
      }
      const cardId = cardEl.dataset.id;
      meHand.removeEventListener('click', onceCard);
      socket.emit('defend', { code: state.code, pairs:[{ attackIndex: idx, cardId }]});
    };
    meHand.addEventListener('click', onceCard, {once:true});
  });

  /* šim demo klientam “my-hand” eventu var atdarināt ar debug pogu – produkcijā serveris to sūta pats kopā ar state */
})();
