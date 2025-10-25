const state = {
  queue: [],
  sessions: [],
  metrics: null,
  selectedSessionId: null,
  joinedSessionId: null,
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
  sessionVideo: document.getElementById('sessionVideo'),
  sessionAudio: document.getElementById('sessionAudio'),
  controlStart: document.getElementById('controlStart'),
  controlQuality: document.getElementById('controlQuality'),
  controlRemote: document.getElementById('controlRemote'),
  controlStats: document.getElementById('controlStats'),
  closureForm: document.getElementById('closureForm'),
  closureOutcome: document.getElementById('closureOutcome'),
  closureSymptom: document.getElementById('closureSymptom'),
  closureSolution: document.getElementById('closureSolution'),
  closureNps: document.getElementById('closureNps'),
  closureFcr: document.getElementById('closureFcr'),
  closureSubmit: document.getElementById('closureSubmit'),
};

const SOCKET_URL = window.location.origin;
const socket = window.io ? window.io(SOCKET_URL, { transports: ['websocket'], withCredentials: true }) : null;

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
  if (bucket.length > 50) bucket.splice(0, bucket.length - 50);
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
      author: isTech ? (dom.techIdentity?.dataset?.techName || 'Você') : session?.clientName || normalized.from,
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
    dom.sessionAudio.srcObject = null;
    dom.sessionAudio.pause();
    dom.sessionAudio.setAttribute('hidden', 'hidden');
  }
  updateMediaDisplay();
};

const updateMediaDisplay = () => {
  const hasLocalScreen = Boolean(state.media.local.screen);
  const hasRemoteVideo = Boolean(state.media.remoteStream);
  if (dom.sessionVideo) {
    if (hasRemoteVideo || hasLocalScreen) {
      dom.sessionVideo.removeAttribute('hidden');
    } else {
      dom.sessionVideo.setAttribute('hidden', 'hidden');
      dom.sessionVideo.srcObject = null;
    }
  }
  if (dom.sessionPlaceholder) {
    if (hasRemoteVideo || hasLocalScreen) {
      dom.sessionPlaceholder.setAttribute('hidden', 'hidden');
    } else {
      dom.sessionPlaceholder.removeAttribute('hidden');
    }
  }
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

const renderChatForSession = () => {
  if (!dom.chatThread) return;
  const session = getSelectedSession();
  if (!session) {
    if (state.renderedChatSessionId !== null) {
      dom.chatThread.innerHTML = '';
      state.renderedChatSessionId = null;
      addChatMessage({ author: 'Sistema', text: 'Selecione uma sessão para conversar com o cliente.', kind: 'system' });
    }
    return;
  }

  if (state.renderedChatSessionId === session.sessionId) return;
  dom.chatThread.innerHTML = '';
  const history = state.chatBySession.get(session.sessionId) || [];
  if (!history.length) {
    addChatMessage({
      author: 'Sistema',
      text: 'Sem mensagens trocadas ainda nesta sessão.',
      kind: 'system',
    });
  } else {
    history.forEach((msg) => {
      const isTech = msg.from === 'tech';
      addChatMessage({
        author: isTech ? (dom.techIdentity?.dataset?.techName || 'Você') : session.clientName || msg.from,
        text: msg.text,
        kind: isTech ? 'self' : 'client',
        ts: msg.ts,
      });
    });
  }
  state.renderedChatSessionId = session.sessionId;
};

const joinSelectedSession = () => {
  if (!socket) return;
  const session = getSelectedSession();
  if (!session || session.status !== 'active') return;
  const sessionId = session.sessionId;
  if (!sessionId || state.joinedSessionId === sessionId) return;
  socket.emit('session:join', { sessionId, role: 'tech', userType: 'tech' }, (ack) => {
    if (ack?.ok) {
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

function handleCommandEffects(command, { local = false } = {}) {
  if (!command) return;
  const by = command.by || (local ? 'tech' : 'unknown');
  switch (command.type) {
    case 'share_start':
      state.commandState.shareActive = true;
      if (dom.controlStart) dom.controlStart.textContent = 'Encerrar visualização';
      if (by !== 'tech') {
        startLocalScreenShare();
      }
      break;
    case 'share_stop':
      state.commandState.shareActive = false;
      if (dom.controlStart) dom.controlStart.textContent = 'Solicitar visualização';
      if (by !== 'tech') {
        stopLocalScreenShare(false);
      } else {
        clearRemoteVideo();
      }
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
    renderChatForSession();
    return;
  }

  const telemetry = getTelemetryForSession(session.sessionId) || session.telemetry || session.extra?.telemetry || {};
  if (typeof telemetry.shareActive === 'boolean' && dom.controlStart) {
    state.commandState.shareActive = telemetry.shareActive;
    dom.controlStart.textContent = telemetry.shareActive ? 'Encerrar visualização' : 'Solicitar visualização';
  }
  if (typeof telemetry.remoteActive === 'boolean' && dom.controlRemote) {
    state.commandState.remoteActive = telemetry.remoteActive;
    dom.controlRemote.textContent = telemetry.remoteActive ? 'Revogar acesso remoto' : 'Solicitar acesso remoto';
  }
  if (typeof telemetry.callActive === 'boolean' && dom.controlQuality) {
    state.commandState.callActive = telemetry.callActive;
    dom.controlQuality.textContent = telemetry.callActive ? 'Encerrar chamada' : 'Iniciar chamada';
  }

  const deviceParts = [session.brand, session.model, session.osVersion ? `Android ${session.osVersion}` : null].filter(Boolean);
  dom.contextDevice.textContent = deviceParts.length ? deviceParts.join(' • ') : 'Dispositivo não informado';
  dom.contextIdentity.textContent = session.clientName ? `${session.clientName}` : 'Cliente';
  dom.contextNetwork.textContent = telemetry.network || session.extra?.network || 'Aguardando dados do app';
  dom.contextHealth.textContent = telemetry.health || session.extra?.health || 'Aguardando dados do app';
  dom.contextPermissions.textContent = telemetry.permissions || session.extra?.permissions || 'Sem registros';
  dom.sessionPlaceholder.textContent = session.status === 'active'
    ? `Sessão ${session.sessionId} • aguardando conexão`
    : `Sessão ${session.sessionId} encerrada ${formatRelative(Date.now() - (session.closedAt || session.acceptedAt))}`;
  dom.indicatorNetwork.textContent = telemetry.network || session.extra?.network || (session.status === 'active' ? 'Aguardando telemetria do app' : 'Sessão encerrada');
  dom.indicatorQuality.textContent = session.status === 'active' ? 'Online' : 'Finalizada';
  dom.indicatorAlerts.textContent = telemetry.alerts || session.extra?.alerts || (session.status === 'active' ? 'Sem alertas' : 'Encerrada');

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

  renderChatForSession();
  updateMediaDisplay();
  joinSelectedSession();
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

const addChatMessage = ({ author, text, kind = 'client', ts = Date.now() }) => {
  if (!dom.chatThread || !text) return;
  const entry = document.createElement('div');
  entry.className = 'message';
  if (kind === 'self') entry.classList.add('self');
  if (kind === 'system') entry.classList.add('system');
  entry.textContent = `${formatTime(ts)} • ${author}: ${text}`;
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
    state.sessions.forEach(syncSessionStores);
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

const bootstrap = async () => {
  updateTechIdentity();
  resetCommandState();
  bindSessionControls();
  initChat();
  bindClosureForm();
  await Promise.all([loadQueue(), loadSessions(), loadMetrics()]);
};

if (socket) {
  socket.on('connect', () => {
    addChatMessage({ author: 'Sistema', text: 'Conectado ao servidor de sinalização.', kind: 'system' });
    state.joinedSessionId = null;
    joinSelectedSession();
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
    loadMetrics();
  });
  socket.on('session:chat:new', (message) => {
    ingestChatMessage(message);
  });
  socket.on('session:command', (command) => {
    registerCommand(command);
  });
  socket.on('session:status', (status) => {
    if (!status || !status.sessionId) return;
    const ts = status.ts || Date.now();
    const current = getTelemetryForSession(status.sessionId) || {};
    const data = typeof status.data === 'object' && status.data !== null ? status.data : {};
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
  });
  socket.on('session:ended', (payload) => {
    if (!payload || !payload.sessionId) return;
    handleSessionEnded(payload.sessionId, payload.reason || 'peer_ended');
  });
  socket.on('signal:offer', async ({ sessionId, sdp }) => {
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
  });
  socket.on('signal:answer', async ({ sessionId, sdp }) => {
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
  });
  socket.on('signal:candidate', async ({ sessionId, candidate }) => {
    if (!sessionId || !candidate) return;
    if (state.media.sessionId && state.media.sessionId !== sessionId) return;
    try {
      const pc = ensurePeerConnection(sessionId);
      if (!pc) return;
      await pc.addIceCandidate(candidate);
    } catch (error) {
      console.error('Erro ao adicionar ICE candidate', error);
    }
  });
}

bootstrap();
