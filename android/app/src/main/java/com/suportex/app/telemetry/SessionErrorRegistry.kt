package com.suportex.app.telemetry

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

class SessionErrorRegistry {
    private val mutex = Mutex()
    private var latestError: TelemetryError? = null

    suspend fun report(code: String, message: String, fatal: Boolean = false) {
        mutex.withLock {
            latestError = TelemetryError(code, message, fatal)
        }
    }

    suspend fun clear() {
        mutex.withLock { latestError = null }
    }

    suspend fun consumeLatest(): TelemetryError? = mutex.withLock {
        val error = latestError
        latestError = null
        error
    }
}
