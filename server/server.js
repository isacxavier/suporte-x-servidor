const path = require('path');
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const { customAlphabet } = require('nanoid');

const ensureString = (value, fallback = '') => {
  if (typeof value === 'string') return value.slice(0, 256);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).slice(0, 256);
  }
  return fallback;
};

const normalizeSessionId = (value) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, 64);
};

const respondAck = (ack, payload) => {
  if (typeof ack === 'function') {
    ack(payload);
  }
};

// ===== Básico
const app = express();
const server = http.createServer(app);
const isProduction = process.env.NODE_ENV === 'production';
const productionOrigins = ['https://suportex.app', 'https://www.suportex.app'];
const corsOptions = isProduction
  ? { origin: productionOrigins, credentials: true }
  : { origin: true, credentials: true };
const io = new Server(server, {
  cors: isProduction
    ? {
        origin: productionOrigins,
        methods: ['GET', 'POST'],
        credentials: true,
      }
    : { origin: '*', methods: ['GET', 'POST'], credentials: true },
  allowEIO3: true, // compat com socket.io-client 2.x (Android)
});
const PORT = process.env.PORT || 3000;
const WEB_STATIC_PATH = path.resolve(__dirname, '../web/public');

app.use(cors(corsOptions));

const CANONICAL_HOST = 'suportex.app';
app.use((req, res, next) => {
  if (!isProduction) return next();
  const host = req.headers.host;
  if (!host) return next();
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  if (isLocal || host === CANONICAL_HOST) return next();

  const target = `https://${CANONICAL_HOST}${req.originalUrl}`;
  return res.redirect(301, target);
});

// ===== Anti-cache seletivo (HTML/JS/CSS)
app.use(express.json());
app.use(express.static(WEB_STATIC_PATH, {
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
const requests = new Map(); // requestId -> { requestId, clientId, clientName, brand, model, osVersion?, plan?, issue?, createdAt, state }
const sessions = new Map(); // sessionId -> { sessionId, requestId, clientId, techName?, clientName, brand, model, requestedAt, acceptedAt, waitTimeMs, status, closedAt?, outcome?, firstContactResolution?, npsScore?, symptom?, solution?, handleTimeMs? }

// ====== SOCKETS
const connectionIndex = new Map();

io.on('connection', (socket) => {
  connectionIndex.set(socket.id, { socketId: socket.id, userType: 'unknown', sessionId: null });

  // 1) CLIENTE cria um pedido de suporte (fila real)
  // payload: { clientName?, brand?, model? }
  socket.on('support:request', (payload = {}) => {
    const requestId = nanoid().toUpperCase();
    const now = Date.now();
    const req = {
      requestId,
      clientId: socket.id,
      clientName: ensureString(payload.clientName, 'Cliente'),
      brand: ensureString(payload.brand || payload?.device?.brand || '', '') || null,
      model: ensureString(payload.model || payload?.device?.model || '', '') || null,
      osVersion: ensureString(payload?.device?.osVersion || payload.osVersion || '', '') || null,
      plan: ensureString(payload.plan || '', '') || null,
      issue: ensureString(payload.issue || '', '') || null,
      extra: typeof payload.extra === 'object' && payload.extra !== null ? payload.extra : {},
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

  socket.on('session:join', (payload = {}, ack) => {
    const sessionId = normalizeSessionId(payload.sessionId);
    if (!sessionId) {
      return respondAck(ack, { ok: false, err: 'no-session' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return respondAck(ack, { ok: false, err: 'session-not-found' });
    }

    const userTypeRaw = ensureString(payload.userType || payload.role || '', '').toLowerCase();
    const userType = userTypeRaw === 'tech' || userTypeRaw === 'client' ? userTypeRaw : 'unknown';
    const room = `s:${sessionId}`;
    socket.join(room);
    if (!socket.data.sessionRoles) socket.data.sessionRoles = {};
    socket.data.sessionRoles[sessionId] = userType;
    socket.data.sessionId = sessionId;
    socket.data.userType = userType;
    connectionIndex.set(socket.id, { socketId: socket.id, userType, sessionId });
    respondAck(ack, { ok: true });
  });

  socket.on('session:chat:send', (msg = {}, ack) => {
    const sessionId = normalizeSessionId(msg.sessionId);
    const text = ensureString(msg.text || '', '').trim();
    const from = ensureString(msg.from || '', '');
    if (!sessionId || !text) {
      return respondAck(ack, { ok: false, err: 'bad-payload' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return respondAck(ack, { ok: false, err: 'session-not-found' });
    }

    const room = `s:${sessionId}`;
    const providedId = ensureString(msg.id || '', '');
    const ts = typeof msg.ts === 'number' ? msg.ts : Date.now();
    const out = {
      id: providedId || Date.now().toString(36),
      sessionId,
      from: from || 'unknown',
      text,
      ts,
    };

    socket.to(room).emit('session:chat:new', out);

    const log = Array.isArray(session.chatLog) ? session.chatLog : [];
    log.push(out);
    if (log.length > 50) log.splice(0, log.length - 50);
    session.chatLog = log;
    session.extra = session.extra || {};
    session.extra.chatLog = log;
    session.extra.lastMessageAt = out.ts;
    sessions.set(sessionId, session);
    io.emit('session:updated', session);

    respondAck(ack, { ok: true, id: out.id });
  });

  socket.on('session:command', (cmd = {}, ack) => {
    const sessionId = normalizeSessionId(cmd.sessionId);
    const type = ensureString(cmd.type || '', '').trim();
    if (!sessionId || !type) {
      return respondAck(ack, { ok: false, err: 'bad-payload' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return respondAck(ack, { ok: false, err: 'session-not-found' });
    }

    const byRole = socket.data?.sessionRoles?.[sessionId];
    const ts = Date.now();
    const enriched = {
      sessionId,
      type,
      data: cmd.data || null,
      by: ensureString(cmd.by || byRole || socket.id, ''),
      ts,
    };

    const room = `s:${sessionId}`;
    socket.to(room).emit('session:command', enriched);

    const commandLog = Array.isArray(session.commandLog) ? session.commandLog : [];
    commandLog.push(enriched);
    if (commandLog.length > 50) commandLog.splice(0, commandLog.length - 50);
    session.commandLog = commandLog;
    session.extra = session.extra || {};
    session.extra.commandLog = commandLog;
    session.extra.lastCommand = enriched;

    session.telemetry = session.telemetry || {};
    const updateTelemetryFlag = (flag, value) => {
      session.telemetry[flag] = value;
      session.extra[flag] = value;
    };

    switch (type) {
      case 'share_start':
        updateTelemetryFlag('shareActive', true);
        break;
      case 'share_stop':
        updateTelemetryFlag('shareActive', false);
        break;
      case 'remote_enable':
        updateTelemetryFlag('remoteActive', true);
        break;
      case 'remote_disable':
        updateTelemetryFlag('remoteActive', false);
        break;
      case 'call_start':
        updateTelemetryFlag('callActive', true);
        break;
      case 'call_end':
        updateTelemetryFlag('callActive', false);
        break;
      case 'session_end': {
        session.status = 'closed';
        session.closedAt = ts;
        session.handleTimeMs = ts - (session.acceptedAt || session.createdAt || ts);
        session.outcome = session.outcome || 'peer_ended';
        updateTelemetryFlag('shareActive', false);
        updateTelemetryFlag('callActive', false);
        updateTelemetryFlag('remoteActive', false);
        io.to(room).emit('session:ended', { sessionId, reason: 'peer_ended' });
        io.socketsLeave(room);
        break;
      }
      default:
        break;
    }

    sessions.set(sessionId, session);
    io.emit('session:updated', session);

    respondAck(ack, { ok: true });
  });

  socket.on('session:telemetry', (payload = {}, ack) => {
    const sessionId = normalizeSessionId(payload.sessionId);
    if (!sessionId) {
      return respondAck(ack, { ok: false, err: 'bad-payload' });
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return respondAck(ack, { ok: false, err: 'session-not-found' });
    }

    const data = typeof payload.data === 'object' && payload.data !== null ? payload.data : {};
    const ts = Date.now();
    const status = {
      sessionId,
      from: ensureString(payload.from || '', ''),
      data,
      ts,
    };

    session.telemetry = { ...(session.telemetry || {}), ...data, updatedAt: ts };
    session.extra = session.extra || {};
    session.extra.telemetry = session.telemetry;
    if (typeof data.network !== 'undefined') session.extra.network = ensureString(data.network, session.extra.network || '');
    if (typeof data.health !== 'undefined') session.extra.health = ensureString(data.health, session.extra.health || '');
    if (typeof data.permissions !== 'undefined')
      session.extra.permissions = ensureString(data.permissions, session.extra.permissions || '');
    if (typeof data.alerts !== 'undefined') session.extra.alerts = ensureString(data.alerts, session.extra.alerts || '');
    sessions.set(sessionId, session);

    io.to(`s:${sessionId}`).emit('session:status', status);
    io.emit('session:updated', session);

    respondAck(ack, { ok: true });
  });

  const relaySignal = (eventName) => {
    socket.on(eventName, (payload = {}) => {
      const sessionId = normalizeSessionId(payload.sessionId);
      if (!sessionId) return;
      const room = `s:${sessionId}`;
      socket.to(room).emit(eventName, {
        sessionId,
        ...(payload.sdp ? { sdp: payload.sdp } : {}),
        ...(payload.candidate ? { candidate: payload.candidate } : {}),
      });
    });
  };

  ['signal:offer', 'signal:answer', 'signal:candidate'].forEach(relaySignal);

  socket.on('disconnect', () => {
    connectionIndex.delete(socket.id);
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

// ====== HTTP API (usada pelo central.html)
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

  const now = Date.now();
  const techName = (req.body && req.body.techName) ? ensureString(req.body.techName, 'Técnico') : 'Técnico';
  const baseExtra = typeof r.extra === 'object' && r.extra !== null ? { ...r.extra } : {};
  const chatLog = Array.isArray(baseExtra.chatLog) ? [...baseExtra.chatLog] : [];
  const commandLog = Array.isArray(baseExtra.commandLog) ? [...baseExtra.commandLog] : [];
  const telemetry =
    typeof baseExtra.telemetry === 'object' && baseExtra.telemetry !== null ? { ...baseExtra.telemetry } : {};
  const session = {
    sessionId,
    requestId: id,
    clientId: r.clientId,
    techName,
    clientName: r.clientName,
    brand: r.brand,
    model: r.model,
    osVersion: r.osVersion,
    plan: r.plan,
    issue: r.issue,
    requestedAt: r.createdAt,
    acceptedAt: now,
    waitTimeMs: now - r.createdAt,
    status: 'active',
    createdAt: now,
    extra: { ...baseExtra, chatLog, commandLog, telemetry },
    chatLog,
    commandLog,
    telemetry,
  };
  sessions.set(sessionId, session);

  // notifica cliente que foi aceito + sessionId
  io.to(r.clientId).emit('support:accepted', { sessionId, techName });

  // remove da fila visível
  requests.delete(id);
  io.emit('queue:updated', { requestId: id, state: 'accepted', sessionId });
  io.emit('session:updated', session);

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
  const list = Array.from(sessions.values()).map((s) => ({
    sessionId: s.sessionId,
    requestId: s.requestId,
    techName: s.techName,
    clientName: s.clientName,
    brand: s.brand,
    model: s.model,
    osVersion: s.osVersion,
    plan: s.plan,
    issue: s.issue,
    requestedAt: s.requestedAt,
    acceptedAt: s.acceptedAt,
    waitTimeMs: s.waitTimeMs,
    status: s.status,
    closedAt: s.closedAt || null,
    handleTimeMs: s.handleTimeMs || null,
    firstContactResolution: s.firstContactResolution ?? null,
    npsScore: typeof s.npsScore === 'number' ? s.npsScore : null,
    outcome: s.outcome || null,
    symptom: s.symptom || null,
    solution: s.solution || null,
    notes: s.notes || null,
    chatLog: Array.isArray(s.chatLog) ? s.chatLog : Array.isArray(s.extra?.chatLog) ? s.extra.chatLog : [],
    commandLog: Array.isArray(s.commandLog) ? s.commandLog : Array.isArray(s.extra?.commandLog) ? s.extra.commandLog : [],
    telemetry: typeof s.telemetry === 'object' && s.telemetry !== null
      ? s.telemetry
      : typeof s.extra?.telemetry === 'object' && s.extra.telemetry !== null
        ? s.extra.telemetry
        : {},
    extra: s.extra || {}
  }));
  list.sort((a, b) => (b.acceptedAt || 0) - (a.acceptedAt || 0));
  res.json(list);
});

app.post('/api/sessions/:id/close', (req, res) => {
  const id = req.params.id;
  const session = sessions.get(id);
  if (!session) {
    return res.status(404).json({ error: 'session_not_found' });
  }
  if (session.status === 'closed') {
    return res.status(409).json({ error: 'session_already_closed' });
  }

  const payload = req.body || {};
  session.status = 'closed';
  session.closedAt = Date.now();
  session.outcome = ensureString(payload.outcome || 'resolved', 'resolved');
  session.symptom = ensureString(payload.symptom || '', '') || null;
  session.solution = ensureString(payload.solution || '', '') || null;
  if (payload.notes && typeof payload.notes === 'string') {
    session.notes = ensureString(payload.notes, '');
  }
  if (typeof payload.npsScore !== 'undefined') {
    const nps = Number(payload.npsScore);
    if (!Number.isNaN(nps)) {
      session.npsScore = Math.max(0, Math.min(10, Math.round(nps)));
    }
  }
  if (typeof payload.firstContactResolution !== 'undefined') {
    session.firstContactResolution = Boolean(payload.firstContactResolution);
  }
  session.handleTimeMs = session.closedAt - (session.acceptedAt || session.createdAt);

  io.emit('session:updated', session);

  res.json({ ok: true });
});

app.get('/api/metrics', (_req, res) => {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const allSessions = Array.from(sessions.values());
  const todaysSessions = allSessions.filter((s) => (s.acceptedAt || 0) >= startOfDay);
  const closedToday = todaysSessions.filter((s) => s.status === 'closed');
  const activeSessions = allSessions.filter((s) => s.status === 'active');

  const waitTimes = todaysSessions.map((s) => s.waitTimeMs).filter((ms) => typeof ms === 'number' && ms >= 0);
  const averageWaitMs = waitTimes.length ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length : null;

  const handleTimes = closedToday
    .map((s) => s.handleTimeMs)
    .filter((ms) => typeof ms === 'number' && ms >= 0);
  const averageHandleMs = handleTimes.length ? handleTimes.reduce((a, b) => a + b, 0) / handleTimes.length : null;

  const fcrValues = closedToday
    .filter((s) => typeof s.firstContactResolution === 'boolean')
    .map((s) => (s.firstContactResolution ? 1 : 0));
  const fcrPercentage = fcrValues.length
    ? Math.round((fcrValues.reduce((a, b) => a + b, 0) / fcrValues.length) * 100)
    : null;

  const npsScores = closedToday
    .map((s) => (typeof s.npsScore === 'number' ? s.npsScore : null))
    .filter((n) => n !== null && !Number.isNaN(n));
  let nps = null;
  if (npsScores.length) {
    const promoters = npsScores.filter((score) => score >= 9).length;
    const detractors = npsScores.filter((score) => score <= 6).length;
    nps = Math.round(((promoters - detractors) / npsScores.length) * 100);
  }

  res.json({
    attendancesToday: todaysSessions.length,
    activeSessions: activeSessions.length,
    averageWaitMs,
    averageHandleMs,
    fcrPercentage,
    nps,
    queueSize: requests.size,
    lastUpdated: Date.now(),
  });
});

// Start
server.listen(PORT, () => {
  console.log(`Suporte X signaling server running on :${PORT}`);
});
