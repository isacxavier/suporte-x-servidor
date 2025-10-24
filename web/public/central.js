const state = {
  queue: [],
  sessions: [],
  metrics: null,
  selectedSessionId: null,
};

const dom = {
  queue: document.getElementById('queue'),
  queueEmpty: document.getElementById('queueEmpty'),
  availability: document.getElementById('availabilityLabel'),
  techStatus: document.getElementById('techStatus'),
  techRole: document.getElementById('techRole'),
  techRoleSecondary: document.getElementById('techRoleSecondary'),
  activeSessionsLabel: document.getElementById('activeSessionsLabel'),
  metricAttendances: document.querySelector('[data-metric="attendances"]'),
  metricQueue: document.querySelector('[data-metric="queue"]'),
  metricFcr: document.querySelector('[data-metric="fcr"]'),
  metricFcrDetail: document.querySelector('[data-metric="fcr-detail"]'),
  metricNps: document.querySelector('[data-metric="nps"]'),
  metricNpsDetail: document.querySelector('[data-metric="nps-detail"]'),
  metricHandle: document.querySelector('[data-metric="handle"]'),
  metricWait: document.querySelector('[data-metric="wait"]'),
  contextDevice: document.getElementById('contextDevice'),
  contextIdentity: document.getElementById('contextIdentity'),
  contextNetwork: document.getElementById('contextNetwork'),
  contextHealth: document.getElementById('contextHealth'),
  contextPermissions: document.getElementById('contextPermissions'),
  contextTimeline: document.getElementById('contextTimeline'),
  sessionPlaceholder: document.getElementById('sessionPlaceholder'),
  indicatorNetwork: document.getElementById('indicatorNetwork'),
  indicatorQuality: document.getElementById('indicatorQuality'),
  indicatorAlerts: document.getElementById('indicatorAlerts'),
  techIdentity: document.querySelector('.tech-identity'),
  techInitials: document.getElementById('techInitials'),
  techName: document.getElementById('techName'),
  topbarTechName: document.getElementById('topbarTechName'),
  chatThread: document.getElementById('chatThread'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatInput'),
  quickReplies: document.querySelectorAll('.quick-replies button[data-reply]'),
  closureForm: document.getElementById('closureForm'),
  closureOutcome: document.getElementById('closureOutcome'),
  closureSymptom: document.getElementById('closureSymptom'),
  closureSolution: document.getElementById('closureSolution'),
  closureNps: document.getElementById('closureNps'),
  closureFcr: document.getElementById('closureFcr'),
  closureSubmit: document.getElementById('closureSubmit'),
};

const socket = window.io ? window.io({ transports: ['websocket', 'polling'] }) : null;

const formatTime = (timestamp) => {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

const formatDuration = (ms) => {
  if (typeof ms !== 'number' || Number.isNaN(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const hours = Math.floor(minutes / 60);
  if (hours >= 1) {
    const remMinutes = minutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(remMinutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const formatRelative = (ms) => {
  if (typeof ms !== 'number' || ms < 0) return 'agora';
  const minutes = Math.round(ms / 60000);
  if (minutes <= 1) return 'há instantes';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `há ${hours} h`;
};

const computeInitials = (name) => {
  if (!name) return 'SX';
  const parts = name.trim().split(/\s+/);
  if (!parts.length) return 'SX';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return `${first}${last}`.toUpperCase();
};

const getSelectedSession = () => {
  if (!state.selectedSessionId) return null;
  return state.sessions.find((s) => s.sessionId === state.selectedSessionId) || null;
};

const selectDefaultSession = () => {
  if (state.selectedSessionId) {
    const exists = state.sessions.some((s) => s.sessionId === state.selectedSessionId);
    if (exists) return;
  }
  const active = state.sessions.find((s) => s.status === 'active');
  const fallback = state.sessions[0];
  const chosen = active || fallback || null;
  state.selectedSessionId = chosen ? chosen.sessionId : null;
};

const renderQueue = () => {
  if (!dom.queue) return;
  dom.queue.innerHTML = '';
  if (!state.queue.length) {
    dom.queueEmpty?.removeAttribute('hidden');
    return;
  }
  dom.queueEmpty?.setAttribute('hidden', 'hidden');
  const now = Date.now();

  state.queue.forEach((req) => {
    const article = document.createElement('article');
    article.className = 'ticket';

    const header = document.createElement('div');
    header.className = 'ticket-header';
    const title = document.createElement('span');
    title.className = 'ticket-title';
    const displayName = req.clientName || 'Cliente';
    title.textContent = `#${req.requestId} • ${displayName}`;
    header.appendChild(title);
    const sla = document.createElement('span');
    sla.className = 'badge';
    const waitMs = now - req.createdAt;
    if (waitMs > 12 * 60000) sla.classList.add('danger');
    else if (waitMs > 5 * 60000) sla.classList.add('warning');
    else sla.classList.add('success');
    sla.textContent = `Espera ${formatRelative(waitMs)}`;
    header.appendChild(sla);
    article.appendChild(header);

    if (req.plan || req.issue) {
      const body = document.createElement('div');
      body.className = 'ticket-body';
      if (req.plan) {
        const plan = document.createElement('div');
        plan.className = 'badge dot';
        plan.textContent = req.plan;
        body.appendChild(plan);
      }
      if (req.issue) {
        const issue = document.createElement('div');
        issue.className = 'muted small';
        issue.textContent = req.issue;
        body.appendChild(issue);
      }
      article.appendChild(body);
    }

    const footer = document.createElement('div');
    footer.className = 'ticket-footer';
    const device = document.createElement('span');
    const deviceParts = [req.brand, req.model, req.osVersion ? `Android ${req.osVersion}` : null].filter(Boolean);
    device.textContent = deviceParts.length ? deviceParts.join(' • ') : 'Dispositivo não informado';
    footer.appendChild(device);
    const waited = document.createElement('span');
    waited.textContent = formatRelative(waitMs);
    footer.appendChild(waited);
    article.appendChild(footer);

    const actions = document.createElement('div');
    actions.className = 'ticket-actions';
    const acceptBtn = document.createElement('button');
    acceptBtn.className = 'tag-btn primary';
    acceptBtn.type = 'button';
    acceptBtn.textContent = 'Aceitar';
    acceptBtn.addEventListener('click', () => acceptRequest(req.requestId));
    actions.appendChild(acceptBtn);
    const transferBtn = document.createElement('button');
    transferBtn.className = 'tag-btn';
    transferBtn.type = 'button';
    transferBtn.textContent = 'Ver detalhes';
    transferBtn.addEventListener('click', () => {
      addChatMessage({
        author: 'Sistema',
        text: `Chamado ${req.requestId} de ${displayName}.`,
        kind: 'system',
      });
    });
    actions.appendChild(transferBtn);
    article.appendChild(actions);

    dom.queue.appendChild(article);
  });
};

const updateTechIdentity = () => {
  if (!dom.techIdentity) return;
  const name = dom.techIdentity.dataset.techName || 'Técnico';
  dom.techName.textContent = name;
  dom.topbarTechName.textContent = name;
  dom.techInitials.textContent = computeInitials(name);
};

const renderSessions = () => {
  const active = state.sessions.filter((s) => s.status === 'active');
  const label = active.length === 1 ? '1 em andamento' : `${active.length} em andamento`;
  dom.activeSessionsLabel.textContent = label;
  dom.techStatus.textContent = active.length ? 'Em atendimento agora' : 'Aguardando chamados';
  dom.availability.textContent = active.length ? 'Em atendimento' : 'Disponível';
  selectDefaultSession();
  const session = getSelectedSession();
  if (!session) {
    dom.contextDevice.textContent = '—';
    dom.contextIdentity.textContent = 'Nenhum atendimento selecionado';
    dom.contextNetwork.textContent = '—';
    dom.contextHealth.textContent = '—';
    dom.contextPermissions.textContent = '—';
    dom.sessionPlaceholder.textContent = 'Aguardando seleção de sessão';
    return;
  }

  const deviceParts = [session.brand, session.model, session.osVersion ? `Android ${session.osVersion}` : null].filter(Boolean);
  dom.contextDevice.textContent = deviceParts.length ? deviceParts.join(' • ') : 'Dispositivo não informado';
  dom.contextIdentity.textContent = session.clientName ? `${session.clientName}` : 'Cliente';
  dom.contextNetwork.textContent = session.extra?.network || 'Aguardando dados do app';
  dom.contextHealth.textContent = session.extra?.health || 'Aguardando dados do app';
  dom.contextPermissions.textContent = session.extra?.permissions || 'Sem registros';
  dom.sessionPlaceholder.textContent = session.status === 'active'
    ? `Sessão ${session.sessionId} • aguardando conexão`
    : `Sessão ${session.sessionId} encerrada ${formatRelative(Date.now() - (session.closedAt || session.acceptedAt))}`;
  dom.indicatorNetwork.textContent = session.extra?.network || (session.status === 'active' ? 'Aguardando telemetria do app' : 'Sessão encerrada');
  dom.indicatorQuality.textContent = session.status === 'active' ? 'Online' : 'Finalizada';
  dom.indicatorAlerts.textContent = session.status === 'active' ? 'Sem alertas' : 'Encerrada';

  if (dom.contextTimeline) {
    dom.contextTimeline.innerHTML = '';
    const events = [];
    if (session.requestedAt) events.push({ at: session.requestedAt, text: 'Cliente entrou na fila' });
    if (session.acceptedAt) events.push({ at: session.acceptedAt, text: 'Atendimento aceito pelo técnico' });
    if (session.closedAt) events.push({ at: session.closedAt, text: 'Atendimento encerrado' });
    if (!events.length) {
      const entry = document.createElement('div');
      entry.className = 'timeline-entry';
      entry.textContent = 'Sem eventos registrados ainda.';
      dom.contextTimeline.appendChild(entry);
    } else {
      events
        .sort((a, b) => a.at - b.at)
        .forEach((evt) => {
          const entry = document.createElement('div');
          entry.className = 'timeline-entry';
          entry.textContent = `${formatTime(evt.at)} • ${evt.text}`;
          dom.contextTimeline.appendChild(entry);
        });
    }
  }

  if (dom.closureForm) {
    const isClosed = session.status === 'closed';
    dom.closureSubmit.disabled = isClosed;
    dom.closureSubmit.textContent = isClosed ? 'Atendimento encerrado' : 'Encerrar suporte e disparar pesquisa';
    dom.closureOutcome.disabled = isClosed;
    dom.closureSymptom.disabled = isClosed;
    dom.closureSolution.disabled = isClosed;
    dom.closureNps.disabled = isClosed;
    dom.closureFcr.disabled = isClosed;
  }
};

const renderMetrics = () => {
  if (!state.metrics) return;
  dom.metricAttendances.textContent = state.metrics.attendancesToday ?? 0;
  dom.metricQueue.textContent = `Fila atual: ${state.metrics.queueSize ?? 0}`;
  dom.metricFcr.textContent = typeof state.metrics.fcrPercentage === 'number' ? `${state.metrics.fcrPercentage}%` : '—';
  dom.metricFcrDetail.textContent = state.metrics.fcrPercentage != null ? 'Base: atendimentos encerrados hoje' : 'Aguardando dados';
  dom.metricNps.textContent = typeof state.metrics.nps === 'number' ? state.metrics.nps : '—';
  dom.metricNpsDetail.textContent = state.metrics.nps != null ? 'Cálculo: promotores - detratores' : 'Coletado ao encerrar';
  dom.metricHandle.textContent = state.metrics.averageHandleMs != null ? formatDuration(state.metrics.averageHandleMs) : '—';
  dom.metricWait.textContent = state.metrics.averageWaitMs != null ? `Espera média ${formatDuration(state.metrics.averageWaitMs)}` : 'Espera média —';
};

const addChatMessage = ({ author, text, kind = 'client' }) => {
  if (!dom.chatThread || !text) return;
  const entry = document.createElement('div');
  entry.className = 'message';
  if (kind === 'self') entry.classList.add('self');
  if (kind === 'system') entry.classList.add('system');
  entry.textContent = `${formatTime(Date.now())} • ${author}: ${text}`;
  dom.chatThread.appendChild(entry);
  dom.chatThread.scrollTo({ top: dom.chatThread.scrollHeight, behavior: 'smooth' });
};

const acceptRequest = async (requestId) => {
  if (!requestId) return;
  const techName = dom.techIdentity?.dataset?.techName || 'Técnico';
  try {
    const res = await fetch(`/api/requests/${requestId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ techName }),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || 'Falha ao aceitar chamado');
    }
    const { sessionId } = await res.json();
    addChatMessage({ author: 'Sistema', text: `Chamado ${requestId} aceito. Sessão ${sessionId}`, kind: 'system' });
    await Promise.all([loadQueue(), loadSessions(), loadMetrics()]);
  } catch (error) {
    console.error(error);
    addChatMessage({ author: 'Sistema', text: error.message || 'Não foi possível aceitar o chamado.', kind: 'system' });
  }
};

const loadQueue = async () => {
  try {
    const res = await fetch('/api/requests?status=queued');
    if (!res.ok) throw new Error('Erro ao carregar fila');
    const data = await res.json();
    state.queue = Array.isArray(data) ? data : [];
    renderQueue();
  } catch (error) {
    console.error(error);
    state.queue = [];
    renderQueue();
  }
};

const loadSessions = async () => {
  try {
    const res = await fetch('/api/sessions');
    if (!res.ok) throw new Error('Erro ao carregar sessões');
    const data = await res.json();
    state.sessions = Array.isArray(data) ? data : [];
    renderSessions();
  } catch (error) {
    console.error(error);
  }
};

const loadMetrics = async () => {
  try {
    const res = await fetch('/api/metrics');
    if (!res.ok) throw new Error('Erro ao carregar métricas');
    state.metrics = await res.json();
    renderMetrics();
  } catch (error) {
    console.error(error);
  }
};

const initChat = () => {
  dom.chatThread.innerHTML = '';
  addChatMessage({ author: 'Sistema', text: 'Painel conectado. Aguardando chamados.', kind: 'system' });
  if (dom.chatForm) {
    dom.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = dom.chatInput.value.trim();
      if (!text) return;
      addChatMessage({ author: dom.techIdentity?.dataset?.techName || 'Você', text, kind: 'self' });
      dom.chatInput.value = '';
    });
  }
  dom.quickReplies.forEach((button) => {
    button.addEventListener('click', () => {
      const template = button.dataset.reply;
      if (!template) return;
      dom.chatInput.value = template;
      dom.chatInput.focus();
    });
  });
};

const bindClosureForm = () => {
  if (!dom.closureForm) return;
  dom.closureForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const session = getSelectedSession();
    if (!session) {
      addChatMessage({ author: 'Sistema', text: 'Nenhuma sessão selecionada.', kind: 'system' });
      return;
    }
    if (session.status === 'closed') {
      addChatMessage({ author: 'Sistema', text: 'Essa sessão já foi encerrada.', kind: 'system' });
      return;
    }

    dom.closureSubmit.disabled = true;
    dom.closureSubmit.textContent = 'Enviando…';
    const payload = {
      outcome: dom.closureOutcome.value,
      symptom: dom.closureSymptom.value.trim(),
      solution: dom.closureSolution.value.trim(),
      firstContactResolution: dom.closureFcr.checked,
    };
    const nps = dom.closureNps.value;
    if (nps !== '') payload.npsScore = Number(nps);
    try {
      const res = await fetch(`/api/sessions/${session.sessionId}/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Erro ao encerrar atendimento');
      }
      addChatMessage({ author: 'Sistema', text: `Sessão ${session.sessionId} encerrada.`, kind: 'system' });
      dom.closureForm.reset();
      await Promise.all([loadSessions(), loadMetrics()]);
    } catch (error) {
      console.error(error);
      addChatMessage({ author: 'Sistema', text: error.message || 'Falha ao encerrar a sessão.', kind: 'system' });
    } finally {
      dom.closureSubmit.disabled = false;
      dom.closureSubmit.textContent = 'Encerrar suporte e disparar pesquisa';
    }
  });
};

const bootstrap = async () => {
  updateTechIdentity();
  initChat();
  bindClosureForm();
  await Promise.all([loadQueue(), loadSessions(), loadMetrics()]);
};

if (socket) {
  socket.on('connect', () => {
    addChatMessage({ author: 'Sistema', text: 'Conectado ao servidor de sinalização.', kind: 'system' });
  });
  socket.on('disconnect', () => {
    addChatMessage({ author: 'Sistema', text: 'Desconectado. Tentando reconectar…', kind: 'system' });
  });
  socket.on('queue:updated', () => {
    loadQueue();
    loadMetrics();
  });
  socket.on('session:updated', (session) => {
    const index = state.sessions.findIndex((s) => s.sessionId === session.sessionId);
    if (index >= 0) {
      state.sessions[index] = { ...state.sessions[index], ...session };
    } else {
      state.sessions.unshift(session);
    }
    renderSessions();
    loadMetrics();
  });
}

bootstrap();
