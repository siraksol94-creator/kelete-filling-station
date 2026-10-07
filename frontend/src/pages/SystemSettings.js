import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useCurrency } from '../context/CurrencyContext';
import {
  getSettings, updateBusiness,
  getDrawerPort, updateDrawerPort,
  getAppPasscode, updateAppPasscode,
  getLanConfig, updateLanConfig, getLanStatus,
  getHqBranches, isHqHost,
} from '../services/api';
import { FiAlertTriangle } from 'react-icons/fi';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';
import AdminPasswordPrompt from '../components/AdminPasswordPrompt';
import { MOBILE_PRINT_MODE_KEY, readMobilePrintMode } from '../utils/printHtml';
import { getDeviceType, setDeviceType } from '../utils/receipt58';

// SystemSettings â€” POS/device-level configuration extracted from the old Profile page.
// Holds everything that is NOT identity/contact info: currencies, default deposit,
// single-location mode, receipt printer, drawer port, cloud sync, LAN sync, factory reset.
// 2026-09-11 â€” System Settings redesign. One line per setting: its name and
// a short explanation on the left, the control on the right.
const Switch = ({ on, onChange, label, disabled }) => (
  <button type="button" role="switch" aria-checked={!!on} aria-label={label} disabled={disabled}
    className="ss-switch" onClick={() => onChange(!on)} />
);
const Seg = ({ name, value, options, onChange }) => (
  <div className="ss-seg" role="radiogroup">
    {options.map(o => (
      <label key={o.value} className={value === o.value ? 'on' : ''}>
        <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
        <span>{o.label}{o.rec && <em>{o.rec}</em>}</span>
      </label>
    ))}
  </div>
);
const Row = ({ title, help, admin, stack, children }) => (
  <div className={`ss-row${stack ? ' stack' : ''}`}>
    <div>
      <h3>{title}{admin && <span className="ss-admin">Admin</span>}</h3>
      {help && <p className="ss-help">{help}</p>}
    </div>
    {children}
  </div>
);

const SystemSettings = () => {
  const { logout, user } = useAuth();
  // 2026-09-11 â€” "Payment methods shown" is for administrators only.
  const isAdmin = user?.role === 'Administrator';
  const { refresh: refreshCurrency } = useCurrency();
  // 2026-09-15 â€” Deposit to: the other depots this one can send deposits to.
  const onHqHost = isHqHost();
  const ownSlug = String(window.location.hostname || '').split('.')[0].toLowerCase();
  const [depotChoices, setDepotChoices] = useState([]);
  useEffect(() => {
    if (onHqHost) return;
    getHqBranches()
      .then(r => setDepotChoices((r.data?.branches || [])
        .filter(b => b.slug && b.slug.toLowerCase() !== ownSlug && !/^(hq|kelete|keletedistributionzm|www)$/i.test(b.slug))))
      .catch(() => {});
  // eslint-disable-next-line
  }, []);

  const [businessName, setBusinessName] = useState('');
  const [form, setForm] = useState({
    singleLocationMode: false,
    currencies: [{ code: 'USD', symbol: '$', is_primary: true }],
    receiptPrinterType: 'usb',
    receiptPrinterName: '',
    receiptPrinterIp:   '',
    receiptPrinterPort: 9100,
    defaultCrateDeposit: 57,
    // Currency mode controls the dual-currency UI gate. 'K' hides the FX
    // rate / dual-currency payment / USD+FRA receipt features (default for
    // lusaka1, mansa1). 'USD+FRA' unlocks them (kassumbalesa1).
    currencyMode: 'K',
    // Workflow mode swaps the single-screen POS for the 3-station flow
    // (Sales â†’ Cashier â†’ Dispatch). 'single_pos' is the default for lusaka1,
    // mansa1. 'three_station' is used for kassumbalesa1.
    workflowMode: 'single_pos',
    // v1.3.9 â€” re-exposes the legacy GRN + Suppliers + AP sidebar
    // entries on this branch so an operator can record initial stock /
    // openings before HQ Procurement is in routine use. Off by default;
    // OK to leave on temporarily at launch then switch off later.
    legacyProcurementEnabled: false,
  });
  const [saving, setSaving] = useState(false);
  // 2026-09-11 â€” redesign. savedForm is the depot's settings as last loaded
  // or saved; the save bar shows only while `form` differs from it.
  const [savedForm, setSavedForm] = useState(null);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const flash = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  };
  const [activeSection, setActiveSection] = useState('ss-selling');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) setActiveSection(en.target.id); });
    }, { rootMargin: '-15% 0px -70% 0px' });
    ['ss-selling', 'ss-money', 'ss-app', 'ss-printer', 'ss-procurement', 'ss-device', 'ss-sync', 'ss-danger']
      .forEach(id => { const el = document.getElementById(id); if (el) io.observe(el); });
    return () => { io.disconnect(); clearTimeout(toastTimer.current); };
  }, []);

  const [drawerPort, setDrawerPort] = useState('POS-80');
  const [savingPort, setSavingPort] = useState(false);

  // 2026-09-18 â€” the phone app now checks every depot's licence key with the
  // server before it opens that depot. HQ has no licence key of its own, so
  // this is what its phones are asked for instead. HQ + Administrator only;
  // the code is never read back, only whether one is set.
  const showPasscode = onHqHost && isAdmin;
  const [passcodeSet, setPasscodeSet] = useState(false);
  const [passcode, setPasscode] = useState('');
  const [savingPasscode, setSavingPasscode] = useState(false);
  useEffect(() => {
    if (!showPasscode) return;
    getAppPasscode().then(r => setPasscodeSet(!!r.data?.isSet)).catch(() => {});
  }, [showPasscode]);
  const handleSavePasscode = async (code) => {
    setSavingPasscode(true);
    try {
      const r = await updateAppPasscode(code);
      setPasscodeSet(!!r.data?.isSet);
      setPasscode('');
      flash(code ? 'Passcode saved' : 'Passcode removed');
    } catch (err) {
      flash(err?.response?.data?.error || 'Could not save the passcode.');
    }
    setSavingPasscode(false);
  };

  // Mobile-only print behaviour. Per-device (localStorage) â€” see printHtml.js.
  //
  // 2026-09-23 â€” this read the key itself and applied its own rule, so when
  // printHtml started defaulting an untouched APK to 'print' the page carried on
  // showing 'PDF download'. It said one thing while the printer did another.
  // It now asks printHtml, exactly as Device type below asks getDeviceType().
  const [mobilePrintMode, setMobilePrintMode] = useState(() => readMobilePrintMode());
  const updateMobilePrintMode = (mode) => {
    setMobilePrintMode(mode);
    try { localStorage.setItem(MOBILE_PRINT_MODE_KEY, mode); } catch (_) {}
  };

  // Which receipt this device prints â€” 80mm (PC) or 58mm (small terminal).
  // Per-device, like Mobile Print Mode: see utils/receipt58.js.
  const [deviceType, setDeviceTypeState] = useState(() => getDeviceType());
  const updateDeviceType = (v) => {
    setDeviceTypeState(v);
    setDeviceType(v);
  };

  // Cloud sync status
  const [syncInfo, setSyncInfo] = useState(null);
  const [resetting, setResetting] = useState(false);

  // LAN sync (mother/child)
  const [lanConfig, setLanConfig] = useState({ role: 'child', motherIp: '', lanSyncKey: '', localIp: '' });
  const [lanChildren, setLanChildren] = useState([]);
  const [savingLan, setSavingLan] = useState(false);
  const [lanMessage, setLanMessage] = useState('');

  // Factory reset modal
  const [resetStep, setResetStep] = useState(0);

  useModalScrollLock(resetStep > 0);
  const [factoryResetting, setFactoryResetting] = useState(false);

  useEffect(() => {
    fetch('/api/sync/status').then(r => r.json()).then(setSyncInfo).catch(() => {});
    getDrawerPort().then(res => setDrawerPort(res.data?.port || 'POS-80')).catch(() => {});
    getLanConfig().then(r => setLanConfig(prev => ({ ...prev, ...r.data }))).catch(() => {});
    getSettings().then(res => {
      const b = res.data?.business || {};
      setBusinessName(b.business_name || '');
      const loaded = {
        singleLocationMode: !!b.single_location_mode,
        blockOversell: !!b.block_oversell,
        currencies: (() => {
          try {
            const parsed = b.currencies_json ? JSON.parse(b.currencies_json) : null;
            if (Array.isArray(parsed) && parsed.length) return parsed;
          } catch { /* fall through */ }
          return [{ code: 'USD', symbol: '$', is_primary: true }];
        })(),
        receiptPrinterType: (b.receipt_printer_type || 'usb').toLowerCase(),
        receiptPrinterName: b.receipt_printer_name || '',
        receiptPrinterIp:   b.receipt_printer_ip   || '',
        receiptPrinterPort: parseInt(b.receipt_printer_port) || 9100,
        defaultCrateDeposit: parseFloat(b.default_crate_deposit) || 57,
        currencyMode: ((cm => ['USD+FRA+K','USD+FRA'].includes(cm) ? cm : 'K')(String(b.currency_mode || 'K').toUpperCase())),
        workflowMode: ((wm => ['three_station','two_station','pos_dispatch'].includes(wm) ? wm : 'single_pos')(String(b.workflow_mode || 'single_pos').toLowerCase())),
        // v1.9.26 â€” third dial: which payment methods the Pay modal shows.
        paymentMethods: ((pm => ['cash_only','cash_momo_bank'].includes(pm) ? pm : 'cash_momo_bank')(String(b.payment_methods || 'cash_momo_bank').toLowerCase())),
        legacyProcurementEnabled: !!parseInt(b.legacy_procurement_enabled || 0, 10),
        // 2026-09-11 â€” which payment methods the screens show (Cash always).
        shownMethods: String(b.shown_payment_methods || 'cash,momo,bank').toLowerCase(),
        // 2026-09-11 â€” Cash Report save â†’ PENDING deposits to HQ.
        autoDeposit: !!parseInt(b.auto_deposit_enabled || 0, 10),
        // 2026-09-15 â€” '' = HQ.
        depositTo: String(b.deposit_to_slug || '').toLowerCase(),
        // 2026-09-18 â€” most this depot may pay out in expenses in one day.
        dailyExpenseLimit: b.daily_expense_limit == null ? 5000 : (parseFloat(b.daily_expense_limit) || 0),
      };
      setForm(loaded);
      setSavedForm(loaded);
    }).catch(() => {});
  }, []);

  // Poll LAN children list every 5s while role=mother
  useEffect(() => {
    if (lanConfig.role !== 'mother') { setLanChildren([]); return; }
    const tick = () => getLanStatus().then(r => setLanChildren(r.data?.children || [])).catch(() => {});
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [lanConfig.role]);

  const handleSave = async (e) => {
    if (e) e.preventDefault();
    setSaving(true);
    try {
      // v1.9.26 â€” auto-align Primary currency to match currency_mode so
      // "K-only mode" doesn't end up with USD as Primary (the bug that
      // caused Mansa's till to price in $ even though the radio said K).
      // For K-only: K becomes Primary, USD/FRA rows are dropped.
      // For USD+FRA / USD+FRA+K: USD becomes Primary, all required rows
      // are added if missing. Anything the user manually added beyond
      // these is preserved.
      let normCurrencies = (form.currencies || []).map(c => ({ ...c, is_primary: false }));
      const upsert = (code, symbol) => {
        if (!normCurrencies.find(c => (c.code || '').toUpperCase() === code)) {
          normCurrencies.push({ code, symbol, is_primary: false });
        }
      };
      const setPrimary = (code) => {
        normCurrencies = normCurrencies.map(c => ({
          ...c,
          is_primary: (c.code || '').toUpperCase() === code,
        }));
      };
      if (form.currencyMode === 'K') {
        normCurrencies = normCurrencies.filter(c => (c.code || '').toUpperCase() === 'K');
        upsert('K', 'K');
        setPrimary('K');
      } else if (form.currencyMode === 'USD+FRA') {
        normCurrencies = normCurrencies.filter(c => ['USD', 'FRA'].includes((c.code || '').toUpperCase()));
        upsert('USD', '$');
        upsert('FRA', 'FRA');
        setPrimary('USD');
      } else if (form.currencyMode === 'USD+FRA+K') {
        upsert('USD', '$');
        upsert('FRA', 'FRA');
        upsert('K',   'K');
        setPrimary('USD');
      }

      await updateBusiness({
        single_location_mode: form.singleLocationMode ? 1 : 0,
        block_oversell: form.blockOversell ? 1 : 0,
        currencies: normCurrencies,
        receipt_printer_type: form.receiptPrinterType,
        receipt_printer_name: form.receiptPrinterName,
        receipt_printer_ip:   form.receiptPrinterIp,
        receipt_printer_port: form.receiptPrinterPort,
        default_crate_deposit: form.defaultCrateDeposit,
        currency_mode: form.currencyMode,
        workflow_mode: form.workflowMode,
        payment_methods: form.paymentMethods,
        legacy_procurement_enabled: form.legacyProcurementEnabled ? 1 : 0,
        ...(isAdmin ? {
          shown_payment_methods: form.shownMethods || 'cash,momo,bank',
          auto_deposit_enabled: form.autoDeposit ? 1 : 0,
          ...(onHqHost ? {} : { deposit_to_slug: form.depositTo || '' }),
          ...(onHqHost ? {} : { daily_expense_limit: form.dailyExpenseLimit === '' ? 0 : form.dailyExpenseLimit }),
        } : {}),
      });
      refreshCurrency();
      // 2026-09-11 â€” the new baseline for the save bar.
      setSavedForm(form);
      flash('Saved for this depot');
    } catch {
      flash('Failed to save â€” please try again.');
    }
    setSaving(false);
  };

  const handleSaveDrawerPort = async () => {
    setSavingPort(true);
    try {
      await updateDrawerPort(drawerPort);
      alert('Drawer port saved.');
    } catch { alert('Failed to save drawer port.'); }
    setSavingPort(false);
  };

  const [pendingDelete, setPendingDelete] = useState(null);
  const confirmDelete = async () => {
    const job = pendingDelete;
    setPendingDelete(null);
    if (job?.perform) await job.perform();
  };
  const handleConnectToCloud = () => {
    setPendingDelete({
      subject: 'Disconnect sync settings â€” Cloud Setup screen will reload',
      actionLabel: 'Reset Sync',
      perform: async () => {
        setResetting(true);
        try {
          await fetch('/api/sync/reset', { method: 'POST' });
          window.location.reload();
        } catch {
          alert('Failed to reset sync config. Make sure the backend is running.');
          setResetting(false);
        }
      },
    });
  };

  const handleSaveLan = async () => {
    setSavingLan(true); setLanMessage('');
    try {
      const res = await updateLanConfig({
        role: lanConfig.role,
        motherIp: lanConfig.motherIp.trim(),
        lanSyncKey: lanConfig.lanSyncKey.trim(),
      });
      setLanConfig({ ...lanConfig, ...res.data });
      setLanMessage('LAN sync settings saved. New target will apply on next sync cycle.');
    } catch (err) {
      setLanMessage(err.response?.data?.error || 'Failed to save LAN settings.');
    } finally { setSavingLan(false); }
  };

  const doFactoryReset = async (includeSettings) => {
    setFactoryResetting(true);
    try {
      await fetch('/api/sync/factory-reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeSettings }),
      });
      logout();
    } catch {
      alert('Factory reset failed. Please try again.');
      setFactoryResetting(false);
      setResetStep(0);
    }
  };

  // 2026-09-11 â€” redesign. Depot settings save together from the bar at the
  // bottom, which appears only once something differs from what was loaded;
  // device settings save as they are clicked; sync keeps its own buttons.
  // Currency Mode, Payment Methods and the Currencies editor were one-option
  // choices for Kelete (handleSave forces Kwacha), so they are one fixed line.
  const DEPOT_KEYS = ['workflowMode', 'blockOversell', 'shownMethods', 'autoDeposit', 'depositTo', 'dailyExpenseLimit', 'defaultCrateDeposit',
    'legacyProcurementEnabled', 'receiptPrinterType', 'receiptPrinterName', 'receiptPrinterIp', 'receiptPrinterPort'];
  const changed = savedForm ? DEPOT_KEYS.filter(k => String(form[k] ?? '') !== String(savedForm[k] ?? '')) : [];
  const set = (k) => (v) => setForm(f => ({ ...f, [k]: v }));
  const shown = String(form.shownMethods || 'cash,momo,bank').split(',');
  const methodOn = (k) => k === 'cash' || shown.includes(k);
  const toggleMethod = (k) => set('shownMethods')(['cash', 'momo', 'bank'].filter(x => x === 'cash' || (x === k ? !methodOn(k) : methodOn(x))).join(','));
  const curSymbol = form.currencies?.find(c => c.is_primary)?.symbol || 'K';
  const cloudOff = syncInfo && (syncInfo.tenantId === 'local-only' || !syncInfo.isConfigured);
  const goTo = (id) => (e) => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const NAV = [
    { group: 'This depot', items: [['ss-selling', 'Selling'], ['ss-money', 'Money & payments'],
      ...(showPasscode ? [['ss-app', 'Phone app']] : []),
      ['ss-printer', 'Receipt printer'], ['ss-procurement', 'Procurement']] },
    { group: 'This device', items: [['ss-device', 'Device & display']] },
    { group: 'Sync', items: [['ss-sync', 'Cloud & LAN']] },
  ];

  return (
    <div className="page-content ss-page">
      <header className="ss-head">
        <div>
          <h1>System Settings</h1>
          <p>{businessName || 'This depot'} Â· {window.location.hostname}</p>
        </div>
        <div className="ss-legend">
          <span className="ss-scope depot">This depot Â· saved with Save</span>
          <span className="ss-scope device">This device Â· saved instantly</span>
        </div>
      </header>

      <div className="ss-layout">
        <nav className="ss-nav" aria-label="Settings sections">
          {NAV.map(g => (
            <div key={g.group}>
              <h4>{g.group}</h4>
              {g.items.map(([id, label]) => (
                <a key={id} href={`#${id}`} onClick={goTo(id)} className={activeSection === id ? 'on' : ''}>{label}</a>
              ))}
            </div>
          ))}
          <div>
            <a href="#ss-danger" onClick={goTo('ss-danger')} className={`danger${activeSection === 'ss-danger' ? ' on' : ''}`}>Danger zone</a>
          </div>
        </nav>

        <div className="ss-content">
          {/* â•â•â• This depot â•â•â• */}
          <section id="ss-selling">
            <div className="ss-group-head"><span className="ss-scope depot">This depot</span><h2>Selling</h2></div>
            <div className="ss-card">
              <Row stack title="How the till works" help="Who writes the sale, who takes the money, and who hands over the goods.">
                <div className="ss-tiles" role="radiogroup">
                  {[
                    { val: 'single_pos',    label: 'Single-screen POS',          sub: 'One cashier does everything. Most depots.' },
                    { val: 'pos_dispatch',  label: 'POS + Dispatch',             sub: 'Writes and pays at POS; a dispatcher hands over the goods. Stock deducts on Dispatch.' },
                    { val: 'two_station',   label: 'Sales â†’ Cashier',            sub: 'Different people. The cashier takes payment and dispatches.' },
                    { val: 'three_station', label: 'Sales â†’ Cashier â†’ Dispatch', sub: 'Three people, the order handed along.' },
                  ].map(o => (
                    <label key={o.val} className={`ss-tile${form.workflowMode === o.val ? ' on' : ''}`}>
                      <input type="radio" name="workflow-mode" checked={form.workflowMode === o.val} onChange={() => set('workflowMode')(o.val)} />
                      <b>{o.label}</b>
                      <small>{o.sub}</small>
                    </label>
                  ))}
                </div>
              </Row>
              <Row title="Block selling beyond stock" help="On: items at 0 can't be tapped and the cart can't go over what's there. Off: cashiers can sell past stock (today's behaviour).">
                <Switch on={form.blockOversell} onChange={set('blockOversell')} label="Block selling beyond stock" />
              </Row>
            </div>
          </section>

          <section id="ss-money">
            <div className="ss-group-head"><span className="ss-scope depot">This depot</span><h2>Money &amp; payments</h2></div>
            <div className="ss-card">
              {isAdmin && (
                <Row admin title="Payment methods shown" help="Untick what this depot doesn't use. Hidden on the POS, reports, PVs, CRs and the Cash Book. Nothing is deleted; old money on a hidden method still shows.">
                  <div className="ss-chips">
                    {[['cash', 'Cash'], ['momo', 'Mobile Money'], ['bank', 'Bank']].map(([k, label]) => (
                      <label key={k} className={`ss-chip${methodOn(k) ? ' on' : ''}${k === 'cash' ? ' locked' : ''}`}>
                        <input type="checkbox" checked={methodOn(k)} disabled={k === 'cash'} onChange={() => toggleMethod(k)} />
                        {label}{k === 'cash' && <span className="ss-lock">always</span>}
                      </label>
                    ))}
                  </div>
                </Row>
              )}
              {isAdmin && (
                <Row admin title="Auto deposit" help={(() => {
                  // 2026-09-15 â€” names where the deposits go (Deposit to below), not always HQ.
                  const to = form.depositTo
                    ? (depotChoices.find(b => b.slug === form.depositTo)?.name || form.depositTo)
                    : 'HQ';
                  return `Saving the Cash Report also sends the money counted to ${to} as deposits, one per method, waiting for ${to} to confirm. Editing the report updates them; once ${to} confirms, the report is locked. For depots with one cashier a day.`;
                })()}>
                  <Switch on={form.autoDeposit} onChange={set('autoDeposit')} label="Auto deposit" />
                </Row>
              )}
              {isAdmin && !onHqHost && (
                <Row admin title="Deposit to" help="Where this depot's deposits go, manual and Auto deposit. HQ by default. Pick a main depot (e.g. Kabwe) and that depot confirms them and books the money; HQ does not see them. Deposits already sent keep going where they were sent.">
                  <select aria-label="Deposit to" value={form.depositTo || ''}
                    onChange={e => set('depositTo')(e.target.value)}
                    style={{ padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, background: '#fff', minWidth: 200 }}>
                    <option value="">HQ</option>
                    {depotChoices.map(b => <option key={b.slug} value={b.slug}>{b.name || b.slug}</option>)}
                    {form.depositTo && !depotChoices.some(b => b.slug === form.depositTo) && (
                      <option value={form.depositTo}>{form.depositTo}</option>
                    )}
                  </select>
                </Row>
              )}
              {isAdmin && !onHqHost && (
                <Row admin title="Maximum expenses per day" help="The most this depot may pay out in payment vouchers in one day. A voucher that would go over it is not saved: the depot sends it to HQ for approval, and while one is waiting no other expense can be raised. 0 = no limit. HQ itself is never limited.">
                  <div className="ss-money">
                    <span>{curSymbol}</span>
                    <input type="number" step="1" min="0" aria-label="Maximum expenses per day"
                      value={form.dailyExpenseLimit ?? ''}
                      onChange={e => set('dailyExpenseLimit')(e.target.value === '' ? '' : parseFloat(e.target.value))} />
                  </div>
                </Row>
              )}
              <Row title="Default crate / empty-bottle deposit" help="Pre-fills each GRN line that has a returnable container (set under Item Details â†’ Returnable Container). Can still be changed per line.">
                <div className="ss-money">
                  <span>{curSymbol}</span>
                  <input type="number" step="0.01" min="0" aria-label="Default crate deposit"
                    value={form.defaultCrateDeposit ?? ''}
                    onChange={e => set('defaultCrateDeposit')(e.target.value === '' ? '' : parseFloat(e.target.value))} />
                </div>
              </Row>
              <div className="ss-row fixed">
                <div className="ss-fixed">
                  <span>Currency <b>Kwacha (K) only</b></span>
                  <span>Pay window columns <b>Cash Â· Mobile Money Â· Bank</b></span>
                  <span className="ss-lock">Fixed for Kelete</span>
                </div>
              </div>
            </div>
          </section>

          {showPasscode && (
            <section id="ss-app">
              <div className="ss-group-head">
                <span className="ss-scope depot">Head Office</span><h2>Phone app</h2>
                <p>Saved on its own, not with Save.</p>
              </div>
              <div className="ss-card">
                <Row admin stack
                  title="Head Office passcode"
                  help={`Asked for the first time someone opens Head Office in the phone app. Every depot is asked for its licence key instead, which HQ does not have. ${passcodeSet ? 'A passcode is set â€” typing a new one replaces it.' : 'No passcode is set, so the app opens Head Office without asking.'} Phones that already went through are not asked again.`}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <input type="password" aria-label="Head Office passcode"
                      value={passcode} placeholder={passcodeSet ? 'Set â€” type to replace' : 'At least 4 characters'}
                      autoComplete="new-password" data-keep-case
                      onChange={e => setPasscode(e.target.value)}
                      style={{ padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14, background: '#fff', minWidth: 220 }} />
                    <button type="button" className="ss-btn" disabled={savingPasscode || passcode.trim().length < 4}
                      onClick={() => handleSavePasscode(passcode.trim())}>
                      {savingPasscode ? 'Savingâ€¦' : 'Save passcode'}
                    </button>
                    {passcodeSet && (
                      <button type="button" className="ss-btn danger" disabled={savingPasscode}
                        onClick={() => handleSavePasscode('')}>
                        Remove
                      </button>
                    )}
                  </div>
                </Row>
              </div>
            </section>
          )}

          <section id="ss-printer">
            <div className="ss-group-head">
              <span className="ss-scope depot">This depot</span><h2>Receipt printer</h2>
              <p>Kept with the depot's settings, so it is saved with Save.</p>
            </div>
            <div className="ss-card">
              <Row title="Connection" help="USB / Shared uses the Windows printer name. Network sends straight to the printer's IP.">
                <Seg name="printer-type" value={form.receiptPrinterType} onChange={set('receiptPrinterType')}
                  options={[{ value: 'usb', label: 'USB / Shared' }, { value: 'lan', label: 'Network (LAN)' }]} />
              </Row>
              <div className="ss-row stack">
                {form.receiptPrinterType === 'lan' ? (
                  <div className="ss-fields ip">
                    <div className="ss-field">
                      <label htmlFor="ss-pip">Printer IP address</label>
                      <input id="ss-pip" className="mono" value={form.receiptPrinterIp || ''} placeholder="e.g. 192.168.1.50"
                        onChange={e => set('receiptPrinterIp')(e.target.value)} />
                      <small>The LAN IP on the printer's self-test page.</small>
                    </div>
                    <div className="ss-field">
                      <label htmlFor="ss-pport">TCP port</label>
                      <input id="ss-pport" className="mono" type="number" min="1" max="65535" value={form.receiptPrinterPort} placeholder="9100"
                        onChange={e => set('receiptPrinterPort')(parseInt(e.target.value, 10) || 9100)} />
                    </div>
                  </div>
                ) : (
                  <div className="ss-field" style={{ maxWidth: 380 }}>
                    <label htmlFor="ss-pname">Windows printer name</label>
                    <input id="ss-pname" className="mono" value={form.receiptPrinterName || ''} placeholder="e.g. POS-80"
                      onChange={e => set('receiptPrinterName')(e.target.value)} />
                    <small>Windows â†’ Devices and Printers â†’ right-click the printer â†’ Printer properties â†’ Sharing.</small>
                  </div>
                )}
                <details className="ss-adv">
                  <summary>Legacy drawer port (advanced)</summary>
                  <div className="ss-inline">
                    <div className="ss-field">
                      <label htmlFor="ss-dport">Drawer port</label>
                      <input id="ss-dport" className="mono" value={drawerPort} placeholder="e.g. POS-80" style={{ width: 180 }}
                        onChange={e => setDrawerPort(e.target.value)} />
                    </div>
                    <button type="button" className="ss-btn" onClick={handleSaveDrawerPort} disabled={savingPort}>
                      {savingPort ? 'Savingâ€¦' : 'Save drawer port'}
                    </button>
                  </div>
                  <small className="ss-note">Used by the standalone Open Drawer fallback when no printer is set above. Saved on its own.</small>
                </details>
              </div>
            </div>
          </section>

          <section id="ss-procurement">
            <div className="ss-group-head"><span className="ss-scope depot">This depot</span><h2>Procurement</h2></div>
            <div className="ss-card">
              <Row title="Legacy GRN, Suppliers & AP pages" help="A depot normally has Incoming Stock and Transfers only; HQ owns procurement. On: the old GRN, Suppliers and Account Payables pages come back, to load openings or rescue a one-off. Save, then refresh. Switch off once HQ Purchases is doing the job.">
                <Switch on={form.legacyProcurementEnabled} onChange={set('legacyProcurementEnabled')} label="Legacy GRN, Suppliers and AP pages" />
              </Row>
            </div>
          </section>

          {/* â•â•â• This device â•â•â• */}
          <section id="ss-device">
            <div className="ss-group-head">
              <span className="ss-scope device">This device</span><h2>Device &amp; display</h2>
              <p>Set on each till or phone; saved as you click.</p>
            </div>
            <div className="ss-card">
              <Row title="Device type" help="PC prints the 80mm receipt used at the depot tills. POS small terminal prints the 58mm receipt and gets the keypad Pay window. Tax Invoices, unsigned Invoices and reprints follow it; A4 documents don't change.">
                <Seg name="device-type" value={deviceType} onChange={(v) => { updateDeviceType(v); flash('Saved on this device'); }}
                  options={[{ value: 'pc', label: 'PC' }, { value: 'terminal58', label: 'POS small terminal' }]} />
              </Row>
              <Row title="Receipts on a phone" help="How receipts and reports print when this device is a phone. Desktops always use the print dialog.">
                <Seg name="mobile-print" value={mobilePrintMode} onChange={(v) => { updateMobilePrintMode(v); flash('Saved on this device'); }}
                  options={[{ value: 'print', label: 'Print dialog' }, { value: 'pdf', label: 'PDF download', rec: 'Recommended' }]} />
              </Row>
              <Row title="Customer display" help="The screen customers see on the second monitor.">
                <button type="button" className="ss-btn"
                  onClick={() => window.open(`/customer-display?bizName=${encodeURIComponent(businessName || '')}`, '_blank', 'width=1024,height=768')}>
                  Preview
                </button>
              </Row>
            </div>
          </section>

          {/* â•â•â• Sync â•â•â• */}
          <section id="ss-sync">
            <div className="ss-group-head">
              <span className="ss-scope sync">Sync</span><h2>Cloud &amp; LAN</h2>
              <p>Each has its own button; not part of Save.</p>
            </div>
            <div className="ss-card">
              <div className="ss-row">
                <div>
                  <h3>Cloud</h3>
                  {!syncInfo ? (
                    <p className="ss-help">Loading sync statusâ€¦</p>
                  ) : cloudOff ? (
                    <p className="ss-help">Offline only â€” not connected to the cloud.</p>
                  ) : (
                    <div className="ss-status">
                      <span className="ss-ok">Connected</span>
                      <span className="ss-ids mono">
                        {syncInfo.vpsUrl ? `${syncInfo.vpsUrl.replace('https://', '').split('.')[0]} Â· ` : ''}
                        tenant {syncInfo.tenantId?.substring(0, 8)}â€¦ Â· branch {syncInfo.branchId?.substring(0, 8)}â€¦
                      </span>
                    </div>
                  )}
                </div>
                {syncInfo && (
                  <button type="button" className={`ss-btn${cloudOff ? ' primary' : ''}`} onClick={handleConnectToCloud} disabled={resetting}>
                    {resetting ? 'Resettingâ€¦' : cloudOff ? 'Connect to Cloud' : 'Change / Disconnect'}
                  </button>
                )}
              </div>
              <Row title="This PC is the Mother" help="For several PCs in one depot: the others sync through the Mother instead of straight to the cloud. Leave off, with the Mother IP empty, for direct cloud sync.">
                <Switch on={lanConfig.role === 'mother'} label="This PC is the Mother"
                  onChange={(on) => setLanConfig({ ...lanConfig, role: on ? 'mother' : 'child' })} />
              </Row>
              <div className="ss-row stack">
                {lanConfig.role === 'mother' ? (
                  <>
                    <div className="ss-field">
                      <label>This PC's LAN IP (give it to the other PCs)</label>
                      <div className="ss-ip mono">{lanConfig.localIp || 'â€”'}</div>
                      <small>Give this PC a static IP on the router so the others don't lose it.</small>
                      {lanConfig.allLocalIps && lanConfig.allLocalIps.length > 1 && (
                        <small>Other addresses on this PC, if that one doesn't work: <span className="mono">{lanConfig.allLocalIps.join(' Â· ')}</span></small>
                      )}
                    </div>
                    <div className="ss-children">
                      <div className="ss-children-head">Other PCs connected <b>{lanChildren.length}</b> <small>active in the last 5 min</small></div>
                      {lanChildren.length === 0 ? (
                        <small className="ss-note">None yet. Set the other PCs to this IP and the same sync key.</small>
                      ) : (
                        <table>
                          <thead><tr><th>Device</th><th>IP</th><th style={{ textAlign: 'right' }}>Last sync</th></tr></thead>
                          <tbody>
                            {lanChildren.map(c => (
                              <tr key={c.deviceId}>
                                <td className="mono">{c.deviceShort}</td>
                                <td className="mono">{c.ip}</td>
                                <td style={{ textAlign: 'right', color: c.secondsAgo < 10 ? '#15803d' : undefined }}>{c.secondsAgo}s ago</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="ss-field" style={{ maxWidth: 420 }}>
                    <label htmlFor="ss-mip">Mother PC's IP address</label>
                    <input id="ss-mip" className="mono" value={lanConfig.motherIp} placeholder="e.g. 192.168.1.10 â€” empty = cloud direct"
                      onChange={e => setLanConfig({ ...lanConfig, motherIp: e.target.value })} />
                  </div>
                )}
                <div className="ss-field" style={{ maxWidth: 420 }}>
                  <label htmlFor="ss-lkey">LAN sync key (the same on every PC in this depot)</label>
                  <input id="ss-lkey" className="mono" value={lanConfig.lanSyncKey} placeholder="e.g. garden-lan-2026"
                    onChange={e => setLanConfig({ ...lanConfig, lanSyncKey: e.target.value })} />
                </div>
                <div className="ss-inline">
                  <button type="button" className="ss-btn primary" onClick={handleSaveLan} disabled={savingLan}>
                    {savingLan ? 'Savingâ€¦' : 'Save LAN settings'}
                  </button>
                  {lanMessage && <span className={`ss-msg${lanMessage.includes('Failed') ? ' bad' : ''}`}>{lanMessage}</span>}
                </div>
              </div>
            </div>
          </section>

          <section id="ss-danger">
            <div className="ss-card danger">
              <Row title="Factory reset" help="Wipes everything on this device (products, orders, GRN, SIV, customers, suppliers) and disconnects it from the cloud. Cannot be undone.">
                <button type="button" className="ss-btn danger" onClick={() => setResetStep(1)}>Factory resetâ€¦</button>
              </Row>
            </div>
          </section>

          {changed.length > 0 && (
            <div className="ss-savebar" role="region" aria-label="Unsaved changes">
              <div>
                <b>{changed.length === 1 ? '1 change' : `${changed.length} changes`}</b> to {businessName || 'this depot'}'s settings
                <small>Only this depot is affected.</small>
              </div>
              <div className="ss-inline">
                <button type="button" className="ss-btn ghost" onClick={() => setForm(savedForm)} disabled={saving}>Discard</button>
                <button type="button" className="ss-btn save" onClick={() => handleSave()} disabled={saving}>{saving ? 'Savingâ€¦' : 'Save changes'}</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {toast && <div className="ss-toast" role="status">{toast}</div>}

      {/* â”€â”€ Confirm reset modals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {resetStep === 1 && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '36px 40px', maxWidth: 400, width: '90%', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#fee2e2', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
              <FiAlertTriangle size={28} color="#dc2626" />
            </div>
            <h3 style={{ margin: '0 0 8px', fontSize: 20 }}>Factory Reset?</h3>
            <p style={{ color: '#6b7280', fontSize: 14, margin: '0 0 24px' }}>
              This will permanently delete <strong>all data</strong> on this device â€” orders, products, GRN, SIV, customers, suppliers â€” and disconnect from cloud. This <strong>cannot be undone</strong>.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button onClick={() => setResetStep(0)} style={{ padding: '10px 24px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
              <button onClick={() => setResetStep(2)} style={{ padding: '10px 24px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>Yes, Continue</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {resetStep === 2 && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 16, padding: '36px 40px', maxWidth: 400, width: '90%', textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 18 }}>Delete Company Settings?</h3>
            <p style={{ color: '#6b7280', fontSize: 14, margin: '0 0 24px' }}>
              Do you also want to delete the company name, phone number, and email?
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => doFactoryReset(true)}  disabled={factoryResetting} style={{ padding: '12px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>
                {factoryResetting ? 'Resetting...' : 'Yes â€” Delete Everything'}
              </button>
              <button onClick={() => doFactoryReset(false)} disabled={factoryResetting} style={{ padding: '12px', background: '#f97316', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, fontWeight: 700 }}>
                {factoryResetting ? 'Resetting...' : 'No â€” Keep Company Settings'}
              </button>
              <button onClick={() => setResetStep(0)} disabled={factoryResetting} style={{ padding: '10px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      <AdminPasswordPrompt
        open={!!pendingDelete}
        subject={pendingDelete?.subject || ''}
        actionLabel={pendingDelete?.actionLabel || 'Confirm Delete'}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
};

export default SystemSettings;
