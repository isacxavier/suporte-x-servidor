const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

// ===== Básico
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  allowEIO3: true, // compat com socket.io-client 2.x (Android)
});
const PORT = process.env.PORT || 3000;

// ===== Anti-cache seletivo (HTML/JS/CSS)
app.use(express.json());
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

// ===== Estado em memória
const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const requests = new Map(); // requestId -> { requestId, clientId, clientName, brand, model, createdAt, state }
const sessions = new Map(); // sessionId -> { sessionId, requestId, clientId, techId?, techName?, createdAt }

// ====== SOCKETS
io.on('connection', (socket) => {
  // 1) CLIENTE cria um pedido de suporte (fila real)
  // payload: { clientName?, brand?, model? }
  socket.on('support:request', (payload = {}) => {
    const requestId = nanoid().toUpperCase();
    const now = Date.now();
    const req = {
      requestId,
      clientId: socket.id,
      clientName: payload.clientName || 'Cliente',
      brand: payload.brand || null,
      model: payload.model || null,
      createdAt: now,
      state: 'queued'
    };
    requests.set(requestId, req);

    // resposta pro cliente
    socket.emit('support:enqueued', { requestId });

    // (Opcional) avisar técnicos por socket também
    io.emit('queue:updated', { requestId, state: 'queued' });
  });

  // Mantém sua sinalização atual por sala (sessionId)
  socket.on('join', (payload) => {
    const room = typeof payload === 'string' ? payload : payload?.room;
    const role = typeof payload === 'object' ? payload?.role : undefined;
    if (!room) return;

    socket.join(room);
    socket.data.room = room;
    socket.to(room).emit('peer-joined', { role });
  });

  socket.on('signal', (payload = {}) => {
    try {
      const room = payload.room || socket.data.room;
      if (!room) return;
      const out = Object.prototype.hasOwnProperty.call(payload, 'data')
        ? payload.data
        : payload;
      socket.to(room).emit('signal', out);
    } catch (e) {
      console.error('signal error:', e);
    }
  });

  socket.on('disconnect', () => {
    // se o cliente desconectar com pedido em fila, remove
    for (const [id, r] of requests) {
      if (r.clientId === socket.id && r.state === 'queued') {
        requests.delete(id);
        io.emit('queue:updated', { requestId: id, state: 'removed' });
      }
    }
    // se sair de uma sessão ativa, avisa o outro lado
    if (socket.data?.room) {
      socket.to(socket.data.room).emit('peer-left');
    }
  });
});

// ====== HTTP API (usada pelo view.html)
app.get('/api/requests', (req, res) => {
  const status = (req.query.status || '').toLowerCase();
  let list = Array.from(requests.values());
  if (status) list = list.filter(r => r.state === status);
  // Ordena por mais antigo primeiro
  list.sort((a, b) => a.createdAt - b.createdAt);
  res.json(list.map(r => ({
    requestId: r.requestId,
    clientName: r.clientName,
    brand: r.brand,
    model: r.model,
    createdAt: r.createdAt,
    state: r.state
  })));
});

// Aceitar um request -> cria sessionId, notifica cliente
app.post('/api/requests/:id/accept', (req, res) => {
  const id = req.params.id;
  const r = requests.get(id);
  if (!r || r.state !== 'queued') {
    return res.status(404).json({ error: 'request_not_found_or_already_taken' });
  }

  const sessionId = nanoid().toUpperCase();
  r.state = 'accepted';

  // guarda sessão
  const techName = (req.body && req.body.techName) ? String(req.body.techName) : 'Técnico';
  sessions.set(sessionId, {
    sessionId,
    requestId: id,
    clientId: r.clientId,
    techName,
    createdAt: Date.now()
  });

  // notifica cliente que foi aceito + sessionId
  io.to(r.clientId).emit('support:accepted', { sessionId, techName });

  // remove da fila visível
  requests.delete(id);
  io.emit('queue:updated', { requestId: id, state: 'accepted', sessionId });

  return res.json({ sessionId });
});

// Recusar/remover um request (apaga da fila e, se quiser, avisa o cliente)
app.delete('/api/requests/:id', (req, res) => {
  const id = req.params.id;
  const r = requests.get(id);
  if (!r) return res.status(204).end();
  requests.delete(id);
  try { io.to(r.clientId).emit('support:rejected', { requestId: id }); } catch {}
  io.emit('queue:updated', { requestId: id, state: 'removed' });
  res.status(204).end();
});

// Debug/saúde
app.get('/health', (_req, res) => res.json({ ok: true, requests: requests.size, sessions: sessions.size, now: Date.now() }));
app.get('/api/sessions', (_req, res) => {
  res.json(Array.from(sessions.values()).map(s => ({
    sessionId: s.sessionId, requestId: s.requestId, techName: s.techName, createdAt: s.createdAt
  })));
});

// Start
server.listen(PORT, () => {
  console.log(`Suporte X QuickView signaling server running on :${PORT}`);
});
