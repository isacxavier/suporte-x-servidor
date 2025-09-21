const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

// sirva sua pasta "public" (view.html, style.css etc. devem estar lá)
app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  // aceita join como string ("123456") ou objeto ({room:"123456", role:"viewer"})
  socket.on('join', (payload) => {
    const room = typeof payload === 'string' ? payload : payload?.room;
    const role = typeof payload === 'object' ? payload?.role : undefined;
    if (!room) return;

    socket.join(room);
    socket.data.room = room;

    // avisa os outros do quarto
    socket.to(room).emit('peer-joined', { role });
  });

  // aceita {room, data: ...} ou {room, type: "...", ...}
  socket.on('signal', (payload = {}) => {
    try {
      const room = payload.room || socket.data.room;
      if (!room) return;

      // se vier {room, data}, repassa só o "data"; senão repassa o próprio payload
      const out = Object.prototype.hasOwnProperty.call(payload, 'data')
        ? payload.data
        : payload;

      socket.to(room).emit('signal', out);
    } catch (e) {
      console.error('signal error:', e);
    }
  });

  socket.on('disconnect', () => {
    if (socket.data?.room) {
      socket.to(socket.data.room).emit('peer-left');
    }
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));

server.listen(PORT, () => {
  console.log(`Suporte X QuickView signaling server running on :${PORT}`);
});
