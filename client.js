const SERVER_URL = "https://duraks-online.onrender.com";
const $ = (id)=>document.getElementById(id);
const logEl = $("log");
function log(m){const d=document.createElement("div");d.innerHTML=m;logEl.appendChild(d);logEl.scrollTop=logEl.scrollHeight}

let socket, myId=null, roomCode=null, state=null;

function ensureSocket(){
  if (socket && socket.connected) return socket;
  socket = io(SERVER_URL, { path:"/socket.io", transports:["websocket"] });

  socket.on("connect",()=>{ myId=socket.id; log("Savienots ar serveri."); });
  socket.on("disconnect",()=> log("Savienojums zudis."));
  socket.on("error.msg",(m)=> log(`<span style="color:#ff8">${m}</span>`));

  socket.on("room.created",({room})=>{ roomCode=room; $("roomLabel").textContent=room; log(`<b>Istaba izveidota: ${room}</b>`); });
  socket.on("room.joined",({room,players})=>{
    roomCode=room; $("roomLabel").textContent=room;
    const other = players.find(p=>p.id!==myId); $("oppName").textContent = other?other.nick:"—";
    log(`<b>Pievienojies istabai: ${room}</b>`);
  });
  socket.on("room.update",({players})=>{
    const other = players.find(p=>p.id!==myId);
    if (other) $("oppName").textContent = other.nick;
    $("btnStart").disabled = players.length<2;
  });

  socket.on("chat",({nick,msg})=> log(`<i>${nick}:</i> ${msg}`));

  socket.on("game.state",(s)=>{ state=s; render(); });

  return socket;
}

function getNick(){ return ($("nick").value||"Bugats").trim(); }
function getDeckSize(){ return parseInt($("deckSize").value,10)||36; }

// UI actions
$("btnCreate").onclick = ()=>{
  const s=ensureSocket(); log("Sūtu pieprasījumu: izveidot istabu…");
  s.emit("room.create",{nick:getNick(),deckSize:getDeckSize()},(res)=>{
    if(!res||!res.ok) return log('<span style="color:#ff8">Neizdevās izveidot istabu.</span>');
    roomCode=res.room; $("roomLabel").textContent=roomCode;
  });
};
$("btnJoin").onclick = ()=>{
  const s=ensureSocket();
  const room = ($("room").value||"").trim().toUpperCase();
  if(!room) return log("Ievadi istabas kodu.");
  log(`Sūtu pieprasījumu: pievienoties ${room}…`);
  s.emit("room.join",{nick:getNick(),room},(res)=>{
    if(!res||!res.ok) return log('<span style="color:#ff8">Nav istabas vai pilna.</span>');
    roomCode=res.room; $("roomLabel").textContent=roomCode;
  });
};
$("btnStart").onclick = ()=>{ if(!roomCode) return; ensureSocket().emit("game.start",{room:roomCode}); };
$("btnTake").onclick  = ()=>{ if(!roomCode) return; ensureSocket().emit("game.take",{room:roomCode}); };
$("btnEnd").onclick   = ()=>{ if(!roomCode) return; ensureSocket().emit("game.endAttack",{room:roomCode}); };

$("chatSend").onclick = ()=>{
  if(!roomCode) return; const msg=$("chatMsg").value.trim(); if(!msg) return;
  $("chatMsg").value=""; ensureSocket().emit("chat",{room:roomCode,msg});
};

// Rendering
function render(){
  if(!state) return;
  $("phase").textContent = state.phase || "—";
  $("stockCount").textContent = state.stock ?? 0;
  $("trumpLabel").textContent = state.trump ? state.trump.s : "—";
  $("turnLabel").textContent =
    state.attacker===myId ? "Gājiens: Tu uzbrūc" :
    state.defender===myId ? "Gājiens: Tu aizstāvi" : "Gājiens: —";

  const me = state.players.find(p=>p.id===myId) || state.players[0];
  const opp = state.players.find(p=>p.id!==myId) || state.players[1];

  $("meCount").textContent  = me ? (me.hand?.length ?? me.handCount ?? 0) : 0;
  $("oppCount").textContent = opp ? (opp.handCount ?? opp.hand?.length ?? 0) : 0;

  renderHand("meHand", me?.hand || [], true, state.trump?.s);
  renderHand("oppHand", Array(opp ? (opp.handCount ?? 0) : 0).fill({hidden:true}), false, state.trump?.s);

  const st = $("stack"); st.innerHTML="";
  (state.table||[]).forEach(pair=>{
    const w=document.createElement("div"); w.className="pair";
    w.appendChild(makeCard(pair.atk, state.trump?.s));
    if(pair.def){ const d=makeCard(pair.def, state.trump?.s); d.classList.add("def"); w.appendChild(d); }
    st.appendChild(w);
  });

  // Aktivizē/atslēdz vadību
  $("btnTake").disabled = state.phase!=="attack" || state.defender!==myId || (state.table||[]).length===0;
  $("btnEnd").disabled  = state.phase!=="attack" || state.attacker!==myId;
}

function renderHand(id, hand, isMe, trumpSuit){
  const el=$(id); el.innerHTML="";
  hand.forEach((c)=>{
    const k = c.hidden ? makeBack() : makeCard(c, trumpSuit);
    if (c.hidden) k.classList.add("disabled");
    el.appendChild(k);
  });
}
function makeBack(){
  const e=document.createElement("div"); e.className="card back"; e.innerHTML="<span>🂠</span>"; return e;
}
function makeCard(c, trumpSuit){
  const e=document.createElement("div"); e.className="card";
  if(!c){ e.innerHTML="<span>—</span>"; return e; }
  if(c.s===trumpSuit) e.classList.add("trump");
  e.innerHTML = `
    <span class="corner tl">${c.r}${c.s}</span>
    <span class="rank">${c.r}</span>
    <span class="suit">${c.s}</span>
    <span class="corner br">${c.r}${c.s}</span>`;
  return e;
}

ensureSocket();
