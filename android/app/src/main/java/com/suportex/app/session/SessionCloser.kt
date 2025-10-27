package com.suportex.app.session

import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.suportex.app.auth.SessionSecurityManager
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

class SessionCloser(
    private val sessionId: String,
    private val firestore: FirebaseFirestore,
    private val securityManager: SessionSecurityManager,
    private val socket: Socket,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val reporter: SessionEventReporter,
) {
    suspend fun closeSession(additionalPayload: SessionEventPayload? = null) {
        val mergedPayload = reporter.emit(SessionEventType.SESSION_END, additionalPayload)
        val finalPayloadMap = mergedPayload.toMap()

        securityManager.assertCanWrite(sessionId)

        val sessionDoc = firestore.collection("sessions").document(sessionId)
        val updates = mutableMapOf<String, Any?>(
            "status" to "closed",
            "closedAt" to FieldValue.serverTimestamp(),
            "clientClosedAt" to FieldValue.serverTimestamp(),
        )
        if (finalPayloadMap.isNotEmpty()) {
            updates["finalTelemetry"] = finalPayloadMap
        }

        sessionDoc.update(updates).await()

        val telemetryBody = JSONObject().apply {
            put("sessionId", sessionId)
            put("from", "app")
            put("data", JSONObject(finalPayloadMap))
        }

        withContext(dispatcher) {
            suspendCancellableCoroutine { continuation ->
                socket.emit("session:telemetry", telemetryBody, Ack { args ->
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
}
