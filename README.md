# Suporte X Monorepo

Este repositório concentra tudo o que é necessário para as plataformas Android e Web do Suporte X, bem como o backend de sinalização e a documentação compartilhada.

```
suportex/
├── android/   # projeto Android (appId com.suportex.app)
├── web/       # painel "Central do Técnico" e assets WebRTC
├── server/    # sinalização Socket.IO / backend Render
└── docs/      # diagramas, decisões (ADR), manuais
```

Cada diretório é versionado de forma independente, mas permanece no mesmo repositório para simplificar a colaboração entre as equipes mobile e web.

## Estrutura

### `android/`
Espaço reservado para o aplicativo Android nativo. Adicione aqui o projeto do Android Studio (`app/`, `build.gradle`, etc.).

### `web/`
Contém os arquivos estáticos utilizados pelo painel web e pela captura de tela do cliente (`public/`). O HTML/JS continua leve e sem build steps para facilitar ajustes rápidos.

### `server/`
Servidor Node.js responsável pela sinalização WebRTC com Socket.IO. Ele serve os arquivos estáticos diretamente de `../web/public` e expõe a API usada pelo painel.

Para rodar localmente:

```bash
cd server
npm install
npm start
```

O servidor roda em `http://localhost:3000`.

#### Eventos Socket.IO de sessão

O canal Socket.IO é a espinha dorsal das interações em tempo real entre o painel e o app Android. Cada sessão utiliza uma sala no formato `s:<sessionId>`. Os papéis previstos são `tech` (painel) e `client` (app). Os principais eventos são:

| Direção | Evento | Payload | Descrição |
| ------- | ------ | ------- | --------- |
| cliente → servidor | `session:join` | `{ sessionId, role }` | Entra na sala da sessão. Recebe ACK `{ ok: true }` em caso de sucesso. |
| cliente → servidor | `session:chat:send` | `{ sessionId, from, text }` | Envia mensagem de chat. Recebe ACK `{ ok: true }` e o servidor reemite `session:chat:new`. |
| cliente → servidor | `session:command` | `{ sessionId, type, payload? }` | Dispara comandos como `share_start`, `remote_enable`, `call_start`, etc. O servidor reenvia para a sala com o campo adicional `by`. |
| cliente → servidor | `session:telemetry` | `{ sessionId, from?, data }` | Atualiza telemetria/estado (rede, permissões, indicadores). O servidor propaga via `session:status`. |
| servidor → sala `s:<sessionId>` | `session:chat:new` | `{ id, sessionId, from, text, ts }` | Nova mensagem de chat. |
| servidor → sala `s:<sessionId>` | `session:command` | `{ sessionId, type, payload?, by, ts }` | Comando replicado para ambos os lados. |
| servidor → sala `s:<sessionId>` | `session:status` | `{ sessionId, from?, data, ts }` | Estado consolidado/telemetria para atualizar UI. |

Exemplos de uso no painel web:

```js
// Entrar na sessão ativa
socket.emit('session:join', { sessionId, role: 'tech' }, (ack) => {
  if (!ack?.ok) console.error('Falha ao entrar na sessão', ack?.err);
});

// Enviar mensagem de chat
socket.emit('session:chat:send', { sessionId, from: 'tech', text }, (ack) => {
  if (!ack?.ok) alert('Não foi possível enviar a mensagem');
});

// Disparar comandos de controle
socket.emit('session:command', { sessionId, type: 'share_start' });
socket.emit('session:command', { sessionId, type: 'remote_enable' });

// Publicar telemetria do app
socket.emit('session:telemetry', {
  sessionId,
  from: 'app',
  data: {
    network: 'Wi-Fi 5GHz',
    permissions: 'Acessibilidade OK',
    shareActive: true,
  },
});

// Consumir eventos vindos do servidor
socket.on('session:chat:new', (msg) => renderChatMessage(msg));
socket.on('session:command', (cmd) => console.log('Comando recebido', cmd));
socket.on('session:status', (status) => updateStatusUI(status));
```

### `docs/`
Área para documentação compartilhada (diagramas, ADRs, manuais internos, etc.).

## Próximos passos
- [ ] Adicionar o projeto Android dentro de `android/`.
- [ ] Evoluir o front-end em `web/` conforme necessário.
- [ ] Documentar decisões relevantes em `docs/`.

Sinta-se à vontade para ajustar esta estrutura à medida que o projeto evoluir.
