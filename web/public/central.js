import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  where,
  Timestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const SessionStates = Object.freeze({
  IDLE: 'IDLE',
  ACTIVE: 'ACTIVE',
  ENDED: 'ENDED',
});

const state = {
  queue: [],
  sessions: [],
  metrics: null,
  techProfile: null,
  techIdentifiers: new Set(),
  selectedSessionId: null,
  joinedSessionId: null,
  sessionState: SessionStates.IDLE,
  activeSessionId: null,
  chatBySession: new Map(),
  telemetryBySession: new Map(),
  renderedChatSessionId: null,
  commandState: {
    shareActive: false,
    remoteActive: false,
    callActive: false,
  },
  media: {
    sessionId: null,
    pc: null,
    local: {
      screen: null,
      audio: null,
    },
    senders: {
      screen: [],
      audio: [],
    },
    remoteStream: null,
    remoteAudioStream: null,
  },
  legacyShare: {
    room: null,
    pc: null,
    remoteStream: null,
    remoteAudioStream: null,
    active: false,
    pendingRoom: null,
  },
};

let firebaseAppInstance = null;
let firestoreInstance = null;
let authInstance = null;
let authReadyPromise = null;
let firebaseConfigCache = null;

const QUEUE_RETRY_INITIAL_DELAY_MS = 5000;
const QUEUE_RETRY_MAX_DELAY_MS = 60000;
let queueRetryDelayMs = QUEUE_RETRY_INITIAL_DELAY_MS;
let queueRetryTimer = null;
let queueLoadPromise = null;
let queueUnavailable = false;

const resolveFirebaseConfig = () => {
  if (firebaseConfigCache) return firebaseConfigCache;
  const candidates = [
    typeof window !== 'undefined' ? window.__FIREBASE_CONFIG__ : null,
    typeof window !== 'undefined' ? window.firebaseConfig : null,
    typeof window !== 'undefined' ? window.__firebaseConfig__ : null,
    typeof window !== 'undefined' ? window.__firebaseConfig : null,
    typeof window !== 'undefined' ? window.__CENTRAL_CONFIG__?.firebase : null,
    typeof window !== 'undefined' ? window.__APP_CONFIG__?.firebase : null,
  ];
  firebaseConfigCache = candidates.find((candidate) => candidate && typeof candidate === 'object') || null;
  return firebaseConfigCache;
};

const ensureFirebaseApp = () => {
  if (firebaseAppInstance) return firebaseAppInstance;
  const config = resolveFirebaseConfig();
  if (!config) {
    console.warn('Firebase config ausente para o painel da central.');
    return null;
  }
  try {
    const apps = getApps();
    firebaseAppInstance = apps.length ? apps[0] : initializeApp(config);
  } catch (error) {
    console.error('Erro ao inicializar Firebase', error);
    firebaseAppInstance = null;
  }
  return firebaseAppInstance;
};

const ensureFirestore = () => {
  if (firestoreInstance) return firestoreInstance;
  const app = ensureFirebaseApp();
  if (!app) return null;
  try {
    firestoreInstance = getFirestore(app);
  } catch (error) {
    console.error('Erro ao inicializar Firestore', error);
    firestoreInstance = null;
  }
  return firestoreInstance;
};

const waitForAuthUser = () =>
  new Promise((resolve, reject) => {
    if (!authInstance) {
      reject(new Error('Auth não inicializado'));
      return;
    }
    const unsub = onAuthStateChanged(
      authInstance,
      (user) => {
        if (user) {
          unsub();
          resolve(user);
        }
      },
      (error) => {
        unsub();
        reject(error);
      }
    );
  });

const ensureAuth = async () => {
  if (authReadyPromise) return authReadyPromise;
  const app = ensureFirebaseApp();
  if (!app) return null;
  if (!authInstance) {
    try {
      authInstance = getAuth(app);
    } catch (error) {
      console.error('Erro ao inicializar Firebase Auth', error);
      return null;
    }
  }
  if (authInstance.currentUser) {
    console.log('AUTH OK uid=', authInstance.currentUser.uid);
    return authInstance.currentUser;
  }

  authReadyPromise = (async () => {
    try {
      await signInAnonymously(authInstance);
    } catch (error) {
      console.error('Falha ao autenticar no Firebase', error);
      throw error;
    }
    const user = await waitForAuthUser();
    console.log('AUTH OK uid=', user.uid);
    return user;
  })();

  try {
    return await authReadyPromise;
  } finally {
    authReadyPromise = null;
  }
};

const sessionRealtimeSubscriptions = new Map();
let pendingSessionsPromise = null;

const unsubscribeSessionRealtime = (sessionId) => {
  const entry = sessionRealtimeSubscriptions.get(sessionId);
  if (!entry) return;
  try {
    if (typeof entry.messages === 'function') entry.messages();
  } catch (error) {
    console.warn('Falha ao cancelar listener de mensagens', error);
  }
  try {
    if (typeof entry.events === 'function') entry.events();
  } catch (error) {
    console.warn('Falha ao cancelar listener de eventos', error);
  }
  sessionRealtimeSubscriptions.delete(sessionId);
};

const unsubscribeAllSessionRealtime = () => {
  sessionRealtimeSubscriptions.forEach((_value, sessionId) => unsubscribeSessionRealtime(sessionId));
  sessionRealtimeSubscriptions.clear();
};

const dom = {
  queue: document.getElementById('queue'),
  queueEmpty: document.getElementById('queueEmpty'),
  queueRetry: document.getElementById('queueRetry'),
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
  techDataset: document.body,
  topbarTechName: document.getElementById('topbarTechName'),
  chatThread: document.getElementById('chatThread'),
  chatForm: document.getElementById('chatForm'),
  chatInput: document.getElementById('chatInput'),
  quickReplies: document.querySelectorAll('.quick-replies button[data-reply]'),
  sessionVideo: document.getElementById('sessionVideo'),
  sessionAudio: document.getElementById('sessionAudio'),
  videoShell: document.getElementById('videoShell'),
  controlStart: document.getElementById('controlStart'),
  controlQuality: document.getElementById('controlQuality'),
  controlRemote: document.getElementById('controlRemote'),
  controlFullscreen: document.getElementById('controlFullscreen'),
  controlPip: document.getElementById('controlPip'),
  controlStats: document.getElementById('controlStats'),
  controlMenuToggle: document.getElementById('controlMenuToggle'),
  controlMenuPanel: document.getElementById('controlMenuPanel'),
  controlMenuBackdrop: document.getElementById('controlMenuBackdrop'),
  webSharePanel: document.getElementById('webSharePanel'),
  webShareRoom: document.getElementById('webShareRoom'),
  webShareConnect: document.getElementById('webShareConnect'),
  webShareDisconnect: document.getElementById('webShareDisconnect'),
  webShareStatus: document.getElementById('webShareStatus'),
  closureForm: document.getElementById('closureForm'),
  closureOutcome: document.getElementById('closureOutcome'),
  closureSymptom: document.getElementById('closureSymptom'),
  closureSolution: document.getElementById('closureSolution'),
  closureNps: document.getElementById('closureNps'),
  closureFcr: document.getElementById('closureFcr'),
  closureSubmit: document.getElementById('closureSubmit'),
  toast: document.getElementById('toast'),
};

const getLegacyRoomFromQuery = () => {
  try {
    return new URLSearchParams(window.location.search).get('room');
  } catch (error) {
    console.warn('Falha ao ler room da URL', error);
    return null;
  }
};

const getTechDatasetElement = () => dom.techIdentity || dom.techDataset;

const getTechDataset = () => getTechDatasetElement()?.dataset || {};

const updateTechDataset = (entries = {}) => {
  const target = getTechDatasetElement();
  if (!target) return;
  Object.entries(entries).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    target.dataset[key] = String(value);
  });
};

const showToast = (message) => {
  if (!dom.toast) return;
  dom.toast.textContent = message;
  dom.toast.hidden = !message;
};

const hideToast = () => {
  if (!dom.toast) return;
  dom.toast.textContent = '';
  dom.toast.hidden = true;
};

const hasActiveVideo = () => Boolean(dom.sessionVideo && dom.sessionVideo.srcObject && !dom.sessionVideo.hidden);

const updateFullscreenLabel = () => {
  if (!dom.controlFullscreen) return;
  dom.controlFullscreen.textContent = document.fullscreenElement ? 'Sair tela cheia' : 'Tela cheia';
};

const updatePipLabel = () => {
  if (!dom.controlPip) return;
  dom.controlPip.textContent = document.pictureInPictureElement ? 'Fechar janela' : 'Janela flutuante';
};

const setControlMenuOpen = (isOpen) => {
  if (!dom.videoShell || !dom.controlMenuToggle || !dom.controlMenuPanel) return;
  dom.videoShell.classList.toggle('control-menu-open', isOpen);
  dom.controlMenuToggle.setAttribute('aria-expanded', String(isOpen));
  dom.controlMenuPanel.setAttribute('aria-hidden', String(!isOpen));
  if (dom.controlMenuBackdrop) {
    dom.controlMenuBackdrop.hidden = !isOpen;
  }
};

const toggleControlMenu = () => {
  if (!dom.videoShell) return;
  const isOpen = dom.videoShell.classList.contains('control-menu-open');
  setControlMenuOpen(!isOpen);
};

const clearQueueRetryTimer = () => {
  if (queueRetryTimer) {
    clearTimeout(queueRetryTimer);
    queueRetryTimer = null;
  }
};

const resetQueueRetryTimer = () => {
  clearQueueRetryTimer();
  queueRetryDelayMs = QUEUE_RETRY_INITIAL_DELAY_MS;
};

const resetQueueRetryState = () => {
  resetQueueRetryTimer();
  queueUnavailable = false;
  if (dom.queueRetry) {
    dom.queueRetry.hidden = true;
  }
  hideToast();
};

const scheduleQueueRetry = (statusText = '') => {
  clearQueueRetryTimer();
  const delay = queueRetryDelayMs;
  queueRetryTimer = window.setTimeout(() => {
    queueRetryTimer = null;
    loadQueue();
  }, delay);
  const seconds = Math.round(delay / 1000);
  const context = statusText ? ` (${statusText})` : '';
  console.warn(`[queue] Fila indisponível${context}. Nova tentativa em ${seconds}s.`);
  queueRetryDelayMs = Math.min(queueRetryDelayMs * 2, QUEUE_RETRY_MAX_DELAY_MS);
};

const updateQueueMetrics = (size) => {
  if (!state.metrics) return;
  state.metrics = {
    ...state.metrics,
    queueSize: typeof size === 'number' ? size : null,
    lastUpdated: Date.now(),
  };
  renderMetrics();
};

const markQueueUnavailable = ({ statusText = '' } = {}) => {
  if (!queueUnavailable) {
    queueUnavailable = true;
    queueRetryDelayMs = QUEUE_RETRY_INITIAL_DELAY_MS;
  }
  if (dom.queueRetry) {
    dom.queueRetry.hidden = false;
  }
  showToast('Fila indisponível. Tente novamente.');
  state.queue = [];
  renderQueue();
  updateQueueMetrics(0);
  scheduleQueueRetry(statusText);
};

const normalizeIdentifier = (value) => {
  if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  return null;
};

const updateTechIdentifiers = (tech) => {
  const identifiers = new Set();
  if (tech) {
    const add = (value) => {
      if (value == null) return;
      const normalized = normalizeIdentifier(typeof value === 'string' ? value : String(value));
      if (normalized) identifiers.add(normalized);
    };
    add(tech.uid);
    add(tech.id);
    add(tech.email);
    add(tech.name);
  }
  state.techIdentifiers = identifiers;
  return identifiers;
};

const getTechProfile = () => {
  const dataset = dom.techIdentity?.dataset || {};
  const candidates = [
    typeof window !== 'undefined' ? window.__CENTRAL_TECH__ : null,
    typeof window !== 'undefined' ? window.__TECH__ : null,
    typeof window !== 'undefined' ? window.centralTech : null,
    typeof window !== 'undefined' ? window.__CENTRAL_CONTEXT__?.tech : null,
  ];
  const context = candidates.find((candidate) => candidate && typeof candidate === 'object') || {};
  const previous = state.techProfile || {};
  const resolvedUid =
    context.uid ||
    context.techUid ||
    context.id ||
    dataset.techUid ||
    dataset.techId ||
    dataset.uid ||
    previous.uid ||
    previous.id ||
    null;
  const resolvedId =
    context.id ||
    context.techId ||
    dataset.techId ||
    dataset.techUid ||
    previous.id ||
    previous.uid ||
    resolvedUid ||
    null;
  const resolvedEmail =
    context.email ||
    context.techEmail ||
    dataset.techEmail ||
    dataset.email ||
    previous.email ||
    null;
  const resolvedName =
    context.name ||
    context.techName ||
    dataset.techName ||
    dataset.name ||
    previous.name ||
    dom.techIdentity?.textContent?.trim() ||
    'Técnico';
  const tech = {
    ...previous,
    ...context,
    uid: resolvedUid,
    id: resolvedId,
    name: resolvedName,
    email: resolvedEmail,
  };
  state.techProfile = tech;
  updateTechIdentifiers(tech);
  if (dom.techIdentity) {
    if (tech.uid) dom.techIdentity.dataset.techUid = tech.uid;
    else delete dom.techIdentity.dataset.techUid;
    if (tech.id) dom.techIdentity.dataset.techId = tech.id;
    else delete dom.techIdentity.dataset.techId;
    if (tech.name) dom.techIdentity.dataset.techName = tech.name;
    else delete dom.techIdentity.dataset.techName;
    if (tech.email) dom.techIdentity.dataset.techEmail = tech.email;
    else delete dom.techIdentity.dataset.techEmail;
  }
  return state.techProfile;
};

const ensureTechIdentifiers = () => {
  if (state.techIdentifiers instanceof Set && state.techIdentifiers.size) {
    return state.techIdentifiers;
  }
  const profile = state.techProfile || getTechProfile();
  return updateTechIdentifiers(profile);
};

const extractSessionIdentifiers = (session) => {
  if (!session || typeof session !== 'object') return [];
  const identifiers = [];
  const push = (value) => {
    if (value != null) identifiers.push(value);
  };
  push(session.techUid);
  push(session.techId);
  push(session.techEmail);
  push(session.techName);
  const extra = session.extra || {};
  if (extra) {
    push(extra.techUid);
    push(extra.techId);
    push(extra.techEmail);
    push(extra.techName);
    if (extra.tech && typeof extra.tech === 'object') {
      push(extra.tech.uid);
      push(extra.tech.id);
      push(extra.tech.email);
      push(extra.tech.name);
    }
  }
  return identifiers;
};

const sessionMatchesCurrentTech = (session) => {
  const identifiers = ensureTechIdentifiers();
  if (!(identifiers instanceof Set) || identifiers.size === 0) {
    return true;
  }
  const candidates = extractSessionIdentifiers(session)
    .map((value) => normalizeIdentifier(String(value)))
    .filter(Boolean);
  if (!candidates.length) return false;
  return candidates.some((candidate) => identifiers.has(candidate));
};

const filterSessionsForCurrentTech = (sessions) => {
  if (!Array.isArray(sessions)) return [];
  const identifiers = ensureTechIdentifiers();
  if (!(identifiers instanceof Set) || identifiers.size === 0) {
    return sessions;
  }
  return sessions.filter((session) => sessionMatchesCurrentTech(session));
};

const pickSessionQueryConstraint = (tech) => {
  if (!tech || typeof tech !== 'object') return null;
  const attempts = [
    ['techUid', tech.uid],
    ['techId', tech.id],
    ['techEmail', tech.email],
    ['tech.uid', tech.uid],
    ['tech.id', tech.id],
    ['tech.email', tech.email],
  ];
  for (const [field, value] of attempts) {
    if (typeof value === 'string' && value.trim()) {
      return { field, value };
    }
  }
  return null;
};

const SOCKET_URL = window.location.origin;
const socket = window.io
  ? window.io(SOCKET_URL, {
      transports: ['websocket'],
      withCredentials: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 20000,
    })
  : null;

const CHAT_RENDER_LIMIT = 100;
const TIMELINE_RENDER_LIMIT = 80;

const pendingRenderJobs = [];
let pendingRafId = null;

function setSessionState(nextState, sessionId = null) {
  if (!Object.values(SessionStates).includes(nextState)) return;
  const changed = state.sessionState !== nextState || state.activeSessionId !== sessionId;
  state.sessionState = nextState;
  state.activeSessionId = sessionId;
  if (changed && document && document.body) {
    document.body.dataset.sessionState = nextState;
  }
}

function isSessionCurrent(sessionId) {
  if (!sessionId) return false;
  return (
    state.activeSessionId === sessionId ||
    state.joinedSessionId === sessionId ||
    state.selectedSessionId === sessionId
  );
}

function markSessionActive(sessionId) {
  if (!sessionId) return;
  setSessionState(SessionStates.ACTIVE, sessionId);
}

function markSessionEnded(sessionId, reason = 'peer_ended') {
  if (!sessionId) return;
  if (state.sessionState === SessionStates.IDLE) return;
  if (!isSessionCurrent(sessionId)) return;
  setSessionState(SessionStates.ENDED, sessionId);
  resetDashboard({ sessionId, reason });
}

function scheduleRender(fn) {
  if (typeof fn !== 'function') return;
  pendingRenderJobs.push(fn);
  if (pendingRafId) return;
  pendingRafId = requestAnimationFrame(() => {
    const jobs = pendingRenderJobs.splice(0, pendingRenderJobs.length);
    pendingRafId = null;
    for (const job of jobs) {
      try {
        job();
      } catch (error) {
        console.error('Render job failed', error);
      }
    }
  });
}

function cancelScheduledRenders() {
  if (pendingRafId) {
    cancelAnimationFrame(pendingRafId);
    pendingRafId = null;
  }
  pendingRenderJobs.length = 0;
}

const sessionResources = {
  timeouts: new Set(),
  intervals: new Set(),
  observers: new Set(),
  socketHandlers: new Map(),
};

function trackTimeout(id) {
  if (typeof id === 'number') sessionResources.timeouts.add(id);
  return id;
}

function trackInterval(id) {
  if (typeof id === 'number') sessionResources.intervals.add(id);
  return id;
}

function trackObserver(observer) {
  if (observer && typeof observer.disconnect === 'function') {
    sessionResources.observers.add(observer);
  }
  return observer;
}

function registerSocketHandler(eventName, handler) {
  if (!socket || typeof eventName !== 'string' || typeof handler !== 'function') return;
  const existing = sessionResources.socketHandlers.get(eventName);
  if (existing) {
    socket.off(eventName, existing);
  }
  sessionResources.socketHandlers.set(eventName, handler);
  socket.on(eventName, handler);
}

const toMillis = (value) => {
  if (!value && value !== 0) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === 'object' && value !== null) {
    if (typeof value.toMillis === 'function') {
      return value.toMillis();
    }
    if (typeof value.toDate === 'function') {
      const date = value.toDate();
      return date instanceof Date ? date.getTime() : null;
    }
    if (typeof value.seconds === 'number') {
      const nanos = typeof value.nanoseconds === 'number' ? value.nanoseconds : 0;
      return value.seconds * 1000 + Math.floor(nanos / 1e6);
    }
  }
  return null;
};

const describeTimelineEvent = (event) => {
  if (!event || typeof event !== 'object') return null;
  const directText = event.text || event.description || event.label || event.message || event.title;
  if (typeof directText === 'string' && directText.trim()) return directText.trim();
  const type =
    typeof event.type === 'string'
      ? event.type
      : typeof event.eventType === 'string'
        ? event.eventType
        : typeof event.kind === 'string'
          ? event.kind
          : typeof event.name === 'string'
            ? event.name
            : null;
  if (!type) return null;
  const normalized = type.toLowerCase();
  const dictionary = {
    queue_entered: 'Cliente entrou na fila',
    request_created: 'Cliente entrou na fila',
    session_accepted: 'Atendimento aceito pelo técnico',
    session_closed: 'Atendimento encerrado',
    share_start: 'Compartilhamento de tela iniciado',
    share_stop: 'Compartilhamento de tela encerrado',
    remote_start: 'Acesso remoto iniciado',
    remote_stop: 'Acesso remoto encerrado',
    call_start: 'Chamada iniciada',
    call_stop: 'Chamada encerrada',
  };
  if (dictionary[normalized]) return dictionary[normalized];
  return normalized.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

const normalizeSessionDoc = (doc) => {
  if (!doc) return null;
  const data = typeof doc.data === 'function' ? doc.data() : {};
  const sessionId = data.sessionId || doc.id;
  const requestedAt = toMillis(data.requestedAt || data.timestamps?.requestedAt || data.createdAt);
  const acceptedAt = toMillis(data.acceptedAt || data.timestamps?.acceptedAt || data.startedAt);
  const closedAt = toMillis(data.closedAt || data.timestamps?.closedAt || data.finishedAt);
  const waitTimeMsRaw = typeof data.waitTimeMs === 'number' ? data.waitTimeMs : null;
  const handleTimeMsRaw = typeof data.handleTimeMs === 'number' ? data.handleTimeMs : null;
  const waitTimeMs =
    waitTimeMsRaw != null ? waitTimeMsRaw : acceptedAt && requestedAt ? acceptedAt - requestedAt : null;
  const handleTimeMs =
    handleTimeMsRaw != null ? handleTimeMsRaw : closedAt && acceptedAt ? closedAt - acceptedAt : null;
  const extra = typeof data.extra === 'object' && data.extra !== null ? { ...data.extra } : {};
  const telemetry =
    typeof data.telemetry === 'object' && data.telemetry !== null ? { ...data.telemetry } : { ...extra.telemetry };
  const chatLog = Array.isArray(data.chatLog)
    ? data.chatLog
    : Array.isArray(extra.chatLog)
      ? extra.chatLog
      : [];
  const timeline = Array.isArray(extra.timeline) ? extra.timeline.map((item) => ({ ...item })) : [];
  const tech = getTechProfile();
  return {
    sessionId,
    requestId: data.requestId || data.request?.id || sessionId,
    techName: data.techName || data.tech?.name || tech.name,
    techId: data.tech?.id || data.techId || tech.id || tech.uid || null,
    techUid: data.tech?.uid || data.techUid || tech.uid || tech.id || null,
    techEmail: data.tech?.email || data.techEmail || tech.email || null,
    clientName: data.clientName || data.client?.name || data.client?.displayName || 'Cliente',
    brand: data.brand || data.device?.brand || data.client?.device?.brand || null,
    model: data.model || data.device?.model || data.client?.device?.model || null,
    osVersion: data.osVersion || data.device?.osVersion || data.client?.device?.osVersion || null,
    plan: data.plan || data.client?.plan || data.context?.plan || null,
    issue: data.issue || data.client?.issue || data.context?.issue || null,
    requestedAt: requestedAt || null,
    acceptedAt: acceptedAt || null,
    waitTimeMs: waitTimeMs != null ? waitTimeMs : null,
    status: data.status || (closedAt ? 'closed' : 'active'),
    closedAt: closedAt || null,
    handleTimeMs: handleTimeMs != null ? handleTimeMs : null,
    firstContactResolution:
      typeof data.firstContactResolution === 'boolean'
        ? data.firstContactResolution
        : typeof data.outcome?.firstContactResolution === 'boolean'
          ? data.outcome.firstContactResolution
          : null,
    npsScore:
      typeof data.npsScore === 'number'
        ? data.npsScore
        : typeof data.outcome?.npsScore === 'number'
          ? data.outcome.npsScore
          : null,
    outcome: data.outcome || null,
    symptom: data.symptom || null,
    solution: data.solution || null,
    chatLog,
    telemetry,
    extra: { ...extra, chatLog, timeline },
  };
};

const normalizeMessageDoc = (doc) => {
  if (!doc) return null;
  const data = typeof doc.data === 'function' ? doc.data() : {};
  const text = data.text || data.body || data.message || '';
  if (typeof text !== 'string' || !text.trim()) return null;
  const ts =
    toMillis(data.ts) ||
    toMillis(data.timestamp) ||
    toMillis(data.createdAt) ||
    toMillis(data.sentAt) ||
    Date.now();
  const fromRaw = data.from || data.author || data.sender || 'client';
  const from = typeof fromRaw === 'string' ? fromRaw : 'client';
  return {
    id: data.id || doc.id,
    from,
    text: text.trim(),
    ts,
  };
};

const normalizeEventDoc = (doc) => {
  if (!doc) return null;
  const data = typeof doc.data === 'function' ? doc.data() : {};
  const at =
    toMillis(data.at) ||
    toMillis(data.timestamp) ||
    toMillis(data.ts) ||
    toMillis(data.createdAt) ||
    toMillis(data.updatedAt) ||
    toMillis(doc?.createTime) ||
    toMillis(doc?.updateTime) ||
    null;
  const telemetryPayload = {};
  if (typeof data.shareActive === 'boolean') telemetryPayload.shareActive = data.shareActive;
  if (typeof data.remoteActive === 'boolean') telemetryPayload.remoteActive = data.remoteActive;
  if (typeof data.callActive === 'boolean') telemetryPayload.callActive = data.callActive;
  if (typeof data.network !== 'undefined') telemetryPayload.network = data.network;
  if (typeof data.health !== 'undefined') telemetryPayload.health = data.health;
  if (typeof data.permissions !== 'undefined') telemetryPayload.permissions = data.permissions;
  if (typeof data.alerts !== 'undefined') telemetryPayload.alerts = data.alerts;
  if (typeof data.telemetry === 'object' && data.telemetry !== null) {
    Object.assign(telemetryPayload, data.telemetry);
  }
  return {
    id: doc.id,
    at,
    text: describeTimelineEvent(data),
    telemetry: telemetryPayload,
  };
};

const handleEventsSnapshot = (sessionId, snapshot) => {
  const events = snapshot.docs.map((docSnap) => normalizeEventDoc(docSnap)).filter(Boolean);
  const timeline = events
    .map((evt) => ({
      at: evt.at || Date.now(),
      text: evt.text || 'Atualização registrada',
    }))
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .slice(-TIMELINE_RENDER_LIMIT);
  const telemetryUpdates = events.reduce((acc, evt) => {
    if (evt.telemetry && Object.keys(evt.telemetry).length) {
      Object.assign(acc, evt.telemetry);
    }
    return acc;
  }, {});
  if (!timeline.length && !Object.keys(telemetryUpdates).length) return;
  const current = state.telemetryBySession.get(sessionId) || {};
  const merged = { ...current };
  if (Object.keys(telemetryUpdates).length) {
    Object.assign(merged, telemetryUpdates, { updatedAt: Date.now() });
  }
  if (timeline.length) {
    merged.timeline = timeline;
  }
  state.telemetryBySession.set(sessionId, merged);
  const index = state.sessions.findIndex((s) => s.sessionId === sessionId);
  if (index >= 0) {
    const session = state.sessions[index];
    const extra = { ...(session.extra || {}) };
    if (timeline.length) extra.timeline = timeline;
    if (Object.keys(telemetryUpdates).length) {
      extra.telemetry = { ...(extra.telemetry || {}), ...telemetryUpdates };
    }
    state.sessions[index] = { ...session, extra, telemetry: { ...(session.telemetry || {}), ...merged } };
  }
  if (state.selectedSessionId === sessionId) {
    renderSessions();
  }
};

const subscribeToSessionRealtime = async (sessionId) => {
  if (!sessionId) return;
  try {
    const user = await ensureAuth();
    if (!user) {
      console.warn('Auth indisponível. Listener da sessão não será iniciado.', sessionId);
      return;
    }
  } catch (error) {
    console.error('Falha ao autenticar antes de escutar sessão', sessionId, error);
    return;
  }
  const db = ensureFirestore();
  if (!db) return;
  if (sessionRealtimeSubscriptions.has(sessionId)) return;
  const sessionRef = doc(db, 'sessions', sessionId);
  const messagesRef = collection(sessionRef, 'messages');
  const eventsRef = collection(sessionRef, 'events');
  let unsubMessages = null;
  let unsubEvents = null;
  try {
    const messagesQuery = query(messagesRef, orderBy('ts', 'asc'), limit(CHAT_RENDER_LIMIT * 2));
    unsubMessages = onSnapshot(
      messagesQuery,
      (snapshot) => {
        const messages = snapshot.docs.map((docSnap) => normalizeMessageDoc(docSnap)).filter(Boolean);
        state.chatBySession.set(sessionId, messages);
        const lastMessage = messages.length ? messages[messages.length - 1] : null;
        const index = state.sessions.findIndex((s) => s.sessionId === sessionId);
        if (index >= 0) {
          const session = state.sessions[index];
          const extra = { ...(session.extra || {}), chatLog: messages };
          if (lastMessage) extra.lastMessageAt = lastMessage.ts;
          state.sessions[index] = { ...session, chatLog: messages, extra };
        }
        if (state.renderedChatSessionId === sessionId) {
          state.renderedChatSessionId = null;
          renderChatForSession();
        } else if (state.selectedSessionId === sessionId) {
          renderChatForSession();
        }
      },
      (error) => {
        console.error('Falha ao escutar mensagens da sessão', sessionId, error);
      }
    );
  } catch (error) {
    console.error('Falha ao iniciar listener de mensagens da sessão', sessionId, error);
  }
  try {
    const eventsQuery = query(eventsRef, orderBy('ts', 'asc'), limit(TIMELINE_RENDER_LIMIT * 2));
    unsubEvents = onSnapshot(
      eventsQuery,
      (snapshot) => handleEventsSnapshot(sessionId, snapshot),
      (error) => {
        console.error('Falha ao escutar eventos da sessão', sessionId, error);
      }
    );
  } catch (error) {
    console.error('Falha ao iniciar listener de eventos da sessão', sessionId, error);
  }
  sessionRealtimeSubscriptions.set(sessionId, { messages: unsubMessages, events: unsubEvents });
};

const updateSessionRealtimeSubscriptions = (sessions) => {
  const activeIds = new Set((sessions || []).map((s) => s?.sessionId).filter(Boolean));
  sessionRealtimeSubscriptions.forEach((_value, sessionId) => {
    if (!activeIds.has(sessionId)) {
      unsubscribeSessionRealtime(sessionId);
    }
  });
  activeIds.forEach((sessionId) => {
    if (!sessionRealtimeSubscriptions.has(sessionId)) {
      subscribeToSessionRealtime(sessionId);
    }
  });
};

const updateMetricsFromSessions = (sessions) => {
  if (!Array.isArray(sessions)) return;
  const relevantSessions = filterSessionsForCurrentTech(sessions);
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todaysSessions = relevantSessions.filter((session) => {
    const basis = session.acceptedAt || session.requestedAt || session.closedAt || 0;
    return basis >= startOfDay;
  });
  const closedToday = todaysSessions.filter((session) => session.status === 'closed');
  const waitTimes = todaysSessions
    .map((session) => session.waitTimeMs)
    .filter((ms) => typeof ms === 'number' && ms >= 0);
  const averageWaitMs = waitTimes.length ? waitTimes.reduce((a, b) => a + b, 0) / waitTimes.length : null;
  const handleTimes = closedToday
    .map((session) => session.handleTimeMs)
    .filter((ms) => typeof ms === 'number' && ms >= 0);
  const averageHandleMs = handleTimes.length ? handleTimes.reduce((a, b) => a + b, 0) / handleTimes.length : null;
  const fcrValues = closedToday
    .filter((session) => typeof session.firstContactResolution === 'boolean')
    .map((session) => (session.firstContactResolution ? 1 : 0));
  const fcrPercentage = fcrValues.length
    ? Math.round((fcrValues.reduce((a, b) => a + b, 0) / fcrValues.length) * 100)
    : null;
  const npsScores = closedToday
    .map((session) => (typeof session.npsScore === 'number' ? session.npsScore : null))
    .filter((score) => score !== null && !Number.isNaN(score));
  let nps = null;
  if (npsScores.length) {
    const promoters = npsScores.filter((score) => score >= 9).length;
    const detractors = npsScores.filter((score) => score <= 6).length;
    nps = Math.round(((promoters - detractors) / npsScores.length) * 100);
  }
  const metrics = {
    attendancesToday: todaysSessions.length,
    activeSessions: sessions.filter((session) => session.status === 'active').length,
    averageWaitMs,
    averageHandleMs,
    fcrPercentage,
    nps,
    queueSize: Array.isArray(state.queue) ? state.queue.length : null,
    lastUpdated: Date.now(),
  };
  state.metrics = metrics;
  renderMetrics();
};

const ensureChatStore = (sessionId) => {
  if (!sessionId) return [];
  if (!state.chatBySession.has(sessionId)) {
    state.chatBySession.set(sessionId, []);
  }
  return state.chatBySession.get(sessionId);
};

const syncSessionStores = (session) => {
  if (!session || !session.sessionId) return;
  const { sessionId } = session;
  const chatLog = Array.isArray(session.chatLog)
    ? session.chatLog
    : Array.isArray(session.extra?.chatLog)
      ? session.extra.chatLog
      : [];
  if (chatLog.length) {
    const normalized = chatLog
      .map((entry) => ({
        id: entry.id || `${sessionId}-${entry.ts || Date.now()}`,
        from: entry.from || 'client',
        text: entry.text || '',
        ts: entry.ts || Date.now(),
      }))
      .sort((a, b) => a.ts - b.ts);
    state.chatBySession.set(sessionId, normalized);
  } else {
    state.chatBySession.set(sessionId, []);
  }

  const telemetrySource =
    (typeof session.telemetry === 'object' && session.telemetry !== null && session.telemetry) ||
    (typeof session.extra?.telemetry === 'object' && session.extra.telemetry !== null ? session.extra.telemetry : null);
  if (telemetrySource) {
    state.telemetryBySession.set(sessionId, { ...telemetrySource });
  } else {
    state.telemetryBySession.delete(sessionId);
  }
};

const pushChatToStore = (sessionId, message) => {
  if (!sessionId || !message) return;
  const bucket = ensureChatStore(sessionId);
  if (bucket.some((entry) => entry.id === message.id)) return;
  bucket.push(message);
  if (bucket.length > CHAT_RENDER_LIMIT) bucket.splice(0, bucket.length - CHAT_RENDER_LIMIT);
  state.chatBySession.set(sessionId, bucket.sort((a, b) => a.ts - b.ts));
};

const ingestChatMessage = (message, { isSelf = false } = {}) => {
  if (!message || !message.sessionId) return;
  const normalized = {
    id: message.id || `${message.sessionId}-${message.ts || Date.now()}`,
    from: message.from || (isSelf ? 'tech' : 'client'),
    text: message.text || '',
    ts: message.ts || Date.now(),
  };
  pushChatToStore(message.sessionId, normalized);
  const sessionIndex = state.sessions.findIndex((s) => s.sessionId === message.sessionId);
  if (sessionIndex >= 0) {
    const updatedLog = ensureChatStore(message.sessionId);
    const existing = state.sessions[sessionIndex];
    state.sessions[sessionIndex] = {
      ...existing,
      chatLog: updatedLog,
      extra: { ...(existing.extra || {}), chatLog: updatedLog, lastMessageAt: normalized.ts },
    };
  }
  if (state.renderedChatSessionId === message.sessionId) {
    const session = state.sessions.find((s) => s.sessionId === message.sessionId);
    const isTech = normalized.from === 'tech';
    addChatMessage({
      author: isTech ? (getTechDataset().techName || 'Você') : session?.clientName || normalized.from,
      text: normalized.text,
      kind: isTech ? 'self' : 'client',
      ts: normalized.ts,
    });
  }
};

const getTelemetryForSession = (sessionId) => {
  if (!sessionId) return null;
  return state.telemetryBySession.get(sessionId) || null;
};

const resetCommandState = () => {
  state.commandState = {
    shareActive: false,
    remoteActive: false,
    callActive: false,
  };
  if (dom.controlStart) dom.controlStart.textContent = 'Solicitar visualização';
  if (dom.controlRemote) dom.controlRemote.textContent = 'Solicitar acesso remoto';
  if (dom.controlQuality) dom.controlQuality.textContent = 'Iniciar chamada';
  if (dom.controlStats) dom.controlStats.textContent = 'Encerrar suporte';
};

const stopStreamTracks = (stream) => {
  if (!stream) return;
  try {
    stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (err) {
        console.warn('Falha ao encerrar track local', err);
      }
    });
  } catch (err) {
    console.warn('Falha ao encerrar stream local', err);
  }
};

const clearRemoteVideo = () => {
  if (state.media.remoteStream) {
    stopStreamTracks(state.media.remoteStream);
  }
  state.media.remoteStream = null;
  if (dom.sessionVideo) {
    dom.sessionVideo.srcObject = null;
    dom.sessionVideo.setAttribute('hidden', 'hidden');
  }
  if (dom.sessionPlaceholder) {
    dom.sessionPlaceholder.removeAttribute('hidden');
  }
  updateMediaDisplay();
};

const clearRemoteAudio = () => {
  if (state.media.remoteAudioStream && state.media.remoteAudioStream !== state.media.remoteStream) {
    stopStreamTracks(state.media.remoteAudioStream);
  }
  state.media.remoteAudioStream = null;
  if (dom.sessionAudio) {
    if (state.legacyShare.remoteAudioStream) {
      dom.sessionAudio.srcObject = state.legacyShare.remoteAudioStream;
    } else {
      dom.sessionAudio.srcObject = null;
      dom.sessionAudio.pause();
      dom.sessionAudio.setAttribute('hidden', 'hidden');
    }
  }
  updateMediaDisplay();
};

const clearLegacyVideo = () => {
  if (state.legacyShare.remoteStream) {
    stopStreamTracks(state.legacyShare.remoteStream);
  }
  state.legacyShare.remoteStream = null;
  updateMediaDisplay();
};

const clearLegacyAudio = () => {
  if (
    state.legacyShare.remoteAudioStream &&
    state.legacyShare.remoteAudioStream !== state.legacyShare.remoteStream
  ) {
    stopStreamTracks(state.legacyShare.remoteAudioStream);
  }
  state.legacyShare.remoteAudioStream = null;
  if (dom.sessionAudio && !state.media.remoteAudioStream) {
    dom.sessionAudio.pause();
    dom.sessionAudio.setAttribute('hidden', 'hidden');
    dom.sessionAudio.srcObject = null;
  } else if (dom.sessionAudio && state.media.remoteAudioStream) {
    dom.sessionAudio.srcObject = state.media.remoteAudioStream;
  }
  updateMediaDisplay();
};

const updateMediaDisplay = () => {
  scheduleRender(() => {
    const activeVideoStream =
      state.media.local.screen || state.media.remoteStream || state.legacyShare.remoteStream;
    const hasVideo = Boolean(activeVideoStream);
    if (dom.sessionVideo) {
      if (hasVideo) {
        dom.sessionVideo.removeAttribute('hidden');
        if (dom.sessionVideo.srcObject !== activeVideoStream) {
          dom.sessionVideo.srcObject = activeVideoStream;
        }
      } else {
        dom.sessionVideo.setAttribute('hidden', 'hidden');
        dom.sessionVideo.srcObject = null;
      }
    }
    if (dom.sessionPlaceholder) {
      if (hasVideo) {
        dom.sessionPlaceholder.setAttribute('hidden', 'hidden');
      } else {
        dom.sessionPlaceholder.removeAttribute('hidden');
      }
    }
  });
};

const teardownPeerConnection = () => {
  if (state.media.pc) {
    try {
      state.media.pc.ontrack = null;
      state.media.pc.onicecandidate = null;
      state.media.pc.onconnectionstatechange = null;
      state.media.pc.close();
    } catch (err) {
      console.warn('Falha ao encerrar PeerConnection', err);
    }
  }
  state.media.pc = null;
  state.media.sessionId = null;
  state.media.senders = { screen: [], audio: [] };
  stopStreamTracks(state.media.local.screen);
  stopStreamTracks(state.media.local.audio);
  state.media.local = { screen: null, audio: null };
  clearRemoteVideo();
  clearRemoteAudio();
};

const ensurePeerConnection = (sessionId) => {
  if (!sessionId) return null;
  if (state.media.pc && state.media.sessionId && state.media.sessionId !== sessionId) {
    teardownPeerConnection();
  }
  if (state.media.pc) return state.media.pc;

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.onicecandidate = (event) => {
    if (event.candidate && socket && !socket.disconnected) {
      socket.emit('signal:candidate', { sessionId, candidate: event.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      clearRemoteVideo();
      clearRemoteAudio();
    }
  };

  pc.ontrack = (event) => {
    if (!event || !event.track) return;
    if (event.track.kind === 'video') {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      state.media.remoteStream = stream;
      if (dom.sessionVideo) {
        dom.sessionVideo.srcObject = stream;
        dom.sessionVideo.removeAttribute('hidden');
        const playPromise = dom.sessionVideo.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
      }
      if (dom.sessionPlaceholder) dom.sessionPlaceholder.setAttribute('hidden', 'hidden');
      event.track.addEventListener('ended', () => {
        if (state.media.remoteStream === stream) {
          clearRemoteVideo();
        }
      });
    }
    if (event.track.kind === 'audio') {
      const audioStream = state.media.remoteAudioStream || new MediaStream();
      audioStream.addTrack(event.track);
      state.media.remoteAudioStream = audioStream;
      if (dom.sessionAudio) {
        dom.sessionAudio.srcObject = audioStream;
        dom.sessionAudio.removeAttribute('hidden');
        const playPromise = dom.sessionAudio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
      }
      event.track.addEventListener('ended', () => {
        if (state.media.remoteAudioStream) {
          const tracks = state.media.remoteAudioStream.getTracks().filter((t) => t !== event.track);
          const stream = new MediaStream(tracks);
          state.media.remoteAudioStream = stream.getTracks().length ? stream : null;
          if (!state.media.remoteAudioStream && dom.sessionAudio) {
            clearRemoteAudio();
          } else if (state.media.remoteAudioStream && dom.sessionAudio) {
            dom.sessionAudio.srcObject = state.media.remoteAudioStream;
          }
        }
      });
    }
    updateMediaDisplay();
  };

  state.media.pc = pc;
  state.media.sessionId = sessionId;
  return pc;
};

const setLegacyStatus = (message) => {
  if (!dom.webShareStatus) return;
  dom.webShareStatus.textContent = message;
};

const updateLegacyControls = () => {
  if (dom.webShareConnect) {
    dom.webShareConnect.disabled = state.legacyShare.active;
  }
  if (dom.webShareDisconnect) {
    dom.webShareDisconnect.disabled = !state.legacyShare.active;
  }
  if (dom.webShareRoom) {
    dom.webShareRoom.disabled = state.legacyShare.active;
  }
};

const teardownLegacyShare = ({ keepRoom = false } = {}) => {
  if (state.legacyShare.pc) {
    try {
      state.legacyShare.pc.ontrack = null;
      state.legacyShare.pc.onicecandidate = null;
      state.legacyShare.pc.onconnectionstatechange = null;
      state.legacyShare.pc.close();
    } catch (err) {
      console.warn('Falha ao encerrar PeerConnection legado', err);
    }
  }
  state.legacyShare.pc = null;
  if (!keepRoom) state.legacyShare.room = null;
  state.legacyShare.active = false;
  state.legacyShare.pendingRoom = null;
  clearLegacyVideo();
  clearLegacyAudio();
  updateLegacyControls();
};

const ensureLegacyPeerConnection = (room) => {
  if (!room) return null;
  if (state.legacyShare.pc && state.legacyShare.room && state.legacyShare.room !== room) {
    teardownLegacyShare({ keepRoom: true });
  }
  if (state.legacyShare.pc && state.legacyShare.room === room) return state.legacyShare.pc;

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  });

  pc.onicecandidate = (event) => {
    if (!event.candidate || !socket || socket.disconnected) return;
    socket.emit('signal', { room, data: event.candidate });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setLegacyStatus('Compartilhamento web conectado.');
      return;
    }
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      setLegacyStatus('Compartilhamento web desconectado.');
      clearLegacyVideo();
      clearLegacyAudio();
    }
  };

  pc.ontrack = (event) => {
    if (!event || !event.track) return;
    if (event.track.kind === 'video') {
      const stream = event.streams?.[0] || new MediaStream([event.track]);
      state.legacyShare.remoteStream = stream;
      event.track.addEventListener('ended', () => {
        if (state.legacyShare.remoteStream === stream) {
          clearLegacyVideo();
        }
      });
    }
    if (event.track.kind === 'audio') {
      const audioStream = state.legacyShare.remoteAudioStream || new MediaStream();
      audioStream.addTrack(event.track);
      state.legacyShare.remoteAudioStream = audioStream;
      if (dom.sessionAudio) {
        dom.sessionAudio.srcObject = audioStream;
        dom.sessionAudio.removeAttribute('hidden');
        const playPromise = dom.sessionAudio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
          playPromise.catch(() => {});
        }
      }
      event.track.addEventListener('ended', () => {
        if (state.legacyShare.remoteAudioStream) {
          const tracks = state.legacyShare.remoteAudioStream.getTracks().filter((t) => t !== event.track);
          const stream = new MediaStream(tracks);
          state.legacyShare.remoteAudioStream = stream.getTracks().length ? stream : null;
          if (!state.legacyShare.remoteAudioStream && dom.sessionAudio) {
            dom.sessionAudio.pause();
            dom.sessionAudio.setAttribute('hidden', 'hidden');
          } else if (state.legacyShare.remoteAudioStream && dom.sessionAudio) {
            dom.sessionAudio.srcObject = state.legacyShare.remoteAudioStream;
          }
        }
      });
    }
    updateMediaDisplay();
  };

  state.legacyShare.pc = pc;
  state.legacyShare.room = room;
  return pc;
};

const activateLegacyShare = (room) => {
  const normalized = typeof room === 'string' ? room.trim() : '';
  if (!normalized) {
    setLegacyStatus('Informe o código de 6 dígitos para conectar.');
    return;
  }

  if (state.legacyShare.room && state.legacyShare.room !== normalized) {
    teardownLegacyShare();
  }

  state.legacyShare.active = true;
  state.legacyShare.room = normalized;
  state.legacyShare.pendingRoom = null;
  updateLegacyControls();

  if (socket && !socket.disconnected) {
    socket.emit('join', { room: normalized, role: 'viewer' });
  } else {
    state.legacyShare.pendingRoom = normalized;
  }

  ensureLegacyPeerConnection(normalized);
  setLegacyStatus('Aguardando o cliente iniciar o compartilhamento…');
};

const disconnectLegacyShare = () => {
  teardownLegacyShare();
  setLegacyStatus('Nenhum compartilhamento web ativo.');
};

const handleLegacySignal = async (payload) => {
  if (!state.legacyShare.active || !payload) return;
  const room = state.legacyShare.room;
  if (!room) return;

  const pc = ensureLegacyPeerConnection(room);
  if (!pc) return;

  if (payload.type === 'offer' || (payload.sdp && payload.type)) {
    try {
      await pc.setRemoteDescription(payload);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      if (socket && !socket.disconnected) {
        socket.emit('signal', { room, data: pc.localDescription });
      }
    } catch (error) {
      console.error('Erro ao processar oferta web', error);
      setLegacyStatus('Falha ao aceitar a oferta do cliente.');
    }
    return;
  }

  if (payload.type === 'answer') {
    try {
      await pc.setRemoteDescription(payload);
    } catch (error) {
      console.error('Erro ao aplicar answer web', error);
    }
    return;
  }

  if (payload.candidate) {
    try {
      await pc.addIceCandidate(payload);
    } catch (error) {
      console.error('Erro ao adicionar ICE web', error);
    }
  }
};

const removeSendersForType = (type) => {
  if (!state.media.pc) return;
  const senders = state.media.senders[type] || [];
  senders.forEach((sender) => {
    try {
      state.media.pc.removeTrack(sender);
    } catch (err) {
      console.warn('Falha ao remover sender', err);
    }
  });
  state.media.senders[type] = [];
};

const startLocalScreenShare = async () => {
  const session = getSelectedSession();
  if (!session) return;
  if (state.media.local.screen) {
    updateMediaDisplay();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const pc = ensurePeerConnection(session.sessionId);
    if (!pc) return;
    removeSendersForType('screen');
    const senders = stream.getTracks().map((track) => {
      const sender = pc.addTrack(track, stream);
      track.addEventListener('ended', () => {
        stopLocalScreenShare(true);
      });
      return sender;
    });
    state.media.senders.screen = senders;
    stopStreamTracks(state.media.local.screen);
    state.media.local.screen = stream;
    if (dom.sessionVideo) {
      dom.sessionVideo.srcObject = stream;
      dom.sessionVideo.muted = true;
      dom.sessionVideo.removeAttribute('hidden');
      const playPromise = dom.sessionVideo.play();
      if (playPromise && typeof playPromise.catch === 'function') playPromise.catch(() => {});
    }
    if (dom.sessionPlaceholder) dom.sessionPlaceholder.setAttribute('hidden', 'hidden');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal:offer', { sessionId: session.sessionId, sdp: pc.localDescription });
    state.commandState.shareActive = true;
    if (dom.controlStart) dom.controlStart.textContent = 'Encerrar visualização';
    updateMediaDisplay();
  } catch (error) {
    console.error('Falha ao iniciar compartilhamento local', error);
    addChatMessage({ author: 'Sistema', text: 'Não foi possível iniciar o compartilhamento de tela.', kind: 'system' });
  }
};

const stopLocalScreenShare = async (notifyRemote = false) => {
  removeSendersForType('screen');
  stopStreamTracks(state.media.local.screen);
  state.media.local.screen = null;
  if (!state.media.remoteStream) {
    if (dom.sessionVideo) {
      dom.sessionVideo.srcObject = null;
      dom.sessionVideo.setAttribute('hidden', 'hidden');
    }
    if (dom.sessionPlaceholder) dom.sessionPlaceholder.removeAttribute('hidden');
  }
  updateMediaDisplay();
  if (notifyRemote && socket && !socket.disconnected) {
    try {
      const sessionId = state.media.sessionId || (getSelectedSession()?.sessionId ?? null);
      const { session } = await sendSessionCommand('share_stop', {}, { silent: true, sessionId });
      registerCommand({ sessionId: session.sessionId, type: 'share_stop', by: 'tech', ts: Date.now() }, { local: true });
    } catch (err) {
      console.warn('Falha ao notificar parada de compartilhamento', err);
    }
  }
  state.commandState.shareActive = false;
  if (dom.controlStart) dom.controlStart.textContent = 'Solicitar visualização';
};

const startLocalCall = async () => {
  const session = getSelectedSession();
  if (!session) return;
  if (state.media.local.audio) {
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const pc = ensurePeerConnection(session.sessionId);
    if (!pc) return;
    removeSendersForType('audio');
    const senders = stream.getTracks().map((track) => {
      const sender = pc.addTrack(track, stream);
      track.addEventListener('ended', () => {
        stopLocalCall(true);
      });
      return sender;
    });
    state.media.senders.audio = senders;
    stopStreamTracks(state.media.local.audio);
    state.media.local.audio = stream;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal:offer', { sessionId: session.sessionId, sdp: pc.localDescription });
    state.commandState.callActive = true;
    if (dom.controlQuality) dom.controlQuality.textContent = 'Encerrar chamada';
    updateMediaDisplay();
  } catch (error) {
    console.error('Falha ao iniciar chamada local', error);
    addChatMessage({ author: 'Sistema', text: 'Não foi possível iniciar a chamada.', kind: 'system' });
  }
};

const stopLocalCall = async (notifyRemote = false) => {
  removeSendersForType('audio');
  stopStreamTracks(state.media.local.audio);
  state.media.local.audio = null;
  if (!state.media.remoteAudioStream && dom.sessionAudio) {
    clearRemoteAudio();
  }
  updateMediaDisplay();
  if (notifyRemote && socket && !socket.disconnected) {
    try {
      const sessionId = state.media.sessionId || (getSelectedSession()?.sessionId ?? null);
      const { session } = await sendSessionCommand('call_end', {}, { silent: true, sessionId });
      registerCommand({ sessionId: session.sessionId, type: 'call_end', by: 'tech', ts: Date.now() }, { local: true });
    } catch (err) {
      console.warn('Falha ao notificar fim da chamada', err);
    }
  }
  state.commandState.callActive = false;
  if (dom.controlQuality) dom.controlQuality.textContent = 'Iniciar chamada';
};

const createChatEntryElement = ({ author, text, kind = 'client', ts = Date.now() }) => {
  const entry = document.createElement('div');
  entry.className = 'message';
  if (kind === 'self') entry.classList.add('self');
  if (kind === 'system') entry.classList.add('system');
  entry.textContent = `${formatTime(ts)} • ${author}: ${text}`;
  return entry;
};

const isNearBottom = (element) => {
  if (!element) return true;
  const { scrollTop, scrollHeight, clientHeight } = element;
  return scrollHeight - (scrollTop + clientHeight) <= 12;
};

const renderChatForSession = () => {
  scheduleRender(() => {
    if (!dom.chatThread) return;
    const container = dom.chatThread;
    const session = getSelectedSession();
    if (!session) {
      if (state.renderedChatSessionId !== null) {
        container.replaceChildren();
        state.renderedChatSessionId = null;
        container.appendChild(
          createChatEntryElement({
            author: 'Sistema',
            text: 'Selecione uma sessão para conversar com o cliente.',
            kind: 'system',
          })
        );
      }
      return;
    }

    if (state.renderedChatSessionId === session.sessionId) return;

    const history = state.chatBySession.get(session.sessionId) || [];
    const messages = history.slice(-CHAT_RENDER_LIMIT);
    const fragment = document.createDocumentFragment();
    const techName = getTechDataset().techName || 'Você';
    if (!messages.length) {
      fragment.appendChild(
        createChatEntryElement({
          author: 'Sistema',
          text: 'Sem mensagens trocadas ainda nesta sessão.',
          kind: 'system',
        })
      );
    } else {
      messages.forEach((msg) => {
        const isTech = msg.from === 'tech';
        fragment.appendChild(
          createChatEntryElement({
            author: isTech ? techName : session.clientName || msg.from,
            text: msg.text,
            kind: isTech ? 'self' : 'client',
            ts: msg.ts,
          })
        );
      });
    }
    container.replaceChildren(fragment);
    state.renderedChatSessionId = session.sessionId;
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  });
};

const joinSelectedSession = () => {
  if (!socket) return;
  const session = getSelectedSession();
  if (!session || session.status !== 'active') return;
  const sessionId = session.sessionId;
  if (!sessionId) return;
  if (state.joinedSessionId && state.joinedSessionId !== sessionId) {
    cleanupSession({ rebindHandlers: true });
  }
  if (state.joinedSessionId === sessionId) return;
  socket.emit('session:join', { sessionId, role: 'tech', userType: 'tech' }, (ack) => {
    if (ack?.ok) {
      markSessionActive(sessionId);
      state.joinedSessionId = sessionId;
      state.media.sessionId = sessionId;
      addChatMessage({
        author: 'Sistema',
        text: `Entrou na sala da sessão ${sessionId}.`,
        kind: 'system',
      });
      renderChatForSession();
    } else {
      addChatMessage({
        author: 'Sistema',
        text: `Falha ao entrar na sessão ${sessionId}: ${ack?.err || 'erro desconhecido'}.`,
        kind: 'system',
      });
    }
  });
};

const sendChatMessage = (text) => {
  const session = getSelectedSession();
  if (!session) {
    addChatMessage({ author: 'Sistema', text: 'Nenhuma sessão selecionada.', kind: 'system' });
    return;
  }
  if (!socket || socket.disconnected) {
    addChatMessage({ author: 'Sistema', text: 'Sem conexão com o servidor.', kind: 'system' });
    return;
  }
  const now = Date.now();
  const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random()}`;
  const payload = { sessionId: session.sessionId, from: 'tech', text, id, ts: now };
  socket.emit('session:chat:send', payload, (ack) => {
    if (ack?.ok) {
      if (dom.chatInput) dom.chatInput.value = '';
      ingestChatMessage({ ...payload, id: ack.id || payload.id }, { isSelf: true });
    } else {
      addChatMessage({
        author: 'Sistema',
        text: ack?.err ? `Não foi possível enviar a mensagem: ${ack.err}` : 'Não foi possível enviar a mensagem.',
        kind: 'system',
      });
    }
  });
};

const sendSessionCommand = (type, extra = {}, { silent = false, sessionId: overrideSessionId = null } = {}) => {
  const session = overrideSessionId
    ? state.sessions.find((s) => s.sessionId === overrideSessionId) || null
    : getSelectedSession();
  if (!session) {
    if (!silent) {
      addChatMessage({ author: 'Sistema', text: 'Nenhuma sessão selecionada para enviar comandos.', kind: 'system' });
    }
    return Promise.reject(new Error('no-session'));
  }
  if (!socket || socket.disconnected) {
    if (!silent) {
      addChatMessage({ author: 'Sistema', text: 'Sem conexão com o servidor.', kind: 'system' });
    }
    return Promise.reject(new Error('no-connection'));
  }
  return new Promise((resolve, reject) => {
    socket.emit('session:command', { sessionId: session.sessionId, type, ...extra }, (ack) => {
      if (ack?.ok) {
        resolve({ session, ack });
      } else {
        if (!silent) {
          addChatMessage({
            author: 'Sistema',
            text: ack?.err ? `Falha ao enviar comando (${ack.err}).` : 'Falha ao enviar comando.',
            kind: 'system',
          });
        }
        reject(new Error(ack?.err || 'command-error'));
      }
    });
  });
};

const emitSessionCommand = (type, extra = {}, onSuccess) => {
  sendSessionCommand(type, extra)
    .then(({ session }) => {
      const command = {
        sessionId: session.sessionId,
        type,
        data: extra?.data || null,
        by: 'tech',
        ts: Date.now(),
      };
      registerCommand(command, { local: true });
      if (typeof onSuccess === 'function') onSuccess();
    })
    .catch(() => {});
};

function handleSessionEnded(sessionId, reason = 'peer_ended') {
  if (!sessionId) return;
  if (state.media.sessionId === sessionId) {
    teardownPeerConnection();
    resetCommandState();
  }
  if (state.joinedSessionId === sessionId) {
    state.joinedSessionId = null;
  }
  const ts = Date.now();
  const index = state.sessions.findIndex((s) => s.sessionId === sessionId);
  if (index >= 0) {
    const session = state.sessions[index];
    const updated = {
      ...session,
      status: 'closed',
      closedAt: session.closedAt || ts,
    };
    state.sessions[index] = updated;
  }
  if (state.selectedSessionId === sessionId) {
    let text = 'Sessão encerrada.';
    if (reason === 'peer_ended') text = 'O cliente encerrou a sessão.';
    if (reason === 'tech_ended') text = 'Você encerrou a sessão.';
    addChatMessage({
      author: 'Sistema',
      text,
      kind: 'system',
    });
  }
  renderSessions();
}

function resetDashboard({ sessionId = null, reason = 'peer_ended' } = {}) {
  const targetSessionId =
    sessionId ||
    state.activeSessionId ||
    state.joinedSessionId ||
    state.selectedSessionId ||
    null;

  cleanupSession({ rebindHandlers: true });
  unsubscribeAllSessionRealtime();

  if (targetSessionId) {
    state.chatBySession.delete(targetSessionId);
    state.telemetryBySession.delete(targetSessionId);
  }

  state.selectedSessionId = null;

  renderSessions();
  renderChatForSession();
  updateMediaDisplay();

  if (dom.closureForm) {
    dom.closureForm.reset();
  }

  scheduleRender(() => {
    if (dom.chatThread) {
      const message =
        reason === 'tech_ended'
          ? 'Atendimento encerrado. Painel pronto para o próximo atendimento.'
          : 'Painel pronto para o próximo atendimento.';
      dom.chatThread.replaceChildren(
        createChatEntryElement({
          author: 'Sistema',
          text: message,
          kind: 'system',
        })
      );
    }
  });

  setSessionState(SessionStates.IDLE, null);

  loadQueue();
  Promise.all([loadSessions(), loadMetrics()]).catch((error) => {
    console.warn('Falha ao atualizar dados após reset', error);
  });
}

function handleCommandEffects(command, { local = false } = {}) {
  if (!command) return;
  const by = command.by || (local ? 'tech' : 'unknown');
  switch (command.type) {
    case 'share_start':
      state.commandState.shareActive = true;
      if (dom.controlStart) dom.controlStart.textContent = 'Encerrar visualização';
      break;
    case 'share_stop':
      state.commandState.shareActive = false;
      if (dom.controlStart) dom.controlStart.textContent = 'Solicitar visualização';
      clearRemoteVideo();
      break;
    case 'remote_enable':
      state.commandState.remoteActive = true;
      if (dom.controlRemote) dom.controlRemote.textContent = 'Revogar acesso remoto';
      break;
    case 'remote_disable':
      state.commandState.remoteActive = false;
      if (dom.controlRemote) dom.controlRemote.textContent = 'Solicitar acesso remoto';
      break;
    case 'call_start':
      state.commandState.callActive = true;
      if (dom.controlQuality) dom.controlQuality.textContent = 'Encerrar chamada';
      if (by !== 'tech') {
        startLocalCall();
      }
      break;
    case 'call_end':
      state.commandState.callActive = false;
      if (dom.controlQuality) dom.controlQuality.textContent = 'Iniciar chamada';
      stopLocalCall(false);
      clearRemoteAudio();
      break;
    case 'session_end':
      handleSessionEnded(command.sessionId, command.reason || 'peer_ended');
      markSessionEnded(command.sessionId, command.reason || 'peer_ended');
      break;
    default:
      break;
  }
}

function registerCommand(command, { local = false } = {}) {
  if (!command || !command.sessionId) return;
  const normalized = {
    ...command,
    ts: command.ts || Date.now(),
    id: command.id || `${command.sessionId}-${command.ts || Date.now()}`,
    by: command.by || (local ? 'tech' : 'unknown'),
  };
  if (normalized.type === 'session_end' && local) {
    normalized.reason = normalized.reason || 'tech_ended';
  }
  const index = state.sessions.findIndex((s) => s.sessionId === normalized.sessionId);
  if (index >= 0) {
    const session = state.sessions[index];
    const log = Array.isArray(session.commandLog) ? [...session.commandLog] : [];
    const exists = log.some((entry) => entry.id === normalized.id);
    if (!exists) log.push(normalized);
    const extra = { ...(session.extra || {}), commandLog: log, lastCommand: normalized };
    state.sessions[index] = { ...session, commandLog: log, extra };
  }
  if (state.selectedSessionId === normalized.sessionId) {
    addChatMessage({
      author: 'Sistema',
      text: `Comando ${normalized.type} executado por ${normalized.by || 'desconhecido'}.`,
      kind: 'system',
      ts: normalized.ts,
    });
  }
  handleCommandEffects(normalized, { local });
}

const bindSessionControls = () => {
  if (dom.controlStart) {
    dom.controlStart.addEventListener('click', () => {
      const nextType = state.commandState.shareActive ? 'share_stop' : 'share_start';
      emitSessionCommand(nextType);
    });
  }

  if (dom.controlRemote) {
    dom.controlRemote.addEventListener('click', () => {
      const nextType = state.commandState.remoteActive ? 'remote_disable' : 'remote_enable';
      emitSessionCommand(nextType);
    });
  }

  if (dom.controlQuality) {
    dom.controlQuality.addEventListener('click', () => {
      const nextType = state.commandState.callActive ? 'call_end' : 'call_start';
      emitSessionCommand(nextType);
    });
  }

  if (dom.controlStats) {
    dom.controlStats.addEventListener('click', () => {
      emitSessionCommand('session_end');
    });
  }
};

const bindControlMenu = () => {
  if (!dom.controlMenuToggle || !dom.videoShell) return;
  dom.controlMenuToggle.addEventListener('click', toggleControlMenu);
  dom.controlMenuBackdrop?.addEventListener('click', () => setControlMenuOpen(false));
  dom.controlMenuPanel?.addEventListener('click', (event) => {
    if (event.target instanceof HTMLButtonElement) {
      setControlMenuOpen(false);
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setControlMenuOpen(false);
    }
  });
};

const bindViewControls = () => {
  if (dom.controlFullscreen) {
    if (!document.fullscreenEnabled) {
      dom.controlFullscreen.hidden = true;
    } else {
      updateFullscreenLabel();
      dom.controlFullscreen.addEventListener('click', async () => {
        if (!hasActiveVideo()) {
          showToast('Nenhuma visualização ativa.');
          return;
        }
        try {
          if (document.fullscreenElement) {
            await document.exitFullscreen();
          } else {
            await dom.sessionVideo.requestFullscreen();
          }
        } catch (error) {
          console.error('Falha ao alternar tela cheia', error);
          showToast('Não foi possível abrir a tela cheia.');
        }
      });
      document.addEventListener('fullscreenchange', updateFullscreenLabel);
    }
  }

  if (dom.controlPip) {
    if (!document.pictureInPictureEnabled || typeof dom.sessionVideo?.requestPictureInPicture !== 'function') {
      dom.controlPip.hidden = true;
    } else {
      updatePipLabel();
      dom.controlPip.addEventListener('click', async () => {
        if (!hasActiveVideo()) {
          showToast('Nenhuma visualização ativa.');
          return;
        }
        try {
          if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
          } else {
            await dom.sessionVideo.requestPictureInPicture();
          }
        } catch (error) {
          console.error('Falha ao abrir picture-in-picture', error);
          showToast('Não foi possível abrir a janela flutuante.');
        }
      });
      dom.sessionVideo?.addEventListener('enterpictureinpicture', updatePipLabel);
      dom.sessionVideo?.addEventListener('leavepictureinpicture', updatePipLabel);
    }
  }
};

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
  const previous = state.selectedSessionId;
  if (previous) {
    const exists = state.sessions.some((s) => s.sessionId === previous);
    if (exists) return;
  }
  const active = state.sessions.find((s) => s.status === 'active');
  const fallback = state.sessions[0];
  const chosen = active || fallback || null;
  state.selectedSessionId = chosen ? chosen.sessionId : null;
  if (previous !== state.selectedSessionId) {
    if (state.joinedSessionId === previous) {
      state.joinedSessionId = null;
    }
    state.renderedChatSessionId = null;
    resetCommandState();
    if (state.media.sessionId && state.media.sessionId !== state.selectedSessionId) {
      teardownPeerConnection();
    }
  }
};

const renderQueue = () => {
  scheduleRender(() => {
    if (!dom.queue) return;
    const items = Array.isArray(state.queue) ? state.queue : [];
    if (!items.length) {
      dom.queue.replaceChildren();
      dom.queueEmpty?.removeAttribute('hidden');
      return;
    }

    dom.queueEmpty?.setAttribute('hidden', 'hidden');
    const fragment = document.createDocumentFragment();
    const now = Date.now();

    items.forEach((req) => {
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

      fragment.appendChild(article);
    });

    dom.queue.replaceChildren(fragment);
  });
};

const updateTechIdentity = () => {
  const tech = getTechProfile();
  const name = tech.name || 'Técnico';
  if (dom.techName) dom.techName.textContent = name;
  if (dom.topbarTechName) dom.topbarTechName.textContent = name;
  if (dom.techInitials) dom.techInitials.textContent = computeInitials(name);
};

const renderSessions = () => {
  selectDefaultSession();

  scheduleRender(() => {
    const activeSessions = state.sessions.filter((s) => s.status === 'active');
    const activeCount = activeSessions.length;
    const label = activeCount === 1 ? '1 em andamento' : `${activeCount} em andamento`;
    const availabilityLabel = activeCount ? 'Em atendimento' : 'Disponível';
    const techStatusLabel = activeCount ? 'Em atendimento agora' : 'Aguardando chamados';

    if (dom.activeSessionsLabel) dom.activeSessionsLabel.textContent = label;
    if (dom.techStatus) dom.techStatus.textContent = techStatusLabel;
    if (dom.availability) dom.availability.textContent = availabilityLabel;

    const session = getSelectedSession();
    const telemetry = session
      ? getTelemetryForSession(session.sessionId) || session.telemetry || session.extra?.telemetry || {}
      : null;

    if (!session) {
      if (dom.contextDevice) dom.contextDevice.textContent = '—';
      if (dom.contextIdentity) dom.contextIdentity.textContent = 'Nenhum atendimento selecionado';
      if (dom.contextNetwork) dom.contextNetwork.textContent = '—';
      if (dom.contextHealth) dom.contextHealth.textContent = '—';
      if (dom.contextPermissions) dom.contextPermissions.textContent = '—';
      if (dom.sessionPlaceholder) dom.sessionPlaceholder.textContent = 'Aguardando seleção de sessão';
      if (dom.indicatorNetwork) dom.indicatorNetwork.textContent = '—';
      if (dom.indicatorQuality) dom.indicatorQuality.textContent = '—';
      if (dom.indicatorAlerts) dom.indicatorAlerts.textContent = '—';
      if (dom.contextTimeline) {
        dom.contextTimeline.replaceChildren(
          (() => {
            const entry = document.createElement('div');
            entry.className = 'timeline-entry';
            entry.textContent = 'Sem eventos registrados ainda.';
            return entry;
          })()
        );
      }
      if (dom.closureForm) {
        dom.closureSubmit.disabled = true;
        dom.closureSubmit.textContent = 'Encerrar suporte e disparar pesquisa';
        dom.closureOutcome.disabled = true;
        dom.closureSymptom.disabled = true;
        dom.closureSolution.disabled = true;
        dom.closureNps.disabled = true;
        dom.closureFcr.disabled = true;
      }
      return;
    }

    const deviceParts = [session.brand, session.model, session.osVersion ? `Android ${session.osVersion}` : null].filter(Boolean);
    if (dom.contextDevice) dom.contextDevice.textContent = deviceParts.length ? deviceParts.join(' • ') : 'Dispositivo não informado';
    if (dom.contextIdentity) dom.contextIdentity.textContent = session.clientName ? `${session.clientName}` : 'Cliente';

    if (telemetry && typeof telemetry.shareActive === 'boolean' && dom.controlStart) {
      state.commandState.shareActive = telemetry.shareActive;
      dom.controlStart.textContent = telemetry.shareActive ? 'Encerrar visualização' : 'Solicitar visualização';
    }
    if (telemetry && typeof telemetry.remoteActive === 'boolean' && dom.controlRemote) {
      state.commandState.remoteActive = telemetry.remoteActive;
      dom.controlRemote.textContent = telemetry.remoteActive ? 'Revogar acesso remoto' : 'Solicitar acesso remoto';
    }
    if (telemetry && typeof telemetry.callActive === 'boolean' && dom.controlQuality) {
      state.commandState.callActive = telemetry.callActive;
      dom.controlQuality.textContent = telemetry.callActive ? 'Encerrar chamada' : 'Iniciar chamada';
    }

    const networkLabel = telemetry?.network || session.extra?.network || (session.status === 'active' ? 'Aguardando dados do app' : 'Sessão encerrada');
    const healthLabel = telemetry?.health || session.extra?.health || 'Aguardando dados do app';
    const permissionsLabel = telemetry?.permissions || session.extra?.permissions || 'Sem registros';
    const alertsLabel = telemetry?.alerts || session.extra?.alerts || (session.status === 'active' ? 'Sem alertas' : 'Encerrada');
    if (dom.contextNetwork) dom.contextNetwork.textContent = networkLabel;
    if (dom.contextHealth) dom.contextHealth.textContent = healthLabel;
    if (dom.contextPermissions) dom.contextPermissions.textContent = permissionsLabel;
    if (dom.indicatorNetwork) dom.indicatorNetwork.textContent = networkLabel;
    if (dom.indicatorQuality) dom.indicatorQuality.textContent = session.status === 'active' ? 'Online' : 'Finalizada';
    if (dom.indicatorAlerts) dom.indicatorAlerts.textContent = alertsLabel;

    if (dom.sessionPlaceholder) {
      dom.sessionPlaceholder.textContent =
        session.status === 'active'
          ? `Sessão ${session.sessionId} • aguardando conexão`
          : `Sessão ${session.sessionId} encerrada ${formatRelative(Date.now() - (session.closedAt || session.acceptedAt))}`;
    }

    if (dom.contextTimeline) {
      const timelineEvents = [
        session.requestedAt ? { at: session.requestedAt, text: 'Cliente entrou na fila' } : null,
        session.acceptedAt ? { at: session.acceptedAt, text: 'Atendimento aceito pelo técnico' } : null,
        session.closedAt ? { at: session.closedAt, text: 'Atendimento encerrado' } : null,
      ]
        .filter(Boolean)
        .sort((a, b) => (a.at || 0) - (b.at || 0))
        .slice(-TIMELINE_RENDER_LIMIT);

      if (!timelineEvents.length) {
        const entry = document.createElement('div');
        entry.className = 'timeline-entry';
        entry.textContent = 'Sem eventos registrados ainda.';
        dom.contextTimeline.replaceChildren(entry);
      } else {
        const fragment = document.createDocumentFragment();
        timelineEvents.forEach((evt) => {
          const entry = document.createElement('div');
          entry.className = 'timeline-entry';
          entry.textContent = `${formatTime(evt.at)} • ${evt.text}`;
          fragment.appendChild(entry);
        });
        dom.contextTimeline.replaceChildren(fragment);
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
  });

  renderChatForSession();
  updateMediaDisplay();
  joinSelectedSession();
};

const renderMetrics = () => {
  if (!state.metrics) return;
  const metrics = state.metrics;
  scheduleRender(() => {
    if (dom.metricAttendances) dom.metricAttendances.textContent = metrics.attendancesToday ?? 0;
    if (dom.metricQueue) dom.metricQueue.textContent = `Fila atual: ${metrics.queueSize ?? 0}`;
    if (dom.metricFcr) dom.metricFcr.textContent = typeof metrics.fcrPercentage === 'number' ? `${metrics.fcrPercentage}%` : '—';
    if (dom.metricFcrDetail)
      dom.metricFcrDetail.textContent = metrics.fcrPercentage != null ? 'Base: atendimentos encerrados hoje' : 'Aguardando dados';
    if (dom.metricNps) dom.metricNps.textContent = typeof metrics.nps === 'number' ? metrics.nps : '—';
    if (dom.metricNpsDetail)
      dom.metricNpsDetail.textContent = metrics.nps != null ? 'Cálculo: promotores - detratores' : 'Coletado ao encerrar';
    if (dom.metricHandle)
      dom.metricHandle.textContent = metrics.averageHandleMs != null ? formatDuration(metrics.averageHandleMs) : '—';
    if (dom.metricWait)
      dom.metricWait.textContent =
        metrics.averageWaitMs != null ? `Espera média ${formatDuration(metrics.averageWaitMs)}` : 'Espera média —';
  });
};

const addChatMessage = ({ author, text, kind = 'client', ts = Date.now() }) => {
  if (!text) return;
  scheduleRender(() => {
    if (!dom.chatThread) return;
    const container = dom.chatThread;
    const shouldStick = isNearBottom(container);
    const entry = createChatEntryElement({ author, text, kind, ts });
    container.appendChild(entry);
    while (container.children.length > CHAT_RENDER_LIMIT) {
      container.removeChild(container.firstChild);
    }
    if (shouldStick) {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    }
  });
};

const acceptRequest = async (requestId) => {
  if (!requestId) return;
  const tech = getTechProfile();
  const techName = tech.name || dom.techIdentity?.dataset?.techName || 'Técnico';
  const payload = { techName };
  if (tech.id) payload.techId = tech.id;
  if (tech.uid) payload.techUid = tech.uid;
  if (tech.email) payload.techEmail = tech.email;
  try {
    const res = await fetch(`/api/requests/${requestId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || 'Falha ao aceitar chamado');
    }
    const { sessionId } = await res.json();
    addChatMessage({ author: 'Sistema', text: `Chamado ${requestId} aceito. Sessão ${sessionId}`, kind: 'system' });
    loadQueue({ manual: true });
    await Promise.all([loadSessions(), loadMetrics()]);
  } catch (error) {
    console.error(error);
    addChatMessage({ author: 'Sistema', text: error.message || 'Não foi possível aceitar o chamado.', kind: 'system' });
  }
};

const loadQueue = async ({ manual = false } = {}) => {
  if (queueLoadPromise) {
    return queueLoadPromise;
  }

  if (manual) {
    resetQueueRetryTimer();
  }

  queueLoadPromise = (async () => {
    try {
      const response = await fetch('/api/requests?status=queued');
      if (!response.ok) {
        if (response.status === 500 || response.status === 503) {
          markQueueUnavailable({ statusText: `status ${response.status}` });
        } else {
          resetQueueRetryState();
          const statusText = `status ${response.status}`;
          console.warn(`[queue] Erro ao carregar fila (${statusText}).`);
          state.queue = [];
          renderQueue();
          updateQueueMetrics(0);
        }
        return [];
      }

      const data = await response.json().catch(() => []);
      state.queue = Array.isArray(data) ? data : [];
      renderQueue();
      updateQueueMetrics(Array.isArray(state.queue) ? state.queue.length : null);
      resetQueueRetryState();
      return state.queue;
    } catch (_error) {
      markQueueUnavailable({ statusText: 'falha de rede' });
      return [];
    }
  })();

  try {
    return await queueLoadPromise;
  } finally {
    queueLoadPromise = null;
  }
};

const loadSessions = async ({ skipMetrics = false } = {}) => {
  if (pendingSessionsPromise) {
    try {
      const sessions = await pendingSessionsPromise;
      if (!skipMetrics) updateMetricsFromSessions(sessions);
      return sessions;
    } catch (error) {
      console.error('Erro ao aguardar carregamento de sessões', error);
      if (!skipMetrics) updateMetricsFromSessions([]);
      return [];
    }
  }

  let authUser = null;
  try {
    authUser = await ensureAuth();
  } catch (error) {
    console.error('Falha ao autenticar antes de carregar sessões', error);
  }
  const db = ensureFirestore();
  const tech = getTechProfile();
  if (!db || !authUser) {
    state.sessions = [];
    renderSessions();
    if (!skipMetrics) updateMetricsFromSessions([]);
    return [];
  }

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const sessionsRef = collection(db, 'sessions');

  pendingSessionsPromise = (async () => {
    let docs = [];
    const constraint = pickSessionQueryConstraint(tech);
    const rangeConstraint = where('acceptedAt', '>=', Timestamp.fromMillis(startOfDay));
    const orderConstraint = orderBy('acceptedAt', 'desc');
    if (constraint) {
      try {
        const constrainedQuery = query(
          sessionsRef,
          where(constraint.field, '==', constraint.value),
          rangeConstraint,
          orderConstraint,
          limit(120)
        );
        const snapshot = await getDocs(constrainedQuery);
        docs = snapshot.docs;
        if (!docs.length) {
          console.warn(
            `[sessions] Nenhum documento encontrado com filtro ${constraint.field}. Aplicando fallback sem filtro.`,
            constraint.value
          );
        }
      } catch (error) {
        console.warn(`[sessions] Falha ao aplicar filtro ${constraint.field}. Usando fallback.`, error);
      }
    } else {
      console.warn('Nenhum identificador único do técnico disponível. Carregando sessões sem filtro.');
    }

    if (!docs.length) {
      try {
        const fallbackQuery = query(sessionsRef, rangeConstraint, orderConstraint, limit(120));
        const snapshot = await getDocs(fallbackQuery);
        docs = snapshot.docs;
      } catch (innerError) {
        console.error('Erro ao carregar sessões do Firestore', innerError);
        throw innerError;
      }
    }

    const normalized = docs.map((docSnap) => normalizeSessionDoc(docSnap)).filter(Boolean);
    const filtered = filterSessionsForCurrentTech(normalized);
    filtered.sort((a, b) => (b.acceptedAt || b.requestedAt || 0) - (a.acceptedAt || a.requestedAt || 0));
    return filtered;
  })();

  let sessions = [];
  try {
    sessions = await pendingSessionsPromise;
  } catch (_error) {
    sessions = [];
  } finally {
    pendingSessionsPromise = null;
  }

  state.sessions = sessions;
  const sessionIdSet = new Set(state.sessions.map((session) => session.sessionId));
  state.chatBySession.forEach((_value, key) => {
    if (!sessionIdSet.has(key)) {
      state.chatBySession.delete(key);
    }
  });
  state.telemetryBySession.forEach((_value, key) => {
    if (!sessionIdSet.has(key)) {
      state.telemetryBySession.delete(key);
    }
  });
  state.sessions.forEach(syncSessionStores);
  updateSessionRealtimeSubscriptions(sessions);
  renderSessions();
  if (!skipMetrics) {
    updateMetricsFromSessions(sessions);
  }
  return sessions;
};

const loadMetrics = async () => {
  try {
    const sessions = state.sessions.length ? state.sessions : await loadSessions({ skipMetrics: true });
    updateMetricsFromSessions(sessions);
  } catch (error) {
    console.error('Erro ao atualizar métricas a partir do Firestore', error);
  }
};

const initChat = () => {
  if (dom.chatThread) {
    dom.chatThread.innerHTML = '';
    addChatMessage({ author: 'Sistema', text: 'Painel conectado. Aguardando chamados.', kind: 'system' });
  }
  if (dom.chatForm) {
    dom.chatForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = dom.chatInput.value.trim();
      if (!text) return;
      sendChatMessage(text);
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

const bindQueueRetryButton = () => {
  if (!dom.queueRetry) return;
  dom.queueRetry.addEventListener('click', () => {
    if (dom.queueRetry.disabled) return;
    dom.queueRetry.disabled = true;
    resetQueueRetryTimer();
    loadQueue({ manual: true }).finally(() => {
      dom.queueRetry.disabled = false;
    });
  });
};

const bindLegacyShareControls = () => {
  if (dom.webShareConnect) {
    dom.webShareConnect.addEventListener('click', () => {
      activateLegacyShare(dom.webShareRoom?.value || '');
    });
  }
  if (dom.webShareDisconnect) {
    dom.webShareDisconnect.addEventListener('click', () => {
      disconnectLegacyShare();
    });
  }
  if (dom.webShareRoom) {
    dom.webShareRoom.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        activateLegacyShare(dom.webShareRoom.value);
      }
    });
  }

  const roomFromUrl = getLegacyRoomFromQuery();
  if (dom.webShareRoom && roomFromUrl) {
    dom.webShareRoom.value = roomFromUrl;
  }
  if (roomFromUrl) {
    if (socket && !socket.disconnected) {
      activateLegacyShare(roomFromUrl);
    } else {
      state.legacyShare.pendingRoom = roomFromUrl;
      setLegacyStatus('Preparando conexão com o compartilhamento web…');
    }
  }
  updateLegacyControls();
};

const bootstrap = async () => {
  updateTechIdentity();
  setSessionState(SessionStates.IDLE, null);
  resetCommandState();
  bindSessionControls();
  bindControlMenu();
  bindViewControls();
  initChat();
  bindClosureForm();
  bindQueueRetryButton();
  bindLegacyShareControls();
  loadQueue();
  try {
    await ensureAuth();
  } catch (error) {
    console.error('Falha ao autenticar no Firebase', error);
  }
  await Promise.all([loadSessions(), loadMetrics()]);
};

function handleSocketConnect() {
  addChatMessage({ author: 'Sistema', text: 'Conectado ao servidor de sinalização.', kind: 'system' });
  state.joinedSessionId = null;
  joinSelectedSession();
  if (state.legacyShare.pendingRoom) {
    activateLegacyShare(state.legacyShare.pendingRoom);
  }
}

function handleSocketDisconnect() {
  addChatMessage({ author: 'Sistema', text: 'Desconectado. Tentando reconectar…', kind: 'system' });
  if (state.legacyShare.active) {
    setLegacyStatus('Conexão perdida. Tentando reconectar…');
  }
}

function handleQueueUpdated() {
  loadQueue({ manual: true });
  loadMetrics();
}

function handleSessionUpdated(session) {
  if (!session || !session.sessionId) return;
  if (!sessionMatchesCurrentTech(session)) {
    const existingIndex = state.sessions.findIndex((s) => s.sessionId === session.sessionId);
    if (existingIndex >= 0) {
      state.sessions.splice(existingIndex, 1);
      state.chatBySession.delete(session.sessionId);
      state.telemetryBySession.delete(session.sessionId);
      updateSessionRealtimeSubscriptions(state.sessions);
      renderSessions();
      loadMetrics();
    }
    return;
  }
  const index = state.sessions.findIndex((s) => s.sessionId === session.sessionId);
  if (index >= 0) {
    state.sessions[index] = {
      ...state.sessions[index],
      ...session,
      extra: { ...(state.sessions[index].extra || {}), ...(session.extra || {}) },
    };
    syncSessionStores(state.sessions[index]);
  } else {
    state.sessions.unshift(session);
    syncSessionStores(session);
  }
  renderSessions();
  updateSessionRealtimeSubscriptions(state.sessions);
  loadMetrics();
}

function handleSessionChat(message) {
  ingestChatMessage(message);
}

function handleSessionCommandEvent(command) {
  registerCommand(command);
}

function handleSessionStatus(status) {
  if (!status || !status.sessionId) return;
  if (!state.sessions.some((s) => s.sessionId === status.sessionId)) return;
  const ts = status.ts || Date.now();
  const current = getTelemetryForSession(status.sessionId) || {};
  const data = typeof status.data === 'object' && status.data !== null ? status.data : {};
  if (!Object.keys(data).length) return;
  const hasChanges = Object.entries(data).some(([key, value]) => current[key] !== value);
  if (!hasChanges) return;
  const merged = { ...current, ...data, updatedAt: ts };
  state.telemetryBySession.set(status.sessionId, merged);
  const index = state.sessions.findIndex((s) => s.sessionId === status.sessionId);
  if (index >= 0) {
    const session = state.sessions[index];
    const extra = { ...(session.extra || {}), telemetry: merged };
    if (typeof data.network !== 'undefined') extra.network = data.network;
    if (typeof data.health !== 'undefined') extra.health = data.health;
    if (typeof data.permissions !== 'undefined') extra.permissions = data.permissions;
    if (typeof data.alerts !== 'undefined') extra.alerts = data.alerts;
    state.sessions[index] = { ...session, telemetry: merged, extra };
  }
  if (state.selectedSessionId === status.sessionId) {
    renderSessions();
  }
}

function handleSessionEndedEvent(payload) {
  if (!payload || !payload.sessionId) return;
  const reason = payload.reason || 'peer_ended';
  handleSessionEnded(payload.sessionId, reason);
  markSessionEnded(payload.sessionId, reason);
}

function handlePeerLeft() {
  if (
    state.legacyShare.active &&
    !state.joinedSessionId &&
    !state.activeSessionId &&
    !state.selectedSessionId
  ) {
    teardownLegacyShare();
    setLegacyStatus('Cliente encerrou o compartilhamento web.');
    return;
  }
  const sessionId = state.joinedSessionId || state.activeSessionId || state.selectedSessionId || null;
  if (!sessionId) return;
  addChatMessage({ author: 'Sistema', text: 'Cliente desconectou do atendimento.', kind: 'system' });
  sendSessionCommand('session_end', { reason: 'peer_left' }, { silent: true, sessionId })
    .then(({ session }) => {
      registerCommand(
        {
          sessionId: session.sessionId,
          type: 'session_end',
          reason: 'peer_left',
          by: 'tech',
          ts: Date.now(),
        },
        { local: true }
      );
    })
    .catch(() => {});
  handleSessionEnded(sessionId, 'peer_left');
  markSessionEnded(sessionId, 'peer_left');
}

async function handleSignalOffer({ sessionId, sdp }) {
  if (!sessionId || !sdp) return;
  if (state.joinedSessionId && state.joinedSessionId !== sessionId) return;
  try {
    const pc = ensurePeerConnection(sessionId);
    if (!pc) return;
    const remote = sdp.type ? sdp : { type: 'offer', sdp };
    await pc.setRemoteDescription(remote);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal:answer', { sessionId, sdp: pc.localDescription });
  } catch (error) {
    console.error('Erro ao processar oferta remota', error);
  }
}

async function handleSignalAnswer({ sessionId, sdp }) {
  if (!sessionId || !sdp) return;
  if (state.media.sessionId && state.media.sessionId !== sessionId) return;
  try {
    const pc = ensurePeerConnection(sessionId);
    if (!pc) return;
    const answer = sdp.type ? sdp : { type: 'answer', sdp };
    await pc.setRemoteDescription(answer);
  } catch (error) {
    console.error('Erro ao aplicar answer remota', error);
  }
}

async function handleSignalCandidate({ sessionId, candidate }) {
  if (!sessionId || !candidate) return;
  if (state.media.sessionId && state.media.sessionId !== sessionId) return;
  try {
    const pc = ensurePeerConnection(sessionId);
    if (!pc) return;
    await pc.addIceCandidate(candidate);
  } catch (error) {
    console.error('Erro ao adicionar ICE candidate', error);
  }
}

function setupSocketHandlers() {
  if (!socket) return;
  registerSocketHandler('connect', handleSocketConnect);
  registerSocketHandler('disconnect', handleSocketDisconnect);
  registerSocketHandler('queue:updated', handleQueueUpdated);
  registerSocketHandler('session:updated', handleSessionUpdated);
  registerSocketHandler('session:chat:new', handleSessionChat);
  registerSocketHandler('session:command', handleSessionCommandEvent);
  registerSocketHandler('session:status', handleSessionStatus);
  registerSocketHandler('session:ended', handleSessionEndedEvent);
  registerSocketHandler('peer-left', handlePeerLeft);
  registerSocketHandler('signal', handleLegacySignal);
  registerSocketHandler('signal:offer', handleSignalOffer);
  registerSocketHandler('signal:answer', handleSignalAnswer);
  registerSocketHandler('signal:candidate', handleSignalCandidate);
}

function cleanupSession({ rebindHandlers = false } = {}) {
  sessionResources.timeouts.forEach((timeoutId) => clearTimeout(timeoutId));
  sessionResources.timeouts.clear();
  sessionResources.intervals.forEach((intervalId) => clearInterval(intervalId));
  sessionResources.intervals.clear();
  sessionResources.observers.forEach((observer) => {
    if (observer && typeof observer.disconnect === 'function') observer.disconnect();
  });
  sessionResources.observers.clear();
  unsubscribeAllSessionRealtime();
  if (socket) {
    sessionResources.socketHandlers.forEach((handler, eventName) => {
      socket.off(eventName, handler);
    });
  }
  sessionResources.socketHandlers.clear();
  cancelScheduledRenders();
  teardownPeerConnection();
  teardownLegacyShare();
  resetCommandState();
  setSessionState(SessionStates.IDLE, null);
  state.joinedSessionId = null;
  state.media.sessionId = null;
  state.renderedChatSessionId = null;
  scheduleRender(() => {
    dom.chatThread?.replaceChildren();
  });
  if (rebindHandlers) {
    setupSocketHandlers();
  }
}

if (socket) {
  setupSocketHandlers();
  window.addEventListener('beforeunload', () => {
    cleanupSession();
  });
}

bootstrap();
