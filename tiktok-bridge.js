import TikTokLive from "tiktok-live-connector";

const { WebcastPushConnection } = TikTokLive;

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME;
const BEYBLADE_EVENT_URL = (process.env.BEYBLADE_EVENT_URL || "https://beyblade.thezone.lv/api/beyblade/events").trim();
const BEYBLADE_INGEST_SECRET = process.env.BEYBLADE_INGEST_SECRET || "";
const TIKTOK_SESSION_ID = process.env.TIKTOK_SESSION_ID || "";
const RECONNECT_DELAY_MS = Number(process.env.TIKTOK_RECONNECT_MS || 5000);

if (!TIKTOK_USERNAME) {
  console.error("Missing TIKTOK_USERNAME env. Example: TIKTOK_USERNAME=bugats");
  process.exit(1);
}

const headers = () => {
  const base = { "Content-Type": "application/json" };
  if (BEYBLADE_INGEST_SECRET) base["x-beyblade-secret"] = BEYBLADE_INGEST_SECRET;
  return base;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const toViewer = (data) => ({
  userId: String(data.userId || data.uniqueId || data.nickname || ""),
  userName: data.uniqueId || data.nickname || "viewer"
});

async function postEvent(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(BEYBLADE_EVENT_URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`Event push failed (${res.status}):`, text || payload.type);
    }
  } catch (err) {
    console.error("Event push error:", err?.message || err);
  } finally {
    clearTimeout(timer);
  }
}

function createConnection() {
  return new WebcastPushConnection(TIKTOK_USERNAME, {
    enableExtendedGiftInfo: true,
    ...(TIKTOK_SESSION_ID ? { sessionId: TIKTOK_SESSION_ID } : {})
  });
}

let connection = createConnection();
let connecting = false;

async function connect() {
  if (connecting) return;
  connecting = true;
  try {
    const state = await connection.connect();
    console.log(`Connected to TikTok live @${TIKTOK_USERNAME}`, state);
  } catch (err) {
    console.error("TikTok connect failed:", err?.message || err);
    await sleep(RECONNECT_DELAY_MS);
    connection = createConnection();
    connect();
  } finally {
    connecting = false;
  }
}

connection.on("chat", (data) => {
  const viewer = toViewer(data);
  postEvent({ type: "chat", userId: viewer.userId, userName: viewer.userName, message: data.comment || "" });
});

connection.on("like", (data) => {
  const viewer = toViewer(data);
  postEvent({ type: "like", userId: viewer.userId, userName: viewer.userName });
});

connection.on("follow", (data) => {
  const viewer = toViewer(data);
  postEvent({ type: "follow", userId: viewer.userId, userName: viewer.userName });
});

connection.on("gift", (data) => {
  const isStreak = data.giftType === 1;
  if (isStreak && !data.repeatEnd) return;
  const viewer = toViewer(data);
  const repeat = Number(data.repeatCount || 1);
  const value = Number(data.diamondCount || data.value || data.diamonds || 0);
  postEvent({
    type: "gift",
    userId: viewer.userId,
    userName: viewer.userName,
    name: data.giftName || "Gift",
    repeat,
    value
  });
});

connection.on("disconnected", () => {
  console.warn("TikTok disconnected. Reconnecting...");
  connection = createConnection();
  connect();
});

connection.on("streamEnd", () => {
  console.warn("TikTok stream ended. Waiting to reconnect...");
  connection = createConnection();
  connect();
});

connection.on("error", (err) => {
  console.error("TikTok error:", err?.message || err);
});

process.on("SIGINT", () => {
  if (typeof connection.disconnect === "function") connection.disconnect();
  process.exit(0);
});

console.log("TikTok bridge starting...", {
  user: TIKTOK_USERNAME,
  eventUrl: BEYBLADE_EVENT_URL,
  hasSecret: Boolean(BEYBLADE_INGEST_SECRET)
});

connect();
