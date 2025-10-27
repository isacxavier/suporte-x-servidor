package com.suportex.app.telemetry

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.Build
import android.view.accessibility.AccessibilityManager
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class DefaultTelemetryProvider(
    private val context: Context,
    private val connectivityManager: ConnectivityManager,
    private val accessibilityManager: AccessibilityManager,
    private val trackedPermissions: List<String> = DEFAULT_PERMISSIONS,
    private val errorRegistry: SessionErrorRegistry,
) : TelemetryProvider {
    override suspend fun collect(): TelemetrySnapshot = withContext(Dispatchers.Default) {
        val networkType = resolveNetworkType()
        val networkMetered = runCatching { connectivityManager.isActiveNetworkMetered }.getOrNull()
        val (granted, denied) = trackedPermissions.partition { permission ->
            ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
        }
        val accessibilityEnabled = isAccessibilityServiceEnabled()

        TelemetrySnapshot(
            networkType = networkType,
            networkMetered = networkMetered,
            grantedPermissions = granted,
            deniedPermissions = denied,
            accessibilityServiceEnabled = accessibilityEnabled,
            latestError = errorRegistry.consumeLatest(),
        )
    }

    private fun resolveNetworkType(): String? {
        val network = connectivityManager.activeNetwork ?: return null
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return null
        return when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "Cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "Ethernet"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) -> "Bluetooth"
            else -> "Unknown"
        }
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            accessibilityManager.enabledAccessibilityServiceList.any { service ->
                service.resolveInfo?.serviceInfo?.packageName == context.packageName
            }
        } else {
            @Suppress("DEPRECATION")
            accessibilityManager.getEnabledAccessibilityServiceList(AccessibilityManager.FEEDBACK_ALL_MASK)
                ?.any { it.resolveInfo?.serviceInfo?.packageName == context.packageName } == true
        }
    }

    companion object {
        val DEFAULT_PERMISSIONS: List<String> = listOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.POST_NOTIFICATIONS,
        )
    }
}
