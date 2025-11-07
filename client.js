/* Duraks Online — klients (v1.2.6) */
(() => {
  // DOM atlasītāji ar drošības gardiem
  const $ = (id) => document.getElementById(id);
  const el = {
    log: $("log"),
    nick: $("nick"),
    deckSize: $("deckSize"),
    btnCreate: $("btnCreate"),
    roomInput: $("room"),
    btnJoin: $("btnJoin"),
    soloBot: $("soloBot"),
    chatMsg: $("chatMsg"),
    chatSend: $("chatSend"),

    roomLabel: $("roomLabel"),
    trumpLabel: $("trumpLabel"),
    stockCount: $("stockCount"),
    phase: $("phase"),
    turnLabel: $("turnLabel"),
    yourTurnBtn: $("btnYourTurn"),

    stack: $("stack"),
    oppHand: $("oppHand"),
    meHand: $("meHand"),
    oppName: $("oppName"),
    oppCount: $("oppCount"),
    meCount: $("meCount"),
    hint: $("hint"),

    btnAttack: $("btnAttack"),
    btnEnd: $("btnEnd"),
    btnTake: $("btnTake"),
    btnPass: $("btnPass"),
    timerBar: $("timerBar"),
    version: $("version"),
  };

  let selfId = null;
  let state = null;
  let selected = new Set();           // izvēlēto kāršu indeksu set (manā rokā)
  let selectedPairIdx = null;         // aizstāvēšanās: izvēlētais pāris uz galda

  // util
  function log(msg){ if(!el.log) return; const p=document.createElement("div"); p.textContent = msg; el.log.appendChild(p); el.log.scrollTop = el.log.scrollHeight; }
  function clear(node){ if(node) node.innerHTML=""; }
  function suitToChar(s){ return s==="H" ? "♥" : s==="D" ? "♦" : s==="C" ? "♣" : s==="S" ? "♠" : s; }
  function rankToLabel(r){ return {11:"J",12:"Q",13:"K",14:"A"}[r] || String(r); }
  function cardNode(card, opts={}){
    const d=document.createElement("div");
    d.className = "card"+(opts.back?" back":"")+(opts.defend?" defend":"");
    if(!opts.back){
      const rank = document.createElement("div");
      const suit = document.createElement("div");
      rank.className = "rank"+((card.suit==="H"||card.suit==="D")?" red":"");
      suit.className = "suit"+((card.suit==="H"||card.suit==="D")?" red":"");
      rank.textContent = rankToLabel(card.rank);
      suit.textContent = suitToChar(card.suit);
      d.appendChild(rank); d.appendChild(suit);
    }
    return d;
  }

  // izvēles pārvalde
  function toggleSelect(idx){
    if(selected.has(idx)) selected.delete(idx); else selected.add(idx);
    renderHand(state ? getMyHand(state) : []);
  }

  function pickPair(pairIdx){
    selectedPairIdx = (selectedPairIdx===pairIdx? null : pairIdx);
    renderStack(state?.stack || []);
  }

  // state helpers
  function getMyHand(st){
    if(!st) return [];
    if(st.hands && selfId && st.hands[selfId]) return st.hands[selfId];
    if(st.meId && st.players && st.players[st.meId]) return st.players[st.meId].hand || [];
    if(st.me && st.me.hand) return st.me.hand;
    return [];
  }

  function myTurn(st){
    if(!st) return false;
    return st.turnId === selfId;
  }

  // render
  function renderHUD(st){
    if(!st) return;
    el.roomLabel.textContent = st.room || "—";
    el.trumpLabel.textContent = st.trump ? suitToChar(st.trump) : "—";
    el.stockCount.textContent = (st.stockCount ?? "—");
    el.phase.textContent = st.phase || "—";
    el.turnLabel.textContent = "Gājiens: " + (myTurn(st) ? "Tu" : "Pretinieks");
    el.yourTurnBtn.disabled = !myTurn(st);
  }

  function renderHand(cards){
    clear(el.meHand);
    el.meCount.textContent = cards.length;
    cards.forEach((c, i) => {
      const d = cardNode(c);
      if(selected.has(i)) d.classList.add("selected");
      d.addEventListener("click", () => toggleSelect(i));
      el.meHand.appendChild(d);
    });
  }

  function renderOpp(count){
    clear(el.oppHand);
    el.oppCount.textContent = count;
    for(let i=0;i<count;i++){
      const d = cardNode(null, {back:true});
      el.oppHand.appendChild(d);
    }
  }

  function renderStack(pairs){
    clear(el.stack);
    pairs.forEach((pair, idx) => {
      const slot = document.createElement("div");
      slot.className = "pair";
      // uzbruktā
      const atk = cardNode(pair.attack);
      atk.title = "Uzbrukuma kārts";
      slot.appendChild(atk);
      // aizstāvēšanās
      if(pair.defend){
        const def = cardNode(pair.defend, {defend:true});
        def.title = "Aizsardzības kārts";
        slot.appendChild(def);
      } else {
        // ļauj aizstāvim atzīmēt pāri, kuru grib sist
        if(state && state.phase==="defend" && state.defenderId===selfId){
          slot.style.outline = (selectedPairIdx===idx) ? "2px solid var(--accent)" : "1px dashed #35527e";
          slot.style.borderRadius = "12px";
          slot.addEventListener("click", ()=> pickPair(idx));
        }
      }
      el.stack.appendChild(slot);
    });
  }

  function renderAll(st){
    renderHUD(st);
    renderHand(getMyHand(st));
    const oppCount = (st.opponent && st.opponent.count) || (st.counts && st.counts.opponent) || st.oppCount || 0;
    renderOpp(oppCount);
    renderStack(st.stack || []);
    el.hint.textContent = (st.phase==="defend")
      ? "Aizstāvi pārus: izvēlies pāri metienā un vienu savu kārti, kas to sit. Vai 'Paņemt'."
      : "Uzbrukums: izvēlies vienu vai vairākas savas kārtis (pēc esošo rangu) un spied 'Uzbrukt'.";
  }

  // sūtītāji
  function emitChat(){
    const msg = el.chatMsg.value.trim();
    if(!msg) return;
    socket.emit("chat", msg);
    el.chatMsg.value = "";
  }

  function createRoom(){
    const nick = el.nick.value.trim() || "Viesis";
    const size = parseInt(el.deckSize.value, 10) || 36;
    const solo = !!el.soloBot.checked;
    socket.emit("createRoom", { nick, deckSize:size, solo });
  }

  function joinRoom(){
    const nick = el.nick.value.trim() || "Viesis";
    const code = el.roomInput.value.trim().toUpperCase();
    if(!code) return log("Ievadi istabas kodu.");
    socket.emit("joinRoom", { nick, room:code });
  }

  function sendAttack(){
    if(!state) return;
    if(state.phase!=="attack" || state.turnId!==selfId) return log("Nav uzbrukuma gājiens.");
    const hand = getMyHand(state);
    if(selected.size===0) return log("Izvēlies vismaz vienu kārti.");
    const cards = [...selected].map(i=>hand[i]);
    socket.emit("attack", { cards });
    selected.clear(); selectedPairIdx=null;
  }

  function sendDefend(){
    if(!state) return;
    if(state.phase!=="defend" || state.defenderId!==selfId) return log("Nav aizsardzības gājiens.");
    if(selectedPairIdx==null) return log("Izvēlies pāri metienā.");
    const hand = getMyHand(state);
    if(selected.size!==1) return log("Izvēlies vienu savu kārti aizsardzībai.");
    const card = hand[[...selected][0]];
    socket.emit("defend", { pairIndex:selectedPairIdx, card });
    selected.clear(); selectedPairIdx=null;
  }

  function endTrick(){
    socket.emit("endTrick"); // aizstāvis aizsargājies, uzbrucējs beidz metienu
  }

  function takeCards(){
    socket.emit("take");
    selected.clear(); selectedPairIdx=null;
  }

  function passAdd(){
    socket.emit("passAdd"); // uzbrucējs nepapildina, vai skatītājs nepieliek (neaizmest)
  }

  // UI eventi
  el.chatSend?.addEventListener("click", emitChat);
  el.btnCreate?.addEventListener("click", createRoom);
  el.btnJoin?.addEventListener("click", joinRoom);

  el.btnAttack?.addEventListener("click", () => {
    if(state?.phase==="defend") return sendDefend();
    return sendAttack();
  });
  el.btnEnd?.addEventListener("click", endTrick);
  el.btnTake?.addEventListener("click", takeCards);
  el.btnPass?.addEventListener("click", passAdd);

  // socket notikumi
  socket.on("connect", () => { selfId = socket.id; log("Savienots ar serveri."); });
  socket.on("disconnect", () => log("Atvienots no servera."));
  socket.on("errorMsg", (m)=> log("Kļūda: "+m));
  socket.on("info", (m)=> log(m));
  socket.on("room", (code)=> { el.roomInput.value = code; el.roomLabel.textContent = code; });
  socket.on("chat", (m)=> log("💬 "+m));

  socket.on("state", (st) => {
    state = st;
    if(!selfId && st.meId) selfId = st.meId;
    renderAll(st);
  });

})();
