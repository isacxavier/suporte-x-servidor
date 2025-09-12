const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// simple room join & relay signaling
io.on('connection', (socket) => {
  socket.on('join', (room) => {
    socket.join(room);
    socket.room = room;
    // notify others that someone joined
    socket.to(room).emit('peer-joined');
  });

  socket.on('signal', ({ room, data }) => {
    socket.to(room).emit('signal', data);
  });

  socket.on('disconnect', () => {
    if (socket.room) {
      socket.to(socket.room).emit('peer-left');
    }
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

server.listen(PORT, () => {
  console.log(`Suporte X QuickView signaling server running on :${PORT}`);
});
