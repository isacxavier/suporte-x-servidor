package com.suportex.app.telemetry

data class TelemetrySnapshot(
    val networkType: String?,
    val networkMetered: Boolean?,
    val grantedPermissions: List<String>,
    val deniedPermissions: List<String>,
    val accessibilityServiceEnabled: Boolean?,
    val latestError: TelemetryError? = null,
) {
    fun asPayloadExtras(): Map<String, Any?> = buildMap {
        val network = buildMap {
            networkType?.let { put("type", it) }
            networkMetered?.let { put("metered", it) }
        }
        if (network.isNotEmpty()) {
            put("network", network)
        }

        val permissions = buildMap {
            put("granted", grantedPermissions)
            put("denied", deniedPermissions)
            accessibilityServiceEnabled?.let { put("accessibilityServiceEnabled", it) }
        }
        if (permissions.isNotEmpty()) {
            put("permissions", permissions)
        }

        latestError?.let { put("error", it.toMap()) }
    }
}

data class TelemetryError(
    val code: String,
    val message: String,
    val fatal: Boolean,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "code" to code,
        "message" to message,
        "fatal" to fatal,
    )
}
