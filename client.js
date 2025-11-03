const SERVER_URL = window.SERVER_URL || "https://duraks-online.onrender.com";

const $ = (id) => document.getElementById(id);
const logEl = $("log");
function log(m){const d=document.createElement("div");d.innerHTML=m;logEl.appendChild(d);logEl.scrollTop=logEl.scrollHeight}

let socket, myId=null, roomCode=null, state=null;

function ensureSocket(){
  if (socket && socket.connected) return socket;
  socket = io(SERVER_URL, { path: "/socket.io", transports: ["websocket"] });

  socket.on("connect", () => { myId = socket.id; log("Savienots ar serveri."); });
  socket.on("disconnect", () => log("Savienojums zudis."));

  socket.on("error.msg", (m)=> log(`<span style="color:#ff8">${m}</span>`));

  socket.on("room.created", ({room})=>{
    roomCode = room;
    $("roomLabel").textContent = room;
    log(`<b>Istaba izveidota: ${room}</b>`);
  });

  socket.on("room.joined", ({room,players})=>{
    roomCode = room;
    $("roomLabel").textContent = room;
    const other = players.find(p=>p.id!==myId);
    $("oppName").textContent = other ? other.nick : "—";
    log(`<b>Pievienojies istabai ${room}</b>`);
  });

  socket.on("room.update", ({players})=>{
    const other = players.find(p=>p.id!==myId);
    if (other) $("oppName").textContent = other.nick;
  });

  socket.on("chat", ({nick,msg})=> log(`<i>${nick}:</i> ${msg}`));

  socket.on("game.state", (s)=>{ state=s; render(); });

  return socket;
}

function getNick(){ return ($("nick").value || "Bugats").trim(); }
function getDeckSize(){ return parseInt($("deckSize").value,10) || 36; }

$("btnCreate").onclick = ()=>{
  const s = ensureSocket();
  s.emit("room.create", { nick: getNick(), deckSize: getDeckSize() });
  log("Sūtu pieprasījumu: izveidot istabu…");
};

$("btnJoin").onclick = ()=>{
  const s = ensureSocket();
  const room = ($("room").value || "").trim().toUpperCase();
  if (!room) return log("Ievadi istabas kodu.");
  s.emit("room.join", { nick: getNick(), room });
  log(`Sūtu pieprasījumu: pievienoties ${room}…`);
};

$("btnStart").onclick = ()=>{
  if (!roomCode) return log("Nav istabas.");
  ensureSocket().emit("game.start", { room: roomCode });
};

$("btnEnd").onclick = ()=>{
  if (!roomCode) return;
  ensureSocket().emit("game.endAttack", { room: roomCode });
};

$("btnTake").onclick = ()=>{
  if (!roomCode) return;
  ensureSocket().emit("game.take", { room: roomCode });
};

$("btnPass").onclick = ()=>{
  if (!roomCode) return;
  ensureSocket().emit("game.pass", { room: roomCode });
};

$("chatSend").onclick = ()=>{
  if (!roomCode) return;
  const msg = $("chatMsg").value.trim();
  if (!msg) return;
  $("chatMsg").value = "";
  ensureSocket().emit("chat", { room: roomCode, msg });
};

function onPlayCard(idx, defendIdx){
  if (!roomCode) return;
  ensureSocket().emit("game.play", { room: roomCode, idx, defendIdx });
}

function render(){
  if (!state) return;
  $("trumpLabel").textContent = state.trump ? state.trump.s : "—";
  $("stockCount").textContent = state.stock ?? 0;
  $("phase").textContent = state.phase || "—";

  const me = state.players.find(p=>p.id===myId) || state.players[0];
  const opp = state.players.find(p=>p.id!==myId) || state.players[1];

  $("meCount").textContent  = me ? me.hand.length : 0;
  $("oppCount").textContent = opp ? (opp.handCount ?? opp.hand?.length ?? 0) : 0;

  $("turnLabel").textContent =
    state.attacker===myId ? "Gājiens: Tu uzbrūc" :
    state.defender===myId ? "Gājiens: Tu aizstāvi" : "Gājiens: —";

  renderHand("meHand", me?me.hand:[], true, state.trump?state.trump.s:null);
  renderHand("oppHand", Array(opp ? (opp.handCount ?? 0) : 0).fill({hidden:true}), false, state.trump?state.trump.s:null);

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

ensureSocket();
