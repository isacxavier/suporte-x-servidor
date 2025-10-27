package com.suportex.app.session

data class SessionEventPayload(
    val networkType: String? = null,
    val networkMetered: Boolean? = null,
    val permissionsGranted: List<String>? = null,
    val deniedPermissions: List<String>? = null,
    val accessibilityServiceEnabled: Boolean? = null,
    val errorMessage: String? = null,
    val errorCode: String? = null,
    val extras: Map<String, Any?>? = null,
) {
    fun toMap(): Map<String, Any?> = buildMap {
        networkType?.let { put("networkType", it) }
        networkMetered?.let { put("networkMetered", it) }
        permissionsGranted?.let { put("permissionsGranted", it) }
        deniedPermissions?.let { put("deniedPermissions", it) }
        accessibilityServiceEnabled?.let { put("accessibilityServiceEnabled", it) }
        errorMessage?.let { put("errorMessage", it) }
        errorCode?.let { put("errorCode", it) }
        extras?.let { put("extras", it) }
    }
}
