const canvas = document.getElementById("arena");
const ctx = canvas.getContext("2d");

const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");
const roundStatusEl = document.getElementById("round-status");
const roundTimersEl = document.getElementById("round-timers");
const roundMetaEl = document.getElementById("round-meta");
const queueEl = document.getElementById("queue");
const leaderboardEl = document.getElementById("leaderboard");
const toggleLogBtn = document.getElementById("toggle-log");
const eventsEl = document.getElementById("events");
const nameInput = document.getElementById("viewer-name");
const saveNameBtn = document.getElementById("save-name");
const spawnBtn = document.getElementById("spawn");
const boostBtn = document.getElementById("boost");
const commandInput = document.getElementById("command");
const sendBtn = document.getElementById("send");

const storageKey = "bbViewer";
const logHiddenKey = "bbLogHidden";
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
let baseArenaScale = 1;
let zoomFactor = 1;
let roundBanner = null;
let lastBannerId = null;
const logoCanvas = document.createElement("canvas");
const backgroundCanvas = document.createElement("canvas");
let backgroundPattern = null;
const TIER_COLORS = {
  boost: "#00f2ea",
  shield: "#4d79ff",
  shock: "#ff8c42",
  ult: "#ff0050",
  revive: "#ffd166"
};

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  baseArenaScale = Math.min(canvas.width, canvas.height) * 0.5;
  arenaScale = baseArenaScale * zoomFactor;
  buildBackgroundPattern();
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

function buildBackgroundPattern() {
  backgroundCanvas.width = 560;
  backgroundCanvas.height = 560;
  const bg = backgroundCanvas.getContext("2d");
  bg.clearRect(0, 0, backgroundCanvas.width, backgroundCanvas.height);
  bg.fillStyle = "#050505";
  bg.fillRect(0, 0, backgroundCanvas.width, backgroundCanvas.height);

  const nebulaColors = ["#2a0f3d", "#0d243f", "#2a1b0a", "#3a0f1f", "#152b1f"];
  for (let i = 0; i < 6; i += 1) {
    const x = Math.random() * backgroundCanvas.width;
    const y = Math.random() * backgroundCanvas.height;
    const radius = 140 + Math.random() * 200;
    const color = nebulaColors[i % nebulaColors.length];
    const grad = bg.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0, withAlpha(color, 0.18));
    grad.addColorStop(1, "rgba(0,0,0,0)");
    bg.fillStyle = grad;
    bg.beginPath();
    bg.arc(x, y, radius, 0, Math.PI * 2);
    bg.fill();
  }

  bg.strokeStyle = "rgba(255, 255, 255, 0.04)";
  bg.lineWidth = 1;
  for (let x = 0; x < backgroundCanvas.width; x += 40) {
    bg.beginPath();
    bg.moveTo(x, 0);
    bg.lineTo(x, backgroundCanvas.height);
    bg.stroke();
  }
  for (let y = 0; y < backgroundCanvas.height; y += 40) {
    bg.beginPath();
    bg.moveTo(0, y);
    bg.lineTo(backgroundCanvas.width, y);
    bg.stroke();
  }

  for (let i = 0; i < 260; i += 1) {
    const x = Math.random() * backgroundCanvas.width;
    const y = Math.random() * backgroundCanvas.height;
    const alpha = 0.05 + Math.random() * 0.1;
    bg.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    bg.fillRect(x, y, 1, 1);
  }

  backgroundPattern = ctx.createPattern(backgroundCanvas, "repeat");
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
  const tier = String(meta.tier || "").toLowerCase();
  const tierColor = TIER_COLORS[tier];
  if (tierColor) color = tierColor;
  let strength = clamp(1 + coins / 200 + repeat / 10, 1, 3);
  if (tier === "boost") strength = Math.max(strength, 1.4);
  if (tier === "shield") strength = Math.max(strength, 1.8);
  if (tier === "shock") strength = Math.max(strength, 2.2);
  if (tier === "ult") strength = Math.max(strength, 2.8);
  if (event.type === "revive") {
    strength = Math.max(strength, 3);
    color = TIER_COLORS.revive || "#ffd166";
  }

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
    if (!seenEventIds.has(event.id) && (event.type === "gift" || event.type === "revive")) {
      spawnGiftEffect(event, payload);
    }
  });
  seenEventIds = nextSeen;
  updateEvents(events || []);
}

function renderEffects(now, perfMode = false) {
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
    const rays = perfMode ? effect.rays.slice(0, 8) : effect.rays;
    rays.forEach((ray) => {
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

function renderTrails(centerX, centerY, perfMode) {
  if (!state) return;
  if (perfMode) return;
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

function renderSparks(dt, perfMode) {
  if (!sparkBursts.length) return;
  if (perfMode && sparkBursts.length > 2) return;
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

function renderHealthDots(x, y, hp, hpMax) {
  const max = Math.max(1, hpMax || 1);
  const current = clamp(Math.ceil(hp || 0), 0, max);
  const spacing = 8;
  const size = 3;
  const startX = x - ((max - 1) * spacing) / 2;
  for (let i = 0; i < max; i += 1) {
    ctx.beginPath();
    ctx.fillStyle = i < current ? "#ff4d4d" : "rgba(255, 255, 255, 0.2)";
    ctx.arc(startX + i * spacing, y, size, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderStaminaArc(x, y, radius, stamina, staminaMax) {
  if (!staminaMax) return;
  const ratio = clamp((stamina || 0) / staminaMax, 0, 1);
  if (ratio <= 0) return;
  const start = -Math.PI / 2;
  const end = start + ratio * Math.PI * 2;
  ctx.strokeStyle = "rgba(0, 242, 234, 0.75)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, radius, start, end);
  ctx.stroke();
}

function renderMomentumTicks(x, y, radius, momentum) {
  const ratio = clamp((momentum || 0) / 100, 0, 1);
  const ticks = Math.round(6 * ratio);
  if (ticks <= 0) return;
  ctx.strokeStyle = "rgba(255, 80, 80, 0.7)";
  ctx.lineWidth = 1.5;
  for (let i = 0; i < ticks; i += 1) {
    const angle = -Math.PI / 2 + (i / 6) * Math.PI * 2;
    const inner = radius * 0.92;
    const outer = radius * 1.06;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(angle) * inner, y + Math.sin(angle) * inner);
    ctx.lineTo(x + Math.cos(angle) * outer, y + Math.sin(angle) * outer);
    ctx.stroke();
  }
}

function drawRoundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function renderNameplate(x, y, name, classKey) {
  const label = name || "Viewer";
  const badge = classKey ? classKey[0].toUpperCase() : "B";
  const badgeColor = classKey === "light"
    ? "#00f2ea"
    : classKey === "heavy"
      ? "#ff8c42"
      : "#6a4c93";
  ctx.font = "12px Segoe UI, sans-serif";
  const textWidth = ctx.measureText(label).width;
  const badgeWidth = 16;
  const paddingX = 6;
  const height = 18;
  const totalWidth = textWidth + badgeWidth + paddingX * 2 + 6;
  const left = x - totalWidth / 2;
  const top = y - height + 2;

  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  drawRoundRect(ctx, left, top, totalWidth, height, 6);
  ctx.fill();

  ctx.fillStyle = badgeColor;
  drawRoundRect(ctx, left + 4, top + 3, badgeWidth, height - 6, 5);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "10px Segoe UI, sans-serif";
  ctx.fillText(badge, left + 4 + badgeWidth / 2, top + height / 2);

  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = "12px Segoe UI, sans-serif";
  ctx.fillText(label, left + badgeWidth + paddingX + 6, top + height / 2);
  ctx.restore();
}

function updateEvents(events) {
  eventsEl.replaceChildren();
  events.forEach((event) => {
    const div = document.createElement("div");
    const tier = event?.meta?.tier ? ` tier-${String(event.meta.tier).toLowerCase()}` : "";
    div.className = `event ${event.type || ""}${tier}`.trim();
    div.textContent = event.message;
    eventsEl.appendChild(div);
  });
}

function setLogHidden(hidden) {
  eventsEl.classList.toggle("hidden", hidden);
  if (toggleLogBtn) {
    toggleLogBtn.textContent = hidden ? "Show log" : "Hide log";
  }
}

function updateStats(stats) {
  if (!stats) return;
  const revenue = Number.isFinite(stats.revenueUsd) ? stats.revenueUsd.toFixed(2) : "0.00";
  statsEl.textContent = `Blades: ${stats.blades} | Viewers: ${stats.viewers} | Coins: ${stats.coins} | Est USD: ${revenue}`;
}

function updateRoundInfo(round, payload) {
  if (!round) return;
  const now = payload?.ts || Date.now();
  const status = round.status || "idle";
  const alive = round.alive ?? payload?.stats?.blades ?? 0;

  if (status === "countdown") {
    const seconds = Math.ceil((round.countdownMs || 0) / 1000);
    roundStatusEl.textContent = `Battle starts in ${seconds}s`;
  } else if (status === "running") {
    roundStatusEl.textContent = "Battle running";
  } else if (status === "finished") {
    const cooldown = Math.max(0, Math.ceil(((round.cooldownUntil || 0) - now) / 1000));
    roundStatusEl.textContent = cooldown ? `Cooldown ${cooldown}s` : "Round finished";
  } else {
    roundStatusEl.textContent = "Waiting for players";
  }

  let timerText = "";
  if (status === "running") {
    if (round.shrinkStartAt && now < round.shrinkStartAt) {
      timerText = `Shrink in ${Math.ceil((round.shrinkStartAt - now) / 1000)}s`;
    } else if (round.shrinkEndAt && now < round.shrinkEndAt) {
      timerText = `Shrinking... ${Math.ceil((round.shrinkEndAt - now) / 1000)}s`;
    } else if (round.shrinkEndAt) {
      timerText = "Shrink complete";
    }
  }
  roundTimersEl.textContent = timerText;
  roundMetaEl.textContent = `Alive: ${alive} | Revives: ${round.revivesUsed || 0}/${round.reviveLimit || 0}`;
}

function updateQueue(queue) {
  if (!queue || queue.length === 0) {
    queueEl.textContent = "Queue: -";
    return;
  }
  const names = queue.map((q) => q.name).join(", ");
  queueEl.textContent = `Queue: ${names}`;
}

function updateLeaderboard(rows) {
  leaderboardEl.replaceChildren();
  if (!rows || rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "entry";
    empty.textContent = "No wins yet";
    leaderboardEl.appendChild(empty);
    return;
  }
  rows.forEach((row, index) => {
    const item = document.createElement("div");
    item.className = "entry";
    item.innerHTML = `<strong>#${index + 1} ${row.name}</strong><span>W:${row.wins} | S:${row.streak}</span>`;
    leaderboardEl.appendChild(item);
  });
}

function computeTargetZoom(blades, radius) {
  if (!blades || blades.length === 0) return 1;
  let maxDist = 0;
  blades.forEach((blade) => {
    const dist = Math.hypot(blade.x, blade.y) + (blade.radius || 0);
    if (dist > maxDist) maxDist = dist;
  });
  const norm = clamp(maxDist / Math.max(radius || 1, 0.1), 0.4, 1.1);
  return clamp(1.15 - (norm - 0.4) * 0.45, 0.75, 1.15);
}

function renderArena(now, dt) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const radius = state?.arena?.radius || 1;
  const targetZoom = computeTargetZoom(state?.blades || [], radius);
  zoomFactor += (targetZoom - zoomFactor) * 0.08;
  arenaScale = baseArenaScale * zoomFactor;
  const ringScale = arenaScale * radius;
  const perfMode = dt > 0.05 || (state?.blades?.length || 0) > 14;
  const bgGradient = ctx.createRadialGradient(centerX, centerY, arenaScale * 0.2, centerX, centerY, arenaScale * 1.2);
  bgGradient.addColorStop(0, "#0f0f0f");
  bgGradient.addColorStop(0.6, "#050505");
  bgGradient.addColorStop(1, "#020202");
  ctx.fillStyle = bgGradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (backgroundPattern) {
    const shiftX = (now / 120) % backgroundCanvas.width;
    const shiftY = (now / 180) % backgroundCanvas.height;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.translate(-shiftX, -shiftY);
    ctx.fillStyle = backgroundPattern;
    ctx.fillRect(shiftX, shiftY, canvas.width + backgroundCanvas.width, canvas.height + backgroundCanvas.height);
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = "rgba(255, 60, 60, 0.35)";
  ctx.shadowColor = "rgba(255, 20, 20, 0.85)";
  ctx.shadowBlur = 32;
  ctx.lineWidth = 14;
  ctx.beginPath();
  ctx.arc(centerX, centerY, ringScale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = "rgba(255, 80, 80, 0.9)";
  ctx.shadowColor = "rgba(255, 40, 40, 0.9)";
  ctx.shadowBlur = 18;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(centerX, centerY, ringScale, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(centerX, centerY, ringScale * 0.98, 0, Math.PI * 2);
  ctx.stroke();

  ctx.save();
  ctx.strokeStyle = "rgba(255, 120, 120, 0.6)";
  ctx.lineWidth = 2;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
    const inner = ringScale * 0.98;
    const outer = ringScale * 1.03;
    ctx.beginPath();
    ctx.moveTo(centerX + Math.cos(a) * inner, centerY + Math.sin(a) * inner);
    ctx.lineTo(centerX + Math.cos(a) * outer, centerY + Math.sin(a) * outer);
    ctx.stroke();
  }
  ctx.restore();

  if (!state) return;
  renderTrails(centerX, centerY, perfMode);

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

    if (blade.shielded) {
      ctx.strokeStyle = "rgba(77, 121, 255, 0.7)";
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.35 * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }

    const logoSize = r * 1.1;
    ctx.drawImage(logoCanvas, -logoSize / 2, -logoSize / 2, logoSize, logoSize);

    ctx.restore();

    renderNameplate(x, y - r - 4, blade.name || "Viewer", blade.class);
    renderHealthDots(x, y - r - 22, blade.hp, blade.hpMax);
    renderStaminaArc(x, y, r * 1.55, blade.stamina, blade.staminaMax);
    renderMomentumTicks(x, y, r * 1.7, blade.momentum);
  });

  renderSparks(dt, perfMode);
  renderEffects(now, perfMode);
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
  updateRoundInfo(payload.round, payload);
  updateQueue(payload.queue || []);
  updateLeaderboard(payload.leaderboard || []);
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

if (toggleLogBtn) {
  const initialHidden = localStorage.getItem(logHiddenKey) === "1";
  setLogHidden(initialHidden);
  toggleLogBtn.addEventListener("click", () => {
    const hidden = !eventsEl.classList.contains("hidden");
    setLogHidden(hidden);
    localStorage.setItem(logHiddenKey, hidden ? "1" : "0");
  });
}

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
