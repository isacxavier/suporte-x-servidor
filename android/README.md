# Suporte X – Android

Este módulo contém a base do aplicativo cliente (`appId` `com.suportex.app`). A pasta já inclui a infraestrutura de Gradle e os componentes de sessão responsáveis por publicar eventos e telemetria no backend Socket.IO/Firestore.

## Componentes principais

- `SessionEventReporter` – envia eventos críticos (`share_start/stop`, `remote_enable/revoke`, `call_start/end`, `end`) simultaneamente pelo Socket.IO e pela coleção `sessions/{id}/events`, incluindo snapshots de rede, permissões e erros recentes.
- `SessionCloser` – finaliza a sessão atualizando `sessions/{id}` com `status="closed"`, `closedAt` (timestamp do servidor) e anexando a telemetria final. Também replica o estado via `session:telemetry` para o painel.
- `SessionSecurityManager` – valida que o usuário autenticado possui permissão para escrever na sessão antes de qualquer operação de rede/Firestore.
- `DefaultTelemetryProvider` – agrega informações do dispositivo (rede ativa, permissões, acessibilidade e últimos erros registrados).

### Exemplo de uso

```kotlin
val security = SessionSecurityManager(FirebaseAuth.getInstance(), FirebaseFirestore.getInstance())
val errorRegistry = SessionErrorRegistry()
val telemetryProvider = DefaultTelemetryProvider(
    context,
    context.getSystemService(ConnectivityManager::class.java),
    context.getSystemService(AccessibilityManager::class.java),
    errorRegistry = errorRegistry,
)
val reporter = SessionEventReporter(
    sessionId = sessionId,
    socket = socket,
    firestore = FirebaseFirestore.getInstance(),
    securityManager = security,
    telemetryProvider = telemetryProvider,
)
val dispatcher = SessionEventDispatcher(reporter)

// Disparar início de compartilhamento
dispatcher.shareStart()

// Encerrar sessão
val closer = SessionCloser(
    sessionId = sessionId,
    firestore = FirebaseFirestore.getInstance(),
    securityManager = security,
    socket = socket,
    reporter = reporter,
)
closer.closeSession()
```

## Estrutura do projeto

```
android/
├── app/
│   ├── build.gradle
│   └── src/main/java/com/suportex/app/... (código Kotlin)
├── build.gradle
└── settings.gradle
```

Arquivos sensíveis (keystore, `google-services.json`, etc.) devem permanecer fora do controle de versão.
