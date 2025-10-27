package com.suportex.app.session

enum class SessionEventType(val backendName: String) {
    SHARE_START("share_start"),
    SHARE_STOP("share_stop"),
    REMOTE_ENABLE("remote_enable"),
    REMOTE_REVOKE("remote_revoke"),
    CALL_START("call_start"),
    CALL_END("call_end"),
    SESSION_END("end");

    companion object {
        fun fromBackendName(name: String): SessionEventType? =
            entries.firstOrNull { it.backendName == name }
    }
}
