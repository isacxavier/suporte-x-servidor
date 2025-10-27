package com.suportex.app.session

class SessionEventDispatcher(
    private val reporter: SessionEventReporter,
) {
    suspend fun shareStart(payload: SessionEventPayload? = null) {
        reporter.emit(SessionEventType.SHARE_START, payload)
    }

    suspend fun shareStop(payload: SessionEventPayload? = null) {
        reporter.emit(SessionEventType.SHARE_STOP, payload)
    }

    suspend fun remoteEnable(payload: SessionEventPayload? = null) {
        reporter.emit(SessionEventType.REMOTE_ENABLE, payload)
    }

    suspend fun remoteRevoke(payload: SessionEventPayload? = null) {
        reporter.emit(SessionEventType.REMOTE_REVOKE, payload)
    }

    suspend fun callStart(payload: SessionEventPayload? = null) {
        reporter.emit(SessionEventType.CALL_START, payload)
    }

    suspend fun callEnd(payload: SessionEventPayload? = null) {
        reporter.emit(SessionEventType.CALL_END, payload)
    }

    suspend fun sessionEnd(payload: SessionEventPayload? = null) {
        reporter.emit(SessionEventType.SESSION_END, payload)
    }
}
