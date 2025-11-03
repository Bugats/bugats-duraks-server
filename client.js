const SERVER_URL = "https://duraks-online.onrender.com";

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
  socket.on("room.created", ({room})=>{ roomCode=room; $("roomLabel").textContent=room; log(`<b>Istaba izveidota: ${room}</b>`); });
  socket.on("room.joined", ({room,players})=>{ roomCode=room; $("roomLabel").textContent=room; const other=players.find(p=>p.id!==myId); $("oppName").textContent=other?other.nick:"—"; log(`<b>Pievienojies ${room}</b>`); });
  socket.on("room.update", ({players})=>{ const other=players.find(p=>p.id!==myId); if(other)$("oppName").textContent=other.nick; });
  socket.on("chat", ({nick,msg})=> log(`<i>${nick}:</i> ${msg}`));
  return socket;
}

function getNick(){ return ($("nick").value || "Bugats").trim(); }
function getDeckSize(){ return parseInt($("deckSize").value,10) || 36; }

$("btnCreate").onclick = ()=>{
  const s = ensureSocket();
  log("Sūtu pieprasījumu: izveidot istabu…");
  s.timeout(5000).emit("room.create", { nick: getNick(), deckSize: getDeckSize() }, (res)=>{
    if (!res || !res.ok) return log('<span style="color:#ff8">Neizdevās izveidot istabu.</span>');
    roomCode = res.room;
    $("roomLabel").textContent = roomCode;
    log(`<b>Istaba izveidota: ${roomCode}</b>`);
  });
};

$("btnJoin").onclick = ()=>{
  const s = ensureSocket();
  const room = ($("room").value || "").trim().toUpperCase();
  if (!room) return log("Ievadi istabas kodu.");
  log(`Sūtu pieprasījumu: pievienoties ${room}…`);
  s.timeout(5000).emit("room.join", { nick: getNick(), room }, (res)=>{
    if (!res || !res.ok) return log('<span style="color:#ff8">Nav istabas vai tā ir pilna.</span>');
    roomCode = res.room;
    $("roomLabel").textContent = roomCode;
    log(`<b>Pievienojies istabai: ${roomCode}</b>`);
  });
};

$("chatSend").onclick = ()=>{
  if (!roomCode) return;
  const msg = $("chatMsg").value.trim();
  if (!msg) return;
  $("chatMsg").value = "";
  ensureSocket().emit("chat", { room: roomCode, msg });
};
