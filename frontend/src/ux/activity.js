// UX-2 — app-wide "working on it" indicator, without touching each screen.
//
// Counts API requests that follow something the user did (click, key, form,
// opening a screen). Background refreshes on timers (sync status, messages,
// approvals…) are not counted, so the indicator doesn't flicker all day.
// The indicator itself only appears if a counted request is still running
// after a short delay (see ActivityBar), so fast answers never flash it.
//
// Pure state + a tiny pub/sub; install(axiosInstance) wires it to axios.
// A request can opt out with config.kSilent = true.

export const INTENT_WINDOW_MS = 1500;

export function createActivity(now = () => Date.now()) {
  let pending = 0;
  let lastIntent = now();          // app start counts as an intent (first screen load)
  const subs = new Set();
  const emit = () => subs.forEach((f) => f(pending));
  return {
    noteIntent() { lastIntent = now(); },
    // Returns a token: true when this request is being counted.
    begin(config = {}) {
      if (config.kSilent) return false;
      if (now() - lastIntent > INTENT_WINDOW_MS) return false;
      pending += 1; emit();
      return true;
    },
    end(token) {
      if (!token) return;
      pending = Math.max(0, pending - 1); emit();
    },
    pending: () => pending,
    subscribe(f) { subs.add(f); return () => subs.delete(f); },
  };
}

export const activity = createActivity();

const installed = new WeakSet();
export function installActivity(axiosInstance, store = activity) {
  if (!axiosInstance || installed.has(axiosInstance)) return;
  installed.add(axiosInstance);
  axiosInstance.interceptors.request.use((config) => {
    config.__kToken = store.begin(config);
    return config;
  });
  axiosInstance.interceptors.response.use(
    (res) => { store.end(res && res.config && res.config.__kToken); return res; },
    (err) => { store.end(err && err.config && err.config.__kToken); return Promise.reject(err); },
  );
}

let listening = false;
export function listenForIntent(store = activity) {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  const note = () => store.noteIntent();
  for (const ev of ['pointerdown', 'keydown', 'submit', 'popstate']) window.addEventListener(ev, note, true);
}
