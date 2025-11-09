/* Duraks Online — klients (v1.2.7) */
(() => {
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
  let selected = new Set();
  let selectedPairIdx = null;

  const log = (m)=>{ if(!el.log) return; const p=document.createElement("div"); p.textContent=m; el.log.appendChild(p); el.log.scrollTop=el.log.scrollHeight; };
  const clear = (n)=>{ if(n) n.innerHTML=""; };

  const suitToChar = (s)=> s==="H"?"♥":s==="D"?"♦":s==="C"?"♣":s==="S"?"♠":s;
  const rankToLabel = (r)=> ({11:"J",12:"Q",13:"K",14:"A"}[r]||String(r));

  function cardNode(card, opts={}){
    const d=document.createElement("div");
    d.className="card"+(opts.back?" back":"")+(opts.defend?" defend":"");
    if(!opts.back){
      const r=document.createElement("div"); r.className="rank"+((card.suit==="H"||card.suit==="D")?" red":"");
      const s=document.createElement("div"); s.className="suit"+((card.suit==="H"||card.suit==="D")?" red":"");
      r.textContent=rankToLabel(card.rank); s.textContent=suitToChar(card.suit);
      d.appendChild(r); d.appendChild(s);
    }
    return d;
  }

  function getMyHand(st){
    if(!st) return [];
    if(st.hands && st.meId && st.hands[st.meId]) return st.hands[st.meId];
    return [];
  }
  const myTurn = (st)=> st && st.turnId===selfId;

  function toggleSelect(idx){
    if(selected.has(idx)) selected.delete(idx); else selected.add(idx);
    renderHand(getMyHand(state));
  }
  function pickPair(pairIdx){
    selectedPairIdx = (selectedPairIdx===pairIdx? null : pairIdx);
    renderStack(state?.stack||[]);
  }

  function renderHUD(st){
    el.roomLabel.textContent = st.room||"—";
    el.trumpLabel.textContent = st.trump ? suitToChar(st.trump) : "—";
    el.stockCount.textContent = (st.stockCount ?? "—");
    el.phase.textContent = st.phase || "—";
    el.turnLabel.textContent = "Gājiens: " + (myTurn(st)?"Tu":"Pretinieks");
    el.yourTurnBtn.disabled = !myTurn(st);
  }

  function renderHand(cards){
    clear(el.meHand);
    el.meCount.textContent = cards.length;
    cards.forEach((c,i)=>{
      const d = cardNode(c);
      if(selected.has(i)) d.classList.add("selected");
      d.addEventListener("click", ()=>toggleSelect(i));
      el.meHand.appendChild(d);
    });
  }

  function renderOpp(count){
    clear(el.oppHand);
    el.oppCount.textContent = count;
    for(let i=0;i<count;i++) el.oppHand.appendChild(cardNode(null,{back:true}));
  }

  function renderStack(pairs){
    clear(el.stack);
    pairs.forEach((pair, idx)=>{
      const slot=document.createElement("div"); slot.className="pair";
      const atk=cardNode(pair.attack); atk.title="Uzbrukums"; slot.appendChild(atk);
      if(pair.defend){
        const def=cardNode(pair.defend,{defend:true}); def.title="Aizsardzība"; slot.appendChild(def);
      }else if(state && state.phase==="defend" && state.defenderId===selfId){
        // iezīmē izvēli, ja esi aizstāvis
        slot.style.outline = (selectedPairIdx===idx) ? "2px solid var(--accent)" : "1px dashed #35527e";
        slot.style.borderRadius = "12px";
        slot.addEventListener("click", ()=>pickPair(idx));
      }
      el.stack.appendChild(slot);
    });
  }

  function canEndTrick(st){
    if(!st) return false;
    const allDefended = (st.stack||[]).length>0 && (st.stack||[]).every(p=>p.defend);
    return allDefended && st.turnId===st.attackerId; // pēc noteikumiem beidz uzbrucējs
  }

  function renderAll(st){
    renderHUD(st);
    renderHand(getMyHand(st));
    const oppCount = (st.opponent && st.opponent.count) || 0;
    renderOpp(oppCount);
    renderStack(st.stack||[]);

    // pogu stāvokļi
    const isAttack = st.phase==="attack" && st.turnId===selfId;
    const isDefendMine = st.phase==="defend" && st.defenderId===selfId;
    el.btnAttack.textContent = isDefendMine ? "Aizstāvēties" : "Uzbrukt";
    el.btnEnd.disabled = !canEndTrick(st);

    el.hint.textContent = isDefendMine
      ? "Aizstāvi pārus: izvēlies pāri metienā un vienu savu kārti, kas to sit. Vai 'Paņemt'."
      : "Uzbrukums: izvēlies vienu vai vairākas savas kārtis (pēc esošo rangu) un spied 'Uzbrukt'.";
  }

  // ===== Sūtītāji
  function emitChat(){
    const msg=el.chatMsg.value.trim(); if(!msg) return;
    socket.emit("chat", msg); el.chatMsg.value="";
  }
  function createRoom(){
    const nick=el.nick.value.trim()||"Viesis";
    const size=+el.deckSize.value||36;
    const solo=!!el.soloBot.checked;
    socket.emit("createRoom",{nick,deckSize:size,solo});
  }
  function joinRoom(){
    const nick=el.nick.value.trim()||"Viesis";
    const code=el.roomInput.value.trim().toUpperCase();
    if(!code) return log("Ievadi istabas kodu.");
    socket.emit("joinRoom",{nick,room:code});
  }

  function sendAttack(){
    if(!state) return;
    const hand=getMyHand(state);
    if(state.phase!=="attack" || state.turnId!==selfId) return log("Nav uzbrukuma gājiens.");
    if(selected.size===0) return log("Izvēlies vismaz vienu kārti.");
    const cards=[...selected].map(i=>hand[i]);
    socket.emit("attack",{cards});
    selected.clear(); selectedPairIdx=null;
  }

  function sendDefend(){
    if(!state) return;
    const hand=getMyHand(state);
    if(state.phase!=="defend" || state.defenderId!==selfId) return log("Nav aizsardzības gājiens.");
    if(selectedPairIdx==null) return log("Izvēlies pāri metienā.");
    if(selected.size!==1) return log("Izvēlies vienu savu kārti aizsardzībai.");
    const card = hand[[...selected][0]];
    socket.emit("defend",{pairIndex:selectedPairIdx,card});
    selected.clear(); selectedPairIdx=null;
  }

  function endTrick(){ socket.emit("endTrick"); }
  function takeCards(){ socket.emit("take"); selected.clear(); selectedPairIdx=null; }
  function passAdd(){ socket.emit("passAdd"); }

  // UI
  el.chatSend?.addEventListener("click", emitChat);
  el.btnCreate?.addEventListener("click", createRoom);
  el.btnJoin?.addEventListener("click", joinRoom);

  el.btnAttack?.addEventListener("click", ()=>{
    if(state?.phase==="defend" && state.defenderId===selfId) return sendDefend();
    return sendAttack();
  });
  el.btnEnd?.addEventListener("click", endTrick);
  el.btnTake?.addEventListener("click", takeCards);
  el.btnPass?.addEventListener("click", passAdd);

  // Socket
  socket.on("connect",()=>{ selfId=socket.id; log("Savienots ar serveri."); });
  socket.on("disconnect",()=>log("Atvienots no servera."));
  socket.on("errorMsg",(m)=>log("Kļūda: "+m));
  socket.on("info",(m)=>log(m));
  socket.on("room",(code)=>{ el.roomInput.value=code; el.roomLabel.textContent=code; });
  socket.on("chat",(m)=>log("💬 "+m));

  socket.on("state",(st)=>{
    state=st; if(!selfId && st.meId) selfId=st.meId;
    renderAll(st);
  });
})();
