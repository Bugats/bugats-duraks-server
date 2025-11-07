// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);

const allowed = [
  "https://thezone.lv",
  "https://www.thezone.lv",
  "https://duraks-online.onrender.com",
  "http://localhost:5173",
  "http://localhost:3000",
];

app.use(cors({
  origin: (origin, cb) => cb(null, !origin || allowed.includes(origin)),
  credentials: true
}));

const io = new Server(server, {
  path: "/socket.io",
  cors: { origin: allowed, methods: ["GET","POST"], credentials: true }
});

app.get("/healthz", (_,res)=>res.status(200).send("OK"));

/** ======= ĻOTI VIENKĀRŠA “ISTABU” UZTURĒŠANA ======= **/
const rooms = new Map();
// rooms.set(code, { players: Map<socketId,{nick}>, createdAt });

function genCode() {
  return crypto.randomBytes(2).toString("hex").toUpperCase();
}

io.on("connection", (socket) => {
  socket.data.nick = "Anon";

  socket.on("set:nick", (nick) => {
    socket.data.nick = (nick || "Anon").toString().slice(0,20);
  });

  socket.on("room:create", (_, cb) => {
    let code;
    do { code = genCode(); } while (rooms.has(code));
    rooms.set(code, { players: new Map(), createdAt: Date.now() });
    cb?.({ ok:true, code });
  });

  socket.on("room:join", ({ code }, cb) => {
    code = (code || "").toString().trim().toUpperCase();
    if (!rooms.has(code)) return cb?.({ ok:false, error:"Nav istabas." });
    const room = rooms.get(code);
    room.players.set(socket.id, { nick: socket.data.nick });
    socket.join(code);
    io.to(code).emit("room:state", {
      code,
      players: [...room.players.values()].map(p=>p.nick)
    });
    cb?.({ ok:true, code });
  });

  socket.on("chat:msg", ({ code, text }) => {
    if (!code) return;
    io.to(code).emit("chat:msg", {
      nick: socket.data.nick,
      text: (text||"").toString().slice(0,300)
    });
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (room.players.delete(socket.id)) {
        io.to(code).emit("room:state", {
          code,
          players: [...room.players.values()].map(p=>p.nick)
        });
        if (room.players.size === 0) rooms.delete(code);
      }
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
