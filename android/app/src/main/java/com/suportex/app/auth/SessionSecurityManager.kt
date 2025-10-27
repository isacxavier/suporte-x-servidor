package com.suportex.app.auth

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await

/**
 * Validates that the authenticated user is allowed to mutate a given session document.
 * The server populates `sessions/{id}.clientUid` with the UID of the device that opened it.
 */
class SessionSecurityManager(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
) {
    private val cacheMutex = Mutex()
    private val allowedSessions = mutableSetOf<String>()

    suspend fun assertCanWrite(sessionId: String) {
        val uid = auth.currentUser?.uid
            ?: throw SecurityException("Usuário não autenticado")

        cacheMutex.withLock {
            if (allowedSessions.contains(sessionId)) return

            val doc = firestore.collection("sessions")
                .document(sessionId)
                .get()
                .await()

            val ownerUid = doc.getString("clientUid")
                ?: throw SecurityException("Sessão sem owner definido")

            if (ownerUid != uid) {
                throw SecurityException("Usuário não é dono da sessão")
            }

            allowedSessions.add(sessionId)
        }
    }

    fun clearCache() {
        allowedSessions.clear()
    }
}
