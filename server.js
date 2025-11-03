import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
  transports: ["websocket"],
});

const PORT = process.env.PORT || 3000;
const rooms = new Map();

function makeRoom(deckSize) {
  const code = Math.random().toString(36).substring(2, 6).toUpperCase();
  const deck = createDeck(deckSize);
  rooms.set(code, {
    code,
    deck,
    trump: deck[deck.length - 1],
    players: [],
    phase: "wait",
    table: [],
    stock: deck.length,
  });
  return rooms.get(code);
}

function createDeck(deckSize) {
  const suits = ["♠", "♥", "♦", "♣"];
  const ranks = ["6","7","8","9","10","J","Q","K","A"];
  const full = [];
  for (const s of suits) for (const r of ranks) full.push({ r, s });
  return deckSize === 52 ? shuffle(full.concat(["2","3","4","5"].flatMap(r=>suits.map(s=>({r,s}))))) : shuffle(full);
}

function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

io.on("connection",(sock)=>{
  console.log("Jauns savienojums:", sock.id);

  sock.on("room.create", ({ nick, deckSize }, ack) => {
    const r = makeRoom(deckSize === 52 ? 52 : 36);
    r.players.push({ id: sock.id, nick: nick || "Spēlētājs", hand: [] });
    sock.join(r.code);
    sock.emit("room.created", { room: r.code });
    if (typeof ack === "function") ack({ ok: true, room: r.code });
    io.to(r.code).emit("room.update", {
      players: r.players.map(p => ({ id: p.id, nick: p.nick }))
    });
  });

  sock.on("room.join", ({ nick, room }, ack) => {
    const r = rooms.get(room);
    if (!r) { io.to(sock.id).emit("error.msg","Istaba neeksistē"); return ack?.({ok:false}); }
    if (r.players.length >= 2) { io.to(sock.id).emit("error.msg","Istaba pilna"); return ack?.({ok:false}); }
    r.players.push({ id: sock.id, nick: nick || "Spēlētājs", hand: [] });
    sock.join(room);
    sock.emit("room.joined", { room, players: r.players.map(p=>({id:p.id,nick:p.nick})) });
    ack?.({ ok:true, room });
    io.to(room).emit("room.update", { players: r.players.map(p => ({ id:p.id, nick:p.nick })) });
  });

  sock.on("chat", ({ room, msg }) => {
    const r = rooms.get(room);
    if (!r) return;
    const p = r.players.find(p => p.id === sock.id);
    io.to(room).emit("chat", { nick: p ? p.nick : "?", msg });
  });

  sock.on("disconnect", ()=>{
    for (const [code,r] of rooms.entries()){
      const idx = r.players.findIndex(p=>p.id===sock.id);
      if (idx>=0){ r.players.splice(idx,1); io.to(code).emit("room.update",{players:r.players}); }
      if (r.players.length===0) rooms.delete(code);
    }
  });
});

app.use(express.static("."));
app.get("/", (_, res) => res.sendFile(process.cwd() + "/index.html"));
httpServer.listen(PORT, () => console.log("Server running on port", PORT));
