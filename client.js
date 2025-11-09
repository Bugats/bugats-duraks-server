// ========= CONFIG =========
const SOCKET_URL = (location.hostname === "localhost")
  ? "http://localhost:3001"
  : "https://duraks-online.onrender.com";

const socket = io(SOCKET_URL, {
  path: "/socket.io",
  transports: ["websocket"]
});

// ========= DOM refs =========
const el = (s)=>document.querySelector(s);
const nick = el("#nick");
const deck = el("#deck");
const solo = el("#solo");
const btnCreate = el("#btnCreate");
const btnJoin = el("#btnJoin");
const roomInp = el("#room");
const logBox = el("#log");
const turn = el("#turn");
const trump = el("#trump");
const roomLabel = el("#roomLabel");
const phase = el("#phase");
const stock = el("#stock");
const tableEl = el("#table");
const meEl = el("#me");
const oppEl = el("#opp");
const oppCount = el("#oppCount");
const meCount = el("#meCount");
const btnAttack = el("#btnAttack");
const btnEnd = el("#btnEnd");
const btnTake = el("#btnTake");
const btnNo = el("#btnNo");
const hint = el("#hint");
const throwInfo = el("#throwInfo");
const msg = el("#msg");
const btnSend = el("#btnSend");

let STATE = {
  you:{}, code:null, phase:"attack", trump:null, stock:0, turnId:null,
  attackerId:null, defenderId:null, players:{}, hand:[], table:[],
  handsCount:{}, canThrowLimit:0, log:[]
};
let SELECT = {hand:new Set(), defendTarget:null};

function suitColor(s){ return (s==="♦"||s==="♥")? "red":"black"; }
function cardHtml(c){
  return `<div class="card" data-id="${c.id}">
    <div class="r">${c.rank}</div>
    <div class="s ${suitColor(c.suit)}">${c.suit}</div>
  </div>`;
}
function facedownHtml(){ return `<div class="card"><div class="r">?</div><div class="s">?</div></div>`; }

function setHint(){
  const me = STATE.you.id, att=STATE.attackerId, def=STATE.defenderId;
  const iAmAtt = me===att, iAmDef=me===def;
  if (iAmAtt && (STATE.phase==="attack" || STATE.phase==="defend")){
    hint.textContent = `Tu esi uzbrucējs. Atzīmē kārtis uzbrukumam (piemest drīkst arī aizstāvēšanās laikā).`;
  } else if (iAmDef && STATE.phase==="defend"){
    hint.textContent = `Tu esi aizstāvis. Klikšķini uz nenosista uzbrukuma kartes (virsū), pēc tam uz savas kartes ko nosist.`;
  } else {
    hint.textContent = ``;
  }
  throwInfo.textContent = `Drīksti piemest vēl: ${STATE.canThrowLimit}`;
}
function setBadges(){
  roomLabel.textContent = STATE.code || "—";
  trump.textContent = STATE.trump || "—";
  stock.textContent = STATE.stock ?? "—";
  phase.textContent = STATE.phase;
  const tNick = STATE.players[STATE.turnId]?.nick || "—";
  turn.textContent = tNick;
}
function renderLog(){
  logBox.innerHTML = STATE.log.map(l=>`<div>${l}</div>`).join("");
  logBox.scrollTop = logBox.scrollHeight;
}
function renderTable(){
  tableEl.innerHTML = "";
  STATE.table.forEach((p, idx)=>{
    const wrap = document.createElement("div");
    wrap.className = "pair";
    const cell = document.createElement("div");
    cell.className = "cell";
    const a = document.createElement("div");
    a.innerHTML = cardHtml(p.attack);
    a.firstChild.style.transform = "rotate(-6deg)";
    cell.appendChild(a.firstChild);
    if (p.defend){
      const d = document.createElement("div");
      d.innerHTML = cardHtml(p.defend);
      const dc = d.firstChild;
      dc.style.transform = "rotate(9deg) translate(18px,-10px)";
      cell.appendChild(dc);
    } else {
      // target select
      if (STATE.you.id === STATE.defenderId && STATE.phase==="defend"){
        cell.style.pointerEvents = "auto";
        cell.onclick = ()=> {
          SELECT.defendTarget = idx;
          render(); // iezīmēt
        };
        if (SELECT.defendTarget === idx) cell.style.outline = "2px dashed var(--accent)";
      }
    }
    wrap.appendChild(cell);
    tableEl.appendChild(wrap);
  });
}
function renderHands(){
  // opp
  oppEl.innerHTML = "";
  const oppId = Object.keys(STATE.players).find(id=>id!==STATE.you.id);
  oppCount.textContent = (oppId? STATE.handsCount[oppId] : 0) || 0;
  for (let i=0;i<(STATE.handsCount[oppId]||0);i++){
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = `<div class="r">×</div><div class="s">×</div>`;
    oppEl.appendChild(c);
  }

  // me
  meEl.innerHTML = "";
  meCount.textContent = STATE.hand.length;
  STATE.hand.forEach(c=>{
    const wrap = document.createElement("div");
    wrap.innerHTML = cardHtml(c);
    const node = wrap.firstChild;
    if (SELECT.hand.has(c.id)) node.classList.add("sel");
    node.onclick = ()=>{
      // ja aizstāvis izvēlējies target – šis klik nosūtīs defend
      if (STATE.you.id===STATE.defenderId && STATE.phase==="defend" && SELECT.defendTarget!=null){
        socket.emit("defend", {pairs:[{attackIndex:SELECT.defendTarget, cardId:c.id}]});
        SELECT.defendTarget=null;
        return;
      }
      // citādi – iezīmē uzbrukumam
      if (SELECT.hand.has(c.id)) SELECT.hand.delete(c.id);
      else SELECT.hand.add(c.id);
      renderHands();
    };
    meEl.appendChild(node);
  });
}
function render(){
  setBadges();
  renderLog();
  renderTable();
  renderHands();
  setHint();
  // pogu stāvoklis
  const myId = STATE.you.id;
  const isMyTurn = STATE.turnId===myId;
  const amAtt = myId===STATE.attackerId;
  const amDef = myId===STATE.defenderId;

  btnAttack.classList.toggle("disabled", !isMyTurn || !amAtt || (STATE.phase!=="attack" && STATE.phase!=="defend"));
  btnEnd.classList.toggle("disabled", !isMyTurn || !amAtt || STATE.table.some(r=>r.attack && !r.defend));
  btnTake.classList.toggle("disabled", !isMyTurn || !amDef);
}

btnCreate.onclick = ()=>{
  socket.emit("createRoom", {
    nick: nick.value.trim()||"Spēlētājs",
    deckSize: parseInt(deck.value,10),
    soloBot: solo.checked
  });
};
btnJoin.onclick = ()=>{
  socket.emit("joinRoom", {
    nick: nick.value.trim()||"Spēlētājs",
    code: (roomInp.value||"").trim().toUpperCase()
  });
};
btnSend.onclick = ()=>{
  if (!msg.value.trim()) return;
  socket.emit("chat", msg.value.trim());
  msg.value="";
};
btnAttack.onclick = ()=>{
  if (btnAttack.classList.contains("disabled")) return;
  if (!SELECT.hand.size) return;
  const ids = Array.from(SELECT.hand);
  SELECT.hand.clear();
  socket.emit("attack", {cardIds: ids});
};
btnEnd.onclick = ()=>{
  if (btnEnd.classList.contains("disabled")) return;
  socket.emit("endAttack");
};
btnTake.onclick = ()=>{
  if (btnTake.classList.contains("disabled")) return;
  socket.emit("take");
};
btnNo.onclick = ()=>{ /* dekoratīva poga – neko nedara */ };

socket.on("state", (s)=>{
  STATE = s;
  render();
});
