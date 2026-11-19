// UX-12 — Dashboard shortcuts tray. One-tap links to screens that sit deep
// in the side menu. Each tile is shown only to someone who can open that
// screen, and only where the side menu shows it (Empty Vouchers is a branch
// screen, never at head office).
import React, { useEffect, useState } from 'react';
import { FiPackage, FiChevronRight } from 'react-icons/fi';
import { listEmptyVouchers, isHqHost } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { voucherSummary } from './dashTrayModel';

export default function DashTray({ onNavigate = () => {} }) {
  const { hasPageAccess } = useAuth();
  const showVouchers = !isHqHost() && hasPageAccess('EmptyVouchers');
  const [open, setOpen] = useState(null); // null = not loaded / not allowed

  useEffect(() => {
    if (!showVouchers) return undefined;
    let alive = true;
    listEmptyVouchers({ active_only: 1, limit: 1000 })
      .then((res) => { if (alive) setOpen(voucherSummary(res.data)); })
      .catch(() => { /* the link still works without the count */ });
    return () => { alive = false; };
  }, [showVouchers]);

  if (!showVouchers) return null;

  return (
    <nav className="k-tray" aria-label="Shortcuts">
      <h3 className="k-section-title">Shortcuts</h3>
      <div className="k-tray-row">
        <button type="button" className="k-tray-tile" onClick={() => onNavigate('/store/empty-vouchers')}>
          <span className="k-tray-icon" aria-hidden="true"><FiPackage /></span>
          <span className="k-tray-text">
            <strong>Empty Vouchers</strong>
            <span>Bottles &amp; crates returned · deposit slips</span>
          </span>
          {open && (
            <span className={`k-tray-badge${open.slips ? '' : ' is-zero'}`}>
              {open.slips ? `${open.slips} open ${open.slips === 1 ? 'slip' : 'slips'}` : 'No open slips'}
            </span>
          )}
          <FiChevronRight className="k-tray-go" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
