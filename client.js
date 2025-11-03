const SERVER_URL = window.SERVER_URL || "https://duraks-online.onrender.com";

// UI helpers
const $ = id => document.getElementById(id);
const logEl = $("log");
function log(m){const d=document.createElement("div");d.innerHTML=m;logEl.appendChild(d);logEl.scrollTop=logEl.scrollHeight}

let socket=null, myId=null, roomCode=null, state=null;

function connect(){
  if(socket) return socket;
  socket = io(SERVER_URL, { path: "/socket.io", transports: ["websocket"] });

  socket.on("connect", ()=>{ myId = socket.id; log("Savienots ar serveri."); });

  socket.on("room.created", ({room})=>{
    roomCode = room; $("roomLabel").textContent = room;
    log(`<b>Istaba izveidota: ${room}</b> — dod šo kodu otram spēlētājam`);
  });

  socket.on("room.joined", ({room,players})=>{
    roomCode = room; $("roomLabel").textContent = room;
    const other = players.find(p=>p.id!==myId);
    $("oppName").textContent = other ? other.nick : "—";
    log(`<b>Pievienojies istabai ${room}</b>`);
  });

  socket.on("room.update", ({players})=>{
    const other = players.find(p=>p.id!==myId);
    if(other) $("oppName").textContent = other.nick;
  });

  socket.on("game.state", s=>{
    state = s;
    render();
  });

  socket.on("chat", ({nick,msg})=> log(`<i>${nick}:</i> ${msg}`) );
  socket.on("error.msg", m=> log(`<span style="color:#ff8">${m}</span>`) );

  return socket;
}

// Buttons
$("btnCreate").onclick = ()=>{
  const nick = $("nick").value.trim() || "Bugats";
  const deckSize = +$("deckSize").value || 36;
  connect().emit("room.create",{nick,deckSize});
};

$("btnJoin").onclick = ()=>{
  const nick = $("nick").value.trim() || "Bugats";
  const room = ($("room").value||"").toUpperCase();
  if(!room) return log("Ievadi istabas kodu.");
  connect().emit("room.join",{nick,room});
};

$("btnStart").onclick = ()=>{
  if(!roomCode) return;
  connect().emit("game.start",{room:roomCode});
};

$("btnEnd").onclick = ()=>{
  if(!roomCode) return;
  connect().emit("game.endAttack",{room:roomCode});
};

$("btnTake").onclick = ()=>{
  if(!roomCode) return;
  connect().emit("game.take",{room:roomCode});
};

$("btnPass").onclick = ()=>{
  if(!roomCode) return;
  connect().emit("game.pass",{room:roomCode});
};

$("chatSend").onclick = ()=>{
  const msg = $("chatMsg").value.trim();
  if(!msg || !roomCode) return;
  $("chatMsg").value = "";
  connect().emit("chat",{room:roomCode,msg});
};

// Render UI
function render(){
  if(!state) return;
  $("trumpLabel").textContent = state.trump ? state.trump.s : "—";
  $("stockCount").textContent = state.stock;
  $("phase").textContent = state.phase;

  const me = state.players.find(p=>p.id===myId) || state.players[0];
  const opp = state.players.find(p=>p.id!==myId) || state.players[1];

  $("meCount").textContent  = me ? me.hand.length : 0;
  $("oppCount").textContent = opp ? opp.handCount : 0;
  $("turnLabel").textContent =
    state.attacker===myId ? "Gājiens: Tu uzbrūc" :
    state.defender===myId ? "Gājiens: Tu aizstāvi" : "Gājiens: —";

  renderHand("meHand", me?me.hand:[], true, state.trump?state.trump.s:null);
  renderHand("oppHand", Array(opp?opp.handCount:0).fill({hidden:true}), false, state.trump?state.trump.s:null);

  const st = $("stack"); st.innerHTML = "";
  (state.table||[]).forEach((pair,i)=>{
    const w = document.createElement("div"); w.className="pair";
    if(!pair.def){ drop(w, idx=>onPlayCard(idx, i)) }
    w.appendChild(card(pair.atk, state.trump?state.trump.s:null));
    if(pair.def){ const d = card(pair.def, state.trump?state.trump.s:null); d.classList.add("def"); w.appendChild(d) }
    st.appendChild(w);
  });

  const ad = $("attackDrop"); if(ad) drop(ad, idx=>onPlayCard(idx,null));
}

function renderHand(id, hand, isMe, trump){
  const el = $(id); el.innerHTML = "";
  (hand||[]).forEach((c,i)=>{
    const k = card(c.hidden?null:c, trump);
    if(isMe && !c.hidden){
      k.onclick = ()=> onPlayCard(i);
      k.setAttribute("draggable","true");
      k.addEventListener("dragstart", e=> e.dataTransfer.setData("text/plain", String(i)));
    }else if(c.hidden){ k.classList.add("disabled"); k.title="Pretinieka kārts"; }
    el.appendChild(k);
  });
}

function card(c,tr){
  const e=document.createElement("div"); e.className="card";
  if(!c){ e.innerHTML='<span class="rank">🂠</span>'; return e }
  if(c.s===tr) e.classList.add("trump");
  e.innerHTML = `<span class="corner">${c.r}${c.s}</span><span class="rank">${c.r}</span><span class="suit">${c.s}</span><span class="corner2">${c.r}${c.s}</span>`;
  return e;
}

function drop(el,fn){
  el.addEventListener("dragover",e=>{e.preventDefault(); el.classList.add("drop-hint")});
  el.addEventListener("dragleave",()=> el.classList.remove("drop-hint"));
  el.addEventListener("drop",e=>{e.preventDefault(); el.classList.remove("drop-hint");
    const i=parseInt(e.dataTransfer.getData("text/plain"),10);
    if(Number.isInteger(i)) fn(i);
  });
}

function onPlayCard(idx, defendIdx){
  if(!roomCode) return;
  connect().emit("game.play",{room:roomCode,idx,defendIdx});
}

// auto-connect
connect();
