// ========= KONFIGS =========
const SERVER_URL = window.SERVER_URL || "https://duraks-online.onrender.com";

// ========= SOCKET =========
const socket = io(SERVER_URL, { transports: ["websocket"], withCredentials: true });

// ====== UI helperi ======
const byId = id => document.getElementById(id) || null;
const byText = (txt) => {
  const btns = [...document.querySelectorAll("button,input[type=button],input[type=submit]")];
  return btns.find(b => (b.innerText || b.value || "").trim().toLowerCase() === txt.trim().toLowerCase()) || null;
};
const log = (...a) => {
  console.log(...a);
  const el = byId("log");
  if (el) el.textContent += a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") + "\n";
};

// ========= elementi =========
const connDot = byId("connDot");
const nameInput = byId("name");
const deckSelect = byId("deck");
const soloChk = byId("solo");
const createBtn = byId("createBtn") || byText("Izveidot istabu");
const joinBtn = byId("joinBtn") || byText("Pievienoties");
const roomCodeInput = byId("roomCode");
const roomBadge = byId("roomBadge");
const seatsWrap = byId("seats");

// darbības (pagaidām neaktivētas spēlei — UI demo)
byId("actAttack")?.addEventListener("click", ()=> alert("Attack: demo"));
byId("actAppend")?.addEventListener("click", ()=> alert("Append: demo"));
byId("actBeat")?.addEventListener("click", ()=> alert("Beat: demo"));
byId("actTake")?.addEventListener("click", ()=> alert("Take: demo"));
byId("actEnd")?.addEventListener("click", ()=> alert("End: demo"));

// ====== Sēdvietu renderētājs ======
function renderSeats(state){
  if(!seatsWrap) return;
  seatsWrap.innerHTML = "";
  const seats = state?.seats || Array.from({length:6}, (_,i)=>({seat:i,name:null,id:null}));
  seats.forEach(s=>{
    const row = document.createElement("div");
    row.className = "seat";
    const title = document.createElement("div");
    title.innerHTML = `<div class="title">Sēdvieta ${s.seat+1}${s.name ? "" : ""}</div><div class="sub">${s.name ? "Aizņemta: "+s.name : "brīvs"}</div>`;
    const btn = document.createElement("button");
    btn.className="join";
    btn.textContent = s.name ? "Aizņemta" : "Pievienoties";
    btn.disabled = !!s.name;

    btn.addEventListener("click", ()=>{
      if(!window.currentRoom){ alert("Vispirms izveido vai pievienojies istabai."); return; }
      const nm = (nameInput?.value || "Spēlētājs").trim() || "Spēlētājs";
      socket.emit("seat:join", { code: window.currentRoom, seat: s.seat, name: nm });
    });

    row.appendChild(title);
    row.appendChild(btn);
    seatsWrap.appendChild(row);
  });
}

// ====== Piesaiste pogām ======
if(createBtn){
  createBtn.addEventListener("click", (e)=>{
    e.preventDefault();
    const name = (nameInput?.value || "Spēlētājs").trim() || "Spēlētājs";
    const deckType = Number(deckSelect?.value) || 36;
    const solo = !!soloChk?.checked;
    log("➡️ Emit room:create", {name, deckType, solo});
    socket.emit("room:create", { name, deckType, solo });
  });
} else {
  console.error("❌ Nevarēju atrast “Izveidot istabu” pogu.");
}

if(joinBtn){
  joinBtn.addEventListener("click", (e)=>{
    e.preventDefault();
    const code = (roomCodeInput?.value || "").trim().toUpperCase();
    if(!code){ alert("Ievadi istabas kodu"); return; }
    window.currentRoom = code;
    if(roomBadge) roomBadge.textContent = code;
    log("➡️ Iestatīts istabas kods:", code, " (izvēlies sēdvietu!)");
  });
}

// ====== SOCKET notikumi ======
socket.on("connect", ()=>{
  connDot.classList.remove("off"); connDot.classList.add("on");
  connDot.textContent = "Savienojums izveidots";
  log("Savienojums izveidots ar serveri");
  socket.emit("ping:client"); // heartbeat tests
});

socket.on("pong:server", ()=> {
  log("PONG saņemts no servera");
});

socket.on("connect_error", (err)=>{
  connDot.classList.remove("on"); connDot.classList.add("off");
  connDot.textContent = "Savienojums nav";
  console.error("connect_error", err);
  log("Savienojuma kļūda:", String(err?.message||err));
});

socket.on("toast", (m)=>{
  if(m?.text) { alert(m.text); log("TOAST:", m.text); }
});

socket.on("room:code", (code)=>{
  window.currentRoom = code;
  if(roomBadge) roomBadge.textContent = code;
  log("✅ Istaba izveidota:", code);
});

socket.on("state:public", (st)=>{
  log("📡 state:public", st);
  renderSeats(st);
});

// sākotnējais render
renderSeats(null);
