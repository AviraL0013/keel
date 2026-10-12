package xyz.eyeler.app

import android.annotation.SuppressLint
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.view.ViewGroup
import android.view.WindowManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject

class MainActivity : FlutterActivity() {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var sdkView: WebView? = null
    private var sdkReady = false
    private var nextCallId = 0
    private val pending = mutableMapOf<String, MethodChannel.Result>()
    private lateinit var ceremonyChannel: MethodChannel

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        ceremonyChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger,
            "xyz.eyeler.app/mera_ceremony")
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger,
            "xyz.eyeler.app/secure_display").setMethodCallHandler { call, result ->
            when (call.method) {
                "enable" -> { window.addFlags(WindowManager.LayoutParams.FLAG_SECURE); result.success(null) }
                "disable" -> { window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE); result.success(null) }
                else -> result.notImplemented()
            }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger,
            "xyz.eyeler.app/mera_sdk").setMethodCallHandler { call, result ->
            if (call.method != "create" && call.method != "get") {
                result.notImplemented()
                return@setMethodCallHandler
            }
            val rpId = call.argument<String>("rpId")
            if (rpId != "app.eyeler.xyz") {
                result.error("MERA_RP_ID", "Unexpected passkey domain", null)
                return@setMethodCallHandler
            }
            ensureSdk()
            val id = (++nextCallId).toString()
            pending[id] = result
            val input = JSONObject()
                .put("rpId", rpId)
                .put("label", call.argument<String>("label") ?: "EYELER")
                .put("credentialId", call.argument<String>("credentialId"))
            val invoke = {
                sdkView?.evaluateJavascript(
                    "window.eyelerMeraSdk.run(${JSONObject.quote(id)}," +
                        "${JSONObject.quote(call.method)},${JSONObject.quote(input.toString())})",
                    null
                )
            }
            if (sdkReady) invoke() else mainHandler.postDelayed({
                if (pending.containsKey(id)) {
                    if (sdkReady) invoke() else pending.remove(id)?.error(
                        "MERA_SDK_UNAVAILABLE", "Mera SDK did not load", null)
                }
            }, 10000)
            mainHandler.postDelayed({
                pending.remove(id)?.error("MERA_TIMEOUT", "Passkey request timed out", null)
            }, 120000)
        }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun ensureSdk() {
        if (sdkView != null) return
        val view = WebView(this)
        sdkView = view
        view.settings.javaScriptEnabled = true
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        view.settings.blockNetworkLoads = true
        view.settings.javaScriptCanOpenWindowsAutomatically = false
        view.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        view.addJavascriptInterface(SdkMessages(), "EyelerMeraNative")
        view.alpha = 0f
        (window.decorView as ViewGroup).addView(view, ViewGroup.LayoutParams(1, 1))
        val script = assets.open("mera-sdk.js").bufferedReader().use { it.readText() }
        view.loadDataWithBaseURL("https://app.eyeler.xyz/mera-sdk", """
            <!doctype html><meta charset="utf-8"><script>$script</script>
        """.trimIndent(), "text/html", "utf-8", null)
    }

    private inner class SdkMessages {
        @JavascriptInterface
        fun ready() { mainHandler.post { sdkReady = true } }

        @JavascriptInterface
        fun request(json: String) {
            mainHandler.post {
                val request = try { JSONObject(json) } catch (_: Exception) { return@post }
                val id = request.optString("id")
                val kind = request.optString("kind")
                if (id.isEmpty() || (kind != "create" && kind != "get")) return@post
                ceremonyChannel.invokeMethod(kind, request.getJSONObject("request").toString(),
                    object : MethodChannel.Result {
                        override fun success(value: Any?) {
                            val response = if (value is String) value else "{\"error\":\"PASSKEY_OPERATION_FAILED\"}"
                            sdkView?.evaluateJavascript(
                                "window.eyelerMeraNativeResponse(${JSONObject.quote(id)}," +
                                    "${JSONObject.quote(response)})", null)
                        }
                        override fun error(code: String, message: String?, details: Any?) {
                            success("{\"error\":\"PASSKEY_OPERATION_FAILED\"}")
                        }
                        override fun notImplemented() { error("NOT_IMPLEMENTED", null, null) }
                    })
            }
        }

        @JavascriptInterface
        fun complete(json: String) {
            mainHandler.post {
                val response = try { JSONObject(json) } catch (_: Exception) { return@post }
                val result = pending.remove(response.optString("id")) ?: return@post
                if (response.has("error")) {
                    result.error("MERA_SDK", response.optString("error"), null)
                } else {
                    result.success(mapOf(
                        "credentialId" to response.getString("credentialId"),
                        "prfOutput" to response.getString("prfOutput")))
                }
            }
        }
    }

    override fun onDestroy() {
        pending.values.forEach { it.error("MERA_CLOSED", "App closed", null) }
        pending.clear()
        (sdkView?.parent as? ViewGroup)?.removeView(sdkView)
        sdkView?.destroy()
        sdkView = null
        super.onDestroy()
    }
}
