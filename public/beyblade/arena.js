const canvas = document.getElementById("arena");
const ctx = canvas.getContext("2d");

const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");
const eventsEl = document.getElementById("events");
const nameInput = document.getElementById("viewer-name");
const saveNameBtn = document.getElementById("save-name");
const spawnBtn = document.getElementById("spawn");
const boostBtn = document.getElementById("boost");
const commandInput = document.getElementById("command");
const sendBtn = document.getElementById("send");

const storageKey = "bbViewer";
const effects = [];
let seenEventIds = new Set();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function loadViewer() {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function saveViewer(viewer) {
  localStorage.setItem(storageKey, JSON.stringify(viewer));
}

function createViewerId() {
  return `viewer-${Math.random().toString(36).slice(2, 10)}`;
}

const viewer = loadViewer() || { id: createViewerId(), name: "" };
saveViewer(viewer);
nameInput.value = viewer.name || "";

const socket = io("/beyblade", {
  path: "/socket.io",
  auth: { viewerId: viewer.id, viewerName: viewer.name }
});

let state = null;
let arenaScale = 1;
const logoCanvas = document.createElement("canvas");

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  arenaScale = Math.min(canvas.width, canvas.height) * 0.45;
}

function drawTikTokLogo(target, size) {
  const scale = size / 100;
  target.save();
  target.scale(scale, scale);
  target.translate(-50, -50);

  target.fillStyle = "#00f2ea";
  target.beginPath();
  target.arc(40, 70, 18, 0, Math.PI * 2);
  target.fill();
  target.fillRect(55, 20, 14, 55);

  target.fillStyle = "#ff0050";
  target.beginPath();
  target.arc(55, 62, 18, 0, Math.PI * 2);
  target.fill();
  target.fillRect(65, 15, 14, 55);

  target.fillStyle = "#ffffff";
  target.beginPath();
  target.arc(48, 66, 14, 0, Math.PI * 2);
  target.fill();
  target.fillRect(60, 18, 10, 44);

  target.restore();
}

function buildLogoCanvas() {
  logoCanvas.width = 120;
  logoCanvas.height = 120;
  const logoCtx = logoCanvas.getContext("2d");
  logoCtx.clearRect(0, 0, logoCanvas.width, logoCanvas.height);
  drawTikTokLogo(logoCtx, 90);
}

function hexToRgb(hex) {
  const clean = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(clean)) return { r: 255, g: 209, b: 102 };
  const int = parseInt(clean, 16);
  return { r: (int >> 16) & 255, g: (int >> 8) & 255, b: int & 255 };
}

function withAlpha(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function makeGiftRays(count) {
  return Array.from({ length: count }, () => ({
    angle: Math.random() * Math.PI * 2,
    length: 0.4 + Math.random() * 0.7,
    width: 1 + Math.random() * 2
  }));
}

function spawnGiftEffect(event, payload) {
  const meta = event?.meta || {};
  const blades = payload?.blades || [];
  const target = meta.viewerId ? blades.find((blade) => blade.id === meta.viewerId) : null;
  let x = 0;
  let y = 0;
  let color = "#ffd166";
  if (target) {
    x = target.x;
    y = target.y;
    color = target.color || color;
  } else {
    const angle = Math.random() * Math.PI * 2;
    const radius = 0.2 + Math.random() * 0.45;
    x = Math.cos(angle) * radius;
    y = Math.sin(angle) * radius;
  }

  const coins = Number(meta.coins || meta.value || 0);
  const repeat = Number(meta.repeat || 1);
  const strength = clamp(1 + coins / 200 + repeat / 10, 1, 3);

  effects.push({
    id: event.id,
    type: "gift",
    x,
    y,
    color,
    startTs: payload?.ts || Date.now(),
    duration: 1400,
    strength,
    rays: makeGiftRays(Math.round(10 + strength * 10))
  });
}

function handleIncomingEvents(events, payload) {
  const nextSeen = new Set();
  (events || []).forEach((event) => {
    nextSeen.add(event.id);
    if (!seenEventIds.has(event.id) && event.type === "gift") {
      spawnGiftEffect(event, payload);
    }
  });
  seenEventIds = nextSeen;
  updateEvents(events || []);
}

function renderEffects() {
  const now = Date.now();
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  for (let i = effects.length - 1; i >= 0; i -= 1) {
    const effect = effects[i];
    const t = (now - effect.startTs) / effect.duration;
    if (t >= 1) {
      effects.splice(i, 1);
      continue;
    }
    const fade = 1 - t;
    const ease = 1 - Math.pow(1 - t, 3);
    const px = centerX + effect.x * arenaScale;
    const py = centerY + effect.y * arenaScale;
    const baseRadius = arenaScale * (0.12 + ease * 0.45 * effect.strength);
    const color = effect.color || "#ffd166";

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    ctx.strokeStyle = withAlpha(color, 0.3 * fade);
    ctx.lineWidth = 6 * effect.strength;
    ctx.beginPath();
    ctx.arc(px, py, baseRadius, 0, Math.PI * 2);
    ctx.stroke();

    const gradient = ctx.createRadialGradient(px, py, baseRadius * 0.4, px, py, baseRadius * 1.7);
    gradient.addColorStop(0, withAlpha(color, 0.25 * fade));
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(px, py, baseRadius * 1.7, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = withAlpha("#ffffff", 0.25 * fade);
    effect.rays.forEach((ray) => {
      const len = baseRadius * ray.length * (0.6 + ease * 1.2);
      ctx.lineWidth = ray.width;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(ray.angle) * len, py + Math.sin(ray.angle) * len);
      ctx.stroke();
    });

    ctx.restore();
  }
}

function updateEvents(events) {
  eventsEl.replaceChildren();
  events.forEach((event) => {
    const div = document.createElement("div");
    div.className = `event ${event.type || ""}`.trim();
    div.textContent = event.message;
    eventsEl.appendChild(div);
  });
}

function updateStats(stats) {
  if (!stats) return;
  const revenue = Number.isFinite(stats.revenueUsd) ? stats.revenueUsd.toFixed(2) : "0.00";
  statsEl.textContent = `Blades: ${stats.blades} | Viewers: ${stats.viewers} | Coins: ${stats.coins} | Est USD: ${revenue}`;
}

function renderArena() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(centerX, centerY, arenaScale, 0, Math.PI * 2);
  ctx.stroke();

  if (!state) return;
  state.blades.forEach((blade) => {
    const x = centerX + blade.x * arenaScale;
    const y = centerY + blade.y * arenaScale;
    const r = blade.radius * arenaScale;
    const isSelf = blade.id === viewer.id;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((state.ts / 800) * blade.spin);
    ctx.shadowColor = isSelf ? "rgba(0, 242, 234, 0.7)" : "rgba(0, 0, 0, 0.4)";
    ctx.shadowBlur = isSelf ? 18 : 8;

    ctx.fillStyle = blade.color || "#ffffff";
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(10, 10, 10, 0.6)";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
    ctx.fill();

    const logoSize = r * 1.1;
    ctx.drawImage(logoCanvas, -logoSize / 2, -logoSize / 2, logoSize, logoSize);

    ctx.restore();

    ctx.fillStyle = isSelf ? "#00f2ea" : "#ffffff";
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(blade.name || "Viewer", x, y - r - 6);
  });

  renderEffects();
}

function tick() {
  renderArena();
  requestAnimationFrame(tick);
}

socket.on("connect", () => {
  statusEl.textContent = "Connected";
});

socket.on("disconnect", () => {
  statusEl.textContent = "Disconnected";
});

socket.on("welcome", (payload) => {
  viewer.id = payload.viewerId;
  viewer.name = payload.viewerName || viewer.name;
  saveViewer(viewer);
  nameInput.value = viewer.name || "";
});

socket.on("state", (payload) => {
  state = payload;
  updateStats(payload.stats);
  handleIncomingEvents(payload.events || [], payload);
});

saveNameBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  viewer.name = name;
  saveViewer(viewer);
  socket.emit("register", { viewerName: name });
});

spawnBtn.addEventListener("click", () => {
  socket.emit("spawn");
});

boostBtn.addEventListener("click", () => {
  socket.emit("control", { action: "boost" });
});

function sendChatCommand() {
  const message = commandInput.value.trim();
  if (!message) return;
  socket.emit("control", { action: "chat", message });
  commandInput.value = "";
}

sendBtn.addEventListener("click", sendChatCommand);
commandInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") sendChatCommand();
});

window.addEventListener("keydown", (event) => {
  if (event.target && event.target.tagName === "INPUT") return;
  switch (event.key) {
    case "ArrowLeft":
      socket.emit("control", { action: "nudge", dx: -1, dy: 0 });
      break;
    case "ArrowRight":
      socket.emit("control", { action: "nudge", dx: 1, dy: 0 });
      break;
    case "ArrowUp":
      socket.emit("control", { action: "nudge", dx: 0, dy: -1 });
      break;
    case "ArrowDown":
      socket.emit("control", { action: "nudge", dx: 0, dy: 1 });
      break;
    case " ":
      socket.emit("control", { action: "boost" });
      break;
    default:
      break;
  }
});

window.addEventListener("resize", resizeCanvas);

resizeCanvas();
buildLogoCanvas();
tick();
