// Detects whether the web app is running inside the Kelete mobile APK
// (Capacitor webview).
//
// window.Capacitor only gets injected on local content. The APK loads the live
// tenant URL in the webview ("thin shell" pattern), so window.Capacitor is
// undefined on that origin. Instead we tag the webview's user-agent via
// capacitor.config.json (android.appendUserAgent = "KeleteMobileApp") and
// check for that token here.
//
// 2026-09-11 — was checking Kelete's token, "KeleteMobileApp", so it was never
// true in the Kelete APK (which has sent "KeleteMobileApp" since the fork).
// Nothing called it until the Login page did.
export function isMobileApp() {
  if (typeof navigator === 'undefined') return false;
  return navigator.userAgent.includes('KeleteMobileApp');
}
