package com.suportex.app.telemetry

interface TelemetryProvider {
    suspend fun collect(): TelemetrySnapshot
}
