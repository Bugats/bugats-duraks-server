const els = {
  nick: document.getElementById("nick"),
  deckSize: document.getElementById("deckSize"),
  btnCreate: document.getElementById("btnCreate"),
  roomInput: document.getElementById("room"),
  btnJoin: document.getElementById("btnJoin"),
  log: document.getElementById("log"),

  roomLabel: document.getElementById("roomLabel"),
  trumpLabel: document.getElementById("trumpLabel"),
  stockCount: document.getElementById("stockCount"),
  phase: document.getElementById("phase"),
  turnLabel: document.getElementById("turnLabel"),

  stack: document.getElementById("stack"),
  oppName: document.getElementById("oppName"),
  oppCount: document.getElementById("oppCount"),
  oppHand: document.getElementById("oppHand"),
  meCount: document.getElementById("meCount"),
  meHand: document.getElementById("meHand"),

  btnStart: document.getElementById("btnStart"),
  btnSolo: document.getElementById("btnSolo"),
  btnEnd: document.getElementById("btnEnd"),
  btnTake: document.getElementById("btnTake"),
  btnPass: document.getElementById("btnPass"),
};

const socket = io("/", { path:"/socket.io", transports:["websocket"] });

let meId = null;          // socket id
let state = null;         // pēdējais state
let currentRoom = null;
let selected = { from:null, index:-1 };

socket.on("connect", ()=>{ meId = socket.id; });

socket.on("state", (s)=>{
  state = s;
  render();
});

function log(msg){
  els.log.textContent += msg + "\n";
  els.log.scrollTop = els.log.scrollHeight;
}

function myRole(){
  if(!state) return "";
  if(state.attacker===meId) return "attacker";
  if(state.defender===meId) return "defender";
  return "observer";
}

function cardHTML(c, cls=""){
  if(!c) return "";
  const red = (c.s==="♥"||c.s==="♦");
  return `
  <div class="card ${red?"red":""} ${cls}">
    <div class="tl">${c.r}</div>
    <div class="suit">${c.s}</div>
    <div class="br">${c.r}</div>
  </div>`;
}

function render(){
  if(!state) return;

  els.roomLabel.textContent = state.room;
  els.trumpLabel.textContent = state.trump || "—";
  els.stockCount.textContent = state.stock;
  els.phase.textContent = state.phase;
  const role = myRole();
  els.turnLabel.textContent = "Gājiens: " + (role==="attacker" ? "Tu uzbrūc" : role==="defender" ? "Tu aizstāvies" : "Citi");

  // buttons
  els.btnStart.disabled = !(currentRoom && state.phase==="lobby");
  els.btnEnd.disabled   = !(role==="attacker" && state.phase==="attack" && everyoneDefended(state.table));
  els.btnTake.disabled  = !(role==="defender" && state.phase==="attack" && state.table.some(p=>p.atk && !p.def));

  // opp + me
  const opp = state.players.find(p=>!p.me);
  if(opp){
    els.oppName.textContent = opp.name;
    els.oppCount.textContent = opp.handCount;
  } else {
    els.oppName.textContent = "—";
    els.oppCount.textContent = "0";
  }

  els.meCount.textContent = (state.hand||[]).length;

  // stack pairs
  els.stack.innerHTML = state.table.map((pair,idx)=>{
    const atk = pair.atk ? cardHTML(pair.atk) : "";
    const def = pair.def ? cardHTML(pair.def,"def") : "";
    return `<div class="pair-slot" data-idx="${idx}">${atk}${def}</div>`;
  }).join("");

  // clickability cue
  const me = state.players.find(p=>p.me);
  const oppP = state.players.find(p=>!p.me);
  const limit = (oppP?.handCount ?? 0);
  const canAttackMore = role==="attacker" && state.phase==="attack" && state.table.length < limit;
  els.stack.classList.toggle("clickable", canAttackMore || state.table.length===0);

  // opp hand backs
  els.oppHand.innerHTML = (opp?.handCount? new Array(opp.handCount).fill(0) : [])
    .map(()=>`<div class="card back">🂠</div>`).join("");

  // my hand
  els.meHand.innerHTML = (state.hand||[]).map((c,i)=>{
    const red = (c.s==="♥"||c.s==="♦");
    const sel = (selected.from==="hand" && selected.index===i) ? "sel" : "";
    return `<div class="card ${red?"red":""} ${sel}" data-idx="${i}"><div class="tl">${c.r}</div><div class="suit">${c.s}</div><div class="br">${c.r}</div></div>`;
  }).join("");
}

function clearSelection(){ selected={from:null,index:-1}; render(); }

function everyoneDefended(table){ if(!table.length) return false; return table.every(p=>p.atk && p.def); }

// Hand select
els.meHand.addEventListener("click", e=>{
  const card = e.target.closest(".card");
  if(!card) return;
  const idx = Number(card.dataset.idx);
  if(isNaN(idx)) return;
  selected = { from:"hand", index: idx };
  render();
});

// Stack (drop)
els.stack.addEventListener("click", (e)=>{
  if(!state || !currentRoom) return;
  if(selected.from!=="hand") return;
  const role = myRole();
  const slot = e.target.closest(".pair-slot");

  if(role==="attacker" && state.phase==="attack"){
    socket.emit("play.attack", { room: currentRoom, cardIndex: selected.index }, (res)=>{
      if(res?.ok) clearSelection();
    });
  } else if(role==="defender" && state.phase==="attack" && slot){
    const idx = Number(slot.dataset.idx);
    socket.emit("play.defend", { room: currentRoom, attackIndex: idx, cardIndex: selected.index }, (res)=>{
      if(res?.ok) clearSelection();
    });
  }
});

els.btnCreate.onclick = ()=>{
  socket.emit("create", { name: els.nick.value.trim()||"Spēlētājs", deckSize: els.deckSize.value }, (res)=>{
    if(res?.ok){
      currentRoom = res.code;
      els.roomInput.value = res.code;
      log(`Istaba izveidota: ${res.code}`);
    }
  });
};

els.btnJoin.onclick = ()=>{
  const code = (els.roomInput.value||"").trim().toUpperCase();
  if(!code){ log("Ievadi istabas kodu."); return; }
  socket.emit("join", { code, name: els.nick.value.trim()||"Spēlētājs" }, (res)=>{
    if(res?.ok){
      currentRoom = code;
      log(`Pievienojies: ${code}`);
    } else log("Nav istabas vai pilna.");
  });
};

els.btnSolo.onclick = ()=>{
  if(currentRoom){ log("Solo tests pieejams tikai pirms pievienošanās."); return; }
  // ātra solo sesija
  socket.emit("create", { name: els.nick.value.trim()||"Spēlētājs", deckSize: els.deckSize.value }, (res)=>{
    if(res?.ok){
      currentRoom = res.code;
      els.roomInput.value = res.code;
      socket.emit("join", { code: res.code, name: els.nick.value.trim()||"Spēlētājs", solo: true }, (j)=>{
        if(j?.ok){
          log(`Solo: ${res.code}`);
        }
      });
    }
  });
};

els.btnStart.onclick = ()=>{ if(currentRoom) socket.emit("start", { room: currentRoom }, (r)=>{ if(!r?.ok) log("Neizdevās sākt."); }); };
els.btnEnd.onclick   = ()=>{ if(currentRoom) socket.emit("endTurn", { room: currentRoom }, (r)=>{ if(!r?.ok) log("Nevar beigt metienu."); }); };
els.btnTake.onclick  = ()=>{ if(currentRoom) socket.emit("take", { room: currentRoom }, (r)=>{ if(!r?.ok) log("Nevar paņemt."); }); };
els.btnPass.onclick  = ()=>{ log("Durakam nav 'pass' noteikuma — izmanto 'Beigt metienu' (kad viss nosists)."); };
