// =====================
// Duraks serveris (Express + Socket.IO) — ar CORS un WS atbalstu
// =====================
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";

/* ===== KONFIG ===== */
const ORIGINS = [
  "https://thezone.lv",
  "https://www.thezone.lv",
  "http://thezone.lv",
  "http://www.thezone.lv"
];

const app = express();
app.set("trust proxy", 1);

// CORS visiem API + preflight
app.use(
  cors({
    origin: (origin, cb) => cb(null, true), // ja gribi – nomaini uz (ORIGINS ietvaros)
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: false,
  })
);
app.options("*", cors());

/* Veselības pārbaude + sakne */
app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/", (_, res) => res.type("text/plain").send("Duraks server OK"));

const httpServer = createServer(app);

// Socket.IO ar tādiem pašiem CORS kā API
const io = new Server(httpServer, {
  path: "/socket.io",
  cors: {
    origin: (origin, cb) => cb(null, true), // vai: ORIGINS
    methods: ["GET", "POST"],
    credentials: false
  },
  transports: ["websocket", "polling"],
});

/* ====== TAVA SPĒLES LOĢIKA (nemainīta) ====== */
/*  >>> ŠEIT IEVIETO visu tavu esošo loģiku (RANKS_36, rooms, events utt.)
    Es nemainu spēles noteikumus — ieliec VISU kodu, ko sūtīji iepriekš,
    tieši šajā vietā bez izmaiņām. <<<                                    */

/* ====== BEIGAS ====== */
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log("Duraks serveris klausās uz porta " + PORT));
