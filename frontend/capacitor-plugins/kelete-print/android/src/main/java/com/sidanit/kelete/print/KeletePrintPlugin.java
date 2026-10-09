package com.sidanit.kelete.print;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

/**
 * KeletePrint — printing for the Kelete site running inside the APK.
 *
 * 2026-09-10. The APK's start page (mobile-shell/index.html) sends the app
 * straight on to the live site. From there the site runs in the app's
 * built-in browser, which has no print window of its own and ignores
 * downloads, and Capacitor's usual JavaScript bridge is not injected into a
 * page loaded from another host. So pressing Print did nothing at all.
 *
 * A JavaScript interface added to the app's browser, unlike the Capacitor
 * bridge, stays on every page that browser loads, including the live site.
 * So on startup this plugin adds one, window.KeleteAndroid, with two ways
 * to print:
 *
 *   printHtml(html, name)   the receipt goes to Android's PrintManager and
 *                           the system print window opens, the same one
 *                           Chrome shows.
 *
 *   sendRaw(base64, jobId)  SILENT. ESC/POS bytes, already drawn by the site
 *                           as a 384-dot image, go straight to the terminal's
 *                           built-in printer, which the KI-POS pairs as the
 *                           Bluetooth device "vBtPrinter". No window. The
 *                           outcome goes back to the page through
 *                           window.__keletePrintDone(jobId, ok, message), and
 *                           the site falls back to printHtml on any failure.
 *
 * Only pages on keletezm.com (and the local start page) are
 * served; a request from anywhere else is refused.
 */
@CapacitorPlugin(name = "KeletePrint")
public class KeletePrintPlugin extends Plugin {

    // Serial Port Profile: the standard channel a Bluetooth receipt printer
    // listens on.
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
    // Written out rather than Manifest.permission.BLUETOOTH_CONNECT so the
    // code reads the same whatever SDK level it is compiled against.
    private static final String BT_CONNECT = "android.permission.BLUETOOTH_CONNECT";
    private static final int BT_REQUEST = 7101;

    // One job at a time: two receipts written into the same link at once
    // would print interleaved.
    private final ExecutorService printQueue = Executors.newSingleThreadExecutor();

    // The page being printed through the print window. Held in a field as
    // Android's guide does: the print job reads it after print() returns, and
    // a view garbage-collected in the meantime prints blank or not at all.
    private WebView printView;

    @Override
    public void load() {
        getBridge().getWebView().addJavascriptInterface(new AndroidBridge(), "KeleteAndroid");
        // Ask for "Nearby devices" once, at startup, rather than in the middle
        // of the first sale.
        askForBluetooth();
    }

    // Also reachable through Capacitor itself, for a page that does have the
    // bridge (the local start page).
    @PluginMethod
    public void print(PluginCall call) {
        printHtml(call.getString("html", ""), call.getString("name", "Receipt"));
        call.resolve();
    }

    // ── The print window ───────────────────────────────────────────────────

    private void printHtml(final String html, final String name) {
        if (html == null || html.isEmpty()) return;
        getActivity().runOnUiThread(() -> {
            // Checked on the UI thread, where the browser's URL can be read.
            if (!isKeletePage(getBridge().getWebView().getUrl())) return;

            final String job = (name == null || name.isEmpty()) ? "Receipt" : name;
            final WebView view = new WebView(getActivity());
            view.setWebViewClient(new WebViewClient() {
                private boolean sent = false;

                @Override
                public void onPageFinished(WebView v, String url) {
                    if (sent) return;
                    sent = true;
                    PrintManager pm = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
                    if (pm == null) return;
                    PrintDocumentAdapter adapter = v.createPrintDocumentAdapter(job);
                    // Default attributes: the printer's own service picks its
                    // paper, exactly as it did when printing from Chrome.
                    pm.print(job, adapter, new PrintAttributes.Builder().build());
                }
            });
            printView = view;
            // No base URL: the receipt is self-contained, its QR code an
            // inline data: image.
            view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        });
    }

    // ── Silent: straight to the built-in printer ───────────────────────────

    private boolean hasBluetoothPermission() {
        if (Build.VERSION.SDK_INT < 31) return true; // granted at install below Android 12
        return ContextCompat.checkSelfPermission(getContext(), BT_CONNECT) == PackageManager.PERMISSION_GRANTED;
    }

    private void askForBluetooth() {
        if (hasBluetoothPermission()) return;
        getActivity().runOnUiThread(() ->
            ActivityCompat.requestPermissions(getActivity(), new String[] { BT_CONNECT }, BT_REQUEST));
    }

    // The paired device whose name says it is a printer: "vBtPrinter" on the
    // KI-POS. Matching the name keeps other paired devices — a phone the
    // terminal was once connected to — from ever being written to.
    @SuppressLint("MissingPermission")
    private BluetoothDevice findPrinter() {
        BluetoothManager bm = (BluetoothManager) getContext().getSystemService(Context.BLUETOOTH_SERVICE);
        BluetoothAdapter adapter = bm == null ? null : bm.getAdapter();
        if (adapter == null || !adapter.isEnabled()) return null;
        Set<BluetoothDevice> paired = adapter.getBondedDevices();
        if (paired == null) return null;
        for (BluetoothDevice d : paired) {
            String n = d.getName();
            if (n != null && n.toLowerCase().contains("printer")) return d;
        }
        return null;
    }

    // Reads the browser's URL from a worker thread by asking the UI thread,
    // which is the only one allowed to read it.
    private boolean currentPageIsKelete() {
        final String[] url = new String[1];
        final CountDownLatch read = new CountDownLatch(1);
        getActivity().runOnUiThread(() -> {
            url[0] = getBridge().getWebView().getUrl();
            read.countDown();
        });
        try {
            read.await(2, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {}
        return isKeletePage(url[0]);
    }

    @SuppressLint("MissingPermission")
    private void writeToPrinter(byte[] bytes) throws Exception {
        if (!currentPageIsKelete()) throw new Exception("not a Kelete page");
        if (!hasBluetoothPermission()) {
            askForBluetooth();
            throw new Exception("Bluetooth permission not granted");
        }
        BluetoothDevice printer = findPrinter();
        if (printer == null) throw new Exception("no paired printer found - is Bluetooth on?");

        BluetoothSocket socket = printer.createRfcommSocketToServiceRecord(SPP);
        try {
            socket.connect();
            OutputStream os = socket.getOutputStream();
            // In pieces, with a breath between: a small printer buffer can be
            // overrun by one large write.
            final int CHUNK = 4096;
            for (int i = 0; i < bytes.length; i += CHUNK) {
                os.write(bytes, i, Math.min(CHUNK, bytes.length - i));
                os.flush();
                Thread.sleep(15);
            }
            // Let the printer take the last of it before the link closes.
            Thread.sleep(800);
        } finally {
            try { socket.close(); } catch (Exception ignored) {}
        }
    }

    private void reportDone(int jobId, String error) {
        final String js = "window.__keletePrintDone && window.__keletePrintDone("
            + jobId + "," + (error == null) + "," + JSONObject.quote(error == null ? "" : error) + ")";
        getActivity().runOnUiThread(() -> getBridge().getWebView().evaluateJavascript(js, null));
    }

    private static boolean isKeletePage(String url) {
        if (url == null) return false;
        String host = Uri.parse(url).getHost();
        if (host == null) return false;
        return host.equals("keletezm.com")
            || host.endsWith(".keletezm.com")
            || host.equals("localhost");
    }

    // Public: the browser reaches these methods by reflection, and a public
    // method on a private class can be refused access.
    public class AndroidBridge {

        @JavascriptInterface
        public boolean isAvailable() {
            return true;
        }

        @JavascriptInterface
        public void printHtml(String html, String name) {
            KeletePrintPlugin.this.printHtml(html, name);
        }

        @JavascriptInterface
        public void sendRaw(final String base64, final int jobId) {
            printQueue.execute(() -> {
                String error = null;
                try {
                    writeToPrinter(Base64.decode(base64, Base64.DEFAULT));
                } catch (Exception e) {
                    error = e.getMessage() != null ? e.getMessage() : e.getClass().getSimpleName();
                }
                reportDone(jobId, error);
            });
        }

        // The printer silent printing would use, or "" — for a settings
        // screen or a quick check from the browser console.
        @JavascriptInterface
        public String printerName() {
            if (!hasBluetoothPermission()) return "";
            try {
                BluetoothDevice d = findPrinter();
                @SuppressLint("MissingPermission") String n = d == null ? "" : d.getName();
                return n == null ? "" : n;
            } catch (Exception e) {
                return "";
            }
        }
    }
}
