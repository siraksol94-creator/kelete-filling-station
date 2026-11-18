import React, { useState, useEffect, useRef, useCallback } from 'react';
import { FiPlus, FiCheckCircle, FiClock, FiSearch, FiPackage, FiPrinter, FiZap } from 'react-icons/fi';
import { matchTokens } from '../utils/tokenSearch';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import Portal from '../utils/Portal';
import useModalScrollLock from '../utils/useModalScrollLock';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:5300/api';
const getToken = () => localStorage.getItem('token');
const headers = () => ({ 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` });

const StockCount = () => {
  const { hasPermission } = useAuth();
  const { t } = useLanguage();
  const [sessions, setSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [items, setItems] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState('');

  // Input state
  const [search, setSearch] = useState('');
  const [qty, setQty] = useState('');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightedIdx, setHighlightedIdx] = useState(-1);
  const [filter, setFilter] = useState('all'); // all, counted, uncounted
  const [tableSearch, setTableSearch] = useState('');
  const searchRef = useRef(null);

  // Session name modal
  const [showNewSession, setShowNewSession] = useState(false);
  const [newSessionName, setNewSessionName] = useState('');

  // PIN modal for Apply as Opening Balance
  const [showPin, setShowPin] = useState(false);
  const [pinValue, setPinValue] = useState('');

  // Mobile scroll-lock while any modal is open.
  useModalScrollLock(showPin || showNewSession);
  const [pinError, setPinError] = useState('');
  const APPLY_PIN = '108120';

  // Business info for print
  const [businessInfo, setBusinessInfo] = useState({});

  // Dropdown scroll ref
  const dropdownRef = useRef(null);
  const qtyRef = useRef(null);

  // Barcode scanner
  const [scannerActive, setScannerActive] = useState(false);
  const [scanNotFound, setScanNotFound] = useState(false);
  const scannerBuffer = useRef('');
  const scannerTimer = useRef(null);
  const scannerActiveRef = useRef(false);
  const productsRef = useRef([]);

  useEffect(() => { scannerActiveRef.current = scannerActive; }, [scannerActive]);
  useEffect(() => { productsRef.current = products; }, [products]);

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${API_BASE}/stock-count/sessions`, { headers: headers() });
      const data = await res.json();
      setSessions(Array.isArray(data) ? data : []);
      const active = data.find(s => s.status === 'Active');
      if (active) {
        setActiveSession(active);
        await fetchItems(active.id);
      }
    } catch (err) { setSessions([]); }
    setLoading(false);
  };

  const fetchItems = async (sessionId) => {
    try {
      const res = await fetch(`${API_BASE}/stock-count/sessions/${sessionId}/items`, { headers: headers() });
      const data = await res.json();
      setItems(Array.isArray(data) ? data : []);
    } catch (err) { setItems([]); }
  };

  const fetchProducts = async () => {
    try {
      const res = await fetch(`${API_BASE}/products`, { headers: headers() });
      const data = await res.json();
      setProducts(Array.isArray(data) ? data : []);
    } catch (err) { setProducts([]); }
  };

  const handleScannerKey = useCallback((e) => {
    if (!scannerActiveRef.current) return;
    // Don't intercept if focus is on search or qty inputs
    const tag = document.activeElement?.tagName;
    const type = document.activeElement?.type;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'Enter') {
      const code = scannerBuffer.current.trim();
      scannerBuffer.current = '';
      clearTimeout(scannerTimer.current);
      if (!code) return;
      const found = productsRef.current.find(p =>
        p.code && p.code.toLowerCase() === code.toLowerCase()
      );
      if (found) {
        setScanNotFound(false);
        setSelectedProduct(found);
        setSearch(found.name);
        setShowDropdown(false);
        setHighlightedIdx(-1);
        setTimeout(() => qtyRef.current?.focus(), 50);
      } else {
        setScanNotFound(true);
        setTimeout(() => setScanNotFound(false), 3000);
      }
    } else if (e.key.length === 1) {
      scannerBuffer.current += e.key;
      clearTimeout(scannerTimer.current);
      // Clear buffer if user stops typing for 300ms (not a scanner)
      scannerTimer.current = setTimeout(() => { scannerBuffer.current = ''; }, 300);
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleScannerKey);
    return () => document.removeEventListener('keydown', handleScannerKey);
  }, [handleScannerKey]);

  useEffect(() => {
    fetchSessions();
    fetchProducts();
    fetch(`${API_BASE}/settings`, { headers: headers() })
      .then(r => r.json())
      .then(d => { if (d?.business) setBusinessInfo(d.business); })
      .catch(() => {});
  }, []);

  const createSession = async () => {
    try {
      const res = await fetch(`${API_BASE}/stock-count/sessions`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ name: newSessionName.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || 'Failed to create session');
      setActiveSession(data);
      setSessions(prev => [data, ...prev]);
      setItems([]);
      setShowNewSession(false);
      setNewSessionName('');
    } catch (err) { alert('Failed to create session'); }
  };

  const addItem = async () => {
    if (!selectedProduct || !qty || parseFloat(qty) <= 0) return;
    try {
      const res = await fetch(`${API_BASE}/stock-count/sessions/${activeSession.id}/items`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({ product_id: selectedProduct.id, quantity: parseFloat(qty) }),
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || 'Failed to add item');

      // Reload the whole list from server — covers both updates AND new rows
      await fetchItems(activeSession.id);

      // Reset input
      setSearch('');
      setQty('');
      setSelectedProduct(null);
      setShowDropdown(false);
      setTimeout(() => searchRef.current?.focus(), 50);
    } catch (err) { alert('Failed to add item'); }
  };

  const applyAsOpeningBalance = () => {
    setPinValue('');
    setPinError('');
    setShowPin(true);
  };

  const confirmApply = async () => {
    if (pinValue !== APPLY_PIN) { setPinError('Incorrect PIN. Please try again.'); setPinValue(''); return; }
    setShowPin(false);
    setApplying(true);
    try {
      const res = await fetch(`${API_BASE}/stock-count/sessions/${activeSession.id}/apply`, {
        method: 'POST', headers: headers(),
      });
      const data = await res.json();
      if (!res.ok) return alert(data.error || 'Failed to apply');
      setMessage(`Opening balance applied for ${data.applied} products.`);
      setActiveSession(prev => ({ ...prev, status: 'Applied' }));
      setSessions(prev => prev.map(s => s.id === activeSession.id ? { ...s, status: 'Applied' } : s));
      await fetchItems(activeSession.id);
    } catch (err) { alert('Failed to apply'); }
    setApplying(false);
  };

  const handlePrint = () => {
    const biz = businessInfo;
    const bizName = biz.business_name || 'Business Name';
    const bizSub = [biz.business_address, biz.business_phone].filter(Boolean).join('  |  ');
    const printedAt = new Date().toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const counted = items.filter(i => i.counted_qty !== null).length;
    const fmt = v => parseFloat(v || 0).toFixed(2);

    const chips = [
      { label: 'Session', value: activeSession.name, bg: '#eff6ff', border: '#bfdbfe', color: '#1d4ed8' },
      { label: 'Date', value: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }), bg: '#f0fdf4', border: '#86efac', color: '#15803d' },
      { label: 'Total Products', value: String(items.length), bg: '#fff7ed', border: '#fed7aa', color: '#c2410c' },
      { label: 'Counted', value: String(counted), bg: '#f0fdf4', border: '#86efac', color: '#15803d' },
    ].map(c => `<div style="padding:12px 16px;border-radius:10px;background:${c.bg};border:1.5px solid ${c.border};text-align:center"><div style="font-size:9px;letter-spacing:0.8px;text-transform:uppercase;color:#64748b;font-weight:600;margin-bottom:5px">${c.label}</div><div style="font-size:14px;font-weight:800;color:${c.color}">${c.value}</div></div>`).join('');

    const rows = items.map((item, idx) => {
      const isCounted = item.counted_qty !== null;
      const diff = item.difference;
      const diffColor = !isCounted ? '#9ca3af' : diff > 0 ? '#16a34a' : diff < 0 ? '#dc2626' : '#374151';
      return `<tr style="border-bottom:1px solid #f1f5f9;background:${idx%2===1?'#fafafa':'#fff'}">
        <td style="padding:9px 14px;color:#9ca3af;font-size:10px">${idx+1}</td>
        <td style="padding:9px 14px;font-weight:500;color:${isCounted?'#111827':'#9ca3af'}">${item.product_name}</td>
        <td style="padding:9px 14px;text-align:right;font-family:monospace;color:#374151">${fmt(item.opening_balance??0)}</td>
        <td style="padding:9px 14px;text-align:right;font-weight:${isCounted?700:400};font-family:monospace;color:${isCounted?'#16a34a':'#9ca3af'}">${isCounted?fmt(item.counted_qty):'—'}</td>
        <td style="padding:9px 14px;text-align:right;font-weight:700;font-family:monospace;color:${diffColor}">${isCounted?(diff>0?`+${fmt(diff)}`:fmt(diff)):'—'}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      @page{size:A4 portrait;margin:12mm}
      *{box-sizing:border-box;margin:0;padding:0}
      body{font-family:"Segoe UI",Arial,sans-serif;font-size:12px;color:#1a1a2e}
      table{width:100%;border-collapse:collapse}
      .sig-line{height:40px;border-bottom:1.5px solid #cbd5e1;margin-bottom:6px}
      .sig-lbl{font-size:9px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;color:#6b7280;text-align:center}
      .sig-sub{font-size:9px;color:#9ca3af;margin-top:2px;text-align:center}
      @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
    </style></head><body>
      <div style="background:linear-gradient(135deg,#1e3a5f,#1e40af,#2563eb);padding:30px 44px 24px;color:#fff;display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div style="font-size:8px;letter-spacing:3px;text-transform:uppercase;opacity:0.6;margin-bottom:8px">Stock Count Report</div>
          <div style="font-size:22px;font-weight:800;letter-spacing:0.3px;margin-bottom:6px">${bizName}</div>
          <div style="font-size:10px;opacity:0.7">${bizSub}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:9px;letter-spacing:2px;text-transform:uppercase;opacity:0.55;margin-bottom:8px">Session</div>
          <div style="font-size:18px;font-weight:900;letter-spacing:0.5px;font-family:monospace">${activeSession.name}</div>
          <div style="margin-top:10px;display:inline-block;padding:3px 12px;border-radius:20px;font-size:10px;font-weight:700;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.35)">${activeSession.status}</div>
        </div>
      </div>
      <div style="height:4px;background:linear-gradient(90deg,#f59e0b,#2563eb,#22c55e,#a855f7)"></div>
      <div style="padding:28px 44px 40px">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:26px">${chips}</div>
        <div style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;margin-bottom:20px">
          <div style="background:#1e40af;padding:10px 16px">
            <span style="font-weight:700;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#dbeafe">Product Count Details</span>
          </div>
          <table>
            <thead><tr style="background:#eff6ff">
              <th style="padding:9px 14px;text-align:left;font-weight:700;color:#1d4ed8;border-bottom:1.5px solid #93c5fd;font-size:10px;width:30px">#</th>
              <th style="padding:9px 14px;text-align:left;font-weight:700;color:#1d4ed8;border-bottom:1.5px solid #93c5fd;font-size:10px">Product</th>
              <th style="padding:9px 14px;text-align:right;font-weight:700;color:#1d4ed8;border-bottom:1.5px solid #93c5fd;font-size:10px">Opening Balance</th>
              <th style="padding:9px 14px;text-align:right;font-weight:700;color:#1d4ed8;border-bottom:1.5px solid #93c5fd;font-size:10px">Counted</th>
              <th style="padding:9px 14px;text-align:right;font-weight:700;color:#1d4ed8;border-bottom:1.5px solid #93c5fd;font-size:10px">Difference</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:24px;margin-top:44px">
          ${['Prepared By','Verified By','Approved By'].map(label=>`
            <div><div class="sig-line"></div><div class="sig-lbl">${label}</div><div class="sig-sub">Name / Signature / Date</div></div>
          `).join('')}
        </div>
      </div>
      <div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:10px 44px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:9px;color:#94a3b8">${bizName} — Confidential Document</span>
        <span style="font-size:9px;color:#94a3b8">Printed: ${printedAt}</span>
      </div>
    </body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => { w.print(); w.close(); }, 300);
  };

  const filteredDropdown = products.filter(p =>
    !!search && matchTokens(search, p.name, p.code, p.barcode)
  ).slice(0, 20);

  const filteredItems = items.filter(i => {
    if (filter === 'counted' && i.counted_qty === null) return false;
    if (filter === 'uncounted' && i.counted_qty !== null) return false;
    if (tableSearch && !matchTokens(tableSearch, i.product_name, i.product_code)) return false;
    return true;
  });

  const countedCount = items.filter(i => i.counted_qty !== null).length;
  const totalCount = items.length;

  if (loading) return <div style={{ padding: 40, color: '#6b7280' }}>{t('loading')}</div>;

  return (
    <div className="page-content">

      {/* Header */}
      <div className="page-header">
        <div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{t('stockCount')}</h1>
          <p style={{ margin: '4px 0 0', color: '#6b7280', fontSize: 14 }}>Count physical stock and apply as opening balance</p>
        </div>
        {!activeSession && hasPermission('StockCount:Add') && (
          <button
            onClick={() => setShowNewSession(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 20px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}
          >
            <FiPlus /> {t('newStockCount')}
          </button>
        )}
      </div>

      {/* Sessions history (collapsed if active session) */}
      {!activeSession && (
        <div className="card" style={{ marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Sessions</h3>
          {sessions.length === 0 ? (
            <p style={{ color: '#9ca3af', textAlign: 'center', padding: 32 }}>No stock count sessions yet. Create one to get started.</p>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600 }}>Name</th>
                  <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600 }}>Status</th>
                  <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600 }}>Items Counted</th>
                  <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600 }}>Created</th>
                  <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600 }}>Created By</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map(s => (
                  <tr key={s.id}
                    onClick={() => { if (s.status === 'Active') { setActiveSession(s); fetchItems(s.id); } }}
                    style={{ borderTop: '1px solid #f1f5f9', cursor: s.status === 'Active' ? 'pointer' : 'default' }}
                  >
                    <td style={{ padding: '10px 12px', fontWeight: 500 }}>{s.name}</td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{
                        padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                        background: s.status === 'Active' ? '#dcfce7' : '#f3f4f6',
                        color: s.status === 'Active' ? '#16a34a' : '#6b7280',
                      }}>
                        {s.status === 'Active' ? <><FiClock size={11} /> Active</> : <><FiCheckCircle size={11} /> Applied</>}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px', color: '#374151' }}>{s.item_count}</td>
                    <td style={{ padding: '10px 12px', color: '#6b7280' }}>{s.created_at?.split('T')[0]}</td>
                    <td style={{ padding: '10px 12px', color: '#6b7280' }}>{s.created_by_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Active session UI */}
      {activeSession && (
        <>
          {/* Session info bar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '12px 18px', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <FiPackage style={{ color: '#16a34a' }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{activeSession.name}</div>
                <div style={{ fontSize: 12, color: '#6b7280' }}>{countedCount} of {totalCount} products counted</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {activeSession.status === 'Applied' && (
                <span style={{ background: '#f3f4f6', color: '#6b7280', borderRadius: 20, padding: '4px 14px', fontSize: 13, fontWeight: 600 }}>
                  <FiCheckCircle size={12} /> Applied
                </span>
              )}
              {activeSession.status === 'Active' && (
                <button
                  onClick={applyAsOpeningBalance}
                  disabled={applying || countedCount === 0}
                  style={{ padding: '9px 20px', background: applying ? '#9ca3af' : '#16a34a', color: '#fff', border: 'none', borderRadius: 8, cursor: applying ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 14 }}
                >
                  {applying ? 'Applying...' : 'Apply as Opening Balance'}
                </button>
              )}
              {activeSession.status === 'Active' && (
                <button
                  onClick={() => setScannerActive(v => !v)}
                  title={scannerActive ? 'Scanner Active — click to disable' : 'Enable barcode scanner'}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: scannerActive ? '#fef3c7' : '#fff', border: `1px solid ${scannerActive ? '#f59e0b' : '#e5e7eb'}`, borderRadius: 8, cursor: 'pointer', fontSize: 14, color: scannerActive ? '#b45309' : '#374151', fontWeight: scannerActive ? 600 : 400 }}
                >
                  <FiZap size={14} style={{ color: scannerActive ? '#f59e0b' : '#9ca3af' }} />
                  {scannerActive ? 'Scanner Active' : 'Scanner'}
                  {scannerActive && <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#f59e0b', display: 'inline-block', marginLeft: 2 }} />}
                </button>
              )}
              <button
                onClick={handlePrint}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 14, color: '#374151' }}
              >
                <FiPrinter size={14} /> Print
              </button>
              <button
                onClick={() => { setActiveSession(null); fetchSessions(); }}
                style={{ padding: '9px 16px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 14, color: '#374151' }}
              >
                View All Sessions
              </button>
            </div>
          </div>

          {message && (
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '12px 16px', marginBottom: 16, color: '#16a34a', fontWeight: 500 }}>
              {message}
            </div>
          )}

          {scannerActive && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 16px', marginBottom: 12, fontSize: 13, color: '#92400e' }}>
              <FiZap size={14} style={{ color: '#f59e0b' }} />
              <span><strong>Scanner Active</strong> — point your barcode scanner at a product. Focus on any input to type manually.</span>
            </div>
          )}

          {scanNotFound && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 16px', marginBottom: 12, fontSize: 13, color: '#dc2626', fontWeight: 600 }}>
              Product not found — barcode does not match any product code.
            </div>
          )}

          {/* Input section */}
          {activeSession.status === 'Active' && (
            <div className="card" style={{ marginBottom: 20 }}>
              <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 600 }}>Add Item</h3>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                {/* Product search */}
                <div style={{ flex: 1, position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1.5px solid #e5e7eb', borderRadius: 8, padding: '9px 12px' }}>
                    <FiSearch style={{ color: '#9ca3af' }} />
                    <input
                      ref={searchRef}
                      type="text"
                      value={search}
                      onChange={e => { setSearch(e.target.value); setSelectedProduct(null); setShowDropdown(true); setHighlightedIdx(-1); }}
                      onFocus={() => setShowDropdown(true)}
                      onBlur={() => setTimeout(() => setShowDropdown(false), 160)}
                      onKeyDown={e => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setHighlightedIdx(h => {
                            const next = Math.min(h + 1, filteredDropdown.length - 1);
                            setTimeout(() => {
                              const el = dropdownRef.current?.children[next];
                              el?.scrollIntoView({ block: 'nearest' });
                            }, 0);
                            return next;
                          });
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setHighlightedIdx(h => {
                            const next = Math.max(h - 1, 0);
                            setTimeout(() => {
                              const el = dropdownRef.current?.children[next];
                              el?.scrollIntoView({ block: 'nearest' });
                            }, 0);
                            return next;
                          });
                        } else if (e.key === 'Enter') {
                          e.preventDefault();
                          if (highlightedIdx >= 0 && filteredDropdown[highlightedIdx]) {
                            const p = filteredDropdown[highlightedIdx];
                            setSelectedProduct(p); setSearch(p.name); setShowDropdown(false); setHighlightedIdx(-1);
                            setTimeout(() => qtyRef.current?.focus(), 50);
                          } else if (selectedProduct) {
                            qtyRef.current?.focus();
                          }
                        } else if (e.key === 'Tab' && selectedProduct) {
                          e.preventDefault(); qtyRef.current?.focus();
                        }
                      }}
                      placeholder="Search product..."
                      style={{ border: 'none', outline: 'none', fontSize: 14, width: '100%' }}
                    />
                    {selectedProduct && <FiCheckCircle style={{ color: '#16a34a' }} />}
                  </div>
                  {showDropdown && filteredDropdown.length > 0 && (
                    <div ref={dropdownRef} style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999, background: '#fff', border: '1px solid #d1d5db', borderRadius: 8, maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.12)', marginTop: 2 }}>
                      {filteredDropdown.map((p, idx) => (
                        <div
                          key={p.id}
                          onMouseDown={() => { setSelectedProduct(p); setSearch(p.name); setShowDropdown(false); setHighlightedIdx(-1); setTimeout(() => qtyRef.current?.focus(), 50); }}
                          onMouseEnter={() => setHighlightedIdx(idx)}
                          style={{ padding: '9px 14px', cursor: 'pointer', fontSize: 13, background: highlightedIdx === idx ? '#f0fdf4' : '#fff', borderBottom: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between' }}
                        >
                          <span style={{ fontWeight: 500 }}>{p.name}</span>
                          <span style={{ color: '#9ca3af', fontSize: 12 }}>Stock: {p.current_stock ?? 0}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Quantity */}
                <input
                  ref={qtyRef}
                  type="number"
                  min="0"
                  step="0.01"
                  value={qty}
                  onChange={e => setQty(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') addItem(); }}
                  placeholder="Quantity"
                  style={{ width: 120, padding: '10px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: 14 }}
                />

                <button
                  onClick={addItem}
                  disabled={!selectedProduct || !qty}
                  style={{ padding: '10px 24px', background: (!selectedProduct || !qty) ? '#e5e7eb' : '#dc2626', color: (!selectedProduct || !qty) ? '#9ca3af' : '#fff', border: 'none', borderRadius: 8, cursor: (!selectedProduct || !qty) ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 14 }}
                >
                  Add
                </button>
              </div>
            </div>
          )}

          {/* Comparison table */}
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                Product Comparison
                <span style={{ marginLeft: 10, fontSize: 13, fontWeight: 400, color: '#6b7280' }}>
                  {countedCount} / {totalCount} counted
                </span>
              </h3>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ position: 'relative' }}>
                  <FiSearch style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af' }} size={14} />
                  <input
                    value={tableSearch}
                    onChange={e => setTableSearch(e.target.value)}
                    placeholder="Filter products..."
                    style={{ paddingLeft: 30, padding: '7px 10px 7px 28px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, width: 180 }}
                  />
                </div>
                {['all', 'counted', 'uncounted'].map(f => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    style={{
                      padding: '6px 14px', borderRadius: 20, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: 'none',
                      background: filter === f ? '#dc2626' : '#f3f4f6',
                      color: filter === f ? '#fff' : '#374151',
                    }}
                  >
                    {f === 'all' ? 'All' : f === 'counted' ? 'Counted' : 'Uncounted'}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ maxHeight: 480, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ background: '#f9fafb', position: 'sticky', top: 0, zIndex: 1 }}>
                  <th style={{ textAlign: 'left', padding: '10px 12px', fontWeight: 600 }}>Product</th>
                  <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600 }}>Store Opening Balance</th>
                  <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600 }}>Counted</th>
                  <th style={{ textAlign: 'right', padding: '10px 12px', fontWeight: 600 }}>Difference</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr><td colSpan="4" style={{ textAlign: 'center', color: '#9ca3af', padding: 40 }}>No products found.</td></tr>
                ) : filteredItems.map(item => {
                  const isCounted = item.counted_qty !== null;
                  const diff = item.difference;
                  return (
                    <tr key={item.product_id} style={{ borderTop: '1px solid #f1f5f9', background: isCounted ? '#fff' : '#fafafa' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 500, color: isCounted ? '#111827' : '#9ca3af' }}>
                        {item.product_name}
                        {!isCounted && <span style={{ marginLeft: 8, fontSize: 11, background: '#fee2e2', color: '#dc2626', borderRadius: 10, padding: '2px 8px' }}>Not counted</span>}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#374151' }}>{item.opening_balance ?? 0}</td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: isCounted ? 600 : 400, color: isCounted ? '#16a34a' : '#9ca3af' }}>
                        {isCounted ? item.counted_qty : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, color: !isCounted ? '#9ca3af' : diff > 0 ? '#16a34a' : diff < 0 ? '#dc2626' : '#374151' }}>
                        {isCounted ? (diff > 0 ? `+${diff}` : diff) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </div>
        </>
      )}

      {/* PIN modal for Apply as Opening Balance */}
      {showPin && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 14, padding: '32px 36px', width: 360, textAlign: 'center', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
            <h3 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 700 }}>Authorization Required</h3>
            <p style={{ margin: '0 0 20px', fontSize: 13, color: '#6b7280' }}>Enter PIN to apply as opening balance</p>
            <input
              type="password"
              value={pinValue}
              onChange={e => { setPinValue(e.target.value); setPinError(''); }}
              onKeyDown={e => { if (e.key === 'Enter') confirmApply(); }}
              placeholder="Enter PIN"
              autoFocus
              style={{ width: '100%', padding: '12px 16px', border: `2px solid ${pinError ? '#dc2626' : '#e5e7eb'}`, borderRadius: 8, fontSize: 18, textAlign: 'center', letterSpacing: 6, marginBottom: 8, boxSizing: 'border-box' }}
            />
            {pinError && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>{pinError}</div>}
            <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button onClick={() => setShowPin(false)} style={{ flex: 1, padding: '10px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
              <button onClick={confirmApply} style={{ flex: 1, padding: '10px', border: 'none', borderRadius: 8, background: '#16a34a', color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600 }}>Confirm</button>
            </div>
          </div>
        </div>
        </Portal>
      )}

      {/* New session modal */}
      {showNewSession && (
        <Portal>
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, width: 400 }}>
            <h3 style={{ margin: '0 0 16px', fontSize: 16, fontWeight: 600 }}>New Stock Count Session</h3>
            <label style={{ fontSize: 13, fontWeight: 500, color: '#374151' }}>Session Name (optional)</label>
            <input
              type="text"
              value={newSessionName}
              onChange={e => setNewSessionName(e.target.value)}
              placeholder={`Stock Count ${new Date().toISOString().split('T')[0]}`}
              style={{ width: '100%', padding: '9px 12px', border: '1.5px solid #e5e7eb', borderRadius: 8, fontSize: 14, marginTop: 6, marginBottom: 20, boxSizing: 'border-box' }}
              onKeyDown={e => { if (e.key === 'Enter') createSession(); }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setShowNewSession(false)} style={{ padding: '9px 18px', border: '1px solid #e5e7eb', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 14 }}>Cancel</button>
              <button onClick={createSession} style={{ padding: '9px 20px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 14 }}>Create</button>
            </div>
          </div>
        </div>
        </Portal>
      )}
    </div>
  );
};

export default StockCount;
