// ========= Klienta stāvoklis =========
let currentRoom = null;
let meId = null;
let state = null;

const els = {
  nick: document.getElementById("nick"),
  deckSize: document.getElementById("deckSize"),
  roomInput: document.getElementById("room"),
  btnCreate: document.getElementById("btnCreate"),
  btnJoin: document.getElementById("btnJoin"),
  btnStart: document.getElementById("btnStart"),
  btnSolo: document.getElementById("btnSolo"),
  btnEnd: document.getElementById("btnEnd"),
  btnTake: document.getElementById("btnTake"),
  roomLabel: document.getElementById("roomLabel"),
  trumpLabel: document.getElementById("trumpLabel"),
  stockCount: document.getElementById("stockCount"),
  phase: document.getElementById("phase"),
  turnLabel: document.getElementById("turnLabel"),
  log: document.getElementById("log"),
  chatMsg: document.getElementById("chatMsg"),
  chatSend: document.getElementById("chatSend"),
  stack: document.getElementById("stack"),
  oppName: document.getElementById("oppName"),
  oppCount: document.getElementById("oppCount"),
  oppHand: document.getElementById("oppHand"),
  meCount: document.getElementById("meCount"),
  meHand: document.getElementById("meHand"),
};

function addLog(msg){ const d=document.createElement("div"); d.textContent=msg; els.log.appendChild(d); els.log.scrollTop = els.log.scrollHeight; }

// atlases stāvoklis
let selected = { from:null, index:null };
const clearSelection = () => { selected={from:null,index:null}; renderHandSelection(); };
function renderHandSelection(){
  [...els.meHand.querySelectorAll(".card")].forEach((el,i)=>{
    el.classList.toggle("selected", selected.from==="hand" && selected.index===i);
  });
}

function suitColor(s){ return (s==="♥"||s==="♦") ? "red" : "black"; }
function cardHTML(c, extra=""){ 
  return `<div class="card ${extra}">
    <div class="rank ${suitColor(c.s)}">${c.r}</div>
    <div class="suit ${suitColor(c.s)}">${c.s}</div>
    <div class="corner ${suitColor(c.s)}">${c.r}${c.s}</div>
  </div>`;
}
function backHTML(){ return `<div class="card"><div class="rank black">🂠</div></div>`; }

function render(){
  if(!state){ return; }
  els.roomLabel.textContent = currentRoom || "—";
  els.stockCount.textContent = state.stock ?? "—";
  els.phase.textContent = state.phase ?? "—";
  const trump = state.trump ? `${state.trump.r}${state.trump.s}` : "—";
  els.trumpLabel.textContent = trump;

  // kas es esmu?
  const me = state.players.find(p=>p.id===meId);
  const opp = state.players.find(p=>p.id!==meId);

  const myRole = (state.attacker===meId) ? "attacker" : (state.defender===meId ? "defender" : "watch");
  els.turnLabel.textContent = (myRole==="attacker") ? "Gājiens: Tu uzbrūc" : (myRole==="defender" ? "Gājiens: Tu aizstāvi" : "Skatītājs");
  // pretinieks
  els.oppName.textContent = opp? (opp.nick||"—") : "—";
  els.oppCount.textContent = opp? opp.handCount : 0;
  els.oppHand.innerHTML = opp? Array.from({length:opp.handCount}).map(backHTML).join("") : "";

  // mana roka
  els.meCount.textContent = me? me.hand.length : 0;
  els.meHand.innerHTML = me? me.hand.map(cardHTML).join("") : "";

  // metiens
  els.stack.innerHTML = state.table.map((pair,idx)=>{
    const atk = pair.atk ? cardHTML(pair.atk) : "";
    const def = pair.def ? cardHTML(pair.def,"def") : "";
    return `<div class="pair-slot" data-idx="${idx}">${atk}${def}</div>`;
  }).join("");

  // klikšķi uz rokām: tikai atlase
  [...els.meHand.querySelectorAll(".card")].forEach((el,i)=>{
    el.addEventListener("click", ()=>{
      if(selected.from==="hand" && selected.index===i) clearSelection();
      else { selected={from:"hand",index:i}; renderHandSelection(); }
    });
  });

  // uzbrukt: klikšķis uz stack (tukšā vietā) vai uz pāra (pievienot vienādu rangu)
  els.stack.addEventListener("click", (ev)=>{
    const slot = ev.target.closest(".pair-slot");
    if(selected.from!=="hand") return;
    if(myRole!=="attacker") return;

    // ja nav pāru, var mest jebkuru; ja ir - tikai atļautos rangus
    // to pārbauda serveris; klients vienkārši sūta pieprasījumu
    socket.emit("play.attack", { room: currentRoom, cardIndex: selected.index }, (res)=>{
      if(res?.ok) clearSelection();
    });
  }, { once:true });

  // aizsardzība: klikšķis uz konkrēta pāra
  [...els.stack.querySelectorAll(".pair-slot")].forEach(slot=>{
    slot.addEventListener("click",()=>{
      if(selected.from!=="hand") return;
      if(myRole!=="defender") return;
      const idx = Number(slot.dataset.idx);
      socket.emit("play.defend", { room: currentRoom, attackIndex: idx, cardIndex: selected.index }, (res)=>{
        if(res?.ok) clearSelection();
      });
    });
  });
}

// ========= Socket notikumi =========
socket.on("connect", ()=>{ meId = socket.id; });
socket.on("room.created", ({room})=>{ currentRoom=room; els.roomInput.value=room; addLog(`Istaba izveidota: ${room}`); });
socket.on("room.joined", ({room})=>{ currentRoom=room; addLog(`Pievienojies: ${room}`); });
socket.on("room.update", ({players})=>{ addLog("Spēlētāji: "+players.map(p=>p.nick).join(", ")); });
socket.on("game.state", (s)=>{ state=s; render(); });
socket.on("log", (msg)=> addLog(msg));
socket.on("error.msg",(m)=> addLog("☝ " + m));
socket.on("chat",(m)=> addLog(`${m.nick}: ${m.msg}`));

// ========= UI pogas =========
els.btnCreate.onclick = ()=>{
  const nick = els.nick.value.trim() || "Spēlētājs";
  const deckSize = Number(els.deckSize.value);
  socket.emit("room.create", { nick, deckSize }, (res)=>{
    if(!res?.ok) return addLog("Neizdevās izveidot.");
    currentRoom = res.room; els.roomInput.value = res.room;
  });
};

els.btnJoin.onclick = ()=>{
  const nick = els.nick.value.trim() || "Spēlētājs";
  const room = (els.roomInput.value||"").trim().toUpperCase();
  socket.emit("room.join", { nick, room }, (res)=>{
    if(!res?.ok) return addLog("Nav istabas vai pilna.");
    currentRoom = res.room;
  });
};

els.btnSolo.onclick = ()=>{
  const room = (els.roomInput.value||currentRoom||"").trim().toUpperCase();
  if(!room) return addLog("Vispirms izveido istabu.");
  socket.emit("room.solo", { room }, (res)=>{
    if(!res?.ok && res?.error!=="") addLog("Solo režīms nav pieejams.");
  });
};

els.btnStart.onclick = ()=>{
  const room = (els.roomInput.value||currentRoom||"").trim().toUpperCase();
  if(!room) return;
  socket.emit("game.start", { room }, (r)=>{ if(!r?.ok) addLog("Sākt nevar."); });
};

els.btnEnd.onclick = ()=>{
  const room = currentRoom; if(!room) return;
  socket.emit("game.endAttack", { room }, (r)=>{ if(!r?.ok) addLog("Nevar beigt metienu."); });
};

els.btnTake.onclick = ()=>{
  const room = currentRoom; if(!room) return;
  socket.emit("game.take", { room }, (r)=>{ if(!r?.ok) addLog("Nevar paņemt."); });
};

els.chatSend.onclick = ()=>{
  const msg = els.chatMsg.value.trim(); if(!msg) return;
  socket.emit("chat", { room: currentRoom, msg });
  els.chatMsg.value="";
};
