// UX-12 — Dashboard shortcuts tray. One-tap links to screens that sit deep
// in the side menu. Each tile is shown only to someone who can open that
// screen (see trayTiles for where each one appears).
import React, { useEffect, useState } from 'react';
import { FiPackage, FiShoppingCart, FiChevronRight, FiDroplet } from 'react-icons/fi';
import { listEmptyVouchers, isHqHost } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { trayTiles, voucherSummary } from './dashTrayModel';
import { useCurrency } from '../context/CurrencyContext';
import { branchKind } from './branchType';

function Tile({ tone, icon, title, sub, badge, badgeZero, onClick }) {
  return (
    <button type="button" className={`k-tray-tile is-${tone}`} onClick={onClick}>
      <span className="k-tray-icon" aria-hidden="true">{icon}</span>
      <span className="k-tray-text">
        <strong>{title}</strong>
        <span>{sub}</span>
      </span>
      {badge && <span className={`k-tray-badge${badgeZero ? ' is-zero' : ''}`}>{badge}</span>}
      <FiChevronRight className="k-tray-go" aria-hidden="true" />
    </button>
  );
}

export default function DashTray({ onNavigate = () => {} }) {
  const { hasPageAccess } = useAuth();
  const { businessType } = useCurrency();
  const hq = isHqHost();
  const tiles = trayTiles({
    hq,
    kind: branchKind({ hq, businessType }),
    canPos: hasPageAccess('POS'),
    canVouchers: hasPageAccess('EmptyVouchers'),
  });
  const showVouchers = tiles.includes('vouchers');
  const [open, setOpen] = useState(null); // null = not loaded / not allowed

  useEffect(() => {
    if (!showVouchers) return undefined;
    let alive = true;
    listEmptyVouchers({ active_only: 1, limit: 1000 })
      .then((res) => { if (alive) setOpen(voucherSummary(res.data)); })
      .catch(() => { /* the link still works without the count */ });
    return () => { alive = false; };
  }, [showVouchers]);

  if (!tiles.length) return null;

  return (
    <nav className="k-tray" aria-label="Shortcuts">
      <h3 className="k-section-title">Shortcuts</h3>
      <div className="k-tray-row">
        {tiles.includes('fuel') && (
          <Tile
            tone="fuel"
            icon={<FiDroplet />}
            title="Fuel"
            sub="Attendant shifts, meters and tickets"
            onClick={() => onNavigate('/fuel/shifts')}
          />
        )}
        {tiles.includes('pos') && (
          <Tile
            tone="pos"
            icon={<FiShoppingCart />}
            title="Point of Sale"
            sub="Open the shop till and ring up a sale"
            onClick={() => onNavigate('/pos')}
          />
        )}
        {showVouchers && (
          <Tile
            tone="vouchers"
            icon={<FiPackage />}
            title="Empty Vouchers"
            sub="Bottles & crates returned · deposit slips"
            badge={open ? (open.slips ? `${open.slips} open ${open.slips === 1 ? 'slip' : 'slips'}` : 'No open slips') : null}
            badgeZero={open && !open.slips}
            onClick={() => onNavigate('/store/empty-vouchers')}
          />
        )}
      </div>
    </nav>
  );
}
