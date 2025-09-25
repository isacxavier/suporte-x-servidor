const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  allowEIO3: true, // compat com socket.io-client 2.x (Android)
});

const PORT = process.env.PORT || 3000;

// —— Anti-cache seletivo (HTML/JS) —— //
const staticDir = path.join(__dirname, 'public');
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.js') || lower.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.removeHeader('ETag');
      res.removeHeader('Last-Modified');
    }
  }
}));

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
