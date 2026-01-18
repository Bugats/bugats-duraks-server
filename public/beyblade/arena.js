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
  updateEvents(payload.events || []);
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
