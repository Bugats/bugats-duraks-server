const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ===== Serve static files =====
const publicPath = path.join(__dirname);
app.use(express.static(publicPath));

// Serve index.html correctly
app.get("/", (req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

// ===== Socket.IO logic =====
io.on("connection", (socket) => {
  console.log("Player connected:", socket.id);

  socket.on("chat.message", (msg) => {
    io.emit("chat.message", msg);
  });

  socket.on("disconnect", () => {
    console.log("Player disconnected:", socket.id);
  });
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Duraks Online running on port", PORT));
