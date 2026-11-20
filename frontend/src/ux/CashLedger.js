// Cash Book ledger view for Kelete's Kwacha-only Cash / Mobile Money / Bank
// setup (see ux/cashBookModel.js). Pages/CashBook.js keeps every action —
// transfer, opening balance (with Administrator password), print, deposits —
// and the old per-currency view for any other setup.
import React, { useMemo, useState } from 'react';
import { FiArrowDownLeft, FiArrowUpRight, FiRepeat, FiDroplet, FiEdit2, FiSearch, FiSend, FiInbox, FiFileText } from 'react-icons/fi';
import ExportButtons from '../components/ExportButtons';
import { quickRanges } from './profitModel';
import { fmtDay } from './forecourt';
import { kindOf, moneyOf, periodTotals, matches, groupDays, accounts, exportRows, FILTERS } from './cashBookModel';

const ICONS = { in: FiArrowDownLeft, fuel: FiDroplet, out: FiArrowUpRight, move: FiRepeat, dep: FiSend, other: FiFileText };

export default function CashLedger({
  stats = {}, entries = [], from, to, today, onRange,
  canView = true, canEditOpening = false, onEditOpening, methodShown = () => true,
  depositTo = 'HQ', curSym = 'K',
}) {
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const money = (v, signed = false) => `${signed && Number(v) < 0 ? '−' : signed && Number(v) > 0 ? '+' : ''}${curSym}${Math.abs(parseFloat(v || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const hide = (s) => (canView ? s : 'N/A');

  const quick = useMemo(() => [...quickRanges(today), { key: 'alltime', label: 'All time', from: '', to: '' }], [today]);
  const activeQuick = quick.find((x) => x.from === (from || '') && x.to === (to || ''))?.key;
  const acc = accounts(stats, methodShown);
  const totals = periodTotals(entries);
  const shown = entries.filter((e) => matches(e, filter, q));
  const days = groupDays(shown);
  const period = !from && !to ? 'all time' : from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`;
  const opening = acc.open;

  return (
    <div className="k-cb">
      <div className="k-pr-toolbar">
        <div className="k-pr-quick" role="group" aria-label="Quick periods">
          {quick.map((x) => (
            <button key={x.key} type="button" aria-pressed={activeQuick === x.key}
              className={`k-pr-qchip${activeQuick === x.key ? ' is-on' : ''}`}
              onClick={() => onRange(x.from, x.to)}>{x.label}</button>
          ))}
        </div>
        <div className="k-pr-dates">
          <label>From <input type="date" value={from || ''} max={to || today} onChange={(e) => onRange(e.target.value, to || e.target.value)} /></label>
          <label>to <input type="date" value={to || ''} min={from || undefined} max={today} onChange={(e) => onRange(from || e.target.value, e.target.value)} /></label>
        </div>
      </div>

      {/* Where the money is now */}
      <section className="k-cb-accounts" aria-label="Balances">
        <div className="k-pr-kpi is-main">
          <span>Cash &amp; cash equivalent</span>
          <strong>{hide(money(acc.now))}</strong>
          <em>{canView && <>opening <b>{money(acc.open)}</b> · <b>{money(acc.change, true)}</b> since</>}</em>
          {canView && acc.now > 0 && (
            <div className="k-cb-share" aria-hidden="true">
              {acc.shares.map((s) => <div key={s.key} className={`is-${s.key}`} style={{ width: `${s.share * 100}%` }} />)}
            </div>
          )}
        </div>
        {acc.list.map((a) => (
          <div key={a.key} className={`k-pr-kpi k-cb-acc is-${a.key}${a.now < -0.001 ? ' is-neg' : ''}`}>
            <span><i className={`k-cb-key is-${a.key}`} aria-hidden="true" /> {a.label}</span>
            <strong>{hide(money(a.now))}</strong>
            <em>{canView && <>opening {money(a.open)} · <b className={a.change < 0 ? 'is-neg' : a.change > 0 ? 'is-pos' : ''}>{money(a.change, true)}</b></>}</em>
          </div>
        ))}
      </section>

      {/* The period */}
      <section className="k-cb-strip" aria-label={`Money moved, ${period}`}>
        <div className="k-cb-stat">
          <span>Opening balance</span>
          <strong>{hide(money(opening))}</strong>
          {canEditOpening && (
            <button type="button" className="k-cb-edit" onClick={onEditOpening}><FiEdit2 size={13} aria-hidden="true" /> Edit</button>
          )}
          {!canEditOpening && <small>{from || to ? 'choose All time to edit' : ''}</small>}
        </div>
        <div className="k-cb-stat is-in">
          <span><FiArrowDownLeft aria-hidden="true" /> Money in</span>
          <strong>{hide(money(totals.in))}</strong>
          {totals.fuel > 0 && <small><FiDroplet aria-hidden="true" /> fuel takings {money(totals.fuel)}</small>}
        </div>
        <div className="k-cb-stat is-out">
          <span><FiArrowUpRight aria-hidden="true" /> Money out</span>
          <strong>{hide(money(totals.out))}</strong>
        </div>
        <div className="k-cb-stat">
          <span><FiRepeat aria-hidden="true" /> Moved between accounts</span>
          <strong>{hide(money(totals.moved))}</strong>
          <small>not money in or out</small>
        </div>
        <div className="k-cb-stat is-net">
          <span>Net for {period}</span>
          <strong className={totals.net < 0 ? 'is-neg' : totals.net > 0 ? 'is-pos' : ''}>{hide(money(totals.net, true))}</strong>
        </div>
      </section>

      {/* Ledger */}
      <section className="k-pr-card">
        <header className="k-cb-head">
          <div className="k-pr-quick" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" aria-pressed={filter === f.key}
                className={`k-pr-qchip${filter === f.key ? ' is-on' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
            ))}
          </div>
          <div className="k-cb-tools">
            <label className="k-cb-search">
              <FiSearch aria-hidden="true" />
              <span className="k-sr-only">Search description or reference</span>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search description or reference" />
            </label>
            <ExportButtons
              rows={exportRows(shown, depositTo)}
              filename="cash-book" sheetName="CashBook"
              columns={[
                { key: 'date', label: 'Date' },
                { key: 'description', label: 'Description' },
                { key: 'reference', label: 'Reference' },
                { key: 'type', label: 'Type' },
                { key: 'money_in', label: 'In', format: (v) => Number(v || 0).toFixed(2) },
                { key: 'money_out', label: 'Out', format: (v) => Number(v || 0).toFixed(2) },
                { key: 'balance', label: 'Balance', format: (v) => Number(v || 0).toFixed(2) },
              ]}
              pdfOptions={{ title: 'Cash Book' }}
            />
          </div>
        </header>

        {days.length === 0 ? (
          <div className="k-cb-empty">
            <FiInbox aria-hidden="true" />
            <p>{entries.length ? 'Nothing matches this filter.' : `No money moved ${from || to ? 'in this period' : 'yet'}. Cash receipts, payment vouchers, supplier payments and transfers appear here.`}</p>
          </div>
        ) : (
          <div className="k-pr-scroll">
            <table className="k-cb-table">
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col">Reference</th>
                  <th scope="col" className="is-num">In</th>
                  <th scope="col" className="is-num">Out</th>
                  <th scope="col" className="is-num">Balance</th>
                </tr>
              </thead>
              {days.map((d) => (
                <tbody key={d.date}>
                  <tr className="k-cb-day">
                    <th scope="rowgroup" colSpan={2}>{fmtDay(d.date)}</th>
                    <td className="is-num">{d.in > 0 ? money(d.in) : ''}</td>
                    <td className="is-num">{d.out > 0 ? money(d.out) : ''}</td>
                    <td className="is-num"><span className="k-cb-close">closing</span> {hide(money(d.closing))}</td>
                  </tr>
                  {d.rows.map((e, i) => {
                    const k = kindOf(e, depositTo);
                    const m = moneyOf(e);
                    const Icon = ICONS[k.tone] || FiFileText;
                    return (
                      <tr key={`${e.reference}-${e.id || i}`} className={`k-cb-row is-${k.tone}`}>
                        <th scope="row">
                          <span className={`k-cb-ico is-${k.tone}`} aria-hidden="true"><Icon /></span>
                          <span className="k-cb-what">
                            <b>{e.description || k.label}</b>
                            {String(e.description || '').trim().toLowerCase() !== k.label.toLowerCase() && <small>{k.label}</small>}
                          </span>
                        </th>
                        <td className="k-cb-ref">{e.reference}</td>
                        {m.moved > 0 ? (
                          <td className="is-num k-cb-moved" colSpan={2}><FiRepeat aria-hidden="true" /> {money(m.moved)} moved</td>
                        ) : (
                          <>
                            <td className="is-num">{m.in > 0 ? <span className="is-pos">{money(m.in, true)}</span> : <span className="k-pr-na">—</span>}</td>
                            <td className="is-num">{m.out > 0 ? <span className="is-neg">{money(-m.out, true)}</span> : <span className="k-pr-na">—</span>}</td>
                          </>
                        )}
                        <td className="is-num k-cb-bal">{hide(money(m.balance))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        )}
        {(filter !== 'all' || q) && shown.length > 0 && (
          <p className="k-cb-foot">Showing {shown.length} of {entries.length} entries. Balances are the account balance after each entry, so they still count the hidden ones.</p>
        )}
      </section>
    </div>
  );
}
