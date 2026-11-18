/**
 * pushNotifications.js — the phone side of Firebase push.
 *
 * 2026-09-18. In the APK the page could only ever chime while someone was
 * looking at it: the chime is Web Audio inside the page, and Android's WebView
 * does not implement the web Notification API, so nothing reached the tray and
 * nothing at all happened once the app was closed. This registers the handset
 * with Firebase so the backend can wake it — see backend/services/push.js.
 *
 * Everything here is a no-op in a browser. The plugin only exists inside the
 * APK, so a web till runs the same build and simply does nothing.
 */
import { registerPushToken, unregisterPushToken } from '../services/api';

// The Android notification channels. A channel decides the SOUND and whether
// it may interrupt, and — this is the part that bites — Android freezes those
// settings the first time a channel is created. Changing a channel's sound
// later means a NEW channel id, which is why these carry a version.
const CHANNELS = [
  {
    id: 'kelete-approvals-v1',
    name: 'Approvals and money',
    description: 'Expense approvals, and deposits confirmed or rejected.',
    importance: 5,          // makes it pop up on screen, with sound
    visibility: 1,
    vibration: true,
  },
  {
    id: 'kelete-alerts-v1',
    name: 'Stock and deliveries',
    description: 'Stock on the way, and deliveries waiting to be received.',
    importance: 4,
    visibility: 1,
    vibration: true,
  },
];

let started = false;

// The plugin is only in the APK. Loading it dynamically keeps the web build
// working, and keeps it out of the web bundle entirely.
async function plugin() {
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor?.isNativePlatform?.()) return null;
    const mod = await import('@capacitor/push-notifications');
    return mod.PushNotifications || null;
  } catch (_) {
    return null;                 // web build, or the plugin is not installed
  }
}

/**
 * Called after login. Asks for permission the first time, registers with
 * Firebase, and hands the token to the server.
 *
 * `onOpen({ type, ... })` is called when someone taps a notification, with
 * whatever `data` the backend sent, so the app can open the right page.
 */
export async function initPushNotifications(onOpen) {
  if (started) return;
  const Push = await plugin();
  if (!Push) return;             // browser — nothing to do
  started = true;

  try {
    // Android 13+ asks; older versions grant it at install.
    let perm = await Push.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
      perm = await Push.requestPermissions();
    }
    if (perm.receive !== 'granted') {
      console.log('[push] permission not granted — no notifications on this phone');
      started = false;
      return;
    }

    for (const ch of CHANNELS) {
      try { await Push.createChannel(ch); } catch (_) { /* already exists */ }
    }

    Push.addListener('registration', (t) => {
      registerPushToken(t.value).catch(() => {});   // told again on every login
    });
    Push.addListener('registrationError', (e) => {
      console.warn('[push] registration failed:', e?.error || e);
    });
    // Tapping a notification, whether the app was open, in the background, or
    // closed. The backend's `data` rides along and says where to go.
    Push.addListener('pushNotificationActionPerformed', (action) => {
      try { onOpen && onOpen(action?.notification?.data || {}); } catch (_) {}
    });

    await Push.register();
  } catch (e) {
    console.warn('[push] could not start:', e?.message || e);
    started = false;
  }
}

// On logout: this handset must stop getting the next cashier's alerts.
export async function stopPushNotifications() {
  const Push = await plugin();
  started = false;
  if (!Push) return;
  try {
    const t = await Push.getDeliveredNotifications().catch(() => null);
    if (t) await Push.removeAllDeliveredNotifications().catch(() => {});
  } catch (_) {}
  try { await unregisterPushToken(); } catch (_) {}
}

// Where a tapped notification goes. Kept here, next to the types the backend
// sends, so adding an event means one line in one file.
export function pathForPush(data) {
  switch (String(data?.type || '')) {
    case 'expense-request':   return '/accounting/payment-vouchers?tab=approvals';
    case 'expense-decision':  return '/accounting/payment-vouchers';
    case 'deposit-confirmed':
    case 'deposit-rejected':  return '/accounting/cash-book?tab=deposits';
    case 'transfer-incoming': return '/stock/transfers?tab=incoming';
    case 'incoming-stock':    return '/stock/incoming';
    default:                  return null;
  }
}
