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
const trailMap = new Map();
const sparkBursts = [];
const lastCollisionAt = new Map();
let seenEventIds = new Set();
let lastFrameTs = Date.now();

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
let roundBanner = null;
let lastBannerId = null;
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

function renderEffects(now) {
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

function updateTrails(blades, ts) {
  const cutoff = ts - 700;
  const activeIds = new Set();
  blades.forEach((blade) => {
    activeIds.add(blade.id);
    const list = trailMap.get(blade.id) || [];
    list.push({ x: blade.x, y: blade.y, ts });
    while (list.length > 20 || (list[0] && list[0].ts < cutoff)) {
      list.shift();
    }
    trailMap.set(blade.id, list);
  });
  for (const id of trailMap.keys()) {
    if (!activeIds.has(id)) trailMap.delete(id);
  }
}

function renderTrails(centerX, centerY) {
  if (!state) return;
  state.blades.forEach((blade) => {
    const list = trailMap.get(blade.id);
    if (!list || list.length < 2) return;
    const baseWidth = Math.max(1.5, blade.radius * arenaScale * 0.6);
    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const cur = list[i];
      const alpha = (i / list.length) * 0.35;
      ctx.strokeStyle = withAlpha(blade.color || "#ffffff", alpha);
      ctx.lineWidth = baseWidth * (i / list.length);
      ctx.beginPath();
      ctx.moveTo(centerX + prev.x * arenaScale, centerY + prev.y * arenaScale);
      ctx.lineTo(centerX + cur.x * arenaScale, centerY + cur.y * arenaScale);
      ctx.stroke();
    }
  });
}

function spawnCollisionSpark(x, y, color, intensity) {
  const strength = clamp(intensity, 0.6, 2.5);
  const count = Math.round(8 + strength * 6);
  const particles = [];
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 0.4 + Math.random() * (0.4 + strength * 0.4);
    const life = 0.25 + Math.random() * 0.25 + strength * 0.05;
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      life,
      ttl: life,
      size: 1 + Math.random() * 1.5 + strength
    });
  }
  sparkBursts.push({ color, particles });
}

function detectCollisions(blades, ts) {
  for (let i = 0; i < blades.length; i += 1) {
    for (let j = i + 1; j < blades.length; j += 1) {
      const a = blades[i];
      const b = blades[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minDist = (a.radius + b.radius) * 1.05;
      if (dist > 0 && dist < minDist) {
        const relVx = (b.vx || 0) - (a.vx || 0);
        const relVy = (b.vy || 0) - (a.vy || 0);
        const relSpeed = Math.hypot(relVx, relVy);
        if (relSpeed < 0.01) continue;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        const last = lastCollisionAt.get(key) || 0;
        if (ts - last < 220) continue;
        lastCollisionAt.set(key, ts);
        const sparkColor = b.color || a.color || "#ffffff";
        spawnCollisionSpark((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, sparkColor, relSpeed * 35);
      }
    }
  }
}

function renderSparks(dt) {
  if (!sparkBursts.length) return;
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (let b = sparkBursts.length - 1; b >= 0; b -= 1) {
    const burst = sparkBursts[b];
    for (let p = burst.particles.length - 1; p >= 0; p -= 1) {
      const particle = burst.particles[p];
      particle.life -= dt;
      if (particle.life <= 0) {
        burst.particles.splice(p, 1);
        continue;
      }
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      const alpha = particle.life / particle.ttl;
      ctx.fillStyle = withAlpha(burst.color || "#ffd166", alpha);
      const px = centerX + particle.x * arenaScale;
      const py = centerY + particle.y * arenaScale;
      ctx.beginPath();
      ctx.arc(px, py, particle.size, 0, Math.PI * 2);
      ctx.fill();
    }
    if (burst.particles.length === 0) sparkBursts.splice(b, 1);
  }
  ctx.restore();
}

function renderRoundBanner(now) {
  if (!roundBanner) return;
  const endAt = roundBanner.ts + roundBanner.durationMs;
  if (now >= endAt) {
    roundBanner = null;
    return;
  }
  const fade = clamp(1 - (now - roundBanner.ts) / roundBanner.durationMs, 0, 1);
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;

  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.textAlign = "center";
  ctx.fillStyle = `rgba(255, 255, 255, ${0.85 * fade})`;
  ctx.font = "bold 40px Segoe UI, sans-serif";
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 12;
  ctx.fillText(roundBanner.text, centerX, centerY - 10);

  if (roundBanner.subtext) {
    ctx.font = "16px Segoe UI, sans-serif";
    ctx.fillStyle = `rgba(0, 242, 234, ${0.75 * fade})`;
    ctx.fillText(roundBanner.subtext, centerX, centerY + 18);
  }
  ctx.restore();
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

function renderArena(now, dt) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const ringScale = arenaScale * (state?.arena?.radius || 1);
  const bgGradient = ctx.createRadialGradient(centerX, centerY, arenaScale * 0.2, centerX, centerY, arenaScale * 1.2);
  bgGradient.addColorStop(0, "#0f0f0f");
  bgGradient.addColorStop(0.6, "#050505");
  bgGradient.addColorStop(1, "#020202");
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(centerX, centerY, ringScale, 0, Math.PI * 2);
  ctx.stroke();

  if (!state) return;
  renderTrails(centerX, centerY);

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

    const energy = clamp(blade.energy || 0, 0, 2);
    const pulse = 1 + 0.08 * Math.sin((now / 180) + blade.spin * 2);
    ctx.strokeStyle = withAlpha(blade.color || "#ffffff", 0.25 + energy * 0.2);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.1 * pulse, 0, Math.PI * 2);
    ctx.stroke();

    const logoSize = r * 1.1;
    ctx.drawImage(logoCanvas, -logoSize / 2, -logoSize / 2, logoSize, logoSize);

    ctx.restore();

    ctx.fillStyle = isSelf ? "#00f2ea" : "#ffffff";
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(blade.name || "Viewer", x, y - r - 6);
  });

  renderSparks(dt);
  renderEffects(now);
  renderRoundBanner(now);
}

function tick() {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastFrameTs) / 1000);
  lastFrameTs = now;
  renderArena(now, dt);
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
  const ts = payload?.ts || Date.now();
  updateTrails(payload?.blades || [], ts);
  detectCollisions(payload?.blades || [], ts);
  const banner = payload?.round?.banner;
  if (banner && banner.id !== lastBannerId) {
    lastBannerId = banner.id;
    roundBanner = { ...banner };
  }
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
