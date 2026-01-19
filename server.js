// =====================
// Duraks serveris (Rooms, Leaderboard, Reconnect, Undo, BOT, drošības slāņi)
// CORS = atļauts tikai https://thezone.lv
// =====================

import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// ---- CORS tikai thezone.lv + beyblade.thezone.lv
const ORIGINS = ["https://thezone.lv", "https://beyblade.thezone.lv"];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(cors({
  origin: ORIGINS,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
}));
app.options("*", cors({
  origin: ORIGINS,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: false,
}));
app.use("/beyblade", express.static(path.join(__dirname, "public/beyblade")));

app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/", (req, res) => {
  const host = String(req.headers.host || "").toLowerCase();
  if (host.includes("beyblade.")) return res.redirect("/beyblade");
  return res.json({ ok: true });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  // Socket.IO CORS
  cors: { origin: ORIGINS, methods: ["GET", "POST"] },
  serveClient: true,   // lai var ielādēt /socket.io/socket.io.js no šī servera
  path: "/socket.io",
});

/* ===== Beyblade Arena (TikTok chat-controlled) ===== */
const BEYBLADE_INGEST_SECRET = process.env.BEYBLADE_INGEST_SECRET || "";
const BEYBLADE_MAX_BLADES = Number(process.env.BEYBLADE_MAX_BLADES || 24);
const BEYBLADE_TICK_MS = Number(process.env.BEYBLADE_TICK_MS || 50);
const BEYBLADE_COMMAND_RATE_MS = Number(process.env.BEYBLADE_COMMAND_RATE_MS || 350);
const BEYBLADE_COIN_TO_USD = Number(process.env.BEYBLADE_COIN_TO_USD || 0.005);
const BEYBLADE_ROUND_COUNTDOWN_MS = Number(process.env.BEYBLADE_ROUND_COUNTDOWN_MS || 5000);
const BEYBLADE_ROUND_SHRINK_START_MS = Number(process.env.BEYBLADE_ROUND_SHRINK_START_MS || 30000);
const BEYBLADE_ROUND_SHRINK_END_MS = Number(process.env.BEYBLADE_ROUND_SHRINK_END_MS || 75000);
const BEYBLADE_ROUND_COOLDOWN_MS = Number(process.env.BEYBLADE_ROUND_COOLDOWN_MS || 8000);
const BEYBLADE_MIN_PLAYERS = Number(process.env.BEYBLADE_MIN_PLAYERS || 2);
const BEYBLADE_MIN_RADIUS = Number(process.env.BEYBLADE_MIN_RADIUS || 0.55);
const BEYBLADE_GIFT_TIER_BOOST = Number(process.env.BEYBLADE_GIFT_TIER_BOOST || 10);
const BEYBLADE_GIFT_TIER_SHIELD = Number(process.env.BEYBLADE_GIFT_TIER_SHIELD || 50);
const BEYBLADE_GIFT_TIER_SHOCK = Number(process.env.BEYBLADE_GIFT_TIER_SHOCK || 150);
const BEYBLADE_GIFT_TIER_ULT = Number(process.env.BEYBLADE_GIFT_TIER_ULT || 300);
const BEYBLADE_GIFT_REVIVE = Number(process.env.BEYBLADE_GIFT_REVIVE || 200);
const BEYBLADE_REVIVE_MAX_PER_ROUND = Number(process.env.BEYBLADE_REVIVE_MAX_PER_ROUND || 2);
const BEYBLADE_HP_MAX = Number(process.env.BEYBLADE_HP_MAX || 5);
const BEYBLADE_DAMAGE_WALL = Number(process.env.BEYBLADE_DAMAGE_WALL || 1);
const BEYBLADE_DAMAGE_COLLISION = Number(process.env.BEYBLADE_DAMAGE_COLLISION || 1);
const BEYBLADE_HIT_COOLDOWN_MS = Number(process.env.BEYBLADE_HIT_COOLDOWN_MS || 1200);
const BEYBLADE_WALL_SPEED_THRESHOLD = Number(process.env.BEYBLADE_WALL_SPEED_THRESHOLD || 0.03);
const BEYBLADE_COLLISION_SPEED_THRESHOLD = Number(process.env.BEYBLADE_COLLISION_SPEED_THRESHOLD || 0.028);
const BEYBLADE_STAMINA_MAX = Number(process.env.BEYBLADE_STAMINA_MAX || 100);
const BEYBLADE_STAMINA_REGEN_PER_SEC = Number(process.env.BEYBLADE_STAMINA_REGEN_PER_SEC || 6);
const BEYBLADE_STAMINA_BOOST_COST = Number(process.env.BEYBLADE_STAMINA_BOOST_COST || 28);
const BEYBLADE_STAMINA_DASH_COST = Number(process.env.BEYBLADE_STAMINA_DASH_COST || 22);
const BEYBLADE_STAMINA_SHIELD_COST = Number(process.env.BEYBLADE_STAMINA_SHIELD_COST || 30);
const BEYBLADE_SHIELD_DURATION_MS = Number(process.env.BEYBLADE_SHIELD_DURATION_MS || 2500);
const BEYBLADE_SHIELD_SLOW_MULT = Number(process.env.BEYBLADE_SHIELD_SLOW_MULT || 0.7);
const BEYBLADE_COLORS = ["#0f0f0f", "#1a1a1a", "#00f2ea", "#ff0050", "#ffffff", "#fbb1d5", "#ffd166", "#6a4c93", "#2f9e44"];
const SAFE_MAX_BLADES = Number.isFinite(BEYBLADE_MAX_BLADES) ? BEYBLADE_MAX_BLADES : 24;
const SAFE_TICK_MS = Number.isFinite(BEYBLADE_TICK_MS) ? BEYBLADE_TICK_MS : 50;
const SAFE_COMMAND_RATE_MS = Number.isFinite(BEYBLADE_COMMAND_RATE_MS) ? BEYBLADE_COMMAND_RATE_MS : 350;
const SAFE_COIN_TO_USD = Number.isFinite(BEYBLADE_COIN_TO_USD) ? BEYBLADE_COIN_TO_USD : 0.005;
const SAFE_ROUND_COUNTDOWN_MS = Number.isFinite(BEYBLADE_ROUND_COUNTDOWN_MS) ? BEYBLADE_ROUND_COUNTDOWN_MS : 5000;
const SAFE_ROUND_SHRINK_START_MS = Number.isFinite(BEYBLADE_ROUND_SHRINK_START_MS) ? BEYBLADE_ROUND_SHRINK_START_MS : 30000;
const SAFE_ROUND_SHRINK_END_MS = Number.isFinite(BEYBLADE_ROUND_SHRINK_END_MS) ? BEYBLADE_ROUND_SHRINK_END_MS : 75000;
const SAFE_ROUND_COOLDOWN_MS = Number.isFinite(BEYBLADE_ROUND_COOLDOWN_MS) ? BEYBLADE_ROUND_COOLDOWN_MS : 8000;
const SAFE_MIN_PLAYERS = Number.isFinite(BEYBLADE_MIN_PLAYERS) ? BEYBLADE_MIN_PLAYERS : 2;
const SAFE_MIN_RADIUS = Number.isFinite(BEYBLADE_MIN_RADIUS) ? BEYBLADE_MIN_RADIUS : 0.55;
const SAFE_GIFT_TIER_BOOST = Number.isFinite(BEYBLADE_GIFT_TIER_BOOST) ? BEYBLADE_GIFT_TIER_BOOST : 10;
const SAFE_GIFT_TIER_SHIELD = Number.isFinite(BEYBLADE_GIFT_TIER_SHIELD) ? BEYBLADE_GIFT_TIER_SHIELD : 50;
const SAFE_GIFT_TIER_SHOCK = Number.isFinite(BEYBLADE_GIFT_TIER_SHOCK) ? BEYBLADE_GIFT_TIER_SHOCK : 150;
const SAFE_GIFT_TIER_ULT = Number.isFinite(BEYBLADE_GIFT_TIER_ULT) ? BEYBLADE_GIFT_TIER_ULT : 300;
const SAFE_GIFT_REVIVE = Number.isFinite(BEYBLADE_GIFT_REVIVE) ? BEYBLADE_GIFT_REVIVE : 200;
const SAFE_REVIVE_MAX_PER_ROUND = Number.isFinite(BEYBLADE_REVIVE_MAX_PER_ROUND) ? BEYBLADE_REVIVE_MAX_PER_ROUND : 2;
const SAFE_HP_MAX = Number.isFinite(BEYBLADE_HP_MAX) ? BEYBLADE_HP_MAX : 5;
const SAFE_DAMAGE_WALL = Number.isFinite(BEYBLADE_DAMAGE_WALL) ? BEYBLADE_DAMAGE_WALL : 1;
const SAFE_DAMAGE_COLLISION = Number.isFinite(BEYBLADE_DAMAGE_COLLISION) ? BEYBLADE_DAMAGE_COLLISION : 1;
const SAFE_HIT_COOLDOWN_MS = Number.isFinite(BEYBLADE_HIT_COOLDOWN_MS) ? BEYBLADE_HIT_COOLDOWN_MS : 1200;
const SAFE_WALL_SPEED_THRESHOLD = Number.isFinite(BEYBLADE_WALL_SPEED_THRESHOLD) ? BEYBLADE_WALL_SPEED_THRESHOLD : 0.03;
const SAFE_COLLISION_SPEED_THRESHOLD = Number.isFinite(BEYBLADE_COLLISION_SPEED_THRESHOLD) ? BEYBLADE_COLLISION_SPEED_THRESHOLD : 0.028;
const SAFE_STAMINA_MAX = Number.isFinite(BEYBLADE_STAMINA_MAX) ? BEYBLADE_STAMINA_MAX : 100;
const SAFE_STAMINA_REGEN_PER_SEC = Number.isFinite(BEYBLADE_STAMINA_REGEN_PER_SEC) ? BEYBLADE_STAMINA_REGEN_PER_SEC : 6;
const SAFE_STAMINA_BOOST_COST = Number.isFinite(BEYBLADE_STAMINA_BOOST_COST) ? BEYBLADE_STAMINA_BOOST_COST : 28;
const SAFE_STAMINA_DASH_COST = Number.isFinite(BEYBLADE_STAMINA_DASH_COST) ? BEYBLADE_STAMINA_DASH_COST : 22;
const SAFE_STAMINA_SHIELD_COST = Number.isFinite(BEYBLADE_STAMINA_SHIELD_COST) ? BEYBLADE_STAMINA_SHIELD_COST : 30;
const SAFE_SHIELD_DURATION_MS = Number.isFinite(BEYBLADE_SHIELD_DURATION_MS) ? BEYBLADE_SHIELD_DURATION_MS : 2500;
const SAFE_SHIELD_SLOW_MULT = Number.isFinite(BEYBLADE_SHIELD_SLOW_MULT) ? BEYBLADE_SHIELD_SLOW_MULT : 0.7;

const beybladeIo = io.of("/beyblade");
const arena = {
  radius: 1,
  friction: 0.985,
  bounce: 0.9,
  spinDecay: 0.992,
  maxSpeed: 0.04,
  blades: new Map(),
  viewers: new Map(),
  events: [],
  totals: { coins: 0, gifts: 0, revenueUsd: 0 },
  winStats: new Map(),
  pending: new Set(),
  round: {
    status: "idle",
    countdownEndsAt: 0,
    startAt: 0,
    shrinkStartAt: 0,
    shrinkEndAt: 0,
    baseRadius: 1,
    minRadius: SAFE_MIN_RADIUS,
    shrinkAnnounced: false,
    banner: null,
    winnerId: null,
    winnerName: null,
    winnerStreak: 0,
    lastWinnerId: null,
    streaks: new Map(),
    cooldownUntil: 0,
    reviveLimit: SAFE_REVIVE_MAX_PER_ROUND,
    revivesUsed: 0,
    eliminated: new Map(),
    revived: new Set()
  }
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const safeText = (value, max = 22) => String(value || "").replace(/[<>]/g, "").trim().slice(0, max);
const asNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function hashString(text) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function normalizeViewerId(userId, userName) {
  const raw = String(userId || userName || "");
  const base = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (base) return base;
  const fallback = raw || Math.random().toString(36);
  return `viewer-${hashString(fallback).toString(36)}`;
}

function colorForViewer(viewerId) {
  const idx = hashString(viewerId) % BEYBLADE_COLORS.length;
  return BEYBLADE_COLORS[idx];
}

function pushArenaEvent(type, message, meta = {}) {
  arena.events.push({
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ts: Date.now(),
    type,
    message,
    meta: (meta && typeof meta === "object") ? meta : {}
  });
  if (arena.events.length > 20) arena.events.shift();
}

function getOrCreateViewer(viewerId, viewerName) {
  const name = safeText(viewerName || viewerId || "Viewer");
  let viewer = arena.viewers.get(viewerId);
  if (!viewer) {
    viewer = {
      id: viewerId,
      name,
      color: colorForViewer(viewerId),
      class: "balanced",
      coins: 0,
      gifts: 0,
      lastCommandAt: 0,
      lastSeen: Date.now()
    };
    arena.viewers.set(viewerId, viewer);
  } else if (name && name !== viewer.name) {
    viewer.name = name;
  }
  viewer.lastSeen = Date.now();
  return viewer;
}

function dropOldestBlade() {
  let oldest = null;
  for (const blade of arena.blades.values()) {
    if (!oldest || blade.createdAt < oldest.createdAt) oldest = blade;
  }
  if (oldest) {
    arena.blades.delete(oldest.id);
    pushArenaEvent("system", `Blade limit reached. Removing ${oldest.name}.`);
  }
}

function createBlade(viewer) {
  if (arena.blades.size >= Math.max(2, SAFE_MAX_BLADES)) dropOldestBlade();
  const angle = Math.random() * Math.PI * 2;
  const distance = 0.2 + Math.random() * 0.55;
  const classKey = normalizeClassKey(viewer.class);
  const now = Date.now();
  const blade = {
    id: viewer.id,
    ownerId: viewer.id,
    name: viewer.name,
    color: viewer.color,
    x: Math.cos(angle) * distance,
    y: Math.sin(angle) * distance,
    vx: (Math.random() - 0.5) * 0.02,
    vy: (Math.random() - 0.5) * 0.02,
    spin: 0.8 + Math.random() * 0.4,
    energy: 1,
    radius: 0.085,
    hp: SAFE_HP_MAX,
    hpMax: SAFE_HP_MAX,
    lastHitAt: 0,
    stamina: SAFE_STAMINA_MAX,
    staminaMax: SAFE_STAMINA_MAX,
    staminaRegen: 1,
    speedMultiplier: 1,
    class: classKey,
    lastRegenAt: now,
    shieldUntil: 0,
    slowUntil: 0,
    createdAt: now,
    lastActionAt: now
  };
  applyClassToBlade(blade, classKey);
  arena.blades.set(blade.id, blade);
  pushArenaEvent("spawn", `${viewer.name} joined the arena.`);
  return blade;
}

function getBlade(viewer) {
  return arena.blades.get(viewer.id) || null;
}

function queueViewer(viewer) {
  if (arena.pending.has(viewer.id)) return;
  arena.pending.add(viewer.id);
  pushArenaEvent("queue", `${viewer.name} queued for next battle.`);
}

function spawnBlade(viewer, { allowDuringRound = false } = {}) {
  const existing = getBlade(viewer);
  if (existing) {
    arena.pending.delete(viewer.id);
    return existing;
  }
  if (!allowDuringRound && arena.round.status === "running") {
    queueViewer(viewer);
    return null;
  }
  const blade = createBlade(viewer);
  arena.pending.delete(viewer.id);
  return blade;
}

function allowViewerCommand(viewer) {
  const now = Date.now();
  if (now - viewer.lastCommandAt < SAFE_COMMAND_RATE_MS) return false;
  viewer.lastCommandAt = now;
  return true;
}

function parseChatCommand(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("!")) return null;
  const lower = trimmed.toLowerCase();
  const [cmd, ...rest] = lower.slice(1).split(/\s+/);
  const rawArgs = trimmed.split(/\s+/).slice(1).join(" ");
  switch (cmd) {
    case "join":
    case "spawn":
    case "beyblade":
      return { type: "spawn" };
    case "boost":
    case "dash":
      return { type: "boost", magnitude: asNumber(rest[0], 1) };
    case "spin":
      return { type: "spin" };
    case "left":
    case "l":
      return { type: "nudge", dx: -1, dy: 0 };
    case "right":
    case "r":
      return { type: "nudge", dx: 1, dy: 0 };
    case "up":
    case "u":
      return { type: "nudge", dx: 0, dy: -1 };
    case "down":
    case "d":
      return { type: "nudge", dx: 0, dy: 1 };
    case "stop":
      return { type: "stop" };
    case "shield":
      return { type: "shield" };
    case "class": {
      const value = (rest[0] || "").toLowerCase();
      return { type: "class", value };
    }
    case "aim":
    case "angle": {
      const deg = asNumber(rest[0], null);
      if (deg == null) return null;
      return { type: "aim", angle: deg };
    }
    case "color":
      return { type: "color", value: rest[0] || "" };
    case "name":
      return { type: "name", value: rawArgs };
    default:
      return null;
  }
}

function normalizeColor(value) {
  const color = String(value || "").toLowerCase();
  const allowed = {
    red: "#ff4d4d",
    blue: "#4d79ff",
    green: "#34c759",
    yellow: "#ffd166",
    purple: "#6a4c93",
    orange: "#ff8c42",
    pink: "#fbb1d5",
    cyan: "#00f2ea",
    white: "#ffffff",
    black: "#0f0f0f"
  };
  if (allowed[color]) return allowed[color];
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  return null;
}

const CLASS_CONFIG = {
  balanced: { hpMax: SAFE_HP_MAX, speed: 1, staminaMax: SAFE_STAMINA_MAX, staminaRegen: 1 },
  light: { hpMax: Math.max(1, SAFE_HP_MAX - 1), speed: 1.15, staminaMax: SAFE_STAMINA_MAX, staminaRegen: 1.1 },
  heavy: { hpMax: SAFE_HP_MAX + 2, speed: 0.88, staminaMax: SAFE_STAMINA_MAX, staminaRegen: 0.9 }
};

function normalizeClassKey(value) {
  const key = String(value || "").toLowerCase();
  if (key === "light" || key === "heavy" || key === "balanced") return key;
  return "balanced";
}

function applyClassToBlade(blade, classKey) {
  const cfg = CLASS_CONFIG[classKey] || CLASS_CONFIG.balanced;
  const prevMax = blade.hpMax ?? cfg.hpMax;
  blade.class = classKey;
  blade.speedMultiplier = cfg.speed;
  blade.staminaMax = cfg.staminaMax;
  blade.staminaRegen = cfg.staminaRegen;
  blade.hpMax = cfg.hpMax;
  if (blade.hp == null) blade.hp = blade.hpMax;
  if (blade.hp > blade.hpMax) blade.hp = blade.hpMax;
  if (blade.hpMax > prevMax) blade.hp = Math.min(blade.hpMax, blade.hp + (blade.hpMax - prevMax));
  if (blade.stamina == null) blade.stamina = blade.staminaMax;
  blade.stamina = clamp(blade.stamina, 0, blade.staminaMax);
}

function getBladeSpeedMultiplier(blade, now) {
  let mult = blade.speedMultiplier || 1;
  if (blade.slowUntil && now < blade.slowUntil) mult *= SAFE_SHIELD_SLOW_MULT;
  return mult;
}

function spendStamina(blade, cost) {
  if (cost <= 0) return { scale: 1, spent: 0 };
  const stamina = blade.stamina ?? 0;
  const ratio = stamina / cost;
  if (ratio < 0.2) return null;
  const scale = clamp(ratio, 0.2, 1);
  const spent = cost * scale;
  blade.stamina = clamp(stamina - spent, 0, blade.staminaMax || SAFE_STAMINA_MAX);
  return { scale, spent };
}

function applyImpulse(blade, dx, dy, spinBoost = 0, energyBoost = 0, now = Date.now()) {
  const maxSpeed = arena.maxSpeed * getBladeSpeedMultiplier(blade, now);
  blade.vx = clamp(blade.vx + dx, -maxSpeed, maxSpeed);
  blade.vy = clamp(blade.vy + dy, -maxSpeed, maxSpeed);
  blade.spin = clamp(blade.spin + spinBoost, 0, 2.5);
  blade.energy = clamp(blade.energy + energyBoost, 0, 2);
  blade.lastActionAt = now;
}

function giftTierForCoins(coins) {
  if (coins >= SAFE_GIFT_TIER_ULT) return "ult";
  if (coins >= SAFE_GIFT_TIER_SHOCK) return "shock";
  if (coins >= SAFE_GIFT_TIER_SHIELD) return "shield";
  if (coins >= SAFE_GIFT_TIER_BOOST) return "boost";
  return "spark";
}

function applyShield(blade, now, durationMs) {
  blade.shieldUntil = Math.max(blade.shieldUntil || 0, now + durationMs);
}

function applyShockwave(origin, power) {
  const range = 0.5 + power * 0.08;
  for (const blade of arena.blades.values()) {
    if (blade.id === origin.id) continue;
    const dx = blade.x - origin.x;
    const dy = blade.y - origin.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0 || dist > range) continue;
    const falloff = 1 - dist / range;
    const force = 0.025 * power * falloff;
    applyImpulse(blade, (dx / dist) * force, (dy / dist) * force, 0.05 * power, 0.02 * power);
  }
}

function markEliminated(blade, now, reason) {
  if (arena.round.status === "running") {
    arena.round.eliminated.set(blade.id, {
      id: blade.id,
      name: blade.name,
      color: blade.color,
      eliminatedAt: now,
      reason
    });
  }
  const label = reason === "ringout" ? "ringed out" : "spun out";
  pushArenaEvent("out", `${blade.name} ${label}.`, { viewerId: blade.id, reason });
}

function applyDamage(blade, amount, now, reason) {
  if (amount <= 0) return false;
  if (now - (blade.lastHitAt || 0) < SAFE_HIT_COOLDOWN_MS) return false;
  const shielded = blade.shieldUntil && now < blade.shieldUntil;
  let multiplier = 1;
  if (shielded) multiplier *= 0.6;
  if (blade.class === "heavy") multiplier *= 0.85;
  if (blade.class === "light") multiplier *= 1.1;
  if (blade.spin >= 1.8) multiplier *= 0.4;
  else if (blade.spin >= 1.3) multiplier *= 0.7;
  const scaled = amount * multiplier;
  const finalDamage = scaled < 0.6 ? 0 : Math.round(scaled);
  if (finalDamage <= 0) return false;
  blade.hp = Math.max(0, (blade.hp ?? SAFE_HP_MAX) - finalDamage);
  blade.lastHitAt = now;
  if (blade.hp <= 0) {
    markEliminated(blade, now, reason);
    return true;
  }
  return false;
}

function recordWin(winner) {
  const existing = arena.winStats.get(winner.id) || { id: winner.id, name: winner.name, wins: 0 };
  existing.wins += 1;
  existing.name = winner.name;
  arena.winStats.set(winner.id, existing);
}

function getLeaderboardTop(limit = 5) {
  const rows = [...arena.winStats.values()].map((row) => ({
    ...row,
    streak: arena.round.streaks.get(row.id) || 0
  }));
  return rows
    .sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.streak !== a.streak) return b.streak - a.streak;
      return a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

function getQueueList(limit = 8) {
  const list = [];
  for (const viewerId of arena.pending.values()) {
    const viewer = arena.viewers.get(viewerId);
    if (viewer) list.push({ id: viewer.id, name: viewer.name });
    if (list.length >= limit) break;
  }
  return list;
}

function applyCommand(viewer, command, source) {
  if (!command) return;
  if (command.type !== "spawn" && !allowViewerCommand(viewer)) return;
  const now = Date.now();

  if (command.type === "class") {
    const classKey = normalizeClassKey(command.value);
    viewer.class = classKey;
    const blade = getBlade(viewer);
    if (blade) applyClassToBlade(blade, classKey);
    pushArenaEvent("class", `${viewer.name} switched to ${classKey} class.`);
    return;
  }

  if (command.type === "shield") {
    const blade = getBlade(viewer);
    if (!blade) return;
    const staminaUse = spendStamina(blade, SAFE_STAMINA_SHIELD_COST);
    if (!staminaUse) return;
    blade.shieldUntil = Math.max(blade.shieldUntil || 0, now + SAFE_SHIELD_DURATION_MS);
    blade.slowUntil = Math.max(blade.slowUntil || 0, now + SAFE_SHIELD_DURATION_MS);
    pushArenaEvent("shield", `${viewer.name} activated shield.`);
    return;
  }

  const blade = spawnBlade(viewer);
  if (!blade) return;

  switch (command.type) {
    case "spawn":
      blade.spin = 1.2;
      blade.energy = 1;
      applyImpulse(blade, (Math.random() - 0.5) * 0.03, (Math.random() - 0.5) * 0.03, 0.4, 0.2, now);
      pushArenaEvent("spawn", `${viewer.name} launched a beyblade (${source}).`);
      break;
    case "boost": {
      const magnitude = clamp(command.magnitude || 1, 0.5, 3);
      const staminaUse = spendStamina(blade, SAFE_STAMINA_BOOST_COST * magnitude);
      if (!staminaUse) return;
      const scale = staminaUse.scale;
      const hasDirection = Math.abs(blade.vx) > 0.001 || Math.abs(blade.vy) > 0.001;
      const angle = hasDirection ? Math.atan2(blade.vy, blade.vx) : Math.random() * Math.PI * 2;
      const force = 0.018 * magnitude * scale;
      applyImpulse(blade, Math.cos(angle) * force, Math.sin(angle) * force, 0.3 * magnitude * scale, 0.15 * magnitude * scale, now);
      pushArenaEvent("boost", `${viewer.name} boosted.`);
      break;
    }
    case "spin":
      applyImpulse(blade, 0, 0, 0.5, 0.2, now);
      pushArenaEvent("spin", `${viewer.name} added spin.`);
      break;
    case "nudge": {
      const nudge = 0.012;
      applyImpulse(blade, (command.dx || 0) * nudge, (command.dy || 0) * nudge, 0.05, 0.02, now);
      break;
    }
    case "aim": {
      const staminaUse = spendStamina(blade, SAFE_STAMINA_DASH_COST);
      if (!staminaUse) return;
      const scale = staminaUse.scale;
      const angle = ((command.angle || 0) * Math.PI) / 180;
      const force = 0.02 * scale;
      applyImpulse(blade, Math.cos(angle) * force, Math.sin(angle) * force, 0.1 * scale, 0.05 * scale, now);
      pushArenaEvent("aim", `${viewer.name} dashed at ${Math.round(command.angle)}°.`);
      break;
    }
    case "stop":
      blade.vx = 0;
      blade.vy = 0;
      blade.spin = clamp(blade.spin - 0.2, 0, 2.5);
      pushArenaEvent("stop", `${viewer.name} stopped the blade.`);
      break;
    case "color": {
      const color = normalizeColor(command.value);
      if (color) {
        viewer.color = color;
        blade.color = color;
        pushArenaEvent("color", `${viewer.name} changed color.`);
      }
      break;
    }
    case "name": {
      const name = safeText(command.value, 22);
      if (name) {
        viewer.name = name;
        blade.name = name;
        pushArenaEvent("name", `Viewer updated name to ${name}.`);
      }
      break;
    }
    default:
      break;
  }
}

function handleGift(viewer, event) {
  const now = Date.now();
  const value = asNumber(event.value || event.amount || event.coins, 0);
  const repeat = Math.max(1, asNumber(event.repeat || event.count, 1));
  const coins = value * repeat;
  const tier = giftTierForCoins(coins);
  const giftName = safeText(event.name || event.giftName || "Gift", 24);

  let blade = getBlade(viewer);
  if (!blade) {
    if (arena.round.status === "running") {
      const canRevive = coins >= SAFE_GIFT_REVIVE
        && arena.round.eliminated.has(viewer.id)
        && !arena.round.revived.has(viewer.id)
        && arena.round.revivesUsed < arena.round.reviveLimit;
      if (canRevive) {
        blade = createBlade(viewer);
        blade.spin = 1.4;
        blade.energy = 1.4;
        applyImpulse(blade, (Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.04, 0.4, 0.2);
        arena.round.eliminated.delete(viewer.id);
        arena.round.revived.add(viewer.id);
        arena.round.revivesUsed += 1;
        pushArenaEvent("revive", `${viewer.name} revived with ${giftName}!`, {
          viewerId: viewer.id,
          coins,
          repeat,
          giftName,
          tier,
          revive: true
        });
      } else {
        queueViewer(viewer);
      }
    } else {
      blade = spawnBlade(viewer);
    }
  }

  viewer.coins += coins;
  viewer.gifts += repeat;
  arena.totals.coins += coins;
  arena.totals.gifts += repeat;
  arena.totals.revenueUsd = Number((arena.totals.coins * SAFE_COIN_TO_USD).toFixed(2));

  if (!blade) {
    pushArenaEvent("gift", `${viewer.name} sent ${giftName} x${repeat}.`, {
      viewerId: viewer.id,
      coins,
      repeat,
      giftName,
      tier,
      queued: true
    });
    return;
  }

  const angle = Math.random() * Math.PI * 2;
  const boost = clamp(coins / 200, 0.2, 1.4);
  applyImpulse(blade, Math.cos(angle) * 0.02 * boost, Math.sin(angle) * 0.02 * boost, 0.4 * boost, 0.2 * boost);

  if (tier === "shield") applyShield(blade, now, 3500);
  if (tier === "shock") applyShockwave(blade, 1.2);
  if (tier === "ult") applyShockwave(blade, 1.9);

  const tierLabel = tier.toUpperCase();
  const message = tier === "spark"
    ? `${viewer.name} sent ${giftName} x${repeat}.`
    : `${viewer.name} triggered ${tierLabel} with ${giftName} x${repeat}.`;
  pushArenaEvent("gift", message, {
    viewerId: viewer.id,
    coins,
    repeat,
    giftName,
    tier
  });
}

function startRoundCountdown(now) {
  arena.round.status = "countdown";
  arena.round.countdownEndsAt = now + SAFE_ROUND_COUNTDOWN_MS;
  arena.round.banner = null;
  pushArenaEvent("round", `Battle starts in ${Math.round(SAFE_ROUND_COUNTDOWN_MS / 1000)}s.`);
}

function startRound(now) {
  arena.round.status = "running";
  arena.round.startAt = now;
  arena.round.countdownEndsAt = 0;
  arena.round.shrinkStartAt = now + SAFE_ROUND_SHRINK_START_MS;
  arena.round.shrinkEndAt = now + SAFE_ROUND_SHRINK_END_MS;
  arena.round.baseRadius = 1;
  arena.round.minRadius = SAFE_MIN_RADIUS;
  arena.round.shrinkAnnounced = false;
  arena.round.banner = null;
  arena.round.reviveLimit = SAFE_REVIVE_MAX_PER_ROUND;
  arena.round.revivesUsed = 0;
  arena.round.eliminated.clear();
  arena.round.revived.clear();
  arena.radius = arena.round.baseRadius;
  pushArenaEvent("round", "Battle started!");
}

function finishRound(now, winner) {
  arena.round.status = "finished";
  arena.round.cooldownUntil = now + SAFE_ROUND_COOLDOWN_MS;
  arena.round.shrinkAnnounced = false;
  arena.radius = arena.round.baseRadius;

  let streak = 0;
  if (winner) {
    streak = arena.round.lastWinnerId === winner.id ? (arena.round.streaks.get(winner.id) || 0) + 1 : 1;
    arena.round.streaks.set(winner.id, streak);
    arena.round.lastWinnerId = winner.id;
    arena.round.winnerId = winner.id;
    arena.round.winnerName = winner.name;
    arena.round.winnerStreak = streak;
    recordWin(winner);
    pushArenaEvent("round", `${winner.name} wins! Streak x${streak}.`, {
      winnerId: winner.id,
      streak
    });
    arena.round.banner = {
      id: `bn-${now}-${winner.id}`,
      ts: now,
      durationMs: 7000,
      text: `${winner.name} wins!`,
      subtext: `Streak x${streak}`
    };
  } else {
    arena.round.lastWinnerId = null;
    arena.round.winnerId = null;
    arena.round.winnerName = null;
    arena.round.winnerStreak = 0;
    pushArenaEvent("round", "Round ended. No winner.");
    arena.round.banner = {
      id: `bn-${now}-none`,
      ts: now,
      durationMs: 6000,
      text: "Round ended",
      subtext: "No winner"
    };
  }
}

function resetRound() {
  arena.round.status = "idle";
  arena.round.countdownEndsAt = 0;
  arena.round.startAt = 0;
  arena.round.shrinkStartAt = 0;
  arena.round.shrinkEndAt = 0;
  arena.round.banner = null;
  arena.round.winnerId = null;
  arena.round.winnerName = null;
  arena.round.winnerStreak = 0;
  arena.round.cooldownUntil = 0;
  arena.round.revivesUsed = 0;
  arena.round.eliminated.clear();
  arena.round.revived.clear();
  arena.radius = arena.round.baseRadius;

  if (arena.pending.size) {
    for (const viewerId of arena.pending.values()) {
      const viewer = arena.viewers.get(viewerId);
      if (viewer) createBlade(viewer);
    }
    arena.pending.clear();
  }
}

function updateRoundState(now) {
  const activeCount = arena.blades.size;
  if (arena.round.status === "idle") {
    if (activeCount >= SAFE_MIN_PLAYERS && now >= arena.round.cooldownUntil) {
      startRoundCountdown(now);
    }
    return;
  }

  if (arena.round.status === "countdown") {
    if (activeCount < SAFE_MIN_PLAYERS) {
      arena.round.status = "idle";
      arena.round.countdownEndsAt = 0;
      pushArenaEvent("round", "Countdown cancelled. Waiting for players.");
      return;
    }
    if (now >= arena.round.countdownEndsAt) startRound(now);
    return;
  }

  if (arena.round.status === "running") {
    if (now >= arena.round.shrinkStartAt) {
      if (!arena.round.shrinkAnnounced) {
        arena.round.shrinkAnnounced = true;
        pushArenaEvent("round", "Arena shrinking!");
      }
      const total = Math.max(1, arena.round.shrinkEndAt - arena.round.shrinkStartAt);
      const progress = clamp((now - arena.round.shrinkStartAt) / total, 0, 1);
      arena.radius = arena.round.baseRadius - (arena.round.baseRadius - arena.round.minRadius) * progress;
    } else {
      arena.radius = arena.round.baseRadius;
    }

    if (activeCount <= 1) {
      const winner = activeCount === 1 ? [...arena.blades.values()][0] : null;
      finishRound(now, winner);
    }
    return;
  }

  if (arena.round.status === "finished") {
    if (now >= arena.round.cooldownUntil) resetRound();
  }
}

function handleBeybladeEvent(event, source = "tiktok") {
  const viewerId = normalizeViewerId(event.userId || event.user || event.viewerId, event.userName || event.username);
  const viewerName = event.userName || event.username || event.user || event.userId || "Viewer";
  const viewer = getOrCreateViewer(viewerId, viewerName);

  if (event.type === "gift") {
    handleGift(viewer, event);
    return;
  }

  if (event.type === "like") {
    applyCommand(viewer, { type: "spin" }, source);
    return;
  }

  if (event.type === "follow") {
    applyCommand(viewer, { type: "spawn" }, source);
    return;
  }

  if (event.type === "chat") {
    const command = parseChatCommand(event.message || event.text || "");
    if (command) applyCommand(viewer, command, source);
  }
}

function stepArena() {
  const now = Date.now();
  updateRoundState(now);
  const blades = [...arena.blades.values()];
  const removed = new Set();
  for (const blade of blades) {
    if (removed.has(blade.id)) continue;
    blade.x += blade.vx;
    blade.y += blade.vy;
    blade.vx *= arena.friction;
    blade.vy *= arena.friction;
    blade.spin *= arena.spinDecay;
    blade.energy = clamp(blade.energy - 0.002, 0, 2);
    const regenRate = (SAFE_STAMINA_REGEN_PER_SEC / 1000) * (blade.staminaRegen || 1);
    const lastRegen = blade.lastRegenAt || now;
    const regenDelta = Math.max(0, now - lastRegen);
    blade.stamina = clamp((blade.stamina ?? SAFE_STAMINA_MAX) + regenDelta * regenRate, 0, blade.staminaMax || SAFE_STAMINA_MAX);
    blade.lastRegenAt = now;

    const speed = Math.hypot(blade.vx, blade.vy);
    const speedLimit = arena.maxSpeed * getBladeSpeedMultiplier(blade, now);
    if (speed > speedLimit) {
      blade.vx = (blade.vx / speed) * speedLimit;
      blade.vy = (blade.vy / speed) * speedLimit;
    }

    const limit = arena.radius - blade.radius;
    const dist = Math.hypot(blade.x, blade.y);
    if (dist > limit) {
      const nx = blade.x / dist;
      const ny = blade.y / dist;
      blade.x = nx * limit;
      blade.y = ny * limit;
      const dot = blade.vx * nx + blade.vy * ny;
      blade.vx -= 2 * dot * nx;
      blade.vy -= 2 * dot * ny;
      blade.vx *= arena.bounce;
      blade.vy *= arena.bounce;
      const shielded = blade.shieldUntil && now < blade.shieldUntil;
      const spinLoss = shielded ? 0.02 : 0.05;
      blade.spin = clamp(blade.spin - spinLoss, 0, 2.5);

      const speed = Math.hypot(blade.vx, blade.vy);
      if (speed > SAFE_WALL_SPEED_THRESHOLD) {
        const damage = speed > SAFE_WALL_SPEED_THRESHOLD * 1.6 ? SAFE_DAMAGE_WALL + 1 : SAFE_DAMAGE_WALL;
        const eliminated = applyDamage(blade, damage, now, "ringout");
        if (eliminated) removed.add(blade.id);
      }
    }
  }

  for (let i = 0; i < blades.length; i += 1) {
    for (let j = i + 1; j < blades.length; j += 1) {
      const a = blades[i];
      const b = blades[j];
      if (removed.has(a.id) || removed.has(b.id)) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minDist = a.radius + b.radius;
      if (dist > 0 && dist < minDist) {
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = minDist - dist;
        a.x -= nx * overlap * 0.5;
        a.y -= ny * overlap * 0.5;
        b.x += nx * overlap * 0.5;
        b.y += ny * overlap * 0.5;

        const dvx = b.vx - a.vx;
        const dvy = b.vy - a.vy;
        const impact = dvx * nx + dvy * ny;
        if (impact < 0) {
          const impulse = -impact * 0.8;
          a.vx -= impulse * nx;
          a.vy -= impulse * ny;
          b.vx += impulse * nx;
          b.vy += impulse * ny;
        }
        const shieldA = a.shieldUntil && now < a.shieldUntil;
        const shieldB = b.shieldUntil && now < b.shieldUntil;
        const loss = 0.03;
        a.spin = clamp(a.spin - (shieldA ? loss * 0.4 : loss), 0, 2.5);
        b.spin = clamp(b.spin - (shieldB ? loss * 0.4 : loss), 0, 2.5);

        const relSpeed = Math.hypot(dvx, dvy);
        if (relSpeed > SAFE_COLLISION_SPEED_THRESHOLD) {
          const damage = relSpeed > SAFE_COLLISION_SPEED_THRESHOLD * 1.7
            ? SAFE_DAMAGE_COLLISION + 1
            : SAFE_DAMAGE_COLLISION;
          if (applyDamage(a, damage, now, "collision")) removed.add(a.id);
          if (applyDamage(b, damage, now, "collision")) removed.add(b.id);
        }
      }
    }
  }

  for (const blade of arena.blades.values()) {
    if (removed.has(blade.id)) continue;
    const idleTime = now - blade.lastActionAt;
    const speed = Math.hypot(blade.vx, blade.vy);
    if (blade.spin < 0.15 && speed < 0.002 && idleTime > 15000) {
      removed.add(blade.id);
      markEliminated(blade, now, "spinout");
    }
  }

  if (removed.size > 0) {
    for (const id of removed.values()) {
      arena.blades.delete(id);
    }
  }

  updateRoundState(now);

  if (beybladeIo.sockets.size > 0) {
    beybladeIo.emit("state", packArenaState());
  }
}

function packArenaState() {
  const now = Date.now();
  const countdownMs = arena.round.status === "countdown"
    ? Math.max(0, arena.round.countdownEndsAt - now)
    : 0;
  const leaderboard = getLeaderboardTop(5);
  const queue = getQueueList(8);
  return {
    ts: now,
    arena: {
      radius: arena.radius,
      maxBlades: Math.max(2, SAFE_MAX_BLADES),
      tickMs: SAFE_TICK_MS
    },
    round: {
      status: arena.round.status,
      countdownMs,
      startAt: arena.round.startAt,
      shrinkStartAt: arena.round.shrinkStartAt,
      shrinkEndAt: arena.round.shrinkEndAt,
      cooldownUntil: arena.round.cooldownUntil,
      winnerId: arena.round.winnerId,
      winnerName: arena.round.winnerName,
      winnerStreak: arena.round.winnerStreak,
      banner: arena.round.banner,
      alive: arena.blades.size,
      reviveLimit: arena.round.reviveLimit,
      revivesUsed: arena.round.revivesUsed
    },
    queue,
    leaderboard,
    stats: {
      blades: arena.blades.size,
      viewers: arena.viewers.size,
      coins: Math.round(arena.totals.coins),
      gifts: arena.totals.gifts,
      revenueUsd: arena.totals.revenueUsd
    },
    events: arena.events.slice(-12),
    blades: [...arena.blades.values()].map(blade => ({
      id: blade.id,
      name: blade.name,
      color: blade.color,
      x: blade.x,
      y: blade.y,
      vx: blade.vx,
      vy: blade.vy,
      spin: blade.spin,
      energy: blade.energy,
      radius: blade.radius,
      hp: blade.hp ?? SAFE_HP_MAX,
      hpMax: blade.hpMax ?? SAFE_HP_MAX,
      stamina: blade.stamina ?? SAFE_STAMINA_MAX,
      staminaMax: blade.staminaMax ?? SAFE_STAMINA_MAX,
      class: blade.class || "balanced",
      shielded: blade.shieldUntil ? blade.shieldUntil > now : false
    }))
  };
}

beybladeIo.on("connection", (socket) => {
  const viewerId = normalizeViewerId(socket.handshake.auth?.viewerId || socket.id, socket.handshake.auth?.viewerName);
  const viewerName = safeText(socket.handshake.auth?.viewerName || "Viewer");
  const viewer = getOrCreateViewer(viewerId, viewerName);
  socket.data.viewerId = viewerId;

  socket.emit("welcome", { viewerId, viewerName: viewer.name, color: viewer.color });
  socket.emit("state", packArenaState());

  socket.on("register", ({ viewerName: newName }) => {
    const updated = safeText(newName, 22);
    if (updated) {
      viewer.name = updated;
      const blade = arena.blades.get(viewer.id);
      if (blade) blade.name = updated;
      pushArenaEvent("name", `Viewer updated name to ${updated}.`);
    }
  });

  socket.on("control", ({ action, angle, message, dx, dy, magnitude }) => {
    if (action === "chat" && message) {
      handleBeybladeEvent({ type: "chat", userId: viewer.id, userName: viewer.name, message }, "web");
      return;
    }
    if (!action) return;
    applyCommand(viewer, { type: action, angle, dx, dy, magnitude }, "web");
  });

  socket.on("spawn", () => applyCommand(viewer, { type: "spawn" }, "web"));
});

app.post("/api/beyblade/events", (req, res) => {
  if (BEYBLADE_INGEST_SECRET) {
    const token = req.headers["x-beyblade-secret"] || req.headers.authorization;
    const clean = String(token || "").replace(/^Bearer\s+/i, "");
    if (clean !== BEYBLADE_INGEST_SECRET) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
  }
  const event = req.body || {};
  if (!event.type) return res.status(400).json({ ok: false, error: "missing type" });
  handleBeybladeEvent(event, "ingest");
  return res.json({ ok: true });
});

app.get("/api/beyblade/state", (_, res) => res.json(packArenaState()));

setInterval(stepArena, Math.max(30, SAFE_TICK_MS));

/* ===== Konstantes ===== */
const RANKS_36 = ["6","7","8","9","10","J","Q","K","A"];
const RANKS_52 = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
const SUITS = ["♣","♦","♥","♠"];
const MAX_PLAYERS = 6;
const BOT_STEP_MIN = 600;
const BOT_STEP_MAX = 1200;
const RECONNECT_GRACE_MS = 30_000;

/* ===== Palīgi ===== */
const nextIndex = (i, list) => (i + 1) % list.length;
const rankValue = (r, ranks) => ranks.indexOf(r);
const now = () => Date.now();
const rand = (a,b)=>Math.floor(a + Math.random()*(b-a+1));

function shuffle(arr){ for (let i=arr.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [arr[i],arr[j]]=[arr[j],arr[i]]; } return arr; }
function makeDeck(mode){ const ranks = mode==="52" ? RANKS_52 : RANKS_36; const d=[]; for(const s of SUITS) for(const r of ranks) d.push({ r,s,id:`${r}${s}-${Math.random().toString(36).slice(2,8)}` }); return shuffle(d); }
function initDeck(mode){ const full=makeDeck(mode); const trumpCard=full[0]; const deck=full.slice(1); return { deck, trumpCard, trumpSuit: trumpCard.s, trumpAvailable:true, ranks:(mode==="52"?RANKS_52:RANKS_36) }; }
function canCover(attack, defend, trump, ranks){
  if (!attack || !defend) return false;
  if (defend.s === attack.s) return rankValue(defend.r, ranks) > rankValue(attack.r, ranks);
  if (attack.s !== trump && defend.s === trump) return true;
  if (attack.s === trump && defend.s === trump) return rankValue(defend.r, ranks) > rankValue(attack.r, ranks);
  return false;
}
function tableRanks(room){ const s=new Set(); for (const pr of room.table){ if (pr.attack) s.add(pr.attack.r); if (pr.defend) s.add(pr.defend.r); } return s; }
function maxPairsAllowed(room){ const def = room.players[room.defender]; return Math.min(6, def?.hand?.length || 0); }

/* ===== Sanitizācija ===== */
const SAFE_ROOM = /^[a-z0-9\-_]{1,24}$/i;
const SAFE_NICK = /^.{1,20}$/s;
function cleanRoomId(x){ x=String(x||"").trim(); if (!SAFE_ROOM.test(x)) throw new Error("Nederīgs istabas ID"); return x; }
function cleanNick(x){ x=String(x||"").trim(); if (!SAFE_NICK.test(x)) throw new Error("Nederīgs segvārds"); return x; }

/* ===== DROŠĪBAS JOSTAS ===== */
function withRoomLock(room, fn) {
  room._lock = room._lock || Promise.resolve();
  room._lock = room._lock.then(async () => {
    try { await fn(); } catch (e) { console.error("Room action error:", e); }
  });
  return room._lock;
}

// Stingra uzbrukuma validācija
function validateAttackAllowed(room, attackerIdx, card) {
  if (attackerIdx === room.defender) throw new Error("Aizsargs nevar uzbrukt");
  const limit = maxPairsAllowed(room);
  if (room.table.length >= limit) throw new Error("Sasniegts pāru limits");
  const ranksOnTable = tableRanks(room);
  const canAdd = room.table.length === 0 || ranksOnTable.has(card.r);
  if (!canAdd) throw new Error("Jāliek tāda paša ranga kārts");
}

/* ===== Invarianti ===== */
function enforceInvariants(room) {
  if (!room) return;
  const limit = maxPairsAllowed(room);
  if (room.table.length > limit) {
    const la = room.lastAction;
    if (la && (la.type === "attack" || la.type === "attackMany")) {
      const actor = room.players.find(p => p.id === la.playerId);
      if (actor) {
        for (let i = room.table.length - 1; i >= 0 && room.table.length > limit; i--) {
          const pr = room.table[i];
          if (!pr.defend) {
            actor.hand.push(pr.attack);
            room.table.splice(i, 1);
          }
        }
      }
    }
  }
  const trump = room.trumpSuit, ranks = room.ranks;
  const defender = room.players[room.defender];
  for (const pr of room.table) {
    if (pr.defend && !canCover(pr.attack, pr.defend, trump, ranks)) {
      if (defender) defender.hand.push(pr.defend);
      pr.defend = undefined;
    }
  }
}

/* ===== Rate-limit ===== */
const lastActionTs = new Map();
function allowAction(socketId) {
  const t = Date.now();
  const arr = lastActionTs.get(socketId) || [];
  const recent = arr.filter(x => t - x < 1000);
  if (recent.length >= 3) return false;
  recent.push(t);
  lastActionTs.set(socketId, recent);
  return true;
}

/* ===== Globālās struktūras ===== */
const rooms = new Map();
const sessions = new Map(); // cid -> { socketId, roomId }

/* ===== Leaderboard ===== */
const leaderboard = {
  all: new Map(),
  daily: new Map(),
  weekly: new Map(),
  lastRotateDay: new Date().toISOString().slice(0,10),
  lastRotateWeek: getWeekKey(new Date())
};
function getWeekKey(d){
  const dt = new Date(d.getTime());
  dt.setHours(0,0,0,0);
  const first = new Date(dt.getFullYear(),0,1);
  const diff = Math.floor((dt-first)/86400000);
  const week = Math.floor((diff + first.getDay()+6)/7)+1;
  return `${dt.getFullYear()}-W${String(week).padStart(2,"0")}`;
}
function rotateBoardsIfNeeded(){
  const today = new Date().toISOString().slice(0,10);
  if (leaderboard.lastRotateDay !== today){
    leaderboard.daily = new Map();
    leaderboard.lastRotateDay = today;
  }
  const wk = getWeekKey(new Date());
  if (leaderboard.lastRotateWeek !== wk){
    leaderboard.weekly = new Map();
    leaderboard.lastRotateWeek = wk;
  }
}
function bumpStats(cid, nick, updater){
  rotateBoardsIfNeeded();
  for (const scope of ["all","daily","weekly"]){
    const map = leaderboard[scope];
    const cur = map.get(cid) || { cid, lastNick: nick, wins:0, cleanDefends:0, fastestMs:null };
    updater(cur);
    cur.lastNick = nick || cur.lastNick;
    map.set(cid, cur);
  }
}
function asSortedArray(map, key){
  return [...map.values()].sort((a,b)=>{
    if (key==="fastestMs"){
      if (a.fastestMs==null && b.fastestMs==null) return 0;
      if (a.fastestMs==null) return 1;
      if (b.fastestMs==null) return -1;
      return a.fastestMs - b.fastestMs;
    }
    return (b[key]||0) - (a[key]||0);
  }).slice(0,50);
}

/* ===== Rangi ===== */
const RANKS_BY_WINS = [
  { name: "Jaunpienācējs", min: 0 },{ name: "Iesācējs", min: 1 },
  { name: "Kāršu Skolnieks", min: 3 },{ name: "Gudrinieks", min: 5 },
  { name: "Viltīgais", min: 8 },{ name: "Stratēģis", min: 12 },
  { name: "Mūrnieks", min: 17 },{ name: "Komandieris", min: 23 },
  { name: "Kapteinis", min: 30 },{ name: "Taktikas Lietpratējs", min: 40 },
  { name: "Dūzis", min: 55 },{ name: "Meistars", min: 75 },
  { name: "Lielmeistars", min: 100 },{ name: "Virsmeistars", min: 130 },
  { name: "Grandmeistars", min: 170 },{ name: "Neuzvaramais", min: 220 },
  { name: "Leģenda", min: 280 },{ name: "Teiksmainais", min: 350 },
  { name: "Nemirstīgais", min: 450 },{ name: "Dievišķais", min: 600 },
  { name: "Kosmiskais", min: 800 },{ name: "Mūžīgais Meistars", min: 1000 },
];
const rankForWins = wins => {
  let name = RANKS_BY_WINS[0].name;
  for (const r of RANKS_BY_WINS) if (wins >= r.min) name = r.name;
  return name;
};
const getTotalWins = cid => leaderboard.all.get(cid)?.wins || 0;

/* ===== Flow ===== */
function drawOne(room){
  if (room.deck.length>0) return room.deck.pop();
  if (room.trumpAvailable){ room.trumpAvailable=false; return room.trumpCard; }
  return null;
}
function dealUpToSix(room){
  let i = room.attacker;
  for (let k=0;k<room.players.length;k++){
    const p = room.players[i];
    if (!p.spectator){
      while (p.hand.length < 6) { const c = drawOne(room); if(!c) break; p.hand.push(c); }
    }
    i = nextIndex(i, room.players);
  }
}
const activePlayers = room => room.players.filter(p=>!p.spectator);
function endBoutDefended(room){
  for (const pr of room.table){ room.discard.push(pr.attack); if (pr.defend) room.discard.push(pr.defend); }
  room.table = [];
  dealUpToSix(room);
  room.attacker = room.defender;
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.undoUsed = new Set();
  room.lastAction = undefined;
  room.phase = "attack";
  room.boutCount++;
}
function endBoutTook(room){
  const def = room.players[room.defender];
  for (const pr of room.table){ def.hand.push(pr.attack); if (pr.defend) def.hand.push(pr.defend); }
  room.table = [];
  dealUpToSix(room);
  room.attacker = nextIndex(room.defender, room.players);
  room.defender = nextIndex(room.attacker, room.players);
  room.passes = new Set();
  room.undoUsed = new Set();
  room.lastAction = undefined;
  room.phase = "attack";
  room.boutCount++;
  room.comboCandidate = null;
}
function checkGameEnd(room){
  const act = activePlayers(room);
  const still = act.filter(p=>p.hand.length>0);
  if (still.length <= 1){
    room.phase = "end";
    const winners = act.filter(p=>p.hand.length===0);
    io.to(room.id).emit("end", { losers: still.map(p=>p.nick), winners: winners.map(p=>p.nick) });

    const dur = now() - (room.startedAt||now());
    for (const w of winners){
      const cid = w.cid || w.id;
      const beforeWins = getTotalWins(cid);
      bumpStats(cid, w.nick, (s)=>{ 
        s.wins = (s.wins||0)+1; 
        if (s.fastestMs==null || dur < s.fastestMs) s.fastestMs = dur; 
      });
      const afterWins = getTotalWins(cid);
      const beforeRank = rankForWins(beforeWins);
      const afterRank  = rankForWins(afterWins);
      if (afterRank !== beforeRank){
        io.to(room.id).emit("rankUpdate", {
          cid, nick: w.nick, wins: afterWins, newRank: afterRank, prevRank: beforeRank
        });
      }
    }
    for (const l of still){ /* nolauž uzvaru sēriju, ja tādu glabā */
      // streaks.set(l.cid||l.id, 0);
    }
    room.lastAction = undefined;
    room.comboCandidate = null;
    return true;
  }
  return false;
}

/* ===== BOT ===== */
function clearBotTimer(room){ if (room.botTimer){ clearTimeout(room.botTimer); room.botTimer = undefined; } }
function schedule(room, fn, d){ clearBotTimer(room); room.botTimer = setTimeout(fn, d); }
function botShouldPlay(room){
  if (room.phase !== "attack") return false;
  const a=room.players[room.attacker], d=room.players[room.defender];
  return (a?.isBot || d?.isBot);
}
const botThinkDelay = room => room.botStepMs || rand(BOT_STEP_MIN, BOT_STEP_MAX);
function msg(room, text){ room.chat.push(text); if (room.chat.length>200) room.chat.splice(0, room.chat.length-200); io.to(room.id).emit("message", text); emitState(room); }

function botOneStep(room){
  if (room.phase !== "attack") return false;
  const aI=room.attacker, dI=room.defender;
  const A=room.players[aI], D=room.players[dI];
  const trump = room.trumpSuit, ranks=room.ranks;

  if (D?.isBot){
    const open = room.table.map((p,i)=>!p.defend?i:-1).filter(i=>i>=0);
    if (open.length){
      const i=open[0], atk=room.table[i].attack;
      const cand = D.hand.filter(c=>canCover(atk,c,trump,ranks)).sort((x,y)=>rankValue(x.r,ranks)-rankValue(y.r,ranks));
      if (cand.length){
        const card=cand[0];
        D.hand.splice(D.hand.findIndex(c=>c.id===card.id),1);
        room.table[i].defend=card;
        room.lastAction = { type:"defend", playerId:D.id, cards:[card], pairIndex:i };
        msg(room, `BOT aizsedz ${atk.r}${atk.s} ar ${card.r}${card.s}`);
        enforceInvariants(room);
        const allCovered = room.table.length>0 && room.table.every(p=>p.defend);
        if (allCovered && room.passes.size === activePlayers(room).length-1){
          endBoutDefended(room);
          if (!checkGameEnd(room)) msg(room, "Viss aizsegts — nākamais bauta.");
          else return true;
        }
        return true;
      }
      endBoutTook(room);
      msg(room, "BOT nevar aizsegt — ņem kārtis.");
      return true;
    }
  }

  if (A?.isBot){
    const ranksOnTable = tableRanks(room);
    const spaceLeft = maxPairsAllowed(room) - room.table.length;
    if (spaceLeft <= 0){ room.passes.add(A.id); room.lastAction=undefined; return true; }

    const hand = A.hand.slice().sort((a,b)=>{
      const at=(a.s===trump), bt=(b.s===trump);
      if (at!==bt) return at-bt;
      return rankValue(a.r,ranks)-rankValue(b.r,ranks);
    });

    let card=null;
    if (room.table.length===0) card = hand.find(c=>c.s!==trump) || hand[0];
    else card = hand.find(c=>ranksOnTable.has(c.r)) || null;

    if (card){
      A.hand.splice(A.hand.findIndex(c=>c.id===card.id),1);
      room.table.push({ attack: card });
      room.passes.delete(A.id);
      room.lastAction = { type:"attack", playerId:A.id, cards:[card], pairIndices:[room.table.length-1] };
      enforceInvariants(room);
      msg(room, `BOT uzbrūk ar ${card.r}${card.s}`);
      return true;
    } else {
      room.passes.add(A.id);
      room.lastAction=undefined;
      const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
      if (allCovered && room.passes.size === activePlayers(room).length-1){
        endBoutDefended(room);
        if (!checkGameEnd(room)) msg(room, "Viss aizsegts — nākamais bauta.");
      }
      return true;
    }
  }
  return false;
}
function runBot(room){
  if (room.phase !== "attack") return;
  let did = false;
  try { did = botOneStep(room); }
  catch(e){ console.error("BOT step error:", e); did = false; }
  emitState(room);
  if (checkGameEnd(room)) return;
  if (did && botShouldPlay(room)) schedule(room, ()=>runBot(room), botThinkDelay(room));
}

/* ===== Redzamība ===== */
function visibleState(room, sid){
  const me = room.players.find(p=>p.id===sid);
  return {
    id: room.id, phase: room.phase,
    hostId: room.hostId,
    trumpSuit: room.trumpSuit, trumpCard: room.trumpCard,
    deckCount: room.deck.length + (room.trumpAvailable?1:0),
    discardCount: room.discard.length,
    attacker: room.attacker, defender: room.defender,
    table: room.table,
    players: room.players.map((p,i)=>{
      const wins = getTotalWins(p.cid||p.id);
      return {
        nick: p.nick, handCount: p.hand.length, me: p.id===sid, index: i,
        isBot: p.isBot, ready: p.ready, spectator: p.spectator,
        rankWins: rankForWins(wins), winsLifetime: wins
      };
    }),
    myHand: (me && !me.spectator) ? me.hand : [],
    chat: room.chat.slice(-60),
    settings: room.settings,
    youSpectator: !!me?.spectator,
    meCanUndo: !!room.lastAction && room.lastAction.playerId===sid && room.phase==="attack",
    undoLeftThisBout: me ? (room.undoUsed?.has(me.id)?0:1) : 0,
    serverTime: Date.now()
  };
}
const emitState = room => { for (const p of room.players) io.to(p.id).emit("state", visibleState(room,p.id)); };

/* ===== Host reassignment ===== */
function reassignHost(room){
  const next = room.players.find(p=>!p.spectator) || room.players[0];
  if (next) room.hostId = next.id;
}
function replaceWithBot(room, idx){
  const left = room.players[idx];
  room.players[idx] = { id:`bot-${Math.random().toString(36).slice(2,7)}`, cid:`bot-${Math.random().toString(36).slice(2,5)}`, nick:"BOT", hand:left.hand||[], isBot:true, ready:true, connected:true, spectator:false, lastSeen:now() };
}

/* ===== Publiskie API (istabu saraksts/leaderboard) ===== */
app.get("/api/rooms", (_, res)=>{
  const list = [...rooms.values()].map(r=>{
    const playing = r.players.filter(p=>!p.spectator);
    return {
      id: r.id,
      status: r.phase,
      players: playing.length,
      spectators: r.players.length - playing.length,
      deckMode: r.settings.deckMode,
      trump: `${r.trumpCard?.r||""}${r.trumpSuit||""}`
    };
  });
  res.json({ rooms: list });
});

app.get("/api/leaderboard", (req,res)=>{
  rotateBoardsIfNeeded();
  const period = (req.query.period||"all").toString(); // all|daily|weekly
  const type   = (req.query.type||"wins").toString();  // wins|clean|fastest
  const src = leaderboard[period]||leaderboard.all;

  let key = "wins";
  if (type==="clean") key="cleanDefends";
  if (type==="fastest") key="fastestMs";

  const rows = asSortedArray(src, key).map(s=>({
    cid:s.cid, nick:s.lastNick, wins:s.wins||0, clean:s.cleanDefends||0, fastestMs:s.fastestMs
  })).slice(0,50);
  res.json({ period, type, rows });
});

/* ===== Sockets ===== */
io.on("connection", (socket) => {
  const err = (m)=>socket.emit("gameError", m);
  const cid = socket.handshake.auth?.cid || socket.handshake.query?.cid || null;

  // Reconnect ar hostId atjaunošanu
  if (cid && sessions.has(cid)){
    const sess = sessions.get(cid);
    const room = rooms.get(sess.roomId);
    if (room){
      const p = room.players.find(pl => pl.id === sess.socketId || pl.cid === cid);
      if (p){
        const oldSocketId = p.id;
        p.id = socket.id; p.connected = true; p.lastSeen = now();
        sessions.set(cid, { socketId: socket.id, roomId: room.id });
        socket.join(room.id);
        if (room.hostId === oldSocketId) room.hostId = socket.id;
        emitState(room);
      }
    }
  }

  socket.on("createRoom", ({ roomId, nickname, deckMode }) => {
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību. Mēģini pēc mirkļa.");
    try{ roomId = cleanRoomId(roomId); nickname = cleanNick(nickname||"Spēlētājs"); }catch(e){ return err(e.message); }
    if (rooms.has(roomId)) return err("Istaba jau eksistē");

    const useDeck = deckMode==="52" ? "52" : "36";
    const { deck, trumpCard, trumpSuit, trumpAvailable, ranks } = initDeck(useDeck);

    const room = {
      id: roomId, hostId: socket.id,
      players: [{ id: socket.id, cid: cid||socket.id, nick: nickname, hand: [], isBot:false, ready:false, connected:true, spectator:false, lastSeen:now() }],
      deck, discard: [], trumpCard, trumpSuit, trumpAvailable, ranks,
      table: [], attacker:0, defender:0, phase:"lobby",
      passes: new Set(), chat:[],
      settings: { deckMode: useDeck },
      botStepMs: undefined,
      lastAction: undefined,
      undoUsed: new Set(),
      createdAt: now(), startedAt: null, boutCount: 0,
      comboCandidate: null
    };
    rooms.set(roomId, room);
    if (cid) sessions.set(cid, { socketId: socket.id, roomId: roomId });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("joinRoom", ({ roomId, nickname }) => {
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību. Mēģini pēc mirkļa.");
    try{ roomId = cleanRoomId(roomId); nickname = cleanNick(nickname||"Spēlētājs"); }catch(e){ return err(e.message); }
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (room.phase !== "lobby") return err("Spēle jau sākusies");

    const playing = room.players.filter(p=>!p.spectator).length;
    const spectator = playing >= MAX_PLAYERS;
    room.players.push({ id: socket.id, cid: cid||socket.id, nick: nickname, hand: [], isBot:false, ready:false, connected:true, spectator, lastSeen:now() });
    if (cid) sessions.set(cid, { socketId: socket.id, roomId });
    socket.join(roomId);
    emitState(room);
  });

  socket.on("toggleReady", ({ roomId }) => {
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    try{ roomId = cleanRoomId(roomId); }catch(e){ return err(e.message); }
    const room = rooms.get(roomId);
    if (!room || room.phase!=="lobby") return;
    const p = room.players.find(pl=>pl.id===socket.id);
    if (!p || p.spectator) return;
    p.ready = !p.ready;
    emitState(room);
  });

  function chooseFirstAttacker(room){
    let best = { have:false, val:Infinity, idx:0 };
    room.players.forEach((p, idx) => {
      if (p.spectator) return;
      p.hand.forEach(c => { if (c.s===room.trumpSuit){ const v=rankValue(c.r,room.ranks); if (v<best.val) best={have:true,val:v,idx}; } });
    });
    room.attacker = best.have ? best.idx : room.players.findIndex(p=>!p.spectator);
    if (room.attacker < 0) room.attacker = 0;
    room.defender = nextIndex(room.attacker, room.players);
    while (room.players[room.defender]?.spectator) room.defender = nextIndex(room.defender, room.players);
  }

  function startGame(room, botStepMs){
    if (room.phase !== "lobby") return "Spēle jau ir sākusies";

    const actives = room.players.filter(p => !p.spectator);
    const humans  = actives.filter(p => !p.isBot);

    if (humans.length >= 2) {
      humans.forEach(p => p.ready = true);
    }
    if (humans.length === 1) {
      const hasBot = actives.some(p => p.isBot);
      if (!hasBot) {
        const botId = `bot-${Math.random().toString(36).slice(2,7)}`;
        room.players.push({
          id: botId, cid: botId, nick: "BOT", hand: [],
          isBot: true, ready: true, connected: true, spectator: false, lastSeen: now()
        });
      }
    }

    if (room.players.filter(p => !p.spectator).length < 2) {
      return "Vajag vismaz 2 spēlētājus";
    }

    const activeBots = room.players.filter(p => !p.spectator && p.isBot);
    if (activeBots.length > 1) {
      for (let i = 1; i < activeBots.length; i++) {
        const idx = room.players.indexOf(activeBots[i]);
        if (idx >= 0) room.players.splice(idx, 1);
      }
    }

    const { deck, trumpCard, trumpSuit, trumpAvailable, ranks } = initDeck(room.settings.deckMode);
    room.deck=deck; room.trumpCard=trumpCard; room.trumpSuit=trumpSuit; room.trumpAvailable=trumpAvailable; room.ranks=ranks;

    room.discard=[]; room.table=[]; room.passes=new Set(); room.phase="attack";
    room.botStepMs = (botStepMs && botStepMs>=400 && botStepMs<=2000) ? botStepMs : undefined;
    room.lastAction = undefined;
    room.undoUsed = new Set();
    room.startedAt = now();
    room.boutCount = 0;
    room.comboCandidate = null;

    for (const p of room.players) if (!p.spectator) {
      while (p.hand.length<6){ const c=drawOne(room); if(!c) break; p.hand.push(c); }
    }
    chooseFirstAttacker(room);

    msg(room, `Trumpis: ${room.trumpCard.r}${room.trumpCard.s} | Kava: ${room.settings.deckMode}`);
    emitState(room);
    if (botShouldPlay(room)) setTimeout(()=>runBot(room), botThinkDelay(room));
    return null;
  }

  socket.on("startGame", ({ roomId, botStepMs }) => {
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    try{ roomId = cleanRoomId(roomId); }catch(e){ return err(e.message); }
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (socket.id !== room.hostId) return err("Tikai host var sākt");
    const problem = startGame(room, botStepMs);
    if (problem) return err(problem);
  });

  socket.on("playAgain", ({ roomId, botStepMs }) => {
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību.");
    try{ roomId = cleanRoomId(roomId); }catch(e){ return err(e.message); }
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (socket.id !== room.hostId) return err("Tikai host var sākt");
    for (const p of room.players) { p.hand=[]; if(!p.spectator) p.ready=true; }
    const problem = startGame(room, botStepMs);
    if (problem) return err(problem);
  });

  socket.on("deleteRoom", ({ roomId }) => {
    try{ roomId = cleanRoomId(roomId); }catch(e){ return err(e.message); }
    const room = rooms.get(roomId);
    if (!room) return err("Istaba nav atrasta");
    if (socket.id !== room.hostId) return err("Tikai host drīkst dzēst istabu");
    io.to(room.id).emit("roomDeleted");
    for (const p of room.players) io.sockets.sockets.get(p.id)?.leave(room.id);
    rooms.delete(room.id);
  });

  // ===== Spēles darbības =====
  socket.on("playAttack", ({ roomId, card }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību. Pamēģini vēlreiz.");
    withRoomLock(room, () => {
      try {
        const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
        const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar uzbrukt");
        validateAttackAllowed(room, idx, card);
        const hi=me.hand.findIndex(c=>c.id===card.id); if (hi<0) throw new Error("Tev tādas kārts nav");
        const realCard = me.hand[hi];

        me.hand.splice(hi,1);
        room.table.push({ attack: realCard });
        room.passes.delete(me.id);
        room.lastAction = { type:"attack", playerId: me.id, cards:[realCard], pairIndices:[room.table.length-1] };

        enforceInvariants(room);
        emitState(room);
        if (botShouldPlay(room)) schedule(room, ()=>runBot(room), botThinkDelay(room));
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
  });

  socket.on("playAttackMany", ({ roomId, cards }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību. Pamēģini vēlreiz.");
    withRoomLock(room, () => {
      try {
        const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
        const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar uzbrukt");
        if (!Array.isArray(cards)||!cards.length) throw new Error("Nav kāršu");
        const ranksOnTable = tableRanks(room);

        const addedCards=[], addedPairs=[];
        for (const card of cards){
          if (room.table.length >= maxPairsAllowed(room)) break;
          const hi=me.hand.findIndex(c=>c.id===card.id); if (hi<0) continue;
          const canAdd = room.table.length===0 || ranksOnTable.has(card.r);
          if (!canAdd) continue;
          const realCard = me.hand[hi];
          me.hand.splice(hi,1);
          room.table.push({ attack: realCard });
          ranksOnTable.add(realCard.r);
          addedCards.push(realCard);
          addedPairs.push(room.table.length-1);
        }
        if (!addedCards.length) throw new Error("Nevarēja pievienot izvēlētās kārtis");

        room.passes.delete(me.id);
        room.lastAction = { type:"attackMany", playerId: me.id, cards: addedCards, pairIndices: addedPairs };

        enforceInvariants(room);
        emitState(room);
        if (botShouldPlay(room)) schedule(room, ()=>runBot(room), botThinkDelay(room));
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
  });

  socket.on("playDefend", ({ roomId, attackIndex, card }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību. Pamēģini vēlreiz.");
    withRoomLock(room, () => {
      try {
        const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
        const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar aizsegt");
        if (idx !== room.defender) throw new Error("Tikai aizsargs drīkst aizsegt");

        const pair = room.table[attackIndex]; if(!pair || pair.defend) throw new Error("Nepareizs pāris");
        const hi=me.hand.findIndex(c=>c.id===card.id); if(hi<0) throw new Error("Tev tādas kārts nav");
        const realCard = me.hand[hi];
        if (!canCover(pair.attack, realCard, room.trumpSuit, room.ranks)) throw new Error("Ar šo kārti nevar aizsegt");

        me.hand.splice(hi,1);
        pair.defend = realCard;
        room.lastAction = { type:"defend", playerId: me.id, cards:[realCard], pairIndex: attackIndex };

        enforceInvariants(room);

        const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
        if (allCovered && room.passes.size === activePlayers(room).length-1){
          endBoutDefended(room);
          if (!checkGameEnd(room)) emitState(room);
        } else {
          emitState(room);
        }
        if (botShouldPlay(room)) schedule(room, ()=>runBot(room), botThinkDelay(room));
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
  });

  socket.on("undoLast", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību. Pamēģini vēlreiz.");
    withRoomLock(room, () => {
      try {
        const la = room.lastAction; 
        if (!la || la.playerId !== socket.id) throw new Error("Nevari atsaukt");
        if (room.undoUsed?.has(socket.id)) throw new Error("Atsaukums jau izmantots šajā bautā");
        const me = room.players.find(p=>p.id===socket.id);
        if (!me || me.spectator) throw new Error("Nevari atsaukt");

        if (la.type === "defend"){
          const i = la.pairIndex;
          const pair = room.table[i];
          if (!pair || !pair.defend || pair.defend.id !== la.cards[0].id) throw new Error("Vairs nevar atsaukt");
          me.hand.push(pair.defend);
          pair.defend = undefined;
          room.lastAction = undefined;
        } else if (la.type === "attack"){
          const i = la.pairIndices?.[0];
          const pair = room.table[i];
          if (!pair || pair.defend) throw new Error("Vairs nevar atsaukt");
          me.hand.push(pair.attack);
          room.table.splice(i,1);
          room.lastAction = undefined;
        } else if (la.type === "attackMany"){
          const indices = (la.pairIndices||[]).slice().sort((a,b)=>b-a);
          let restored=0;
          for (const i of indices){
            const pair = room.table[i];
            if (pair && !pair.defend){
              me.hand.push(pair.attack);
              room.table.splice(i,1);
              restored++;
            }
          }
          if (!restored) throw new Error("Vairs nevar atsaukt");
          room.lastAction = undefined;
        }
        room.undoUsed.add(socket.id);
        enforceInvariants(room);
        emitState(room);
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
  });

  socket.on("takeCards", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību. Pamēģini vēlreiz.");
    withRoomLock(room, () => {
      try {
        const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
        const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar ņemt");
        if (idx !== room.defender) throw new Error("Tikai aizsargs var ņemt");
        room.lastAction = undefined;
        endBoutTook(room);
        if (!checkGameEnd(room)) emitState(room);
        if (botShouldPlay(room)) schedule(room, ()=>runBot(room), botThinkDelay(room));
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
  });

  socket.on("pass", ({ roomId }) => {
    const room = rooms.get(roomId); if(!room || room.phase!=="attack") return;
    if (!allowAction(socket.id)) return err("Pārāk daudz darbību. Pamēģini vēlreiz.");
    withRoomLock(room, () => {
      try {
        const idx = room.players.findIndex(p=>p.id===socket.id); if(idx<0) throw new Error("Nav spēlētāja");
        const me = room.players[idx]; if (me.spectator) throw new Error("Skatītājs nevar pasēt");
        if (idx===room.defender) throw new Error("Aizsargs nevar pasēt");

        room.passes.add(me.id);
        room.lastAction = undefined;

        const allCovered = room.table.length>0 && room.table.every(x=>x.defend);
        if (allCovered && room.passes.size === activePlayers(room).length-1){
          endBoutDefended(room);
          if (!checkGameEnd(room)) emitState(room);
        } else {
          emitState(room);
        }
        if (botShouldPlay(room)) schedule(room, ()=>runBot(room), botThinkDelay(room));
      } catch (e) { err(e.message||"Kļūda"); emitState(room); }
    });
  });

  socket.on("chat", ({ roomId, text }) => {
    const room = rooms.get(roomId); if(!room || !text) return;
    const p = room.players.find(pl=>pl.id===socket.id); if(!p) return;
    const line = `${p.nick}: ${String(text).slice(0,200)}`;
    room.chat.push(line); if (room.chat.length>200) room.chat.splice(0, room.chat.length-200);
    io.to(room.id).emit("message", room.chat[room.chat.length-1]);
    emitState(room);
  });

  socket.on("leaveRoom", ({ roomId }) => {
    try{ roomId = cleanRoomId(roomId); }catch(e){ /* ignore */ }
    const room = rooms.get(roomId); if(!room) return;
    const idx = room.players.findIndex(p=>p.id===socket.id);
    if (idx<0) return;
    const leaving = room.players[idx];

    if (room.hostId === leaving.id) reassignHost(room);

    if (room.phase === "lobby"){
      room.players.splice(idx,1);
    } else {
      if (!leaving.spectator) replaceWithBot(room, idx);
      else room.players.splice(idx,1);
      room.lastAction = undefined;
    }
    if (activePlayers(room).length === 0){ rooms.delete(room.id); return; }
    emitState(room);
  });

  socket.on("disconnect", () => {
    const dcTime = now();
    lastActionTs.delete(socket.id);
    for (const room of rooms.values()){
      const i = room.players.findIndex(p=>p.id===socket.id);
      if (i>=0){
        const p = room.players[i];
        p.connected = false; p.lastSeen = dcTime;
        setTimeout(()=>{
          if (!rooms.has(room.id)) return;
          const still = room.players[i];
          if (!still || still.connected) return;
          if (room.phase === "lobby"){
            room.players.splice(i,1);
          } else {
            if (!still.spectator) replaceWithBot(room, i);
            else room.players.splice(i,1);
          }
          emitState(room);
        }, RECONNECT_GRACE_MS);
      }
    }
  });
});

const PORT = process.env.PORT || 10000; // Render free port
httpServer.listen(PORT, () => console.log("Duraks serveris klausās uz porta " + PORT));
