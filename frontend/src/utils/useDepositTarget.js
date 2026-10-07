// useDepositTarget â€” who this depot's cash actually goes to.
//
// 2026-09-18. System Settings â†’ Deposit to lets a depot send its cash to
// another depot instead of HQ (Bankers and Buwach â†’ Kabwe). The money already
// went to the right place, but every screen still said "HQ Deposits" and
// "sent to HQ", which reads as wrong to the depot sending it.
//
// This is the one place that answers "what do we call the destination here?".
// `label` is the short name for headings and tabs ("Kabwe", "HQ"); `name` is
// the full business name for sentences ("Kelete Distribution - KABWE").
//
// The answer is the same for every screen in a session, so it is fetched once
// and shared â€” Layout, the Cash Book tab, the deposits page and the Cash
// Report all ask, and only the first one calls the server.
import { useEffect, useState } from 'react';
import { getCashDepositTarget, isHqHost, getBranchSlug } from '../services/api';

// "kabwe" â†’ "Kabwe", "new-site" â†’ "New Site". Built from the slug, not the
// business name, which reads "Kelete Distribution - KABWE" and is too long
// for a tab.
export function labelFromSlug(slug) {
  return String(slug || '').split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

let cached;        // undefined = not asked yet, null = HQ, object = a depot
let inflight;

function load() {
  if (cached !== undefined) return Promise.resolve(cached);
  if (inflight) return inflight;
  if (isHqHost()) { cached = null; return Promise.resolve(cached); }
  const slug = getBranchSlug() || (window.location.hostname.split('.')[0] || '');
  if (!slug) { cached = null; return Promise.resolve(cached); }
  inflight = getCashDepositTarget(slug)
    .then(r => { cached = r.data?.to || null; return cached; })
    .catch(() => { cached = null; return cached; })   // unreachable â†’ say HQ, as before
    .finally(() => { inflight = null; });
  return inflight;
}

export default function useDepositTarget() {
  const [target, setTarget] = useState(cached === undefined ? null : cached);
  useEffect(() => {
    let alive = true;
    load().then(t => { if (alive) setTarget(t); });
    return () => { alive = false; };
  }, []);
  return {
    target,
    label: target?.slug ? labelFromSlug(target.slug) : 'HQ',
    name: target?.name || 'HQ',
    isHq: !target?.slug,
  };
}
