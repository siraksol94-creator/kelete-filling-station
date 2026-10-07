import React, { useState, useEffect, useRef } from 'react';
import pkg from '../../package.json';
const { version } = pkg;
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { useCurrency } from '../context/CurrencyContext';
import { isHqHost, getHqBranch, getNotificationBadges, getIncomingNotice, getChatUnread, getExpenseRequests, cancelExpenseRequest, getHqExpensePendingCount, searchNotes } from '../services/api';
import SyncStatus from './SyncStatus';
import { getDiscountRequestsPendingCount } from '../services/api';
import { matchTokens } from '../utils/tokenSearch';
import keleteLogo from '../assets/kelete-logo.png';
import { isTerminal58 } from '../utils/receipt58';
import { FiGrid, FiShoppingCart, FiPackage, FiFileText, FiDollarSign, FiUsers, FiSettings,
         FiChevronDown, FiLogOut, FiSearch, FiBell, FiMenu, FiDownload, FiUpload, FiList,
         FiBook, FiCreditCard, FiClipboard, FiUser, FiUserPlus, FiSliders, FiGlobe, FiCloud, FiTool,
         FiCornerDownLeft, FiCornerUpLeft, FiTrendingUp, FiTrendingDown, FiAlertTriangle, FiCheckCircle, FiTag, FiRefreshCw, FiTruck, FiInbox, FiSend, FiDownloadCloud, FiHardDrive, FiLock, FiMessageSquare } from 'react-icons/fi';
import ChangePasswordModal from './ChangePasswordModal';

const LANGUAGES = [
  { code: 'en', label: 'English', flag: 'ðŸ‡¬ðŸ‡§' },
  { code: 'am', label: 'Amharic', flag: 'ðŸ‡ªðŸ‡¹' },
  { code: 'ti', label: 'Tigrinya', flag: 'ðŸ‡ªðŸ‡·' },
  { code: 'fr', label: 'French',  flag: 'ðŸ‡«ðŸ‡·' },
  { code: 'ar', label: 'Arabic',  flag: 'ðŸ‡¸ðŸ‡¦' },
  { code: 'sw', label: 'Swahili', flag: 'ðŸ‡°ðŸ‡ª' },
];

const Layout = () => {
  const { user, logout, hasPageAccess, isAllAccess } = useAuth();
  const [showChangePassword, setShowChangePassword] = useState(false);

  // POS-only: user has POS access but no broader management page access
  const isPOSOnly = user && !isAllAccess() &&
    hasPageAccess('POS') &&
    !hasPageAccess('Items', 'GRN', 'SIV', 'StockAdjustment', 'StockCount', 'Inventory',
      'CashReceipt', 'PaymentVoucher', 'CashBook', 'FxRates', 'AccountPayables', 'AccountReceivables', 'ProfitReport',
      'Suppliers', 'Customers', 'Sales', 'Reports');
  const { language, changeLanguage, t } = useLanguage();
  // 3-station gate â€” only kassumbalesa1 sees the Cashier sidebar entry.
  const { workflowMode, legacyProcurementEnabled, currencyMode } = useCurrency();
  // v1.7.0: triple-currency mode 'USD+FRA+K' also counts as "dual/multi
  // currency" for sidebar gating â€” same Currency Rates page handles both.
  const isDualCurrency = currencyMode === 'USD+FRA' || currencyMode === 'USD+FRA+K';
  // HQ branch selector â€” only when the React app is served from the bare
  // keletezm.com host. On real per-branch subdomains hq=false and the
  // dropdown stays hidden (the host already pins the tenant).
  const hq = isHqHost();
  // v1.3.2 â€” branches are pure POS / receive points. Several sidebar
  // entries (procurement, supplier mgmt, supplier AP, equity / loans /
  // shareholders, etc.) are HQ-only. When `branchOnly` is true we hide
  // them from the sidebar regardless of permission so branch staff can't
  // stumble into the legacy single-tenant flows. HQ admins still see
  // everything because hq=true sets branchOnly=false. Direct URL access
  // is not blocked here â€” perms already gate routes; this just keeps the
  // nav focused on what branches actually do.
  const branchOnly = !hq;
  // v1.3.9 â€” legacy GRN + Suppliers + AP entries are shown at HQ always,
  // or on a branch only when the operator flipped the per-branch toggle
  // in System Settings (used to seed openings at launch). Must be declared
  // AFTER branchOnly â€” referencing it earlier was the v1.3.9 TDZ crash
  // that blanked Layout.js for every branch.
  const showLegacyProcurement = !branchOnly || legacyProcurementEnabled;
  // v1.13.29 â€” hqBranches + switchHqBranch removed with the "Pick a branch"
  // dropdown. currentHqBranch stays: existing HQ users who previously
  // clicked into a branch have that slug persisted in localStorage, and
  // the badge poller below still respects it. To operate against a
  // different branch, visit its subdomain directly.
  const currentHqBranch = getHqBranch();
  // Sidebar badge counts for the current branch (Cashier / Dispatch
  // pending + Incoming Stock from HQ + Incoming Inter-Branch Transfers).
  // Derives slug the same way StockTransfers / IncomingStock do: HQ
  // X-Branch when on bare keletezm.com, else host's first subdomain.
  const [badges, setBadges] = useState({ cashier_pending: 0, dispatch_pending: 0, incoming_stock: 0, incoming_transfers: 0, hq_pending_grn: 0, hq_pending_damages: 0 });
  useEffect(() => {
    let cancelled = false;
    const slug = hq ? (currentHqBranch || '') : (typeof window !== 'undefined' ? window.location.hostname.split('.')[0] : '');
    // 2026-09-19 â€” HQ normally has NO branch picked, which made slug empty and
    // abandoned this fetch before it asked. So hq_pending_grn and
    // hq_pending_damages sat at 0 forever and their badges never drew â€” the
    // Generate GRN badge had never once been seen. The server returns the HQ
    // counts whatever the slug is (it says so); only the asking was missing.
    if (!user || (!slug && !hq)) return undefined;
    const tick = async () => {
      try {
        const r = await getNotificationBadges(slug);
        if (cancelled) return;
        const next = r.data || badges;
        setBadges(next);
      } catch (_) { /* keep last value on transient errors */ }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  // eslint-disable-next-line
  }, [hq, currentHqBranch, user?.id]);

  // 2026-09-15 â€” incoming stock / inter-branch transfer notice (depots only).
  // Every 10s: what is waiting to be received. Anything not yet announced â€”
  // including what is already waiting when the app opens â€” brings up the big
  // dark notice. While the cashier is mid-sale (POS reports it through
  // window.__rsPosBusy) the big notice waits and the small corner card shows
  // instead. "Later" closes the big notice and leaves the corner card up until
  // everything is received; its Ã— hides it until the next arrival or app open.
  const [incoming, setIncoming] = useState({ stock: [], transfers: [], grns: [] });
  const [noticePhase, setNoticePhase] = useState('none'); // 'none' | 'big' | 'later'
  const [cornerClosed, setCornerClosed] = useState(false);
  const [posBusy, setPosBusy] = useState(() => !!window.__rsPosBusy);
  const incomingSeenRef = useRef(new Set());
  useEffect(() => {
    const onBusy = () => setPosBusy(!!window.__rsPosBusy);
    window.addEventListener('pos:busy', onBusy);
    return () => window.removeEventListener('pos:busy', onBusy);
  }, []);

  // 2026-09-18 â€” register this phone with Firebase once someone is logged in,
  // so the backend can wake it even with the app closed. Does nothing in a
  // browser: the plugin only exists inside the APK. Tapping a notification
  // lands on the page it is about.
  useEffect(() => {
    if (!user) return;
    import('../utils/pushNotifications')
      .then(m => m.initPushNotifications((data) => {
        const path = m.pathForPush(data);
        if (path) navigate(path);
      }))
      .catch(() => {});
  // eslint-disable-next-line
  }, [user?.id]);

  // 2026-09-18 â€” the corner card sits bottom-right, which on POS is exactly
  // where Pay is, so the cashier can drag it out of the way. Where they put it
  // is kept per till (localStorage), not per user: it is about that screen.
  // null = the default bottom-right corner.
  const CARD_POS_KEY = 'rs.incomingCard.pos';
  const [cardPos, setCardPos] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(CARD_POS_KEY) || 'null');
      return raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) ? raw : null;
    } catch (_) { return null; }
  });
  const cardRef = useRef(null);
  const dragRef = useRef(null);      // the drag in progress
  const movedRef = useRef(false);    // was this a drag, or just a tap?
  const lastPosRef = useRef(null);   // where it ended up, for saving

  // Keep it on screen: a card parked at the right edge of a wide monitor must
  // not end up off-screen on a laptop, and the same after a window resize.
  const clampToScreen = (p) => {
    const box = cardRef.current?.getBoundingClientRect();
    const w = box?.width || 330;
    const h = box?.height || 80;
    return {
      x: Math.min(Math.max(8, p.x), Math.max(8, window.innerWidth - w - 8)),
      y: Math.min(Math.max(8, p.y), Math.max(8, window.innerHeight - h - 8)),
    };
  };
  useEffect(() => {
    if (!cardPos) return undefined;
    const onResize = () => setCardPos((p) => (p ? clampToScreen(p) : p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  // eslint-disable-next-line
  }, [cardPos]);

  const startCardDrag = (e) => {
    // The Ã— and the buttons inside keep their own jobs.
    if (e.target.closest('button')) return;
    const box = cardRef.current?.getBoundingClientRect();
    if (!box) return;
    movedRef.current = false;
    dragRef.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
  };
  const onCardDrag = (e) => {
    if (!dragRef.current) return;
    const next = clampToScreen({ x: e.clientX - dragRef.current.dx, y: e.clientY - dragRef.current.dy });
    // A few pixels of wobble while tapping is not a drag.
    if (!movedRef.current) {
      const box = cardRef.current.getBoundingClientRect();
      if (Math.abs(next.x - box.left) + Math.abs(next.y - box.top) < 4) return;
      movedRef.current = true;
    }
    lastPosRef.current = next;     // what to save â€” state lands a render later
    setCardPos(next);
  };
  const endCardDrag = (e) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
    if (movedRef.current && lastPosRef.current) {
      try { localStorage.setItem(CARD_POS_KEY, JSON.stringify(lastPosRef.current)); } catch (_) {}
    }
  };
  useEffect(() => {
    const slug = typeof window !== 'undefined' ? window.location.hostname.split('.')[0] : '';
    // 2026-09-19 â€” HQ gets the same notice for the opposite direction: a depot
    // has confirmed a delivery and it is waiting in Generate GRN. Until that
    // is done there is no GRN and no payable, so the supplier's invoice has
    // nothing to match against. HQ was skipped here entirely before.
    if (!user || (!hq && !slug)) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await getIncomingNotice(hq ? 'hq' : slug);
        if (cancelled) return;
        const stock = Array.isArray(r.data?.stock) ? r.data.stock : [];
        const transfers = Array.isArray(r.data?.transfers) ? r.data.transfers : [];
        const grns = Array.isArray(r.data?.grns) ? r.data.grns : [];
        setIncoming({ stock, transfers, grns });
        if (!hq) {
          setBadges((b) => ({ ...b, incoming_stock: stock.reduce((s, p) => s + (Number(p.lines) || 0), 0), incoming_transfers: transfers.length }));
        }
        const keys = [...stock.map((p) => `p${p.id}`), ...transfers.map((t) => `t${t.id}`), ...grns.map((g) => `g${g.id}-${g.slug}`)];
        if (!keys.length) { setNoticePhase('none'); incomingSeenRef.current = new Set(); return; }
        const fresh = keys.filter((k) => !incomingSeenRef.current.has(k));
        incomingSeenRef.current = new Set(keys);
        if (!fresh.length) return;
        setNoticePhase('big');
        setCornerClosed(false);
        playChatSound();
        if (document.hidden && 'Notification' in window && window.Notification.permission === 'granted') {
          try {
            const body = [
              stock.length && `${stock.length} delivery(ies) from HQ`,
              transfers.length && `${transfers.length} transfer(s)`,
              grns.length && `${grns.length} delivery(ies) to turn into a GRN`,
            ].filter(Boolean).join(' Â· ');
            const note = new window.Notification(
              hq ? 'Deliveries waiting for a GRN' : 'Stock waiting to be received',
              { body, tag: 'incoming-stock' });
            note.onclick = () => { window.focus(); note.close(); };
          } catch (_) { /* notifications unavailable here */ }
        }
      } catch (_) { /* keep the last list on transient errors */ }
    };
    tick();
    const id = setInterval(tick, 10_000);
    window.addEventListener('stock:refresh', tick);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener('stock:refresh', tick); };
  // eslint-disable-next-line
  }, [hq, user?.id]);

  // 2026-09-18 â€” an expense over this depot's daily limit, waiting for HQ.
  // Depots see a red card while it waits, green once HQ approves (tap it to
  // save the voucher, already filled in) and the reason if it is rejected.
  // HQ sees how many are waiting beside Payment Voucher in the sidebar.
  const [expenseReq, setExpenseReq] = useState(null);
  const [hqExpensePending, setHqExpensePending] = useState(0);
  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        if (hq) {
          const r = await getHqExpensePendingCount();
          if (!cancelled) setHqExpensePending(Number(r.data?.count) || 0);
        } else {
          const r = await getExpenseRequests({ status: 'open' });
          if (cancelled) return;
          const rows = Array.isArray(r.data?.rows) ? r.data.rows : [];
          setExpenseReq(rows.find(x => x.status === 'approved')
            || rows.find(x => x.status === 'pending')
            || rows.find(x => x.status === 'rejected')
            || null);
        }
      } catch (_) { /* keep the last state */ }
    };
    tick();
    const id = setInterval(tick, 20_000);
    window.addEventListener('pv:refresh', tick);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener('pv:refresh', tick); };
  // eslint-disable-next-line
  }, [hq, user?.id]);

  // 2026-09-14 â€” Messages notifications. Every 12s: the unread count (sidebar
  // badge, top-bar bell, "(3)" in the tab title) and the newest unread message.
  // A NEW one pops a pop-up with a short sound â€” except on the Messages page,
  // which shows it already â€” and, while the tab is in the background, a
  // computer notification if the user allowed them. Refreshes at once when the
  // Messages page marks a conversation read.
  const [chatUnread, setChatUnread] = useState(0);
  const [chatToast, setChatToast] = useState(null);
  const chatSeenRef = useRef(null); // newest message already announced; null until the first check
  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    const baseTitle = document.title.replace(/^\(\d+\+?\)\s*/, '');
    const openConversation = (id) => {
      window.history.pushState({}, '', `/messages?c=${id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    };
    const tick = async () => {
      try {
        const r = await getChatUnread();
        if (cancelled) return;
        const total = Number(r.data?.total) || 0;
        const latest = r.data?.latest || null;
        setChatUnread(total);
        document.title = total ? `(${total > 99 ? '99+' : total}) ${baseTitle}` : baseTitle;
        // The first check only records where we are: messages already waiting
        // when the app opens are shown by the badge, not announced one by one.
        const isNew = !!latest && chatSeenRef.current !== null && latest.id > chatSeenRef.current;
        chatSeenRef.current = Math.max(chatSeenRef.current || 0, latest?.id || 0);
        if (!isNew) return;
        if (window.location.pathname !== '/messages') {
          setChatToast(latest);
          playChatSound();
        }
        if (document.hidden && 'Notification' in window && window.Notification.permission === 'granted') {
          try {
            const n = new window.Notification(`${latest.from} Â· ${latest.group || latest.place}`, {
              body: latest.preview, tag: `chat-${latest.conversation_id}`,
            });
            n.onclick = () => { window.focus(); openConversation(latest.conversation_id); n.close(); };
          } catch (_) { /* notifications unavailable here */ }
        }
      } catch (_) { /* keep the last count */ }
    };
    tick();
    const id = setInterval(tick, 12_000);
    window.addEventListener('chat:refresh', tick);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('chat:refresh', tick);
      document.title = baseTitle;
    };
  // eslint-disable-next-line
  }, [user?.id]);
  useEffect(() => {
    if (!chatToast) return undefined;
    const id = setTimeout(() => setChatToast(null), 7000);
    return () => clearTimeout(id);
  }, [chatToast]);

  const navigate = useNavigate();
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showLangMenu, setShowLangMenu] = useState(false);
  // Bumped by the header Refresh button to remount the current route (via
  // <Outlet key={refreshKey} />) so its useEffects re-run and the page
  // re-fetches data. Same pattern as Butchery POS â€” avoids window.location
  // .reload() which would log the user out and break deep paths on Electron.
  const [refreshKey, setRefreshKey] = useState(0);
  // Pending discount-request count drives the red badge on the Approvals
  // sidebar entry. Admin-only â€” non-admins never poll this endpoint.
  const [pendingDiscountCount, setPendingDiscountCount] = useState(0);
  // v1.8.37 â€” in-app passcode modal to gate System Settings + Cloud Sync.
  // Replaces window.prompt() which Electron silently blocks (no dialog
  // shown, click did nothing). State carries the navigation target +
  // entered value + last error.
  const [passcodeGate, setPasscodeGate] = useState(null); // { path, label, value, error }
  const PASSCODE = '108120';
  const openPasscodeGate = (path, label) => setPasscodeGate({ path, label, value: '', error: '' });
  const submitPasscode = () => {
    if (!passcodeGate) return;
    if (passcodeGate.value !== PASSCODE) {
      setPasscodeGate(prev => ({ ...prev, error: 'Incorrect passcode.', value: '' }));
      return;
    }
    const path = passcodeGate.path;
    setPasscodeGate(null);
    navigate(path);
  };
  useEffect(() => {
    if (user?.role !== 'Administrator') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await getDiscountRequestsPendingCount();
        if (!cancelled) setPendingDiscountCount(res.data?.count || 0);
      } catch (_) { /* keep last value on transient failure */ }
    };
    tick();
    const id = setInterval(tick, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, [user?.role]);

  const isPhoneViewport = () => typeof window !== 'undefined' && window.innerWidth <= 768;

  // Auto-close mobile sidebar on route change.
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  // Auto-label <td> cells so the mobile card layout can show
  // "Date: May 20, 2026" etc. without every page hand-annotating each cell.
  // A MutationObserver watches for new tables (page navigations, filter changes)
  // and labels each cell from its column header. Manual data-label attrs win.
  useEffect(() => {
    const labelTables = () => {
      // 2026-09-12 â€” table.phone-cards too: the phone-only card layout.
      // 2026-09-13 â€” and table.purchase-lines, the New HQ Purchase item lines.
      document.querySelectorAll('table.data-table, table.phone-cards, table.purchase-lines, .modal table').forEach(table => {
        // 2026-09-12 â€” sortable headers carry a â–²/â–¼ glyph; it is not part of
        // the column's name, so it stays out of the card label.
        const headers = Array.from(table.querySelectorAll('thead > tr > th'))
          .map(th => th.textContent.replace(/[â–²â–¼â†‘â†“â‡…]/g, '').trim());
        if (headers.length === 0) return;
        table.querySelectorAll('tbody > tr').forEach(tr => {
          let i = 0;
          for (const td of tr.children) {
            if (td.tagName === 'TD' && !td.hasAttribute('data-label') && headers[i]) {
              td.setAttribute('data-label', headers[i]);
            }
            i++;
          }
        });
      });
    };
    labelTables();
    const obs = new MutationObserver(() => labelTables());
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  const handleLangSelect = (code) => {
    changeLanguage(code);
    setShowLangMenu(false);
  };

  const currentLang = LANGUAGES.find(l => l.code === language) || LANGUAGES[0];
  const langRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (langRef.current && !langRef.current.contains(e.target)) setShowLangMenu(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const getActiveGroup = (pathname) => {
    if (pathname.startsWith('/pos')) return 'pos';
    if (pathname.startsWith('/stock')) return 'stock';
    if (pathname.startsWith('/accounting')) return 'accounting';
    if (pathname.startsWith('/suppliers-customers')) return 'suppliersCustomers';
    if (pathname.startsWith('/settings')) return 'settings';
    if (pathname.startsWith('/fuel')) return 'fuel';
    return null;
  };

  const [openGroups, setOpenGroups] = useState(() => {
    const active = getActiveGroup(window.location.pathname);
    return { pos: active === 'pos', stock: active === 'stock', accounting: active === 'accounting', suppliersCustomers: active === 'suppliersCustomers', settings: active === 'settings', fuel: active === 'fuel' };
  });

  const toggleGroup = (group) => {
    setOpenGroups(prev => {
      const isOpen = prev[group];
      const allClosed = Object.keys(prev).reduce((acc, key) => ({ ...acc, [key]: false }), {});
      return { ...allClosed, [group]: !isOpen };
    });
  };

  const isActive = (path) => location.pathname === path;
  const isGroupActive = (paths) => paths.some(p => location.pathname.startsWith(p));

  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  // Global search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) setSearchOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // v1.10.8 â€” kill accidental value nudges on every <input type="number">.
  // Wheel: blur the input so scrolling scrolls the page instead of changing
  // the value. Arrow â†‘/â†“: swallow the keypress. Typing/paste/tab untouched.
  useEffect(() => {
    const stopWheel = (e) => {
      if (e.target && e.target.type === 'number' && document.activeElement === e.target) {
        e.target.blur();
      }
    };
    const stopArrows = (e) => {
      if (e.target && e.target.type === 'number' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
      }
    };
    document.addEventListener('wheel', stopWheel, { passive: true });
    document.addEventListener('keydown', stopArrows);
    return () => {
      document.removeEventListener('wheel', stopWheel);
      document.removeEventListener('keydown', stopArrows);
    };
  }, []);

  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); setSearchOpen(false); return; }
    const token = localStorage.getItem('token');
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/products', { headers }).then(r => r.json()).catch(() => []),
      fetch('/api/customers', { headers }).then(r => r.json()).catch(() => []),
      fetch('/api/suppliers', { headers }).then(r => r.json()).catch(() => []),
      // 2026-09-18 â€” and what people wrote ON documents: the same box is
      // called notes, description, comment or reason depending on the form,
      // so the server maps the names (services/noteSources.js) and searches
      // them together. Every hit says which page it belongs to; anything the
      // user may not open is dropped below.
      searchNotes(searchQuery).then(r => r.data?.results || []).catch(() => []),
    ]).then(([products, customers, suppliers, notes]) => {
      const results = [];
      (Array.isArray(products) ? products : products.data || [])
        .filter(p => matchTokens(searchQuery, p.name, p.code, p.barcode))
        .slice(0, 4)
        .forEach(p => results.push({ type: 'Product', label: p.name, sub: `K ${p.selling_price ?? ''}`, path: '/stock/items' }));
      (Array.isArray(customers) ? customers : customers.data || [])
        .filter(c => matchTokens(searchQuery, c.name, c.phone, c.email))
        .slice(0, 3)
        .forEach(c => results.push({ type: 'Customer', label: c.name, sub: c.phone || '', path: '/suppliers-customers/customers' }));
      (Array.isArray(suppliers) ? suppliers : suppliers.data || [])
        .filter(s => matchTokens(searchQuery, s.name, s.phone, s.email))
        .slice(0, 3)
        .forEach(s => results.push({ type: 'Supplier', label: s.name, sub: s.phone || '', path: '/suppliers-customers/suppliers' }));
      // The note itself is the label â€” it is what was searched for â€” with the
      // document's number, date and amount underneath so a hit can be
      // recognised without opening it.
      (Array.isArray(notes) ? notes : [])
        .filter(n => !n.page || hasPageAccess(n.page))
        .slice(0, 6)
        .forEach(n => results.push({
          type: n.type,
          label: n.note,
          sub: [n.number, n.date, n.amount != null ? `K${Number(n.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null]
            .filter(Boolean).join(' Â· '),
          path: n.path,
        }));
      setSearchResults(results);
      setSearchOpen(results.length > 0);
    });
  }, [searchQuery]);

  const handleSearchSelect = (path) => {
    navigate(path);
    setSearchQuery('');
    setSearchOpen(false);
  };

  // 2026-09-18 â€” documents found by their note share one colour: what matters
  // in the list is that the row is a document, not which kind. Anything not
  // named here falls back to that grey-blue.
  const typeColors = { Product: '#2563eb', Customer: '#16a34a', Supplier: '#f59e0b' };
  const typeColor = (t) => typeColors[t] || '#64748b';

  const pageTitle = () => {
    const path = location.pathname;
    const titles = {
      '/dashboard': t('dashboard'), '/pos': t('pos'), '/pos/sales-report': t('salesReport'),
      '/pos/sales-inventory': t('salesInventory'), '/pos/cash-report': t('cashReport'),
      '/pos/sales-bin-card': 'Sales Bin Card',
      '/pos/vat-report': 'VAT Transaction Report',
      '/pos/sales-stock-card': 'Sales Stock Card',
      '/pos/cashier': 'Cashier',
      '/pos/dispatch': 'Dispatch',
      '/hq/overview': 'HQ Overview',
      '/hq/sales-report': 'HQ Sales Report',
      '/hq/route-sales': 'HQ Route Selling',
      '/hq/vat-report': 'HQ VAT Transaction Report',
      '/hq/inventory-report': 'HQ Inventory Report',
      '/hq/cash-position': 'HQ Cash Position',
      '/hq/consolidated-profit': 'HQ Consolidated Profit',
      '/hq/products': 'HQ Products',
      '/hq/purchases': 'HQ Purchases',
      '/hq/confirm-grn': 'Generate GRN',
      '/hq/grn-archive': 'GRN Archive',
      '/hq/variances':   'Transit Variances',
      '/hq/confirm-damages': 'Confirm Damages',
      '/hq/suppliers': 'HQ Suppliers',
      '/stock/incoming': 'Incoming Stock',
      '/stock/items': t('itemDetails'), '/stock/grn': t('grn'), '/stock/siv': t('siv'),
      '/stock/sales-damages': 'Sales Damages',
      '/stock/inventory': t('inventory'), '/stock/adjustments': t('stockAdjustment'),
      '/stock/categories': 'Categories and Units', '/stock/expiry-report': 'Expiry Report', '/stock/stock-count': 'Stock Count',
      '/stock/transfers': 'Inter-Branch Transfers',
      '/accounting/cash-receipts': t('cashReceipt'), '/accounting/payment-vouchers': t('paymentVoucher'),
      '/accounting/cash-book': t('cashBook'), '/accounting/account-payables': t('accountPayables'),
      '/accounting/account-receivables': 'Account Receivables',
      '/accounting/credit-notes': 'Credit Notes',
      '/accounting/capital-account': 'Capital Account',
      '/accounting/dividend-account': 'Dividend Account',
      '/accounting/shareholders': 'Shareholders',
      '/accounting/loans': 'Loan Account',
      '/suppliers-customers/suppliers': t('suppliers'), '/suppliers-customers/customers': t('customers'),
      '/settings/profile': t('profile'), '/settings/system': 'System Settings', '/settings/users': t('users'), '/settings/zra': 'ZRA Smart Invoice', '/settings/backups': 'Backups',
      '/hq/zra-purchases': 'HQ ZRA Purchase Queue',
      '/hq/zra-imports': 'HQ ZRA Import Queue',
      '/messages': 'Messages',
    };
    return titles[path] || t('dashboard');
  };

  const initials = user ? `${user.firstName?.[0] || ''}${user.lastName?.[0] || ''}` : 'JD';

  return (
    <div className="app-layout">
      {/* Backdrop: tap outside to close the mobile sidebar. */}
      {mobileOpen && <div className="sidebar-backdrop" onClick={() => setMobileOpen(false)} />}
      {/* Sidebar */}
      {/* 2026-09-11 â€” the POS small terminal gets the logo's navy menu; PCs
          keep the slate one. */}
      <div className={`sidebar ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}${isTerminal58() ? ' terminal-navy' : ''}`}>
        <div className="sidebar-header">
          <img className="sidebar-logo" src={keleteLogo} alt="Red Sea Distribution" />
          {!collapsed && (
            <div className="sidebar-brand">
              <h2>Kelete{hq ? ' HQ' : ''}</h2>
              <p>{hq ? 'Head Office' : 'Management System'}</p>
            </div>
          )}
        </div>

        {/* v1.13.29 â€” HQ "Pick a branch" dropdown removed. HQ users
            reach a branch by visiting its subdomain directly
            (buseko.keletezm.com, etc.) â€” cleaner separation. */}

        <nav className="sidebar-nav">
          {/* HQ Overview â€” only when serving from bare keletezm.com.
              Sits above Dashboard because it's the natural landing page
              for an HQ operator (cross-branch snapshot, jump-to-branch). */}
          {hq && hasPageAccess('HQOverview') && (
            <div className={`nav-item ${isActive('/hq/overview') ? 'active' : ''}`} onClick={() => navigate('/hq/overview')}>
              <FiGlobe className="nav-icon" />
              {!collapsed && <span>HQ Overview</span>}
            </div>
          )}
          {/* v1.9.25 â€” flat HQ items relocated into the existing groups
              (Sales / Store / Accounting / Suppliers & Customers) so the
              sidebar reads the same on HQ and branch. HQ Overview stays
              flat above because it's the landing dashboard, not a group
              child. HQ Products kept hidden (replaced by Store â†’ Item
              Details that pushes to branches automatically). */}

          {/* Dashboard â€” only for All access users */}
          {isAllAccess() && (
            <div className={`nav-item ${isActive('/dashboard') ? 'active' : ''}`} onClick={() => navigate('/dashboard')}>
              <FiGrid className="nav-icon" />
              {!collapsed && <span>{t('dashboard')}</span>}
            </div>
          )}

          {/* 2026-09-14 â€” Messages: in-app chat for every signed-in user. */}
          <div className={`nav-item ${isActive('/messages') ? 'active' : ''}`} onClick={() => navigate('/messages')}>
            <FiMessageSquare className="nav-icon" />
            {!collapsed && <span>Messages</span>}
            {!collapsed && chatUnread > 0 && <SidebarBadge n={chatUnread} />}
          </div>

          {/* Kelete Fuel Station - all users (permissions can be layered later) */}
          {collapsed ? (
            <div className={`nav-item ${isGroupActive(['/fuel']) ? 'active' : ''}`} onClick={() => navigate('/fuel/pos')}>
              <FiDownloadCloud className="nav-icon" />
            </div>
          ) : (
            <>
              <div className={`nav-group-header ${isGroupActive(['/fuel']) ? 'active' : ''}`} onClick={() => toggleGroup('fuel')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiDownloadCloud className="nav-icon" />
                  <span>Fuel Station</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.fuel ? 'open' : ''}`} />
              </div>
              {openGroups.fuel && (
                <div className="nav-children">
                  <div className={`nav-item ${isActive('/fuel/pos') ? 'active' : ''}`} onClick={() => navigate('/fuel/pos')}>
                    <FiDollarSign className="nav-icon" /> <span>Fuel POS</span>
                  </div>
                  <div className={`nav-item ${isActive('/fuel/shifts') ? 'active' : ''}`} onClick={() => navigate('/fuel/shifts')}>
                    <FiClipboard className="nav-icon" /> <span>Attendant Shifts</span>
                  </div>
                  <div className={`nav-item ${isActive('/fuel/deliveries') ? 'active' : ''}`} onClick={() => navigate('/fuel/deliveries')}>
                    <FiDownload className="nav-icon" /> <span>Fuel Deliveries</span>
                  </div>
                  <div className={`nav-item ${isActive('/fuel/tanks') ? 'active' : ''}`} onClick={() => navigate('/fuel/tanks')}>
                    <FiHardDrive className="nav-icon" /> <span>Tanks</span>
                  </div>
                  <div className={`nav-item ${isActive('/fuel/pumps') ? 'active' : ''}`} onClick={() => navigate('/fuel/pumps')}>
                    <FiSliders className="nav-icon" /> <span>Pumps &amp; Nozzles</span>
                  </div>
                  <div className={`nav-item ${isActive('/fuel/grades') ? 'active' : ''}`} onClick={() => navigate('/fuel/grades')}>
                    <FiTag className="nav-icon" /> <span>Fuel Grades</span>
                  </div>
                  <div className={`nav-item ${isActive('/fuel/fleet') ? 'active' : ''}`} onClick={() => navigate('/fuel/fleet')}>
                    <FiTruck className="nav-icon" /> <span>Fleet Customers</span>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Sales Group.
              v1.9.25 â€” Group now renders on HQ too so HQ Sales Report can
              live inside it instead of as a flat top-level entry. The
              existing branch-only children stay gated with !hq; the HQ
              Sales Report child is gated with hq. */}
          {((hq && hasPageAccess('HQSalesReport')) || (!hq && hasPageAccess('POS', 'Cashier', 'Dispatch', 'SalesReport', 'SalesInventory', 'CashReport', 'SalesBinCard', 'VATReport', 'SalesStockCard'))) && (collapsed ? (
            <div className={`nav-item ${isGroupActive(['/pos', '/hq/sales-report', '/hq/route-sales', '/hq/vat-report']) ? 'active' : ''}`} onClick={() => navigate(hq ? '/hq/sales-report' : '/pos')}>
              <FiShoppingCart className="nav-icon" />
            </div>
          ) : (
            <>
              <div className={`nav-group-header ${isGroupActive(['/pos', '/hq/sales-report', '/hq/route-sales', '/hq/vat-report']) ? 'active' : ''}`} onClick={() => toggleGroup('pos')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiShoppingCart className="nav-icon" />
                  <span>{t('sales')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.pos ? 'open' : ''}`} />
              </div>
              {openGroups.pos && (
                <div className="nav-children">
                  {/* v1.9.25 â€” HQ Sales Report sits inside the Sales group
                      (HQ-only). Branch never sees this; HQ never sees the
                      branch /pos/sales-report below. */}
                  {hq && hasPageAccess('HQSalesReport') && (
                    <div className={`nav-item ${isActive('/hq/sales-report') ? 'active' : ''}`} onClick={() => navigate('/hq/sales-report')}>
                      <FiFileText className="nav-icon" /> <span>HQ Sales Report</span>
                    </div>
                  )}
                  {/* 2026-09-15 â€” route sellers' sales per depot; same permission as HQ Sales Report. */}
                  {hq && hasPageAccess('HQSalesReport') && (
                    <div className={`nav-item ${isActive('/hq/route-sales') ? 'active' : ''}`} onClick={() => navigate('/hq/route-sales')}>
                      <FiTruck className="nav-icon" /> <span>HQ Route Selling</span>
                    </div>
                  )}
                  {/* 2026-09-12 â€” every depot's VAT Transaction Report in one. */}
                  {hq && hasPageAccess('HQVatReport') && (
                    <div className={`nav-item ${isActive('/hq/vat-report') ? 'active' : ''}`} onClick={() => navigate('/hq/vat-report')}>
                      <FiFileText className="nav-icon" /> <span>HQ VAT Report</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('POS') && (
                    <div className={`nav-item ${isActive('/pos') ? 'active' : ''}`} onClick={() => navigate('/pos')}>
                      <FiShoppingCart className="nav-icon" /> <span>{t('pos')}</span>
                    </div>
                  )}
                  {/* v1.9.25 â€” all the branch-side Sales children gate on
                      !hq so HQ only sees HQ Sales Report above. */}
                  {!hq && (workflowMode === 'three_station' || workflowMode === 'two_station') && hasPageAccess('Cashier') && (
                    <div className={`nav-item ${isActive('/pos/cashier') ? 'active' : ''}`} onClick={() => navigate('/pos/cashier')}>
                      <FiCreditCard className="nav-icon" /> <span>Cashier</span>
                      {badges.cashier_pending > 0 && <SidebarBadge n={badges.cashier_pending} />}
                    </div>
                  )}
                  {!hq && (workflowMode === 'three_station' || workflowMode === 'pos_dispatch') && hasPageAccess('Dispatch') && (
                    <div className={`nav-item ${isActive('/pos/dispatch') ? 'active' : ''}`} onClick={() => navigate('/pos/dispatch')}>
                      <FiPackage className="nav-icon" /> <span>Dispatch</span>
                      {badges.dispatch_pending > 0 && <SidebarBadge n={badges.dispatch_pending} />}
                    </div>
                  )}
                  {!hq && hasPageAccess('SalesReport') && (
                    <div className={`nav-item ${isActive('/pos/sales-report') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-report')}>
                      <FiFileText className="nav-icon" /> <span>{t('salesReport')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('SalesInventory') && (
                    <div className={`nav-item ${isActive('/pos/sales-inventory') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-inventory')}>
                      <FiList className="nav-icon" /> <span>{t('salesInventory')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('CashReport') && (
                    <div className={`nav-item ${isActive('/pos/cash-report') ? 'active' : ''}`} onClick={() => navigate('/pos/cash-report')}>
                      <FiDollarSign className="nav-icon" /> <span>{t('cashReport')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('SalesBinCard') && (
                    <div className={`nav-item ${isActive('/pos/sales-bin-card') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-bin-card')}>
                      <FiBook className="nav-icon" /> <span>Sales Bin Card</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('VATReport') && (
                    <div className={`nav-item ${isActive('/pos/vat-report') ? 'active' : ''}`} onClick={() => navigate('/pos/vat-report')}>
                      <FiBook className="nav-icon" /> <span>VAT Transaction Report</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('SalesStockCard') && (
                    <div className={`nav-item ${isActive('/pos/sales-stock-card') ? 'active' : ''}`} onClick={() => navigate('/pos/sales-stock-card')}>
                      <FiList className="nav-icon" /> <span>Sales Stock Card</span>
                    </div>
                  )}
                </div>
              )}
            </>
          ))}

          {/* Stock Group */}
          {!collapsed && hasPageAccess('Items', 'QuickPrice', 'OpeningBalance', 'SalesReturns', 'EmptyVouchers', 'StockReconciliation', 'IncomingStock', 'BranchTransfers', 'Categories', 'HQInventoryReport', 'HQPurchases', 'HQConfirmGrn', 'HQGrnArchive', 'HQVariances', 'HQConfirmDamages') && (
            <>
              <div className={`nav-group-header ${isGroupActive(['/stock']) ? 'active' : ''}`} onClick={() => toggleGroup('stock')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiPackage className="nav-icon" />
                  <span>{t('store')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.stock ? 'open' : ''}`} />
              </div>
              {openGroups.stock && (
                <div className="nav-children">
                  {hasPageAccess('Items') && (
                    <div className={`nav-item ${isActive('/stock/items') ? 'active' : ''}`} onClick={() => navigate('/stock/items')}>
                      <FiFileText className="nav-icon" /> <span>{t('itemDetails')}</span>
                    </div>
                  )}
                  {/* v1.9.25 â€” HQ procurement + stock supervision children
                      relocated from the flat top-level into the Store group.
                      All gated with `hq`; branches never see them. */}
                  {hq && hasPageAccess('HQInventoryReport') && (
                    <div className={`nav-item ${isActive('/hq/inventory-report') ? 'active' : ''}`} onClick={() => navigate('/hq/inventory-report')}>
                      <FiPackage className="nav-icon" /> <span>HQ Inventory</span>
                    </div>
                  )}
                  {hq && hasPageAccess('HQPurchases') && (
                    <div className={`nav-item ${isActive('/hq/purchases') ? 'active' : ''}`} onClick={() => navigate('/hq/purchases')}>
                      <FiClipboard className="nav-icon" /> <span>HQ Purchases</span>
                    </div>
                  )}
                  {hq && user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/hq/zra-purchases') ? 'active' : ''}`} onClick={() => navigate('/hq/zra-purchases')}>
                      <FiDownloadCloud className="nav-icon" /> <span>HQ ZRA Purchase Queue</span>
                    </div>
                  )}
                  {hq && user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/hq/zra-imports') ? 'active' : ''}`} onClick={() => navigate('/hq/zra-imports')}>
                      <FiDownloadCloud className="nav-icon" /> <span>HQ ZRA Import Queue</span>
                    </div>
                  )}
                  {hq && hasPageAccess('HQConfirmGrn') && (
                    <div className={`nav-item ${isActive('/hq/confirm-grn') ? 'active' : ''}`} onClick={() => navigate('/hq/confirm-grn')}>
                      <FiCheckCircle className="nav-icon" /> <span>Generate GRN</span>
                      {badges.hq_pending_grn > 0 && <SidebarBadge n={badges.hq_pending_grn} />}
                    </div>
                  )}
                  {hq && hasPageAccess('HQGrnArchive') && (
                    <div className={`nav-item ${isActive('/hq/grn-archive') ? 'active' : ''}`} onClick={() => navigate('/hq/grn-archive')}>
                      <FiInbox className="nav-icon" /> <span>GRN Archive</span>
                    </div>
                  )}
                  {hq && hasPageAccess('HQVariances') && (
                    <div className={`nav-item ${isActive('/hq/variances') ? 'active' : ''}`} onClick={() => navigate('/hq/variances')}>
                      <FiAlertTriangle className="nav-icon" /> <span>Transit Variances</span>
                    </div>
                  )}
                  {hq && hasPageAccess('HQConfirmDamages') && (
                    <div className={`nav-item ${isActive('/hq/confirm-damages') ? 'active' : ''}`} onClick={() => navigate('/hq/confirm-damages')}>
                      <FiAlertTriangle className="nav-icon" /> <span>Confirm Damages</span>
                      {badges.hq_pending_damages > 0 && <SidebarBadge n={badges.hq_pending_damages} />}
                    </div>
                  )}
                  {/* v1.8.34 â€” Quick Price Update. Bulk selling-price editor.
                      Branch-only (HQ doesn't manage prices) and gated by
                      Items:Edit so cashier-supervisors can adjust prices
                      without full item-edit rights. */}
                  {!hq && hasPageAccess('QuickPrice') && (
                    <div className={`nav-item ${isActive('/stock/quick-price') ? 'active' : ''}`} onClick={() => navigate('/stock/quick-price')}>
                      <FiDollarSign className="nav-icon" /> <span>Quick Price</span>
                    </div>
                  )}
                  {/* v1.13.153 â€” Opening Balance. Branch-only for the same
                      reason Quick Price is: an opening balance states what a
                      BRANCH holds, and HQ carries no sellable stock. */}
                  {!hq && hasPageAccess('OpeningBalance') && (
                    <div className={`nav-item ${isActive('/stock/opening-balance') ? 'active' : ''}`} onClick={() => navigate('/stock/opening-balance')}>
                      <FiDollarSign className="nav-icon" /> <span>Opening Balance</span>
                    </div>
                  )}
                  {/* v1.13.154 â€” Branch Prices. HQ ONLY, the mirror image of
                      Quick Price: that one is branch-side and prices the branch
                      you are in, this one prices a branch you are not in. */}
                  {hq && hasPageAccess('Items') && (
                    <div className={`nav-item ${isActive('/stock/branch-prices') ? 'active' : ''}`} onClick={() => navigate('/stock/branch-prices')}>
                      <FiDollarSign className="nav-icon" /> <span>Branch Prices</span>
                    </div>
                  )}
                  {/* v1.8.9 â€” at HQ, the Store group keeps only Item Details
                      + Categories and Units (HQ-owned data pushed to branches).
                      Everything else here (GRN, SIV, Sales Damages, Bin Card,
                      Stock Count, Incoming Stock, Inter-Branch Transfers â€¦)
                      is branch-side operational. Hidden when !hq is false. */}
                  {/* v1.8.29 â€” GRN hidden on branches TEMPORARILY until
                      HQ purchase-order flow is wired up. Branch will only
                      receive stock via Inter-Branch Transfer or HQ PO. */}
                  {false && !hq && showLegacyProcurement && hasPageAccess('GRN') && (
                    <div className={`nav-item ${isActive('/stock/grn') ? 'active' : ''}`} onClick={() => navigate('/stock/grn')}>
                      <FiDownload className="nav-icon" /> <span>{t('grn')}</span>
                    </div>
                  )}
                  {!hq && !branchOnly && hasPageAccess('SIV') && (
                    <div className={`nav-item ${isActive('/stock/siv') ? 'active' : ''}`} onClick={() => navigate('/stock/siv')}>
                      <FiUpload className="nav-icon" /> <span>{t('siv')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('SalesReturns') && (
                    <div className={`nav-item ${isActive('/stock/sales-damages') ? 'active' : ''}`} onClick={() => navigate('/stock/sales-damages')}>
                      <FiCornerDownLeft className="nav-icon" /> <span>Sales Damages</span>
                    </div>
                  )}
                  {/* v1.13.67 â€” Empty Voucher Controller. Records customer
                      empties returned + issues bearer slips redeemable at POS. */}
                  {!hq && hasPageAccess('EmptyVouchers') && (
                    <div className={`nav-item ${isActive('/store/empty-vouchers') ? 'active' : ''}`} onClick={() => navigate('/store/empty-vouchers')}>
                      <FiPackage className="nav-icon" /> <span>Empty Vouchers</span>
                    </div>
                  )}
                  {/* v1.8.29 â€” Store > Inventory ('Store Stock card')
                      hidden on branches TEMPORARILY until HQ flow stabilises.
                      Re-enable when stock-receipt-via-HQ is fully working. */}
                  {false && !hq && hasPageAccess('Inventory') && (
                    <div className={`nav-item ${isActive('/stock/inventory') ? 'active' : ''}`} onClick={() => navigate('/stock/inventory')}>
                      <FiList className="nav-icon" /> <span>{t('inventory')}</span>
                    </div>
                  )}
                  {/* v1.8.29 â€” Store > Bin Card hidden on branches per
                      user request. Route still works for direct URL access. */}
                  {false && !hq && hasPageAccess('BinCard') && (
                    <div className={`nav-item ${isActive('/stock/bin-card') ? 'active' : ''}`} onClick={() => navigate('/stock/bin-card')}>
                      <FiList className="nav-icon" /> <span>{t('binCard')}</span>
                    </div>
                  )}
                  {/* Stock Adjustment â€” replaced by Stock Reconciliation (Store floor). Hidden but route still works in case of legacy access. */}
                  {false && hasPageAccess('StockAdjustment') && (
                    <div className={`nav-item ${isActive('/stock/adjustments') ? 'active' : ''}`} onClick={() => navigate('/stock/adjustments')}>
                      <FiSliders className="nav-icon" /> <span>{t('stockAdjustment')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('StockReconciliation') && (
                    <div className={`nav-item ${isActive('/stock/reconciliation') ? 'active' : ''}`} onClick={() => navigate('/stock/reconciliation')}>
                      <FiCheckCircle className="nav-icon" /> <span>Stock Reconciliation</span>
                    </div>
                  )}
                  {/* v1.8.29 â€” Categories and Units hidden on branches
                      (HQ-owned data; branch never edits it). Visible at HQ. */}
                  {hq && hasPageAccess('Categories') && (
                    <div className={`nav-item ${isActive('/stock/categories') ? 'active' : ''}`} onClick={() => navigate('/stock/categories')}>
                      <FiList className="nav-icon" /> <span>Categories and Units</span>
                    </div>
                  )}
                  {/* v1.8.29 â€” Expiry Report + Stock Count hidden on
                      branches per user request. Permanent (to be removed). */}
                  {false && !hq && hasPageAccess('ExpiryReport') && (
                    <div className={`nav-item ${isActive('/stock/expiry-report') ? 'active' : ''}`} onClick={() => navigate('/stock/expiry-report')}>
                      <FiAlertTriangle className="nav-icon" /> <span>Expiry Report</span>
                    </div>
                  )}
                  {false && !hq && hasPageAccess('StockCount') && (
                    <div className={`nav-item ${isActive('/stock/stock-count') ? 'active' : ''}`} onClick={() => navigate('/stock/stock-count')}>
                      <FiClipboard className="nav-icon" /> <span>Stock Count</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('IncomingStock') && (
                    <div className={`nav-item ${isActive('/stock/incoming') ? 'active' : ''}`} onClick={() => navigate('/stock/incoming')}>
                      <FiInbox className="nav-icon" /> <span>Incoming Stock</span>
                      {badges.incoming_stock > 0 && <SidebarBadge n={badges.incoming_stock} />}
                    </div>
                  )}
                  {!hq && hasPageAccess('BranchTransfers') && (
                    <div className={`nav-item ${isActive('/stock/transfers') ? 'active' : ''}`} onClick={() => navigate('/stock/transfers')}>
                      <FiTruck className="nav-icon" /> <span>Inter-Branch Transfers</span>
                      {badges.incoming_transfers > 0 && <SidebarBadge n={badges.incoming_transfers} />}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Accounting Group.
              v1.8.9 â€” Originally hidden on HQ (no per-tenant till).
              v1.8.61 â€” HQ now needs Cash Book + HQ Deposits inbox, so the
              group renders on HQ too. Per-item visibility flags below keep
              HQ from seeing branch-only entries (Cash Receipt / PV /
              Receivables / Profit Report). */}
          {!collapsed && hasPageAccess('CashReceipt', 'PaymentVoucher', 'PvTypes', 'CashBook', 'AccountPayables', 'AccountReceivables', 'ProfitReport', 'HQCashPosition', 'HQConsolidatedProfit', 'APConfirm', 'APCheck', 'APApprove', 'APPay', 'APPaid', 'APAll', 'HQDeposits', 'CreditNotes', 'CapitalAccount', 'DividendAccount', 'Shareholders', 'LoanAccount') && (
            <>
              <div className={`nav-group-header ${isGroupActive(['/accounting']) ? 'active' : ''}`} onClick={() => toggleGroup('accounting')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiDollarSign className="nav-icon" />
                  <span>{t('accounting')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.accounting ? 'open' : ''}`} />
              </div>
              {openGroups.accounting && (
                <div className="nav-children">
                  {/* v1.9.25 â€” HQ Cash Position relocated from the flat
                      top-level into the Accounting group. */}
                  {hq && hasPageAccess('HQCashPosition') && (
                    <div className={`nav-item ${isActive('/hq/cash-position') ? 'active' : ''}`} onClick={() => navigate('/hq/cash-position')}>
                      <FiDollarSign className="nav-icon" /> <span>HQ Cash Position</span>
                    </div>
                  )}
                  {/* Cash Receipt / Payment Voucher.
                      v1.8.9 hid these on HQ under the assumption that HQ
                      had no till of its own â€” only Branch â†’ HQ deposits.
                      v1.10.40 â€” HQ does run a real till (its own opening
                      balance, its own Cash Book with USD/FRA/K columns).
                      CR + PV are the two entry points that FEED that
                      Cash Book, so hiding them on HQ made it impossible
                      to record HQ-side inflows (rent, refunds) or
                      outflows (utilities, staff advances). Now shown on
                      HQ too. AR + Profit Report stay branch-only for now
                      (separate scopes; ask when needed). */}
                  {hasPageAccess('CashReceipt') && (
                    <div className={`nav-item ${isActive('/accounting/cash-receipts') ? 'active' : ''}`} onClick={() => navigate('/accounting/cash-receipts')}>
                      <FiBook className="nav-icon" /> <span>{t('cashReceipt')}</span>
                    </div>
                  )}
                  {hasPageAccess('PaymentVoucher') && (
                    <div className={`nav-item ${isActive('/accounting/payment-vouchers') ? 'active' : ''}`} onClick={() => navigate('/accounting/payment-vouchers')}>
                      <FiCreditCard className="nav-icon" /> <span>{t('paymentVoucher')}</span>
                      {hq && hqExpensePending > 0 && <SidebarBadge n={hqExpensePending} />}
                    </div>
                  )}
                  {hasPageAccess('CashBook') && (
                    <div className={`nav-item ${isActive('/accounting/cash-book') ? 'active' : ''}`} onClick={() => navigate('/accounting/cash-book')}>
                      <FiClipboard className="nav-icon" /> <span>{t('cashBook')}</span>
                    </div>
                  )}
                  {/* v1.8.59 â€” Branch â†’ HQ Cash Deposit workflow.
                      Merged INTO Cash Book as a tab (v1.13.11) â€” this
                      standalone menu item is hidden but the route stays
                      wired for direct-URL access. */}
                  {false && hasPageAccess('CashBook') && (
                    <div className={`nav-item ${isActive('/accounting/hq-deposits') ? 'active' : ''}`} onClick={() => navigate('/accounting/hq-deposits')}>
                      <FiSend className="nav-icon" /> <span>HQ Deposits</span>
                    </div>
                  )}
                  {!hq && isDualCurrency && hasPageAccess('FxRates') && (
                    <div className={`nav-item ${isActive('/accounting/fx-rates') ? 'active' : ''}`} onClick={() => navigate('/accounting/fx-rates')}>
                      <FiDollarSign className="nav-icon" /> <span>Currency Rates</span>
                    </div>
                  )}
                  {/* v1.8.29 â€” Account Payables hidden on branches per
                      user request (branch doesn't manage supplier AP). */}
                  {hq && showLegacyProcurement && hasPageAccess('AccountPayables') && (
                    <div className={`nav-item ${isActive('/accounting/account-payables') ? 'active' : ''}`} onClick={() => navigate('/accounting/account-payables')}>
                      <FiFileText className="nav-icon" /> <span>{t('accountPayables')}</span>
                    </div>
                  )}
                  {/* v1.13.30 â€” AP approval queue for the Storeâ†’Accountsâ†’Financeâ†’Cashier chain. */}
                  {hq && hasPageAccess('APConfirm', 'APCheck', 'APApprove', 'APPay') && (
                    <div className={`nav-item ${isActive('/accounting/ap-approvals') ? 'active' : ''}`} onClick={() => navigate('/accounting/ap-approvals')}>
                      <FiCheckCircle className="nav-icon" /> <span>AP Approvals</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('AccountReceivables') && (
                    <div className={`nav-item ${isActive('/accounting/account-receivables') ? 'active' : ''}`} onClick={() => navigate('/accounting/account-receivables')}>
                      <FiFileText className="nav-icon" /> <span>Account Receivables</span>
                    </div>
                  )}
                  {/* 2026-09-04 â€” branches get Credit Notes too. The damage is
                      seen at the depot, so the depot raises the note; HQ still
                      confirms it before it reduces anything, via AP Approvals.
                      Previously HQ-only, which meant a depot had to phone in a
                      breakage for someone else to record. */}
                  {hasPageAccess('CreditNotes') && (
                    <div className={`nav-item ${isActive('/accounting/credit-notes') ? 'active' : ''}`} onClick={() => navigate('/accounting/credit-notes')}>
                      <FiCreditCard className="nav-icon" /> <span>Credit Notes</span>
                    </div>
                  )}
                  {!branchOnly && hasPageAccess('CapitalAccount') && (
                    <div className={`nav-item ${isActive('/accounting/capital-account') ? 'active' : ''}`} onClick={() => navigate('/accounting/capital-account')}>
                      <FiTrendingUp className="nav-icon" /> <span>Capital Account</span>
                    </div>
                  )}
                  {!branchOnly && hasPageAccess('DividendAccount') && (
                    <div className={`nav-item ${isActive('/accounting/dividend-account') ? 'active' : ''}`} onClick={() => navigate('/accounting/dividend-account')}>
                      <FiDollarSign className="nav-icon" /> <span>Dividend Account</span>
                    </div>
                  )}
                  {!branchOnly && hasPageAccess('Shareholders') && (
                    <div className={`nav-item ${isActive('/accounting/shareholders') ? 'active' : ''}`} onClick={() => navigate('/accounting/shareholders')}>
                      <FiUsers className="nav-icon" /> <span>Shareholders</span>
                    </div>
                  )}
                  {!branchOnly && hasPageAccess('LoanAccount') && (
                    <div className={`nav-item ${isActive('/accounting/loans') ? 'active' : ''}`} onClick={() => navigate('/accounting/loans')}>
                      <FiTrendingDown className="nav-icon" /> <span>Loan Account</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('ProfitReport') && (
                    <div className={`nav-item ${isActive('/accounting/profit-report') ? 'active' : ''}`} onClick={() => navigate('/accounting/profit-report')}>
                      <FiTrendingUp className="nav-icon" /> <span>Profit Report</span>
                    </div>
                  )}
                  {/* v1.13.62 â€” HQ Consolidated Profit. Group Net across all
                      branches, all in K (Kelete is K-only), minus HQ overhead.
                      HQ-only. 2026-09-15 â€” gated by the HQConsolidatedProfit permission. */}
                  {hq && hasPageAccess('HQConsolidatedProfit') && (
                    <div className={`nav-item ${isActive('/hq/consolidated-profit') ? 'active' : ''}`} onClick={() => navigate('/hq/consolidated-profit')}>
                      <FiTrendingUp className="nav-icon" /> <span>HQ Consolidated Profit</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Suppliers & Customers Group.
              v1.9.25 â€” Group now renders on HQ too so HQ Suppliers can live
              inside it instead of as a flat top-level entry. Branch shows
              Customers (and legacy Suppliers when enabled); HQ shows HQ
              Suppliers. */}
          {!collapsed && ((hq && hasPageAccess('HQSuppliers')) || (!hq && hasPageAccess('Suppliers', 'Customers'))) && (
            <>
              <div className={`nav-group-header ${isGroupActive(['/suppliers-customers', '/hq/suppliers']) ? 'active' : ''}`} onClick={() => toggleGroup('suppliersCustomers')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiUsers className="nav-icon" />
                  <span>{t('suppliersCustomers')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.suppliersCustomers ? 'open' : ''}`} />
              </div>
              {openGroups.suppliersCustomers && (
                <div className="nav-children">
                  {hq && hasPageAccess('HQSuppliers') && (
                    <div className={`nav-item ${isActive('/hq/suppliers') ? 'active' : ''}`} onClick={() => navigate('/hq/suppliers')}>
                      <FiUsers className="nav-icon" /> <span>HQ Suppliers</span>
                    </div>
                  )}
                  {/* v1.8.29 â€” branch Suppliers hidden per user request
                      (HQ owns the supplier master + AP). */}
                  {false && !hq && showLegacyProcurement && hasPageAccess('Suppliers') && (
                    <div className={`nav-item ${isActive('/suppliers-customers/suppliers') ? 'active' : ''}`} onClick={() => navigate('/suppliers-customers/suppliers')}>
                      <FiUserPlus className="nav-icon" /> <span>{t('suppliers')}</span>
                    </div>
                  )}
                  {!hq && hasPageAccess('Customers') && (
                    <div className={`nav-item ${isActive('/suppliers-customers/customers') ? 'active' : ''}`} onClick={() => navigate('/suppliers-customers/customers')}>
                      <FiUser className="nav-icon" /> <span>{t('customers')}</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* Approvals â€” admin-only top-level entry. Red badge shows the
              count of pending discount requests. Polled every 10s in the
              useEffect above. v1.8.9 â€” hidden at HQ (discount requests
              originate at branches, never at HQ). */}
          {/* 2026-09-03 â€” Approvals hidden: Red Sea does not use the discount
              approval flow, and Red Sea gives no discounts to anyone. Route stays
              wired for direct-URL access. Never had a permission of its own, so
              there is no key to revoke â€” hiding it here is the whole switch. */}
          {false && !hq && !collapsed && user?.role === 'Administrator' && (
            <div
              className={`nav-item ${isActive('/approvals/discounts') ? 'active' : ''}`}
              onClick={() => navigate('/approvals/discounts')}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <FiTag className="nav-icon" /> <span>Approvals</span>
              </div>
              {pendingDiscountCount > 0 && (
                <span style={{ minWidth: 22, height: 22, padding: '0 6px', borderRadius: 11, background: '#dc2626', color: '#fff', fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginRight: 4 }}>
                  {pendingDiscountCount > 99 ? '99+' : pendingDiscountCount}
                </span>
              )}
            </div>
          )}

          {/* Settings Group â€” All Access users only */}
          {!collapsed && isAllAccess() && (
            <>
              <div className={`nav-group-header ${isGroupActive(['/settings']) ? 'active' : ''}`} onClick={() => toggleGroup('settings')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <FiSettings className="nav-icon" />
                  <span>{t('settings')}</span>
                </div>
                <FiChevronDown className={`chevron ${openGroups.settings ? 'open' : ''}`} />
              </div>
              {openGroups.settings && (
                <div className="nav-children">
                  <div className={`nav-item ${isActive('/settings/profile') ? 'active' : ''}`} onClick={() => navigate('/settings/profile')}>
                    <FiUser className="nav-icon" /> <span>{t('profile')}</span>
                  </div>
                  {/* v1.8.29 + v1.8.37 â€” passcode gate via in-app modal
                      (window.prompt is silently blocked by Electron, so
                      the click used to do nothing). */}
                  <div className={`nav-item ${isActive('/settings/system') ? 'active' : ''}`} onClick={() => openPasscodeGate('/settings/system', 'System Settings')}>
                    <FiSliders className="nav-icon" /> <span>System Settings</span>
                  </div>
                  {user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/settings/users') ? 'active' : ''}`} onClick={() => navigate('/settings/users')}>
                      <FiUsers className="nav-icon" /> <span>{t('users')}</span>
                    </div>
                  )}
                  {user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/settings/zra') ? 'active' : ''}`} onClick={() => navigate('/settings/zra')}>
                      <FiFileText className="nav-icon" /> <span>ZRA Smart Invoice</span>
                    </div>
                  )}
                  {user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/settings/backups') ? 'active' : ''}`} onClick={() => navigate('/settings/backups')}>
                      <FiHardDrive className="nav-icon" /> <span>Backups</span>
                    </div>
                  )}
                  {user?.role === 'Administrator' && (
                    <div className={`nav-item ${isActive('/setup') ? 'active' : ''}`} onClick={() => openPasscodeGate('/setup', 'Cloud Sync')}>
                      <FiCloud className="nav-icon" /> <span>Cloud Sync</span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </nav>

        {/* Sidebar Footer */}
        {!collapsed && (
          <div className="sidebar-footer">
            <div className="user-info">
              <div className="user-avatar">{initials}</div>
              <div className="user-details">
                <h4>{user?.firstName} {user?.lastName}</h4>
                <p>{user?.role}</p>
              </div>
            </div>
            {/* 2026-09-13 â€” every user can change their own password here. */}
            <button className="logout-btn" onClick={() => setShowChangePassword(true)}>
              <FiLock /> Change password
            </button>
            <button className="logout-btn" onClick={() => { logout(); navigate('/login'); }}>
              <FiLogOut /> {t('logout')}
            </button>
            <p style={{ fontSize: 10, color: '#475569', textAlign: 'center', marginTop: 4 }}>v{version}</p>
          </div>
        )}
        {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
      </div>

      {/* Main Content */}
      <div className="main-content">
        {/* HQ sea-teal stripe â€” unmistakable "you are in HQ mode" cue. Only
            rendered on the bare keletezm.com host; branch subdomains never
            show it. Thin 3px bar so it doesn't steal real estate. */}
        {hq && (
          <div style={{
            height: 3,
            background: 'linear-gradient(90deg, #164E63 0%, #0E7490 50%, #164E63 100%)',
            boxShadow: '0 1px 4px rgba(14,116,144,0.4)',
          }} />
        )}
        {/* Top Header */}
        <div className="top-header">
          <div className="top-header-left">
            <button className="sidebar-toggle" onClick={() => isPhoneViewport() ? setMobileOpen(o => !o) : setCollapsed(!collapsed)} style={{ marginRight: 8, color: '#374151' }}>
              <FiMenu />
            </button>
            <h2>{pageTitle()}</h2>
          </div>
          <div className="top-header-right">
            <div ref={searchRef} style={{ position: 'relative' }}>
              <div className="search-bar">
                <FiSearch style={{ color: '#9ca3af' }} />
                <input
                  type="text"
                  placeholder={t('search')}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onFocus={() => searchResults.length > 0 && setSearchOpen(true)}
                />
              </div>
              {searchOpen && (
                <div style={{ position: 'absolute', top: '110%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 1000, overflow: 'hidden', minWidth: 280 }}>
                  {searchResults.map((r, i) => (
                    <div
                      key={i}
                      onClick={() => handleSearchSelect(r.path)}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', cursor: 'pointer', borderBottom: i < searchResults.length - 1 ? '1px solid #f1f5f9' : 'none' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                      onMouseLeave={e => e.currentTarget.style.background = '#fff'}
                    >
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: `${typeColor(r.type)}18`, color: typeColor(r.type), minWidth: 56, textAlign: 'center', flex: '0 0 auto' }}>{r.type}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        {/* A note can be a sentence, so it wraps to two lines
                            and stops rather than pushing the row wider. */}
                        <div style={{ fontSize: 14, fontWeight: 500, color: '#111827',
                                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                                      overflow: 'hidden' }}>{r.label}</div>
                        {r.sub && <div style={{ fontSize: 12, color: '#9ca3af' }}>{r.sub}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Refresh Page â€” remounts the current route (via Outlet key bump)
                so its useEffects re-run and the page re-fetches the latest
                data. Lighter than window.location.reload(): no full app reboot,
                no token loss, no deep-path 404 on Electron. */}
            <button
              onClick={() => setRefreshKey(k => k + 1)}
              title="Refresh page (show latest data)"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 36, height: 36, padding: 0,
                border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff',
                cursor: 'pointer', color: '#374151',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f9fafb'; e.currentTarget.style.color = '#1f2937'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff'; e.currentTarget.style.color = '#374151'; }}
            >
              <FiRefreshCw size={16} />
            </button>

            {/* Language Selector */}
            <div ref={langRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setShowLangMenu(p => !p)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#374151' }}
              >
                <FiGlobe size={15} style={{ color: '#6b7280' }} />
                <span>{currentLang.flag}</span>
                <span>{currentLang.label}</span>
                <FiChevronDown size={13} style={{ color: '#9ca3af' }} />
              </button>
              {showLangMenu && (
                <div style={{ position: 'absolute', top: '110%', right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, boxShadow: '0 8px 24px rgba(0,0,0,0.12)', zIndex: 999, minWidth: 160, overflow: 'hidden' }}>
                  {LANGUAGES.map(lang => (
                    <div
                      key={lang.code}
                      onClick={() => handleLangSelect(lang.code)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                        cursor: 'pointer', fontSize: 13, fontWeight: language === lang.code ? 600 : 400,
                        background: language === lang.code ? '#f0f9ff' : '#fff',
                        color: language === lang.code ? '#2563eb' : '#374151',
                      }}
                      onMouseEnter={e => e.currentTarget.style.background = language === lang.code ? '#f0f9ff' : '#f9fafb'}
                      onMouseLeave={e => e.currentTarget.style.background = language === lang.code ? '#f0f9ff' : '#fff'}
                    >
                      <span style={{ fontSize: 18 }}>{lang.flag}</span>
                      <span>{lang.label}</span>
                      {language === lang.code && <span style={{ marginLeft: 'auto', color: '#2563eb' }}>âœ“</span>}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="hide-on-mobile"><SyncStatus /></div>

            {/* 2026-09-14 â€” the bell was a fixed "2". It now shows unread
                messages and opens Messages. */}
            <button className="notification-btn hide-on-mobile" onClick={() => navigate('/messages')}
              title={chatUnread ? `${chatUnread} unread message${chatUnread === 1 ? '' : 's'}` : 'Messages'}>
              <FiBell />
              {chatUnread > 0 && <span className="notification-badge">{chatUnread > 99 ? '99+' : chatUnread}</span>}
            </button>
            <div className="date-display hide-on-mobile">
              <div style={{ fontWeight: 700 }}>{dateStr}</div>
              <div style={{ fontWeight: 700 }}>{timeStr}</div>
            </div>
          </div>
        </div>

        {/* Page Content - rendered by child routes */}
        <Outlet key={refreshKey} />
      </div>

      {/* 2026-09-14 â€” new message pop-up (see the Messages notifications effect). */}
      {chatToast && (
        <div role="status" aria-live="polite"
          onClick={() => { const id = chatToast.conversation_id; setChatToast(null); navigate(`/messages?c=${id}`); }}
          style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 4000, width: 330, maxWidth: 'calc(100vw - 36px)',
                   background: '#fff', border: '1px solid #e3e7ef', borderLeft: '4px solid #13306b', borderRadius: 12,
                   boxShadow: '0 12px 30px rgba(15,23,42,0.18)', padding: '12px 14px', cursor: 'pointer',
                   display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <FiMessageSquare style={{ color: '#13306b', marginTop: 3, flex: '0 0 auto' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>
              {chatToast.from}
              <span style={{ fontWeight: 400, color: '#64748b' }}> Â· {chatToast.group || chatToast.place}</span>
            </div>
            <div style={{ fontSize: 13, color: '#334155', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {chatToast.preview}
            </div>
          </div>
          <button type="button" aria-label="Dismiss" onClick={(e) => { e.stopPropagation(); setChatToast(null); }}
            style={{ border: 0, background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}>
            Ã—
          </button>
        </div>
      )}

      {/* 2026-09-18 â€” the depot's expense waiting for (or answered by) HQ.
          Bottom-left, so it never sits on top of the stock notice. */}
      {!hq && expenseReq && (() => {
        const st = String(expenseReq.status || '').toLowerCase();
        const amt = `K${(parseFloat(expenseReq.amount) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const meta = st === 'approved'
          ? { bg: '#dcfce7', line: '#15803d', ink: '#14532d', title: 'Expense approved by HQ', text: `${amt} Â· ${expenseReq.category || 'Expense'} â€” tap to save the voucher` }
          : st === 'rejected'
          ? { bg: '#fff1f2', line: '#b91c1c', ink: '#7f1d1d', title: 'Expense rejected by HQ', text: `${amt} Â· ${expenseReq.rejection_reason || 'No reason given'}` }
          : { bg: '#fef2f2', line: '#dc2626', ink: '#991b1b', title: 'Waiting for HQ approval', text: `${amt} Â· ${expenseReq.category || 'Expense'} â€” no other expense until this is answered` };
        const clear = async (e) => {
          e.stopPropagation();
          if (st === 'pending' && !window.confirm('Withdraw this request? The voucher will not be saved.')) return;
          try { await cancelExpenseRequest(expenseReq.sync_id); } catch (_) { /* already gone */ }
          setExpenseReq(null);
          window.dispatchEvent(new Event('pv:refresh'));
        };
        return (
          <div role="status" aria-live="polite"
            style={{ position: 'fixed', left: 18, bottom: 18, zIndex: 4000, width: 320, maxWidth: 'calc(100vw - 36px)' }}>
            {/* 2026-09-21 â€” back to the screen it was raised on. An expense
                raised on the Cash Report was approved and then opened on the
                Payment Voucher page, which is not where the cashier was
                working and not where the voucher belongs. A request carrying
                a cashier came from that cashier's Cash Report, so it goes
                back there, on its own date. Anything else is a plain voucher
                and still opens on the Payment Voucher page. */}
            <div onClick={() => {
              if (st !== 'approved') return;
              const cashierId = parseInt(expenseReq.cashier_id) || 0;
              navigate(cashierId > 0
                ? `/pos/cash-report?req=${expenseReq.sync_id}&date=${expenseReq.date || ''}&cashier=${cashierId}`
                : `/accounting/payment-vouchers?req=${expenseReq.sync_id}`);
            }}
              style={{ background: meta.bg, border: '1px solid #e3e7ef', borderLeft: `4px solid ${meta.line}`, borderRadius: 12,
                       boxShadow: '0 12px 30px rgba(15,23,42,0.18)', padding: '12px 14px',
                       cursor: st === 'approved' ? 'pointer' : 'default', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <FiCreditCard style={{ color: meta.line, marginTop: 3, flex: '0 0 auto' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: meta.ink }}>{meta.title}</div>
                <div style={{ fontSize: 12.5, color: '#334155', marginTop: 2 }}>{meta.text}</div>
              </div>
              {st !== 'approved' && (
                <button type="button" aria-label="Dismiss" onClick={clear}
                  style={{ border: 0, background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}>
                  Ã—
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* 2026-09-15 â€” incoming stock / inter-branch transfer notice. The big
          dark one (like the POS change screen) when the cashier is free; the
          small corner card while they are mid-sale, or after "Later". */}
      {(() => {
        const { stock, transfers, grns = [] } = incoming;
        // 2026-09-19 â€” the same notice now serves HQ, for the other direction:
        // deliveries a depot has confirmed, waiting to be turned into a GRN.
        if (noticePhase === 'none' || (!stock.length && !transfers.length && !grns.length)) return null;
        const showBig = noticePhase === 'big' && !posBusy;
        const showCorner = !showBig && !cornerClosed;
        const fmtDate = (s) => {
          if (!s) return '';
          const d = new Date(String(s).length > 10 ? String(s).replace(' ', 'T') + 'Z' : s);
          return isNaN(d) ? String(s) : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
        };
        const rows = [
          ...stock.map((p) => ({ key: `p${p.id}`, kind: 'stock', ref: p.purchase_number,
            from: p.supplier_name ? `HQ Â· ${p.supplier_name}` : 'HQ',
            items: `${p.lines} item${Number(p.lines) === 1 ? '' : 's'}`, date: fmtDate(p.date) })),
          ...transfers.map((t) => ({ key: `t${t.id}`, kind: 'transfer', ref: t.transfer_number,
            from: t.from_name || t.from_slug,
            items: `${t.total_items} item${Number(t.total_items) === 1 ? '' : 's'}`, date: fmtDate(t.created_at) })),
          ...grns.map((g) => ({ key: `g${g.id}-${g.slug}`, kind: 'grn', ref: g.purchase_number,
            from: g.branch_name || g.slug,
            items: `${g.lines} line${Number(g.lines) === 1 ? '' : 's'}`, date: fmtDate(g.confirmed_at || g.date) })),
        ];
        const openPath = (path) => { setNoticePhase('later'); navigate(path); };
        const title = hq
          ? 'Deliveries waiting for a GRN'
          : (stock.length && transfers.length ? 'Stock waiting to be received'
            : stock.length ? 'Incoming stock' : 'Stock transfer');
        const shown = rows.slice(0, 3);
        const more = rows.length - shown.length;

        if (showBig) {
          return (
            <div role="alertdialog" aria-modal="true" aria-label={title}
              style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 5000,
                       display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
              <div style={{ background: '#fff', borderRadius: 16, padding: '28px 26px', width: 'min(440px, 100%)',
                            maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.3)', textAlign: 'center' }}>
                <img src={keleteLogo} alt="Red Sea"
                  style={{ display: 'block', width: 64, height: 64, objectFit: 'contain', margin: '0 auto 10px' }} />
                <div style={{ fontSize: 13, color: '#6b7280', letterSpacing: 1, textTransform: 'uppercase' }}>{title}</div>
                <div style={{ fontSize: 44, fontWeight: 800, color: '#16a34a', lineHeight: 1.1, margin: '4px 0 2px' }}>{rows.length}</div>
                <div style={{ fontSize: 14, color: '#374151', marginBottom: 16 }}>
                  {hq ? 'confirmed by depots, waiting for a GRN' : 'waiting to be received at this depot'}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left', marginBottom: 18 }}>
                  {shown.map((r) => (
                    <div key={r.key} style={{ border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 12px', background: '#f9fafb' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }}>
                        <span style={{ fontWeight: 700, color: '#0f172a' }}>{r.kind === 'stock' ? 'From HQ' : r.kind === 'grn' ? 'Confirmed' : 'Transfer'} Â· {r.ref}</span>
                        <span style={{ color: '#6b7280', whiteSpace: 'nowrap' }}>{r.date}</span>
                      </div>
                      <div style={{ fontSize: 13, color: '#374151', marginTop: 2 }}>
                        {r.kind === 'stock' ? r.from : `From ${r.from}`} Â· {r.items}
                      </div>
                    </div>
                  ))}
                  {more > 0 && <div style={{ fontSize: 13, color: '#6b7280', textAlign: 'center' }}>+{more} more</div>}
                </div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => { setNoticePhase('later'); setCornerClosed(false); }}
                    style={{ flex: '1 1 120px', padding: '12px 16px', borderRadius: 10, border: '1.5px solid #d1d5db', background: '#fff',
                             color: '#374151', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>
                    Later
                  </button>
                  {transfers.length > 0 && (
                    <button type="button" autoFocus onClick={() => openPath('/stock/transfers?tab=incoming')}
                      style={{ flex: '1 1 150px', padding: '12px 16px', borderRadius: 10, border: 'none', background: '#16a34a',
                               color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
                      Open transfers
                    </button>
                  )}
                  {grns.length > 0 && (
                    <button type="button" autoFocus onClick={() => openPath('/hq/confirm-grn')}
                      style={{ flex: '1 1 150px', padding: '12px 16px', borderRadius: 10, border: 'none', background: '#16a34a',
                               color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
                      Open Generate GRN
                    </button>
                  )}
                  {stock.length > 0 && (
                    <button type="button" autoFocus={!transfers.length} onClick={() => openPath('/stock/incoming')}
                      style={{ flex: '1 1 150px', padding: '12px 16px', borderRadius: 10, border: 'none', background: '#16a34a',
                               color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer' }}>
                      Open incoming stock
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        }
        if (!showCorner) return null;
        return (
          <div role="status" aria-live="polite" ref={cardRef}
            onPointerDown={startCardDrag} onPointerMove={onCardDrag}
            onPointerUp={endCardDrag} onPointerCancel={endCardDrag}
            // 2026-09-18 â€” draggable: at bottom-right it covers Pay on the POS
            // screen. Once moved it stays where the cashier left it on this
            // till. touchAction none so a drag on a touch screen moves the card
            // instead of scrolling the page under it.
            style={cardPos
              ? { position: 'fixed', left: cardPos.x, top: cardPos.y, zIndex: 4000, width: 330,
                  maxWidth: 'calc(100vw - 36px)', display: 'grid', gap: 8,
                  cursor: 'grab', touchAction: 'none' }
              : { position: 'fixed', right: 18, bottom: chatToast ? 104 : 18, zIndex: 4000, width: 330,
                  maxWidth: 'calc(100vw - 36px)', display: 'grid', gap: 8,
                  cursor: 'grab', touchAction: 'none' }}>
            {[
              stock.length > 0 && { path: '/stock/incoming', title: 'Incoming stock from HQ',
                text: `${stock.length} deliver${stock.length === 1 ? 'y' : 'ies'} waiting to be received` },
              transfers.length > 0 && { path: '/stock/transfers?tab=incoming', title: 'Inter-branch transfer',
                text: `${transfers.length} transfer${transfers.length === 1 ? '' : 's'} waiting to be received` },
              // 2026-09-19 â€” HQ's card: a depot has confirmed a delivery and
              // it needs turning into a GRN before there is any payable.
              grns.length > 0 && { path: '/hq/confirm-grn', title: 'Delivery confirmed by a depot',
                text: `${grns.length} waiting to become a GRN` },
            ].filter(Boolean).map((a) => (
              <div key={a.path} title="Drag to move"
                // A drag that ends on the card must not also open the page.
                onClick={() => { if (movedRef.current) { movedRef.current = false; return; } openPath(a.path); }}
                style={{ background: '#fff', border: '1px solid #e3e7ef', borderLeft: '4px solid #15803d', borderRadius: 12,
                         boxShadow: '0 12px 30px rgba(15,23,42,0.18)', padding: '12px 14px', cursor: 'pointer',
                         display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                {a.path === '/stock/transfers?tab=incoming'
                  ? <FiTruck style={{ color: '#15803d', marginTop: 3, flex: '0 0 auto' }} />
                  : <FiInbox style={{ color: '#15803d', marginTop: 3, flex: '0 0 auto' }} />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{a.title}</div>
                  <div style={{ fontSize: 13, color: '#334155', marginTop: 2 }}>{a.text}</div>
                </div>
                <button type="button" aria-label="Dismiss" onClick={(e) => { e.stopPropagation(); setCornerClosed(true); }}
                  style={{ border: 0, background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0 }}>
                  Ã—
                </button>
              </div>
            ))}
          </div>
        );
      })()}

      {/* v1.8.37 â€” in-app passcode modal. Replaces window.prompt which
          Electron silently blocks. Renders only when passcodeGate state
          is non-null (set by openPasscodeGate on a gated nav click). */}
      {passcodeGate && (
        <div onClick={() => setPasscodeGate(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99999 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ width: 360, maxWidth: '92vw', background: '#fff', borderRadius: 14, padding: 22, boxShadow: '0 20px 50px rgba(0,0,0,0.25)' }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a', marginBottom: 4 }}>{passcodeGate.label}</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>Enter the admin passcode to continue.</div>
            <input
              type="password" autoFocus
              value={passcodeGate.value}
              onChange={e => setPasscodeGate(prev => ({ ...prev, value: e.target.value, error: '' }))}
              onKeyDown={e => { if (e.key === 'Enter') submitPasscode(); if (e.key === 'Escape') setPasscodeGate(null); }}
              placeholder="Passcode"
              style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: passcodeGate.error ? '2px solid #ef4444' : '1.5px solid #d1d5db', fontSize: 16, letterSpacing: 4, textAlign: 'center', fontFamily: 'monospace', outline: 'none', boxSizing: 'border-box' }}
            />
            {passcodeGate.error && (
              <div style={{ color: '#dc2626', fontSize: 12, marginTop: 6, fontWeight: 600 }}>{passcodeGate.error}</div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => setPasscodeGate(null)}
                style={{ flex: 1, padding: '10px 16px', borderRadius: 10, border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
              <button onClick={submitPasscode}
                style={{ flex: 1, padding: '10px 16px', borderRadius: 10, border: 'none', background: '#1d4ed8', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Continue</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Tiny red pill rendered to the right of a sidebar entry when there's
// pending work. Numbers >99 collapse to "99+" so the pill stays compact.
// 2026-09-14 â€” a short two-note chime for a new message, made with Web Audio
// so there is no sound file to ship. Silently does nothing where audio is
// blocked (a browser that has not seen a click on the page yet).
function playChatSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    [[880, 0], [1320, 0.13]].forEach(([freq, at]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.24);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.26);
    });
    setTimeout(() => { try { ctx.close(); } catch (_) { /* already closed */ } }, 900);
  } catch (_) { /* no sound available */ }
}

function SidebarBadge({ n }) {
  const label = n > 99 ? '99+' : String(n);
  return (
    <span style={{
      marginLeft: 'auto',
      background: '#dc2626', color: '#fff',
      fontSize: 10, fontWeight: 800,
      minWidth: 18, height: 18, padding: '0 5px',
      borderRadius: 9, display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center',
      lineHeight: 1,
    }}>{label}</span>
  );
}

export default Layout;
