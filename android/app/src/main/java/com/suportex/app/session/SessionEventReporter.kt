package com.suportex.app.session

import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.suportex.app.auth.SessionSecurityManager
import com.suportex.app.telemetry.TelemetryProvider
import com.suportex.app.telemetry.TelemetrySnapshot
import io.socket.client.Ack
import io.socket.client.Socket
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

class SessionEventReporter(
    private val sessionId: String,
    private val socket: Socket,
    private val firestore: FirebaseFirestore,
    private val securityManager: SessionSecurityManager,
    private val telemetryProvider: TelemetryProvider,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    suspend fun emit(type: SessionEventType, basePayload: SessionEventPayload? = null): SessionEventPayload {
        val snapshot = telemetryProvider.collect()
        val mergedPayload = mergePayload(snapshot, basePayload)

        securityManager.assertCanWrite(sessionId)
        sendThroughSocket(type, mergedPayload)
        writeToFirestore(type, mergedPayload)

        return mergedPayload
    }

    private suspend fun sendThroughSocket(type: SessionEventType, payload: SessionEventPayload) {
        val data = JSONObject().apply {
            put("sessionId", sessionId)
            put("type", type.backendName)
            if (payload.toMap().isNotEmpty()) {
                put("payload", JSONObject(payload.toMap()))
            }
        }

        withContext(dispatcher) {
            suspendCancellableCoroutine { continuation ->
                socket.emit("session:command", data, Ack { args ->
                    val ack = args.firstOrNull()
                    val ok = when (ack) {
                        is JSONObject -> ack.optBoolean("ok", true)
                        is Map<*, *> -> ack["ok"] as? Boolean ?: true
                        else -> true
                    }
                    if (ok) {
                        continuation.resume(Unit)
                    } else {
                        val err = when (ack) {
                            is JSONObject -> ack.optString("err", "Ack desconhecido")
                            is Map<*, *> -> ack["err"] as? String ?: "Ack desconhecido"
                            else -> "Ack desconhecido"
                        }
                        continuation.resumeWithException(IllegalStateException(err))
                    }
                })
            }
        }
    }

    private suspend fun writeToFirestore(type: SessionEventType, payload: SessionEventPayload) {
        val data = mutableMapOf<String, Any?>()
        data["type"] = type.backendName
        data["createdAt"] = FieldValue.serverTimestamp()
        data["source"] = "android"
        val payloadMap = payload.toMap()
        if (payloadMap.isNotEmpty()) {
            data["payload"] = payloadMap
        }

        firestore.collection("sessions")
            .document(sessionId)
            .collection("events")
            .add(data)
            .await()
    }

    private fun mergePayload(
        snapshot: TelemetrySnapshot,
        basePayload: SessionEventPayload?,
    ): SessionEventPayload {
        val extras = snapshot.asPayloadExtras().toMutableMap()
        basePayload?.extras?.let { extras.putAll(it) }
        val errorMessage = basePayload?.errorMessage ?: snapshot.latestError?.message
        val errorCode = basePayload?.errorCode ?: snapshot.latestError?.code

        return SessionEventPayload(
            networkType = basePayload?.networkType ?: snapshot.networkType,
            networkMetered = basePayload?.networkMetered ?: snapshot.networkMetered,
            permissionsGranted = basePayload?.permissionsGranted ?: snapshot.grantedPermissions,
            deniedPermissions = basePayload?.deniedPermissions ?: snapshot.deniedPermissions,
            accessibilityServiceEnabled = basePayload?.accessibilityServiceEnabled
                ?: snapshot.accessibilityServiceEnabled,
            errorMessage = errorMessage,
            errorCode = errorCode,
            extras = extras.takeIf { it.isNotEmpty() }
        )
    }

    companion object {
        private const val TAG = "SessionEventReporter"
    }
}
