// UX-2 — attendant avatar (original artwork): a forecourt attendant in a cap,
// a ring showing progress to the next level, and the level number.
// Click (or Enter) opens the attendant's card: level, what's next, badges.
import React, { useEffect, useRef, useState } from 'react';
import { avatarLook, initials } from './attendantLevel';

export function AvatarFace({ name, size = 40, progress = 0, level = 1 }) {
  const look = avatarLook(name);
  const r = 22, c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox="0 0 52 52" aria-hidden="true" focusable="false" className="k-avatar-svg">
      <circle cx="26" cy="26" r={r} fill="none" stroke="#e2e8f0" strokeWidth="3.5" />
      <circle cx="26" cy="26" r={r} fill="none" stroke="#f59e0b" strokeWidth="3.5" strokeLinecap="round"
        strokeDasharray={`${c * Math.max(0.02, progress)} ${c}`} transform="rotate(-90 26 26)" />
      <clipPath id={`k-av-${initials(name)}-${size}`}><circle cx="26" cy="26" r="19" /></clipPath>
      <g clipPath={`url(#k-av-${initials(name)}-${size})`}>
        <rect x="0" y="0" width="52" height="52" fill="#f1f5f9" />
        <path d="M8 52 Q10 38 26 37 Q42 38 44 52 Z" fill={look.shirt} />
        <path d="M22 37 L26 43 L30 37 Z" fill="#fff" />
        <circle cx="26" cy="27" r="8.5" fill={look.skin} />
        <path d="M16.5 24 Q17 15 26 15 Q35 15 35.5 24 Z" fill={look.cap} />
        <path d="M26 23 L40 23 Q41 25 38 25.5 L26 25.5 Z" fill={look.cap} />
        <circle cx="26" cy="19.5" r="2.2" fill="#fbbf24" />
      </g>
      <g transform="translate(37 37)">
        <circle cx="6" cy="6" r="7" fill="#0f172a" stroke="#fff" strokeWidth="1.5" />
        <text x="6" y="9.2" textAnchor="middle" fontSize="8.5" fontWeight="800" fill="#fff" fontFamily="Inter, system-ui, sans-serif">{level}</text>
      </g>
    </svg>
  );
}

export default function AttendantAvatar({ profile, size = 36, showName = false, compact = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc, true); };
  }, [open]);
  if (!profile) return null;
  const { who, level } = profile;
  const name = who.name || 'Attendant';
  return (
    <span className="k-avatar" ref={ref}>
      <button type="button" className="k-avatar-btn" onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-expanded={open} aria-label={`${name}: level ${level.level}, ${level.title}. Show badges`}>
        <AvatarFace name={name} size={size} progress={level.progress} level={level.level} />
        {showName && <span className="k-avatar-name">{name}{!compact && <small>{level.title}</small>}</span>}
      </button>
      {open && <AttendantCard profile={profile} onClose={() => setOpen(false)} />}
    </span>
  );
}

export function AttendantCard({ profile }) {
  const { who, level, badges, stats } = profile;
  const earned = badges.filter((b) => b.earned).length;
  return (
    <div className="k-avatar-card" role="dialog" aria-label={`${who.name} — attendant card`} onClick={(e) => e.stopPropagation()}>
      <div className="k-avatar-card-head">
        <AvatarFace name={who.name} size={64} progress={level.progress} level={level.level} />
        <div>
          <div className="k-avatar-card-name">{who.name}</div>
          <div className="k-avatar-card-title">Level {level.level} · {level.title}</div>
          <div className="k-muted">{stats.completed} shift{stats.completed === 1 ? '' : 's'} finished</div>
        </div>
      </div>
      <div className="k-avatar-card-next">
        {level.next
          ? <>{level.toNext} more shift{level.toNext === 1 ? '' : 's'} to <strong>{level.next}</strong></>
          : <strong>Top level reached</strong>}
        <div className="k-progress" style={{ marginTop: 6 }}><div className="k-progress-fill k-tone-amber" style={{ width: `${Math.round(level.progress * 100)}%` }} /></div>
      </div>
      <div className="k-avatar-card-sub">Badges · {earned} of {badges.length}</div>
      <ul className="k-badges">
        {badges.map((b) => (
          <li key={b.key} className={b.earned ? 'k-badge-earned' : 'k-badge-todo'} title={b.earned ? b.title : `Not yet — ${b.how}`}>
            <span className="k-badge-icon" aria-hidden="true">{b.icon}</span>
            <span className="k-badge-title">{b.title}</span>
            <span className="k-badge-how">{b.earned ? 'Earned' : b.how}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// A short celebration after a shift brings a new level or badge.
export function Celebration({ who, items, onDone }) {
  useEffect(() => {
    if (!items || !items.length) return undefined;
    const t = setTimeout(onDone, 5000);
    return () => clearTimeout(t);
  }, [items, onDone]);
  if (!items || !items.length) return null;
  return (
    <div className="k-celebrate" role="status" aria-live="polite" onClick={onDone}>
      <div className="k-confetti" aria-hidden="true">{Array.from({ length: 14 }).map((_, i) => <i key={i} style={{ '--i': i }} />)}</div>
      <AvatarFace name={who} size={48} progress={1} level={items.find((x) => x.kind === 'level') ? '★' : '✓'} />
      <div>
        <div className="k-celebrate-title">Nice one, {String(who || '').split(' ')[0]}!</div>
        {items.map((m, i) => (
          <div key={i} className="k-celebrate-line">
            {m.kind === 'level' ? <>New level: <strong>{m.title}</strong></> : <>{m.icon} Badge earned: <strong>{m.title}</strong></>}
          </div>
        ))}
      </div>
    </div>
  );
}
