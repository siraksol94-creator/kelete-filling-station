// ZRA Smart Invoice (VSDC) — Config + Initialize Device page.
//
// One-time setup screen: admin fills TPIN / BhfID / dvcSrlNo, points the
// backend at the local VSDC URL, then clicks Initialize. On success VSDC
// returns sdcId + counters that persist to business_settings.
import React, { useEffect, useState } from 'react';
import { FiSave, FiPlay, FiRefreshCw, FiCheckCircle, FiAlertTriangle, FiDownloadCloud, FiDatabase, FiSearch, FiTrendingDown, FiPackage, FiHome } from 'react-icons/fi';
import {
  getZraSettings, saveZraSettings, initializeZra, getZraAuditLog,
  syncZraCodes, syncZraItemClasses, syncZraNotices, syncZraAll,
  getZraSyncState, importZraItemClassesXlsx, isHqHost,
  // v1.13.128 — diagnostic + reconciliation endpoints.
  lookupZraInvoice, reconcileZraItems, syncZraRrp, reconcileZraStock, getZraBranches,
  getZraPendingFiscalisation,
  pullZraImports, getHqBranches,
  getZraPushPending, pushZraPendingBatch,
} from '../services/api';

const ENV_OPTIONS = [
  { value: 'sandbox',    label: 'Sandbox (testing)' },
  { value: 'production', label: 'Production (live)' },
];

const ZraConfig = () => {
  const [form, setForm] = useState({
    zra_env:         'sandbox',
    zra_vsdc_url:    '',
    zra_tpin:        '',
    zra_bhf_id:      '',
    zra_dvc_srl_no:  '',
    zra_enabled:     0,
    // v1.13.141 — T11A block-offline enforced ON by default for
    // compliance (ZRA UAT §3.11 T11A: "Invoice should not be created on
    // the CIS" when VSDC is offline). Toggle hidden from UI to prevent
    // users disabling it.
    zra_block_offline_sales: 1,
    // v1.13.154 — HQ-device proxy branch (only meaningful on HQ's own
    // row; branches ignore it since they check their own device first).
    zra_proxy_branch_slug: '',
    zra_proxy_secret: '',
  });
  const [hqBranchList, setHqBranchList] = useState([]); // for the proxy-branch dropdown

  // v1.13.175 — the backlog of sales rung before ZRA was connected.
  const [backlog, setBacklog] = useState(null);
  const [pushing, setPushing] = useState(false);
  const [pushDone, setPushDone] = useState(0);
  const [pushTotal, setPushTotal] = useState(0);
  const [pushStopped, setPushStopped] = useState(null);
  const [initState, setInitState] = useState({});   // sdc_id, mrc_no, last_* counters, initialized_at
  const [loading, setLoading]   = useState(true);
  const [saving, setSaving]     = useState(false);
  const [initing, setIniting]   = useState(false);
  const [message, setMessage]   = useState(null);   // {type: 'ok'|'err', text: ''}
  const [audit, setAudit]       = useState([]);
  const [selectedAudit, setSelectedAudit] = useState(null); // v1.13.144 audit-row detail modal
  const [syncState, setSyncState] = useState({ state: [], counts: { codes: 0, itemClasses: 0, notices: 0 } });
  const [syncing, setSyncing]     = useState({ codes: false, itemClasses: false, notices: false, all: false });
  // v1.13.37 — offline UNSPSC importer state. The Sync-tile is greyed
  // out until the VSDC WAR is installed; the importer works standalone.
  const [importingXlsx, setImportingXlsx] = useState(false);
  // v1.13.128 — Diagnostics card state. Each action has its own
  // { loading, result, error } bucket so a slow reconcile doesn't block
  // the operator from clicking Sync RRP in a different tile.
  const [invcNoInput, setInvcNoInput] = useState('');
  const [diagInvc, setDiagInvc]       = useState({ loading: false, result: null, error: null });
  const [diagItems, setDiagItems]     = useState({ loading: false, result: null, error: null });
  const [diagRrp, setDiagRrp]         = useState({ loading: false, result: null, error: null });
  const [diagStock, setDiagStock]     = useState({ loading: false, result: null, error: null });
  const [diagBranches, setDiagBranches] = useState({ loading: false, result: null, error: null });
  const [diagImports, setDiagImports] = useState({ loading: false, result: null, error: null }); // v1.13.151 — T05A GET IMPORTS
  // 2026-08-27 — age of the oldest unfiscalised order. Polled on load so
  // an ageing offline queue is visible without anyone going looking.
  const [pendingFisc, setPendingFisc] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [{ data: cfg }, { data: log }, { data: st }] = await Promise.all([
        getZraSettings(),
        getZraAuditLog({ limit: 100 }),
        getZraSyncState(),
      ]);
      setForm(f => ({
        ...f,
        zra_env:        cfg.zra_env        || 'sandbox',
        zra_vsdc_url:   cfg.zra_vsdc_url   || '',
        zra_tpin:       cfg.zra_tpin       || '',
        zra_bhf_id:     cfg.zra_bhf_id     || '',
        zra_dvc_srl_no: cfg.zra_dvc_srl_no || '',
        zra_enabled:    cfg.zra_enabled    || 0,
        zra_block_offline_sales: cfg.zra_block_offline_sales || 0,
        zra_proxy_branch_slug: cfg.zra_proxy_branch_slug || '',
        zra_proxy_secret: cfg.zra_proxy_secret || '',
      }));
      // v1.13.154 — branch list for the proxy-branch dropdown. HQ-only;
      // branches never need this field so skip the extra fetch there.
      if (isHqHost()) {
        try {
          const { data } = await getHqBranches();
          setHqBranchList(Array.isArray(data?.branches) ? data.branches : []);
        } catch { /* non-fatal — dropdown just stays empty */ }
      }
      setInitState({
        zra_sdc_id:             cfg.zra_sdc_id,
        zra_mrc_no:             cfg.zra_mrc_no,
        zra_taxpr_nm:           cfg.zra_taxpr_nm,
        zra_vat_ty_cd:          cfg.zra_vat_ty_cd,
        zra_last_invc_no:       cfg.zra_last_invc_no,
        zra_last_sale_invc_no:  cfg.zra_last_sale_invc_no,
        zra_last_pchs_invc_no:  cfg.zra_last_pchs_invc_no,
        zra_last_sale_rcpt_no:  cfg.zra_last_sale_rcpt_no,
        zra_last_train_invc_no: cfg.zra_last_train_invc_no,
        zra_last_copy_invc_no:  cfg.zra_last_copy_invc_no,
        zra_initialized_at:     cfg.zra_initialized_at,
      });
      // v1.13.144 — audit-log endpoint now returns { rows, total, endpoints, ... }
      // instead of a bare array. Accept either shape for backwards-compat.
      setAudit(Array.isArray(log) ? log : (Array.isArray(log?.rows) ? log.rows : []));
      setSyncState(st || { state: [], counts: { codes: 0, itemClasses: 0, notices: 0 } });
      try {
        const { data: pf } = await getZraPendingFiscalisation();
        setPendingFisc(pf);
      } catch { /* non-fatal — the banner just stays hidden */ }
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
    setLoading(false);
  };

  const runSync = async (key, fn, label) => {
    setSyncing(s => ({ ...s, [key]: true }));
    setMessage(null);
    try {
      const { data } = await fn();
      setMessage({ type: 'ok', text: `${label}: ${data.upserted ?? data.batches ?? 'done'}${data.note ? ' — ' + data.note : ''}` });
      load();
    } catch (e) {
      setMessage({ type: 'err', text: `${label} failed: ${e?.response?.data?.error || e.message}` });
      load();
    }
    setSyncing(s => ({ ...s, [key]: false }));
  };
  const syncStateByEndpoint = Object.fromEntries((syncState.state || []).map(r => [r.endpoint, r]));

  // v1.13.37 — file-picker handler for the offline UNSPSC importer.
  // v1.13.41 — seed the itemClasses count from the import response's
  //            final_count so the "rows cached" tile updates instantly
  //            even if the follow-up sync-state fetch lags.
  const handleImportUnspscXlsx = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so re-picking the same file re-triggers
    if (!file) return;
    setImportingXlsx(true); setMessage(null);
    try {
      const { data } = await importZraItemClassesXlsx(file);
      const finalCount = data.final_count ?? data.inserted;
      setMessage({
        type: 'ok',
        text: `Imported ${data.inserted?.toLocaleString?.() || data.inserted} rows${data.skipped ? ` · skipped ${data.skipped}` : ''} from "${data.sheet}". ${finalCount?.toLocaleString?.() || finalCount} UNSPSC classes now cached.`,
      });
      // Optimistic update — reflect the import in the counts tile right
      // away without waiting for /sync-state.
      setSyncState(s => ({
        ...s,
        counts: { ...(s.counts || {}), itemClasses: finalCount || 0 },
      }));
      load();
    } catch (err) {
      setMessage({ type: 'err', text: `Import failed: ${err?.response?.data?.error || err.message}` });
    }
    setImportingXlsx(false);
  };

  useEffect(() => { load(); }, []);

  const handleSave = async () => {
    setSaving(true); setMessage(null);
    try {
      // v1.13.93 — strip zra_enabled from the payload before send. The
      // backend rejects it anyway (compliance lock), but sending a stale
      // value from initial form state would surface a 400 to the user
      // for no useful reason.
      // eslint-disable-next-line no-unused-vars
      const { zra_enabled, ...safeForm } = form;
      await saveZraSettings(safeForm);
      setMessage({ type: 'ok', text: 'Settings saved.' });
      load();
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
    }
    setSaving(false);
  };

  const handleInitialize = async () => {
    if (!window.confirm('Call VSDC /initializer/selectInitInfo now? This registers this device with ZRA and stores the returned counters. Do it once per branch.')) return;
    setIniting(true); setMessage(null);
    try {
      const { data } = await initializeZra();
      setMessage({ type: 'ok', text: `Initialized. SDC ID: ${data.settings?.zra_sdc_id || '—'}` });
      load();
    } catch (e) {
      setMessage({ type: 'err', text: e?.response?.data?.error || e.message });
      load(); // still reload — audit log will show the failure
    }
    setIniting(false);
  };

  const isInitialized = !!initState.zra_initialized_at;
  const canInitialize = form.zra_vsdc_url && form.zra_tpin && form.zra_bhf_id && form.zra_dvc_srl_no;

  // v1.13.128 — Diagnostics handlers. Each wraps the corresponding API
  // helper with { loading → result | error } state so the tile can show
  // a spinner while pending and a coloured summary when done. Nothing
  // reloads the whole page — these are side calls, not saves.
  const runInvcLookup = async () => {
    const n = String(invcNoInput || '').trim();
    if (!/^\d+$/.test(n)) {
      setDiagInvc({ loading: false, result: null, error: 'Enter a numeric invoice number' });
      return;
    }
    setDiagInvc({ loading: true, result: null, error: null });
    try {
      const { data } = await lookupZraInvoice(n);
      setDiagInvc({ loading: false, result: data, error: null });
    } catch (e) {
      setDiagInvc({ loading: false, result: null, error: e?.response?.data?.error || e.message });
    }
  };
  const runReconcileItems = async () => {
    setDiagItems({ loading: true, result: null, error: null });
    try {
      const { data } = await reconcileZraItems(false);
      setDiagItems({ loading: false, result: data, error: null });
    } catch (e) {
      setDiagItems({ loading: false, result: null, error: e?.response?.data?.error || e.message });
    }
  };
  const runRrpSync = async () => {
    setDiagRrp({ loading: true, result: null, error: null });
    try {
      const { data } = await syncZraRrp(false);
      setDiagRrp({ loading: false, result: data, error: null });
    } catch (e) {
      setDiagRrp({ loading: false, result: null, error: e?.response?.data?.error || e.message });
    }
  };
  const runStockReconcile = async () => {
    setDiagStock({ loading: true, result: null, error: null });
    try {
      const { data } = await reconcileZraStock({});
      setDiagStock({ loading: false, result: data, error: null });
    } catch (e) {
      setDiagStock({ loading: false, result: null, error: e?.response?.data?.error || e.message });
    }
  };
  const runBranchesList = async () => {
    setDiagBranches({ loading: true, result: null, error: null });
    try {
      const { data } = await getZraBranches();
      setDiagBranches({ loading: false, result: data, error: null });
    } catch (e) {
      setDiagBranches({ loading: false, result: null, error: e?.response?.data?.error || e.message });
    }
  };
  // v1.13.151 — T05A GET IMPORTS diagnostic. Red Sea sources 100%
  // locally so this should always come back empty — that's the
  // EXPECTED, correct result for this taxpayer, not a failure.
  // 2026-08-26 — the inline approve/reject list that used to live in this
  // tile has moved to the dedicated HQ ZRA Import Queue page
  // (pages/ZraImports.js), which mirrors the Purchase Queue: destination
  // branch picker, editable quantity (T05A step 3), and status history.
  // This tile keeps the raw pull as a connectivity diagnostic only.
  const runImportsPull = async () => {
    setDiagImports({ loading: true, result: null, error: null });
    try {
      const { data } = await pullZraImports();
      setDiagImports({ loading: false, result: data, error: null });
    } catch (e) {
      setDiagImports({ loading: false, result: null, error: e?.response?.data?.error || e.message });
    }
  };

  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1px solid #d1d5db', fontSize: 14, boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 };

  const loadBacklog = async () => {
    try {
      const { data } = await getZraPushPending();
      setBacklog(data);
    } catch (_) { setBacklog(null); }
  };
  useEffect(() => { loadBacklog(); }, []);

  // Drains the backlog in small batches. Sequential on purpose: the server
  // pushes one order at a time so ZRA receives them in date order, and the
  // browser waits for each batch before asking for the next.
  const handlePushAll = async () => {
    const n = backlog?.pending || 0;
    if (!n) return;
    if (!window.confirm(
      `Send ${n} sale(s) to ZRA?\n\n`
      + `NO SALES MUST BE RUNG WHILE THIS RUNS. A new sale in the middle would `
      + `take an invoice number out of date order.\n\n`
      + `Each sale keeps the date it actually happened.`
    )) return;

    setPushing(true); setPushDone(0); setPushTotal(n); setPushStopped(null);
    let sent = 0;
    try {
      // Guard the loop on its own progress, not on a count that could stay
      // stale: if a batch sends nothing, stop rather than spin.
      for (;;) {
        const { data } = await pushZraPendingBatch(10);
        sent += data?.signed || 0;
        setPushDone(sent);
        if (data?.stopped_on) { setPushStopped(data.stopped_on); break; }
        if (!data?.attempted || !data?.remaining) break;
      }
    } catch (e) {
      setPushStopped({ error: e?.response?.data?.error || e.message });
    } finally {
      setPushing(false);
      loadBacklog();
    }
  };

  return (
    <div style={{ padding: 24, background: '#f8fafc', height: '100vh', overflowY: 'auto', boxSizing: 'border-box' }}>
      {/* v1.13.175 — sales rung before ZRA was connected. Sits at the very
          top because it is a one-off cutover job with a deadline: ZRA refuses
          anything more than 180 days old, and until this is empty those sales
          do not exist as far as the tax authority is concerned. Renders
          nothing once the backlog is clear. */}
      {backlog?.pending > 0 && (
        <div style={{ border: '1px solid #fcd34d', background: '#fffbeb', borderRadius: 12, padding: '16px 18px', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <FiAlertTriangle size={18} style={{ color: '#b45309', flex: 'none' }} />
            <strong style={{ color: '#92400e', fontSize: 15 }}>
              {backlog.pending.toLocaleString()} sale{backlog.pending === 1 ? '' : 's'} have never been sent to ZRA
            </strong>
            <button
              onClick={handlePushAll}
              disabled={pushing || !backlog.enabled}
              title={!backlog.enabled ? 'Connect this branch to ZRA first' : 'Send every waiting sale, oldest first'}
              style={{ marginLeft: 'auto', padding: '9px 20px', borderRadius: 9, border: 'none', background: (pushing || !backlog.enabled) ? '#d1d5db' : '#b45309', color: '#fff', cursor: (pushing || !backlog.enabled) ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>
              {pushing ? `Sending ${pushDone} of ${pushTotal}...` : 'Push All to ZRA'}
            </button>
          </div>

          <div style={{ fontSize: 12.5, color: '#92400e', marginTop: 8, lineHeight: 1.6 }}>
            {backlog.oldest && (
              <>From <strong>{String(backlog.oldest).slice(0, 10)}</strong> to <strong>{String(backlog.newest).slice(0, 10)}</strong>. </>
            )}
            Each sale is sent with the date it actually happened, not today's.
            {backlog.reversed_excluded > 0 && (
              <> <strong>{backlog.reversed_excluded} reversed sale(s) are NOT included</strong> — decide those separately.</>
            )}
            {!backlog.enabled && <> <strong>This branch is not connected to ZRA yet.</strong></>}
          </div>

          {/* Progress. A bar rather than a spinner: this can take minutes and
              the operator needs to see it moving, not just that it is busy. */}
          {(pushing || pushDone > 0) && (
            <div style={{ marginTop: 12 }}>
              <div style={{ height: 8, background: '#fde68a', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pushTotal ? Math.round((pushDone / pushTotal) * 100) : 0}%`, background: '#16a34a', transition: 'width .3s' }} />
              </div>
              <div style={{ fontSize: 12, color: '#92400e', marginTop: 5 }}>
                {pushDone} of {pushTotal} accepted by ZRA
                {pushing && ' — do not ring any sales until this finishes'}
              </div>
            </div>
          )}

          {pushStopped && (
            <div style={{ marginTop: 12, padding: '10px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12.5, color: '#991b1b' }}>
              <strong>Stopped.</strong>{' '}
              {pushStopped.order_number ? <>ZRA refused <strong>{pushStopped.order_number}</strong>. </> : null}
              {pushStopped.error || 'Refused by ZRA.'}
              {pushStopped.result_code ? ` (code ${pushStopped.result_code})` : ''}
              <div style={{ marginTop: 4 }}>
                Everything before it was accepted. Fix this one, then press Push All again to carry on.
              </div>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#111827' }}>ZRA Smart Invoice (VSDC)</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Configure the local VSDC service, then initialize this device with ZRA once.
          </p>
        </div>
        {/* v1.13.93 — pill promoted to authoritative reporting-status
            indicator. Green = every sale routes to VSDC (compliant).
            Amber = device not initialised yet, sales still commit
            locally but land with zra_status='FAILED' pending retry.

            2026-09-01 — the pill now names the ENVIRONMENT too. A green
            "ACTIVE" on sandbox read as compliant while nothing was reaching
            ZRA at all, and the only clue anywhere on this page was the word
            "sandbox" buried in the VSDC URL. Sandbox therefore gets its own
            colour rather than borrowing production's green — the point of the
            pill is to be readable at a glance, and reassurance is exactly the
            wrong thing to show for a device filing nothing.

            The two sources are checked against each other. zra_env is stored
            as sent, while the environment is really decided by which URL the
            calls go to, so the pair can disagree — and a device recorded as
            production while pointing at a sandbox URL is the dangerous case:
            it looks compliant and files nothing. That state gets red. */}
        {(() => {
          const url    = String(form.zra_vsdc_url || '');
          const stored = String(form.zra_env || '').toLowerCase();
          const urlSaysSandbox = /sandbox/i.test(url);
          const urlKnown = urlSaysSandbox || /vsdc/i.test(url);
          const mismatch = isInitialized && urlKnown &&
            ((stored === 'production' && urlSaysSandbox) ||
             (stored === 'sandbox' && !urlSaysSandbox && /prod/i.test(url)));
          const sandbox = urlSaysSandbox || stored === 'sandbox';

          let bg, fg, bd, Icon, label, hint;
          if (!isInitialized) {
            bg = '#fef3c7'; fg = '#a16207'; bd = '#fde68a'; Icon = FiAlertTriangle;
            label = 'ZRA REPORTING: NOT INITIALISED';
          } else if (mismatch) {
            bg = '#fee2e2'; fg = '#b91c1c'; bd = '#fecaca'; Icon = FiAlertTriangle;
            label = 'ZRA REPORTING: CHECK CONFIGURATION';
            hint  = `saved as ${stored}, URL points to ${urlSaysSandbox ? 'sandbox' : 'production'}`;
          } else if (sandbox) {
            bg = '#e0f2fe'; fg = '#075985'; bd = '#bae6fd'; Icon = FiAlertTriangle;
            label = 'ZRA REPORTING: SANDBOX';
            hint  = 'test only — nothing is filed with ZRA';
          } else if (urlKnown) {
            bg = '#dcfce7'; fg = '#166534'; bd = '#86efac'; Icon = FiCheckCircle;
            label = 'ZRA REPORTING: ACTIVE · PRODUCTION';
          } else {
            // Neither the URL nor the stored value says what this device is.
            // Green is a claim of compliance and must never be reached by
            // falling through — an empty URL with no stored environment used
            // to land here and print PRODUCTION.
            bg = '#fef3c7'; fg = '#a16207'; bd = '#fde68a'; Icon = FiAlertTriangle;
            label = 'ZRA REPORTING: ENVIRONMENT UNKNOWN';
            hint  = 'the VSDC URL does not say which one';
          }

          return (
            <div style={{
              padding: '8px 14px', borderRadius: 20, fontSize: 12, fontWeight: 700,
              background: bg, color: fg, border: `1.5px solid ${bd}`,
              display: 'inline-flex', alignItems: 'center', gap: 6,
              flexWrap: 'wrap', maxWidth: 520,
            }}>
              <Icon size={14} />
              {label}
              {hint && (
                <span style={{ fontWeight: 500, opacity: 0.85 }}>— {hint}</span>
              )}
              {isInitialized && initState.zra_initialized_at && (
                <span style={{ fontWeight: 500, opacity: 0.75 }}>
                  (since {initState.zra_initialized_at.split('T')[0]})
                </span>
              )}
            </div>
          );
        })()}
      </div>

      {message && (
        <div style={{
          padding: '12px 16px', marginBottom: 16, borderRadius: 8, fontSize: 13,
          background: message.type === 'ok' ? '#f0fdf4' : '#fef2f2',
          color:      message.type === 'ok' ? '#166534' : '#b91c1c',
          border:     `1px solid ${message.type === 'ok' ? '#86efac' : '#fecaca'}`,
        }}>{message.text}</div>
      )}

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
      ) : (
        <>
          {/* Editable config */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 22, marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#111827' }}>Device Configuration</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
              {/* v1.13.145 — Environment dropdown HIDDEN per Sirak
                  2026-08-25. A cashier/admin flipping this from
                  Production → Sandbox while live would silently divert
                  every fiscal call to sandbox — tax evasion by
                  accident. Environment is now inferred from the VSDC
                  URL alone; back-end still stores zra_env for the
                  logs. Unhide by removing the false-guard if a
                  legitimate need appears. */}
              {false && (
              <div>
                <label style={labelStyle}>Environment</label>
                <select value={form.zra_env} onChange={e => setForm({ ...form, zra_env: e.target.value })} style={inputStyle}>
                  {ENV_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              )}
              <div>
                <label style={labelStyle}>VSDC URL</label>
                <input type="text" value={form.zra_vsdc_url}
                  onChange={e => setForm({ ...form, zra_vsdc_url: e.target.value })}
                  placeholder="http://localhost:8080/zraSandboxVsdc" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>TPIN (10 digits)</label>
                <input type="text" value={form.zra_tpin} maxLength={10}
                  onChange={e => setForm({ ...form, zra_tpin: e.target.value })}
                  placeholder="1000000000" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Branch ID (3 chars, "000" = HQ)</label>
                <input type="text" value={form.zra_bhf_id} maxLength={3}
                  onChange={e => setForm({ ...form, zra_bhf_id: e.target.value })}
                  placeholder="000" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Device Serial No</label>
                <input type="text" value={form.zra_dvc_srl_no}
                  onChange={e => setForm({ ...form, zra_dvc_srl_no: e.target.value })}
                  placeholder="KELETE-POS-001" style={inputStyle} />
              </div>
              {/* 2026-08-27 — VSDC proxy secret. Only needed when a till
                  has no local VSDC and reaches this branch's VSDC through
                  the VPS (Electron desktops). Copy this value into the
                  Electron install's ZRA page along with the proxy URL;
                  vsdcClient then sends it automatically on every call.
                  Shown as a normal field so it can be copied and rotated
                  — it authenticates a machine, not a person. */}
              <div style={{ gridColumn: '1 / -1' }}>
                <label style={labelStyle}>
                  VSDC proxy secret
                  <span style={{ fontWeight: 400, color: '#6b7280' }}> — only for tills with no local VSDC (Electron)</span>
                </label>
                <input type="text" value={form.zra_proxy_secret || ''}
                  onChange={e => setForm({ ...form, zra_proxy_secret: e.target.value })}
                  placeholder="auto-generated" style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12 }} />
                <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, lineHeight: 1.6 }}>
                  On an Electron till set <strong>VSDC URL</strong> to
                  {' '}<code>https://&lt;branch&gt;.keletezm.com/api/zra/vsdc-proxy</code>{' '}
                  and paste this secret here. The desktop then fiscalises through the VPS —
                  no Tomcat needed locally, and VSDC itself stays private.
                  <br />
                  {/* 2026-08-27 — the BRANCH subdomain, not the bare host.
                      The bare host is HQ and resolves to HQ's database, whose
                      settings row holds a different secret — so a branch's
                      secret is rejected there. Each branch has its own VSDC
                      device and its own secret, so a till must address its
                      own branch. Getting this wrong cost a debugging round. */}
                  <strong>Use the branch subdomain</strong> (e.g. <code>garden.</code>), not the bare
                  domain — the bare domain is HQ and holds a different secret.
                </div>
              </div>
              {/* v1.13.154 — HQ-device proxy branch. HQ has no VSDC
                  device of its own by default (Pattern A) — the T06A
                  Purchase Queue page needs SOME device to talk to ZRA,
                  so this picks which branch's device to route through.
                  HQ-only (isHqHost()): branches always use their own
                  device and never read this column. "— use my own
                  device —" clears it, for once HQ ever registers
                  directly. */}
              {isHqHost() && (
              <div>
                <label style={labelStyle}>Purchase-pull proxy branch</label>
                <select value={form.zra_proxy_branch_slug}
                  onChange={e => setForm({ ...form, zra_proxy_branch_slug: e.target.value })}
                  style={inputStyle}>
                  <option value="">— use my own device (once registered) —</option>
                  {hqBranchList.map(b => <option key={b.slug} value={b.slug}>{b.name} ({b.slug})</option>)}
                </select>
              </div>
              )}
              {/* v1.13.93 — "Route sales through VSDC" checkbox removed.
                  ZRA compliance means every sale MUST route through VSDC —
                  the operator was never supposed to have an off switch.
                  Enabled auto-flips to 1 on successful Initialize Device;
                  reporting status is shown by the pill in the header
                  above. Backend PUT /zra/settings now rejects any
                  zra_enabled in the body. */}
              {/* v1.13.141 — T11A offline-block toggle hidden from the UI.
                  Per Sirak 2026-08-25: T11A mandates strict blocking
                  ("Invoice should not be created on the CIS" when VSDC is
                  offline), so it is enforced ON and hidden from Cashier /
                  Manager / Admin — nobody turns compliance off by
                  accident.
                  2026-08-27 — now visible on ELECTRON TILLS ONLY.
                  A desktop till has no local VSDC and reaches the VPS
                  through the proxy, so losing internet means losing
                  fiscalisation — and ZRA has confirmed queuing is
                  acceptable in that case. A till therefore needs the
                  choice; the web app (HQ and branch browsers) still
                  cannot see or change it, because there the VSDC sits on
                  the same server and an outage is an ops problem, not a
                  trading one. */}
              {/* 2026-08-30 — visible everywhere, not just on a till.
                  Hidden behind isElectronUa() while the till was the only
                  place it mattered. The first go-live is web-only, so this
                  switch — the one that decides whether a sale may proceed
                  when VSDC cannot be reached — would have been unreachable
                  during a ZRA launch. */}
              {(
              <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', marginTop: 4, background: form.zra_block_offline_sales ? '#fef3c7' : '#f9fafb', border: `1.5px solid ${form.zra_block_offline_sales ? '#fbbf24' : '#e5e7eb'}`, borderRadius: 8 }}>
                <input
                  id="zra_block_offline_sales"
                  type="checkbox"
                  checked={!!form.zra_block_offline_sales}
                  onChange={e => setForm({ ...form, zra_block_offline_sales: e.target.checked ? 1 : 0 })}
                  style={{ marginTop: 3, cursor: 'pointer' }}
                />
                <label htmlFor="zra_block_offline_sales" style={{ cursor: 'pointer', fontSize: 13, color: '#374151', lineHeight: 1.5, fontWeight: 700 }}>
                  Block sales when VSDC is offline
                  {form.zra_block_offline_sales
                    ? <span style={{ marginLeft: 8, padding: '1px 8px', background: '#f59e0b', color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 700 }}>ON</span>
                    : <span style={{ marginLeft: 8, padding: '1px 8px', background: '#dc2626', color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 700 }}>OFF</span>}
                  <div style={{ fontWeight: 400, fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                    <strong>ON</strong> — no sale is made without a fiscal receipt. Strictest reading of T11A.
                    <br />
                    <strong>OFF</strong> — the till keeps selling with a <em>provisional</em> receipt and the
                    invoice is fiscalised once it reconnects. The customer leaves with no QR or signature
                    until then, so only use this where ZRA has agreed to queuing.
                  </div>
                </label>
              </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
              <button onClick={handleSave} disabled={saving}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 22px', borderRadius: 8, border: 'none', background: saving ? '#9ca3af' : '#2563eb', color: '#fff', cursor: saving ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700 }}>
                <FiSave size={15} /> {saving ? 'Saving…' : 'Save Configuration'}
              </button>
              <button onClick={handleInitialize} disabled={initing || !canInitialize}
                title={!canInitialize ? 'Save configuration first' : 'Register this device with VSDC now'}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 22px', borderRadius: 8, border: 'none', background: (!canInitialize || initing) ? '#9ca3af' : '#16a34a', color: '#fff', cursor: (!canInitialize || initing) ? 'not-allowed' : 'pointer', fontSize: 14, fontWeight: 700 }}>
                <FiPlay size={15} /> {initing ? 'Initializing…' : 'Initialize Device'}
              </button>
              <button onClick={load} disabled={loading}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '10px 18px', borderRadius: 8, border: '1.5px solid #e5e7eb', background: '#fff', color: '#374151', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                <FiRefreshCw size={14} /> Reload
              </button>
            </div>
          </div>

          {/* Init state (read-only) — v1.13.145: counters HIDDEN per
              Sirak 2026-08-25. ZRA T01A verification only requires
              device status = "Activated"; the counters (VAT Type
              Code, Last Invoice No, Last Sale Invoice No, Last
              Purchase Invoice No, Last Sale Receipt No, Last Training
              Invoice, Last Copy Invoice) were not in the spec's
              verification list and just cluttered the panel with
              some fields never populated. Kept the 3 activation
              identifiers (SDC ID, MRC No, Taxpayer Name) that
              directly prove T01A activation. */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 22, marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700, color: '#111827' }}>Device Identity (from VSDC)</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
              {[
                ['SDC ID',        initState.zra_sdc_id],
                ['MRC No',        initState.zra_mrc_no],
                ['Taxpayer Name', initState.zra_taxpr_nm],
              ].map(([label, value]) => (
                <div key={label} style={{ padding: 12, borderRadius: 8, background: '#f9fafb', border: '1px solid #f3f4f6' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>{label}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: value ? '#111827' : '#cbd5e1', fontFamily: 'monospace' }}>{value ?? '—'}</div>
                </div>
              ))}
            </div>
          </div>

          {/* v1.13.37 — Offline UNSPSC importer. Populates
              zra_item_classes from ZRA's Excel file, so Item Details
              dropdowns work before the VSDC WAR is installed.
              v1.13.98 — Hidden on branches. Classification is HQ-owned
              (v1.13.86 locked the fields), branches only display
              read-only codes. The VSDC sync tile below populates the
              local table once VSDC WAR is live on that branch. */}
          {isHqHost() && (
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 22, marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#111827' }}>Import UNSPSC from Excel</h3>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: '#6b7280' }}>
                  Bulk-load the ZRA-published <strong>UNSPSC-Classification-Codes.xlsx</strong> straight into the local database. Use this to unblock Item Details before the VSDC WAR is installed — you can still re-sync from VSDC later.
                </p>
                <p style={{ margin: '6px 0 0', fontSize: 11, color: '#9ca3af' }}>
                  Rows currently cached: <strong style={{ color: '#111827' }}>{syncState.counts.itemClasses.toLocaleString()}</strong>
                </p>
              </div>
              <div>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 8, border: '1.5px solid #0ea5e9', background: importingXlsx ? '#f3f4f6' : '#fff', color: importingXlsx ? '#9ca3af' : '#0ea5e9', cursor: importingXlsx ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>
                  <FiDownloadCloud size={14} /> {importingXlsx ? 'Importing…' : 'Pick Excel file'}
                  <input type="file" accept=".xlsx,.xls" onChange={handleImportUnspscXlsx} disabled={importingXlsx} style={{ display: 'none' }} />
                </label>
              </div>
            </div>
          </div>
          )}

          {/* Data Sync — Codes / UNSPSC / Notices */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 22, marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#111827' }}>Data Sync (from VSDC)</h3>
              <button
                onClick={async () => {
                  setSyncing(s => ({ ...s, all: true })); setMessage(null);
                  try {
                    const { data } = await syncZraAll();
                    const parts = Object.entries(data).map(([k, v]) => `${k}: ${v?.error ? '❌ ' + v.error : (v?.upserted ?? v?.batches ?? 'ok')}`);
                    setMessage({ type: 'ok', text: 'Sync All → ' + parts.join(' · ') });
                  } catch (e) { setMessage({ type: 'err', text: e?.response?.data?.error || e.message }); }
                  setSyncing(s => ({ ...s, all: false })); load();
                }}
                disabled={syncing.all || !isInitialized}
                title={!isInitialized ? 'Initialize the device first' : 'Run all three syncs in sequence'}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '8px 16px', borderRadius: 8, border: 'none', background: (syncing.all || !isInitialized) ? '#9ca3af' : '#7c3aed', color: '#fff', cursor: (syncing.all || !isInitialized) ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>
                <FiDownloadCloud size={14} /> {syncing.all ? 'Syncing all…' : 'Sync All'}
              </button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
              {[
                { key: 'codes',       label: 'VSDC Codes',       endpoint: '/code/selectCodes',            count: syncState.counts.codes,       run: () => runSync('codes',       () => syncZraCodes(),       'Codes') },
                { key: 'itemClasses', label: 'UNSPSC Item Classes', endpoint: '/itemClass/selectItemsClass', count: syncState.counts.itemClasses, run: () => runSync('itemClasses', () => syncZraItemClasses(), 'Item classes') },
                { key: 'notices',     label: 'Notices',          endpoint: '/notices/selectNotices',       count: syncState.counts.notices,     run: () => runSync('notices',     () => syncZraNotices(),     'Notices') },
              ].map(card => {
                const st = syncStateByEndpoint[card.endpoint] || {};
                const okBadge = st.last_result_cd === '000';
                return (
                  <div key={card.key} style={{ padding: 14, borderRadius: 10, background: '#f9fafb', border: '1px solid #f3f4f6' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, fontWeight: 700, color: '#374151' }}>
                      <FiDatabase size={13} /> {card.label}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
                      <span style={{ fontSize: 22, fontWeight: 800, color: '#111827', fontFamily: 'monospace' }}>{card.count.toLocaleString()}</span>
                      <span style={{ fontSize: 11, color: '#6b7280' }}>rows cached</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
                      Last pulled: {st.last_pulled_at
                        ? new Date(/[TZ]/.test(st.last_pulled_at) ? st.last_pulled_at : st.last_pulled_at.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { hour12: false })
                        : '—'}
                      {st.last_result_cd && (
                        <span style={{ marginLeft: 6, padding: '1px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700, background: okBadge ? '#dcfce7' : '#fef2f2', color: okBadge ? '#166534' : '#b91c1c' }}>{st.last_result_cd}</span>
                      )}
                    </div>
                    {st.last_error && (
                      <div style={{ fontSize: 11, color: '#b91c1c', marginBottom: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={st.last_error}>
                        {st.last_error}
                      </div>
                    )}
                    <button onClick={card.run} disabled={syncing[card.key] || !isInitialized}
                      title={!isInitialized ? 'Initialize the device first' : 'Sync now'}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1.5px solid #2563eb', background: (syncing[card.key] || !isInitialized) ? '#f3f4f6' : '#fff', color: (syncing[card.key] || !isInitialized) ? '#9ca3af' : '#2563eb', cursor: (syncing[card.key] || !isInitialized) ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700 }}>
                      <FiDownloadCloud size={12} /> {syncing[card.key] ? 'Syncing…' : 'Sync Now'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* 2026-08-27 — Ageing unfiscalised queue.
              A provisional receipt is already in the customer's hand, and
              ZRA rejects sales submitted too late (921/922) — so a queue
              that quietly ages is a compliance risk, not just a backlog.
              Shown only when something is actually pending. */}
          {pendingFisc && pendingFisc.pending > 0 && (
            <div style={{
              marginBottom: 20, padding: '14px 18px', borderRadius: 12,
              background: pendingFisc.breached ? '#fef2f2' : '#fffbeb',
              border: `1.5px solid ${pendingFisc.breached ? '#f87171' : '#fbbf24'}`,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14, color: pendingFisc.breached ? '#991b1b' : '#92400e' }}>
                <FiAlertTriangle size={16} />
                {pendingFisc.pending} invoice{pendingFisc.pending > 1 ? 's' : ''} awaiting fiscalisation
                {pendingFisc.breached && ' — ACT NOW'}
              </div>
              <div style={{ fontSize: 12, color: '#374151', marginTop: 6, lineHeight: 1.7 }}>
                Oldest is <strong>{pendingFisc.oldest_age_hours} hours</strong> old
                (warning threshold {pendingFisc.warn_hours}h).
                {pendingFisc.breached
                  ? ' Customers already hold provisional receipts for these. ZRA rejects sales submitted too late, so these need to reach VSDC before the tolerance window closes.'
                  : ' The retry queue re-sends automatically once VSDC is reachable.'}
              </div>
              {(pendingFisc.orders || []).slice(0, 3).map(o => (
                <div key={o.id} style={{ fontSize: 11, color: '#6b7280', marginTop: 4, fontFamily: 'monospace' }}>
                  {o.order_number} · {o.age_hours}h · {o.retries} retries
                  {o.zra_error_code ? ` · [${o.zra_error_code}]` : ''}
                </div>
              ))}
            </div>
          )}

          {/* v1.13.128 — ZRA Diagnostics.
              Five operator-facing tools that were previously endpoint-only:
                • Invoice status lookup — "did ZRA get invoice N?"
                • Item reconciliation    — local products vs ZRA registry drift
                • Manufacturer RRP sync  — refresh MTV Category B pricing
                • Stock drift            — local current_stock vs ZRA ledger
                • Branch list            — ZRA's registered bhfIds for this TPIN
              All disabled until the device is initialized (no cfg → nothing
              to call). Each tile carries its own state so a slow reconcile
              doesn't block clicking another button.  */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 22, marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700, color: '#111827' }}>ZRA Diagnostics</h3>
            <p style={{ margin: '0 0 16px', fontSize: 12, color: '#6b7280' }}>
              On-demand reconciliation + lookup tools. Nothing here changes fiscal state — reads and non-destructive updates only.
            </p>

            {/* Invoice status lookup — text input + button + inline result */}
            <div style={{ padding: 14, borderRadius: 10, background: '#f9fafb', border: '1px solid #f3f4f6', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12, fontWeight: 700, color: '#374151' }}>
                <FiSearch size={13} /> Invoice status on ZRA
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap' }}>
                <input
                  type="text"
                  inputMode="numeric"
                  value={invcNoInput}
                  onChange={e => { setInvcNoInput(e.target.value.replace(/\D/g, '')); setDiagInvc({ loading: false, result: null, error: null }); }}
                  placeholder="Invoice number (e.g. 12345)"
                  style={{ flex: 1, minWidth: 180, padding: '8px 12px', border: '1.5px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'monospace', boxSizing: 'border-box' }}
                />
                <button onClick={runInvcLookup} disabled={diagInvc.loading || !isInitialized || !invcNoInput}
                  title={!isInitialized ? 'Initialize the device first' : 'Query ZRA for this invoice'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 16px', borderRadius: 6, border: '1.5px solid #2563eb', background: (diagInvc.loading || !isInitialized || !invcNoInput) ? '#f3f4f6' : '#2563eb', color: (diagInvc.loading || !isInitialized || !invcNoInput) ? '#9ca3af' : '#fff', cursor: (diagInvc.loading || !isInitialized || !invcNoInput) ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700 }}>
                  {diagInvc.loading ? 'Checking…' : 'Look up'}
                </button>
              </div>
              {diagInvc.error && (
                <div style={{ marginTop: 8, fontSize: 12, color: '#b91c1c' }}>{diagInvc.error}</div>
              )}
              {diagInvc.result && !diagInvc.error && (
                <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: diagInvc.result.exists ? '#f0fdf4' : '#fef2f2', border: `1px solid ${diagInvc.result.exists ? '#86efac' : '#fecaca'}`, fontSize: 12 }}>
                  {diagInvc.result.exists ? (
                    <>
                      <div style={{ fontWeight: 700, color: '#166534', marginBottom: 4 }}>✓ Invoice {diagInvc.result.invcNo} exists on ZRA</div>
                      <div style={{ color: '#374151', fontFamily: 'monospace', fontSize: 11 }}>
                        Receipt: {diagInvc.result.data?.rcptNo ?? '—'} · SDC: {diagInvc.result.data?.sdcId ?? '—'} · Signed: {diagInvc.result.data?.vsdcRcptPbctDate ?? '—'}
                      </div>
                    </>
                  ) : (
                    <div style={{ fontWeight: 700, color: '#b91c1c' }}>✗ Invoice {diagInvc.result.invcNo} not found on ZRA</div>
                  )}
                </div>
              )}
            </div>

            {/* Four action tiles — reconcile items / sync RRP / stock drift / branches */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
              {/* Item reconciliation */}
              <div style={{ padding: 14, borderRadius: 10, background: '#f9fafb', border: '1px solid #f3f4f6' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, fontWeight: 700, color: '#374151' }}>
                  <FiDatabase size={13} /> Item registry drift
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
                  Compare local products vs ZRA's item list. Flags unregistered, missing, or tax-mismatched rows.
                </div>
                <button onClick={runReconcileItems} disabled={diagItems.loading || !isInitialized}
                  title={!isInitialized ? 'Initialize the device first' : 'Run reconciliation now'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1.5px solid #2563eb', background: (diagItems.loading || !isInitialized) ? '#f3f4f6' : '#fff', color: (diagItems.loading || !isInitialized) ? '#9ca3af' : '#2563eb', cursor: (diagItems.loading || !isInitialized) ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700 }}>
                  <FiRefreshCw size={12} /> {diagItems.loading ? 'Checking…' : 'Reconcile'}
                </button>
                {diagItems.error && <div style={{ marginTop: 8, fontSize: 11, color: '#b91c1c' }}>{diagItems.error}</div>}
                {diagItems.result && !diagItems.error && (
                  <div style={{ marginTop: 8, fontSize: 11, color: '#374151', lineHeight: 1.7 }}>
                    <div>ZRA: <strong>{diagItems.result.total_on_zra}</strong> · Local: <strong>{diagItems.result.total_local}</strong></div>
                    <div>Matched: <strong style={{ color: '#166534' }}>{diagItems.result.matched}</strong></div>
                    {diagItems.result.unregistered_locally > 0 && <div style={{ color: '#a16207' }}>Never pushed: <strong>{diagItems.result.unregistered_locally}</strong></div>}
                    {diagItems.result.missing_on_zra > 0     && <div style={{ color: '#b91c1c' }}>Missing on ZRA: <strong>{diagItems.result.missing_on_zra}</strong></div>}
                    {diagItems.result.missing_locally > 0    && <div style={{ color: '#a16207' }}>On ZRA only: <strong>{diagItems.result.missing_locally}</strong></div>}
                    {diagItems.result.tax_mismatches > 0     && <div style={{ color: '#b91c1c' }}>Tax mismatches: <strong>{diagItems.result.tax_mismatches}</strong></div>}
                  </div>
                )}
              </div>

              {/* Manufacturer RRP sync */}
              <div style={{ padding: 14, borderRadius: 10, background: '#f9fafb', border: '1px solid #f3f4f6' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, fontWeight: 700, color: '#374151' }}>
                  <FiDownloadCloud size={13} /> Manufacturer RRP sync
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
                  Pull the latest Recommended Retail Prices from ZRA and refresh MTV Category B products.
                </div>
                <button onClick={runRrpSync} disabled={diagRrp.loading || !isInitialized}
                  title={!isInitialized ? 'Initialize the device first' : 'Pull RRPs now'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1.5px solid #16a34a', background: (diagRrp.loading || !isInitialized) ? '#f3f4f6' : '#fff', color: (diagRrp.loading || !isInitialized) ? '#9ca3af' : '#16a34a', cursor: (diagRrp.loading || !isInitialized) ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700 }}>
                  <FiDownloadCloud size={12} /> {diagRrp.loading ? 'Syncing…' : 'Sync RRPs'}
                </button>
                {diagRrp.error && <div style={{ marginTop: 8, fontSize: 11, color: '#b91c1c' }}>{diagRrp.error}</div>}
                {diagRrp.result && !diagRrp.error && (
                  <div style={{ marginTop: 8, fontSize: 11, color: '#374151', lineHeight: 1.7 }}>
                    <div>Pulled: <strong>{diagRrp.result.pulled ?? 0}</strong></div>
                    <div>Updated products: <strong style={{ color: '#166534' }}>{diagRrp.result.updated ?? 0}</strong></div>
                    {diagRrp.result.unmatched > 0 && <div style={{ color: '#6b7280' }}>Unmatched (not in our catalogue): <strong>{diagRrp.result.unmatched}</strong></div>}
                  </div>
                )}
              </div>

              {/* Stock drift check */}
              <div style={{ padding: 14, borderRadius: 10, background: '#f9fafb', border: '1px solid #f3f4f6' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, fontWeight: 700, color: '#374151' }}>
                  <FiTrendingDown size={13} /> Stock drift vs ZRA
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
                  Compare local current_stock against ZRA's ledger. Non-zero drift = a stock push likely failed.
                </div>
                <button onClick={runStockReconcile} disabled={diagStock.loading || !isInitialized}
                  title={!isInitialized ? 'Initialize the device first' : 'Check stock drift now'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1.5px solid #f59e0b', background: (diagStock.loading || !isInitialized) ? '#f3f4f6' : '#fff', color: (diagStock.loading || !isInitialized) ? '#9ca3af' : '#f59e0b', cursor: (diagStock.loading || !isInitialized) ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700 }}>
                  <FiRefreshCw size={12} /> {diagStock.loading ? 'Checking…' : 'Check drift'}
                </button>
                {diagStock.error && <div style={{ marginTop: 8, fontSize: 11, color: '#b91c1c' }}>{diagStock.error}</div>}
                {diagStock.result && !diagStock.error && (
                  <div style={{ marginTop: 8, fontSize: 11, color: '#374151', lineHeight: 1.7 }}>
                    <div>Items on ZRA: <strong>{diagStock.result.unique_items_on_zra ?? 0}</strong> · Matched local: <strong>{diagStock.result.matched_local ?? 0}</strong></div>
                    {diagStock.result.zra_result_note && (
                      <div style={{ color: '#b45309' }}>
                        ZRA answered: <strong>{diagStock.result.zra_result_cd || '—'} {diagStock.result.zra_result_note}</strong> — an empty list here is ZRA's own response, not a local filter.
                      </div>
                    )}
                    <div style={{ color: diagStock.result.drift_count > 0 ? '#b91c1c' : '#166534' }}>
                      Drift rows: <strong>{diagStock.result.drift_count ?? 0}</strong>
                    </div>
                    {diagStock.result.drift_count > 0 && (
                      <div style={{ marginTop: 6, maxHeight: 120, overflowY: 'auto', fontSize: 10, fontFamily: 'monospace' }}>
                        {(diagStock.result.drifts || []).slice(0, 5).map(d => (
                          <div key={d.id} style={{ padding: '2px 0', color: '#6b7280' }}>
                            {d.name}: local {d.local} · ZRA movements {d.zra_movement_qty ?? '—'}
                            {d.zra_movement_records ? ` (${d.zra_movement_records} rec)` : ''}
                            {d.note ? ` — ${d.note}` : ''}
                          </div>
                        ))}
                        {diagStock.result.drift_count > 5 && <div style={{ padding: '2px 0', color: '#9ca3af' }}>… and {diagStock.result.drift_count - 5} more</div>}
                      </div>
                    )}
                  </div>
                )}

                {/* 2026-08-26 — "Fix drift" button removed. It computed a
                    correction from an rsdQty (residual) field that
                    /stock/selectStockItems does not actually return, so its
                    delta treated ZRA as holding zero of everything. Backend
                    route now returns 410. See routes/zra.js for the full
                    writeup. Residual stock is push-only on VSDC; ZRA's
                    Stock Inventory page is the authoritative read. */}
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed #e5e7eb', fontSize: 11, color: '#6b7280', lineHeight: 1.6 }}>
                  This endpoint returns ZRA's <strong>movement ledger</strong> (per-movement quantities), not residual
                  stock levels — residual is push-only on VSDC. Compare residuals on the ZRA portal's
                  Stock Inventory page.
                </div>
              </div>

              {/* v1.13.151 — T05A Import declarations. Spec marks GET
                  IMPORTS mandatory even though Red Sea (100% local
                  suppliers) will always get back an empty list — this
                  tile demonstrates the CIS CAN make the call and
                  handles "no data" gracefully, which is the correct,
                  expected result for this taxpayer's business scope. */}
              <div style={{ padding: 14, borderRadius: 10, background: '#f9fafb', border: '1px solid #f3f4f6' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, fontWeight: 700, color: '#374151' }}>
                  <FiDownloadCloud size={13} /> Import declarations (ASYCUDA)
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
                  Pull import declarations Smart Invoice has for our TPIN. Red Sea sources locally — an empty result here is expected and correct.
                </div>
                <button onClick={runImportsPull} disabled={diagImports.loading || !isInitialized}
                  title={!isInitialized ? 'Initialize the device first' : 'Pull import declarations now'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1.5px solid #0ea5e9', background: (diagImports.loading || !isInitialized) ? '#f3f4f6' : '#fff', color: (diagImports.loading || !isInitialized) ? '#9ca3af' : '#0ea5e9', cursor: (diagImports.loading || !isInitialized) ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700 }}>
                  <FiDownloadCloud size={12} /> {diagImports.loading ? 'Pulling…' : 'Pull imports'}
                </button>
                {diagImports.error && <div style={{ marginTop: 8, fontSize: 11, color: '#b91c1c' }}>{diagImports.error}</div>}
                {diagImports.result && !diagImports.error && (
                  <div style={{ marginTop: 8, fontSize: 11, color: '#374151' }}>
                    <div>Declaration lines pulled: <strong style={{ color: (diagImports.result.pulled || 0) === 0 ? '#166534' : '#111827' }}>{diagImports.result.pulled ?? 0}</strong>
                      {diagImports.result.inserted != null && <span style={{ color: '#6b7280' }}> · {diagImports.result.inserted} new</span>}
                    </div>
                    {(diagImports.result.pulled || 0) === 0 ? (
                      <div style={{ color: '#9ca3af', marginTop: 2 }}>✓ Expected — no ASYCUDA declarations for this TPIN.</div>
                    ) : (
                      <div style={{ color: '#b45309', marginTop: 4 }}>
                        Review and decide them on the <strong>HQ ZRA Import Queue</strong> page.
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Branch list */}
              <div style={{ padding: 14, borderRadius: 10, background: '#f9fafb', border: '1px solid #f3f4f6' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12, fontWeight: 700, color: '#374151' }}>
                  <FiHome size={13} /> ZRA branches for this TPIN
                </div>
                <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 10 }}>
                  Show branch office IDs (bhfId) that ZRA has registered for our TPIN. Handy when opening a new depot.
                </div>
                <button onClick={runBranchesList} disabled={diagBranches.loading || !isInitialized}
                  title={!isInitialized ? 'Initialize the device first' : 'Fetch ZRA branches'}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 6, border: '1.5px solid #7c3aed', background: (diagBranches.loading || !isInitialized) ? '#f3f4f6' : '#fff', color: (diagBranches.loading || !isInitialized) ? '#9ca3af' : '#7c3aed', cursor: (diagBranches.loading || !isInitialized) ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700 }}>
                  <FiPackage size={12} /> {diagBranches.loading ? 'Loading…' : 'Show branches'}
                </button>
                {diagBranches.error && <div style={{ marginTop: 8, fontSize: 11, color: '#b91c1c' }}>{diagBranches.error}</div>}
                {diagBranches.result && !diagBranches.error && (
                  <div style={{ marginTop: 8, fontSize: 11, color: '#374151' }}>
                    <div style={{ marginBottom: 6 }}>Found: <strong>{(diagBranches.result.branches || []).length}</strong></div>
                    <div style={{ maxHeight: 140, overflowY: 'auto', fontSize: 10, fontFamily: 'monospace' }}>
                      {(diagBranches.result.branches || []).map((b, i) => (
                        <div key={i} style={{ padding: '3px 0', color: '#6b7280', borderTop: i > 0 ? '1px dashed #e5e7eb' : 'none' }}>
                          <strong style={{ color: '#111827' }}>{b.bhfId || '—'}</strong> · {b.bhfNm || '—'}
                          {b.locDesc && <span style={{ color: '#9ca3af' }}> · {b.locDesc}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Audit log — v1.13.144: rows clickable, opens detail modal with
              full request_body + response_body. Reviewer can inspect every
              VSDC round-trip without SSHing to the VPS. */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#111827' }}>Recent VSDC Calls</h3>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>{audit.length} entr{audit.length === 1 ? 'y' : 'ies'} · click a row for full request/response</span>
            </div>
            {audit.length === 0 ? (
              <div style={{ padding: 24, color: '#9ca3af', fontSize: 13, textAlign: 'center' }}>No VSDC calls yet. Click Initialize Device to make the first one.</div>
            ) : (
              <div style={{ overflowX: 'auto', maxHeight: 500 }}>
                <table className="phone-cards" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f9fafb', color: '#6b7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, position: 'sticky', top: 0 }}>
                      <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>When</th>
                      <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Endpoint</th>
                      <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Result</th>
                      <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 700 }}>Message</th>
                      <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 700 }}>ms</th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.map(r => {
                      const ok = r.result_cd === '000';
                      return (
                        <tr key={r.id}
                            style={{ borderTop: '1px solid #f1f5f9', cursor: 'pointer' }}
                            onClick={() => setSelectedAudit(r)}
                            onMouseEnter={e => e.currentTarget.style.background = '#f9fafb'}
                            onMouseLeave={e => e.currentTarget.style.background = ''}>
                          <td style={{ padding: '10px 12px', color: '#374151', whiteSpace: 'nowrap' }}>{(() => {
                            const raw = r.created_at || r.created_at_local; if (!raw) return '—';
                            const iso = /[TZ]/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z';
                            return new Date(iso).toLocaleString('en-GB', { hour12: false });
                          })()}</td>
                          <td style={{ padding: '10px 12px', color: '#6b7280', fontFamily: 'monospace', fontSize: 12 }}>{r.endpoint}</td>
                          <td style={{ padding: '10px 12px' }}>
                            <span style={{ display: 'inline-block', padding: '2px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700, background: ok ? '#dcfce7' : '#fef2f2', color: ok ? '#166534' : '#b91c1c' }}>
                              {r.result_cd || '—'}
                            </span>
                          </td>
                          <td style={{ padding: '10px 12px', color: '#6b7280', fontSize: 12, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.result_msg || '—'}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'right', color: '#6b7280', fontFamily: 'monospace' }}>{r.duration_ms ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* v1.13.144 — Audit-row detail modal. Pretty-prints the JSON
              request and response bodies so the ZRA reviewer sees exactly
              what left the CIS and what VSDC responded. */}
          {selectedAudit && (() => {
            const prettyJson = (s) => {
              if (!s) return '(empty)';
              try { return JSON.stringify(JSON.parse(s), null, 2); }
              catch { return s; }
            };
            const ok = selectedAudit.result_cd === '000';
            return (
              <div onClick={() => setSelectedAudit(null)}
                   style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
                <div onClick={e => e.stopPropagation()}
                     style={{ background: '#fff', borderRadius: 12, width: '100%', maxWidth: 900, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
                  {/* Header */}
                  <div style={{ padding: '16px 22px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: '#111827', fontFamily: 'monospace' }}>{selectedAudit.endpoint}</div>
                      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{(() => {
                        const raw = selectedAudit.created_at || selectedAudit.created_at_local; if (!raw) return '—';
                        const iso = /[TZ]/.test(raw) ? raw : raw.replace(' ', 'T') + 'Z';
                        return new Date(iso).toLocaleString('en-GB', { hour12: false });
                      })()} · {selectedAudit.duration_ms ?? '—'} ms · HTTP {selectedAudit.http_status ?? '—'}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <span style={{ display: 'inline-block', padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700, background: ok ? '#dcfce7' : '#fef2f2', color: ok ? '#166534' : '#b91c1c' }}>
                        {selectedAudit.result_cd || '—'} {selectedAudit.result_msg ? '· ' + selectedAudit.result_msg : ''}
                      </span>
                      <button onClick={() => setSelectedAudit(null)}
                              style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: '#6b7280', lineHeight: 1 }}
                              title="Close">×</button>
                    </div>
                  </div>
                  {/* Body panels */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0, overflow: 'auto', flex: 1 }}>
                    <div style={{ padding: '14px 22px 6px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #f1f5f9' }}>Request Body</div>
                    <pre style={{ margin: 0, padding: '12px 22px', fontSize: 12, fontFamily: 'monospace', color: '#111827', background: '#f9fafb', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflow: 'auto' }}>{prettyJson(selectedAudit.request_body)}</pre>
                    <div style={{ padding: '14px 22px 6px', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, borderBottom: '1px solid #f1f5f9', borderTop: '1px solid #e5e7eb' }}>Response Body</div>
                    <pre style={{ margin: 0, padding: '12px 22px', fontSize: 12, fontFamily: 'monospace', color: '#111827', background: '#f9fafb', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 300, overflow: 'auto' }}>{prettyJson(selectedAudit.response_body)}</pre>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* v1.13.98 — "Onboarding steps" banner removed at user
              request. One-time setup checklist that added no value once
              the device was initialised. Sandbox portal still reachable
              at https://sandboxportal.zra.org.zm/ if needed later. */}
        </>
      )}
    </div>
  );
};

export default ZraConfig;
