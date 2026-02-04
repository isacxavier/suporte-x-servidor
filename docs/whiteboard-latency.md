# Latência e fluidez da lousa (Web)

## Objetivo
Medir a latência ponta-a-ponta e garantir fluidez ao espelhar a lousa/desenho do Android no painel web.

## Como habilitar a instrumentação (Web)

1. Abra o painel web normalmente.
2. Adicione `?wbMetrics=1` na URL (exemplo: `https://suportex.app/central.html?wbMetrics=1`).
3. Abra o DevTools → Console.

Com esse parâmetro, o web passa a registrar métricas agregadas a cada ~2s.

### Exemplo de log
```
[WB][metrics] {
  windowMs: 2004,
  events: 120,
  points: 1440,
  drawnPoints: 1400,
  droppedPoints: 0,
  eventsPerSec: 60,
  pointsPerSec: 720,
  kbPerSec: 48,
  avgNetworkMs: 80,
  avgRenderMs: 2,
  avgE2eMs: 82
}
```

### O que significam as métricas
- **avgNetworkMs (t1 - t0)**: tempo entre o Android gerar o evento e o web recebê-lo.
- **avgRenderMs (t2 - t1)**: tempo para o web aplicar o ponto no canvas.
- **avgE2eMs (t2 - t0)**: latência ponta-a-ponta.
- **events/points por segundo**: frequência de eventos e volume de pontos.
- **kb/s**: estimativa de tamanho do payload recebendo do Android.

> **Importante**: para `t1 - t0` e `t2 - t0` fazerem sentido, o Android deve enviar o timestamp **t0** em milissegundos (ou nanos) e o web converte automaticamente quando necessário. Se usar `elapsedRealtimeNanos`, o valor é convertido automaticamente para ms.

## Formato recomendado de evento (Android → Web)

Preferir payload compacto e com batching:

```json
{
  "type": "whiteboard",
  "payload": {
    "strokeId": "abc123",
    "color": "#22c55e",
    "size": 2,
    "t0": 1234567890,
    "points": [
      { "x": 0.12, "y": 0.34, "action": "start" },
      { "x": 0.13, "y": 0.35, "action": "move" },
      { "x": 0.14, "y": 0.36, "action": "end" }
    ]
  }
}
```

### Notas
- `x` e `y` devem ser normalizados (0–1). O web também aceita coordenadas em pixels do frame (`units: "frame"`).
- `points` pode conter vários pontos (batch) para reduzir overhead.
- `action` aceita `start`, `move`, `end` e `clear`.

## Expectativa de números

Em uma rede estável:
- `avgNetworkMs`: 30–120ms.
- `avgRenderMs`: 1–4ms.
- `avgE2eMs`: próximo de `avgNetworkMs` (diferença pequena).
- `droppedPoints`: idealmente 0 (se >0, há fila crescendo ou payload grande).

Se o `avgRenderMs` ou `droppedPoints` estiverem altos, o gargalo está no **render/UI** (precisa reduzir carga por frame ou fazer batching maior).
