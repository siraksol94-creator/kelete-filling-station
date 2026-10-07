// Messages â€” in-app chat between HQ and the depots (2026-09-14).
//
// Desk: conversation list on the left, the open conversation on the right.
// Phone: the list, or the open conversation with a back button.
// Text, photos (camera or file), PDF / Excel / Word. Photos show in the chat;
// files download. A sender can delete their own message for 15 minutes.
// New messages arrive by polling: the open conversation every 3s, the list
// every 8s. Backend: /api/chat (routes/chat.js).
//
// Layout uses class names in the <style> block below, not inline display
// styles â€” the phone CSS rewrites inline flex/grid on every page.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  FiSend, FiPaperclip, FiCamera, FiPlus, FiUsers, FiSearch, FiArrowLeft,
  FiFileText, FiDownload, FiTrash2, FiX, FiMessageSquare, FiCheck, FiMic, FiBell,
} from 'react-icons/fi';
import Portal from '../utils/Portal';
import {
  getChatMe, getChatPeople, getChatConversations, startDirectChat, createChatGroup,
  updateChatMembers, getChatMessages, sendChatMessage, deleteChatMessage, markChatRead, getChatFile,
} from '../services/api';

const DELETE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// 2026-09-14 â€” voice notes: recorded in the browser with MediaRecorder,
// sent through the same file route as photos.
const MAX_VOICE_MS = 5 * 60 * 1000;
const MIN_VOICE_MS = 800;
const pickRecorderType = () => {
  if (typeof window === 'undefined' || !window.MediaRecorder || !window.MediaRecorder.isTypeSupported) return '';
  return ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/aac']
    .find((t) => window.MediaRecorder.isTypeSupported(t)) || '';
};
const clock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const utc = (s) => {
  const str = String(s || '');
  return new Date(/Z$|[+-]\d\d:?\d\d$/.test(str) ? str : `${str.replace(' ', 'T')}Z`);
};
// "Kelete Distribution - BANKERS (KABWE)" â†’ "Bankers (Kabwe)"; "HQ" stays.
const shortPlace = (name) => (String(name || '') === 'HQ' ? 'HQ' : String(name || '')
  .split(/\s+-\s+/).pop().replace(/\s+Depo$/i, '')
  .toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()));
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const sameDay = (a, b) => a.toDateString() === b.toDateString();
const hm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const listTime = (d) => {
  const now = new Date();
  if (sameDay(d, now)) return hm(d);
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
};
const dayLabel = (d) => {
  const now = new Date();
  if (sameDay(d, now)) return 'Today';
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round((n || 0) / 1024))} KB`);
const isShowableImage = (mime) => /^image\/(jpeg|png|webp|gif)$/i.test(String(mime || ''));
const errText = (e, fallback) => e?.response?.data?.error || fallback;

export default function Messages() {
  const [me, setMe] = useState(null);
  const [convs, setConvs] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [thread, setThread] = useState({ conversation: null, members: [], messages: [] });
  const [loadingThread, setLoadingThread] = useState(false);
  const [text, setText] = useState('');
  const [pendingFile, setPendingFile] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null); // 'direct' | 'group' | 'members'
  const [, setClock] = useState(0);
  const lastIdRef = useRef(0);
  const bodyRef = useRef(null);
  const fileRef = useRef(null);
  const camRef = useRef(null);
  const [rec, setRec] = useState(null);   // the voice note being recorded
  const [recMs, setRecMs] = useState(0);
  const recRef = useRef(null);
  const finishRef = useRef(null);

  useEffect(() => { getChatMe().then((r) => setMe(r.data)).catch(() => {}); }, []);

  // 2026-09-14 â€” opened from a notification or pop-up: /messages?c=<conversation id>.
  const location = useLocation();
  useEffect(() => {
    const c = parseInt(new URLSearchParams(location.search).get('c'), 10);
    if (c) setActiveId(c);
  }, [location.search]);

  // Computer notifications: offered once, until the user answers the browser.
  const [notifyAsk, setNotifyAsk] = useState(() => (
    typeof window !== 'undefined' && 'Notification' in window && window.Notification.permission === 'default'
  ));

  const loadConvs = useCallback(async () => {
    try { const r = await getChatConversations(); setConvs(r.data || []); } catch (_) { setConvs((c) => c || []); }
  }, []);
  useEffect(() => {
    loadConvs();
    const id = setInterval(loadConvs, 8000);
    return () => clearInterval(id);
  }, [loadConvs]);

  // Re-render every 30s so the 15-minute Delete button disappears on time.
  useEffect(() => { const id = setInterval(() => setClock((n) => n + 1), 30000); return () => clearInterval(id); }, []);

  const markRead = useCallback(async (convId, lastId) => {
    if (!convId || !lastId) return;
    try {
      await markChatRead(convId, lastId);
      setConvs((cs) => (cs || []).map((c) => (c.id === convId ? { ...c, unread: 0 } : c)));
      window.dispatchEvent(new Event('chat:refresh'));
    } catch (_) { /* next poll retries */ }
  }, []);

  const loadThread = useCallback(async (convId, { quiet } = {}) => {
    if (!quiet) { setLoadingThread(true); setError(''); }
    try {
      const r = await getChatMessages(convId);
      const msgs = r.data.messages || [];
      lastIdRef.current = msgs.length ? msgs[msgs.length - 1].id : 0;
      setThread({ conversation: r.data.conversation, members: r.data.members || [], messages: msgs });
      if (document.visibilityState === 'visible') markRead(convId, lastIdRef.current);
    } catch (e) {
      if (!quiet) setError(errText(e, 'Could not open this conversation.'));
      if (e?.response?.status === 403 || e?.response?.status === 404) { setActiveId(null); loadConvs(); }
    }
    if (!quiet) setLoadingThread(false);
  }, [markRead, loadConvs]);

  // Open a conversation; then poll for newer messages every 3s and refresh
  // the whole page every 30s (picks up messages deleted by others).
  useEffect(() => {
    if (!activeId) return undefined;
    setThread({ conversation: null, members: [], messages: [] });
    setText(''); setPendingFile(null); setRec(null);
    loadThread(activeId);
    let polls = 0;
    const id = setInterval(async () => {
      polls += 1;
      if (polls % 10 === 0) { loadThread(activeId, { quiet: true }); return; }
      try {
        const r = await getChatMessages(activeId, { after: lastIdRef.current });
        const fresh = r.data.messages || [];
        if (!fresh.length) return;
        lastIdRef.current = fresh[fresh.length - 1].id;
        setThread((t) => ({ ...t, messages: [...t.messages, ...fresh.filter((m) => !t.messages.some((x) => x.id === m.id))] }));
        if (document.visibilityState === 'visible') markRead(activeId, lastIdRef.current);
      } catch (_) { /* keep polling */ }
    }, 3000);
    return () => clearInterval(id);
  }, [activeId, loadThread, markRead]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [thread.messages.length, activeId]);

  const pickFile = (file) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { setError('That file is larger than 10 MB.'); return; }
    setError(''); setPendingFile(file);
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && !pendingFile) || !activeId || sending) return;
    setSending(true); setError('');
    try {
      const r = await sendChatMessage(activeId, body, pendingFile);
      const m = r.data;
      lastIdRef.current = Math.max(lastIdRef.current, m.id);
      setThread((t) => ({ ...t, messages: t.messages.some((x) => x.id === m.id) ? t.messages : [...t.messages, m] }));
      setText(''); setPendingFile(null);
      loadConvs();
    } catch (e) {
      setError(errText(e, 'The message was not sent. Try again.'));
    }
    setSending(false);
  };

  // â”€â”€ Voice notes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const stopTracks = (r) => { try { r?.stream?.getTracks().forEach((t) => t.stop()); } catch (_) { /* already stopped */ } };

  const startRecording = async () => {
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder === 'undefined') {
      setError('This device or browser cannot record voice notes.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = pickRecorderType();
      const recorder = new window.MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const r = { recorder, stream, chunks: [], startedAt: Date.now() };
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
      recorder.start(250);
      recRef.current = r;
      setRecMs(0);
      setRec(r);
    } catch (e) {
      setError(e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
        ? 'The microphone is blocked. Allow the microphone for this site or app, then try again.'
        : 'Could not start recording. Check that the device has a microphone.');
    }
  };

  // Stop the recording, then send it (sendIt) or throw it away.
  const finishRecording = async (sendIt) => {
    const r = recRef.current;
    if (!r) return;
    recRef.current = null;
    setRec(null);
    if (r.recorder.state !== 'inactive') {
      await new Promise((resolve) => { r.recorder.onstop = resolve; try { r.recorder.stop(); } catch (_) { resolve(); } });
    }
    stopTracks(r);
    if (!sendIt) return;
    if (Date.now() - r.startedAt < MIN_VOICE_MS || !r.chunks.length) { setError('That voice note was too short â€” tap the microphone and speak.'); return; }
    const baseType = String(r.recorder.mimeType || r.chunks[0].type || 'audio/webm').split(';')[0];
    const type = baseType.startsWith('audio/') ? baseType : 'audio/webm';
    const ext = /mp4|m4a|aac/.test(type) ? '.m4a' : /ogg/.test(type) ? '.ogg' : '.webm';
    const file = new File(r.chunks, `voice-note-${new Date().toISOString().replace(/[:.]/g, '-')}${ext}`, { type });
    if (file.size > MAX_FILE_BYTES) { setError('That voice note is larger than 10 MB.'); return; }
    if (!activeId) return;
    setSending(true); setError('');
    try {
      const res = await sendChatMessage(activeId, '', file);
      const m = res.data;
      lastIdRef.current = Math.max(lastIdRef.current, m.id);
      setThread((t) => ({ ...t, messages: t.messages.some((x) => x.id === m.id) ? t.messages : [...t.messages, m] }));
      loadConvs();
    } catch (e) {
      setError(errText(e, 'The voice note was not sent. Try again.'));
    }
    setSending(false);
  };
  finishRef.current = finishRecording;

  // Recording timer; stops and sends by itself at the 5-minute limit.
  useEffect(() => {
    if (!rec) return undefined;
    const id = setInterval(() => {
      const ms = Date.now() - rec.startedAt;
      setRecMs(ms);
      if (ms >= MAX_VOICE_MS) finishRef.current(true);
    }, 250);
    return () => clearInterval(id);
  }, [rec]);

  // Switching conversation or leaving the page drops an unfinished recording
  // and releases the microphone.
  useEffect(() => () => {
    const r = recRef.current;
    if (!r) return;
    recRef.current = null;
    try { if (r.recorder.state !== 'inactive') r.recorder.stop(); } catch (_) { /* ignore */ }
    stopTracks(r);
  // eslint-disable-next-line
  }, [activeId]);

  const removeMessage = async (m) => {
    if (!window.confirm('Delete this message for everyone?')) return;
    try {
      await deleteChatMessage(m.id);
      setThread((t) => ({ ...t, messages: t.messages.map((x) => (x.id === m.id ? { ...x, deleted: true, body: null, file: null } : x)) }));
      loadConvs();
    } catch (e) {
      setError(errText(e, 'Could not delete the message.'));
    }
  };

  const openConversation = async (id) => { await loadConvs(); setActiveId(id); setModal(null); };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (convs || []).filter((c) => !q || `${c.title} ${c.place || ''}`.toLowerCase().includes(q));
  }, [convs, search]);

  const conv = thread.conversation;
  const subtitle = conv
    ? (conv.kind === 'group' ? `${thread.members.length} members` : shortPlace(conv.place))
    : '';

  return (
    <div className="page-content msg-page">
      <style>{CSS}</style>
      <div className={`msg-shell${activeId ? ' has-thread' : ''}`}>
        {/* â”€â”€ Conversation list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <aside className="msg-list">
          <div className="msg-list-head">
            <h2>Messages</h2>
            <div className="msg-row-gap">
              {me?.isHqAdmin && (
                <button type="button" className="msg-ghost-btn" onClick={() => setModal('group')} title="Create a group">
                  <FiUsers /> <span>New group</span>
                </button>
              )}
              <button type="button" className="msg-primary-btn" onClick={() => setModal('direct')}>
                <FiPlus /> <span>New chat</span>
              </button>
            </div>
          </div>
          {notifyAsk && (
            <button type="button" className="msg-notify"
              onClick={async () => { try { await window.Notification.requestPermission(); } catch (_) { /* ignore */ } setNotifyAsk(false); }}>
              <FiBell /> Turn on computer notifications for new messages
            </button>
          )}
          <label className="msg-search">
            <FiSearch />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search conversations" />
          </label>
          <div className="msg-convos">
            {convs === null ? (
              <p className="msg-empty">Loadingâ€¦</p>
            ) : filtered.length === 0 ? (
              <p className="msg-empty">{convs.length ? 'No conversation matches that search.' : 'No conversations yet. Tap New chat to start one.'}</p>
            ) : filtered.map((c) => (
              <button type="button" key={c.id} className={`msg-convo${c.id === activeId ? ' on' : ''}`} onClick={() => setActiveId(c.id)}>
                <span className={`msg-av${c.kind === 'group' ? ' grp' : ''}`}>{c.kind === 'group' ? <FiUsers /> : initials(c.title)}</span>
                <span className="msg-convo-main">
                  <span className="msg-convo-top">
                    <b>{c.title}</b>
                    <small>{c.last_at ? listTime(utc(c.last_at)) : ''}</small>
                  </span>
                  <span className="msg-convo-bottom">
                    <span className="msg-preview">
                      {c.preview || (c.kind === 'group' ? `${c.member_count} members` : shortPlace(c.place))}
                    </span>
                    {c.unread > 0 && <span className="msg-unread">{c.unread > 99 ? '99+' : c.unread}</span>}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        {/* â”€â”€ Open conversation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        <section className="msg-thread">
          {!activeId ? (
            <div className="msg-placeholder">
              <FiMessageSquare size={42} />
              <p>Choose a conversation, or start a new chat.</p>
            </div>
          ) : (
            <>
              <header className="msg-thread-head">
                <button type="button" className="msg-back" onClick={() => setActiveId(null)} aria-label="Back to conversations">
                  <FiArrowLeft />
                </button>
                <div className="msg-thread-title">
                  <b>{conv?.title || 'â€¦'}</b>
                  {subtitle && <small>{subtitle}</small>}
                </div>
                {conv?.kind === 'group' && (
                  <button type="button" className="msg-ghost-btn" onClick={() => setModal('members')}>
                    <FiUsers /> <span>Members</span>
                  </button>
                )}
              </header>

              <div className="msg-body" ref={bodyRef}>
                {loadingThread && !thread.messages.length ? (
                  <p className="msg-empty">Loadingâ€¦</p>
                ) : thread.messages.length === 0 ? (
                  <p className="msg-empty">No messages yet. Say hello.</p>
                ) : thread.messages.map((m, i) => {
                  const d = utc(m.created_at);
                  const prev = thread.messages[i - 1];
                  const newDay = !prev || !sameDay(utc(prev.created_at), d);
                  const showSender = conv?.kind === 'group' && !m.mine && (newDay || !prev || prev.sender !== m.sender);
                  const canDelete = m.mine && !m.deleted && Date.now() - d.getTime() < DELETE_WINDOW_MS;
                  return (
                    <React.Fragment key={m.id}>
                      {newDay && <div className="msg-day"><span>{dayLabel(d)}</span></div>}
                      <div className={`msg-line${m.mine ? ' mine' : ''}`}>
                        <div className="msg-stack">
                          {showSender && <span className="msg-sender">{m.sender_name} Â· {shortPlace(m.sender_place)}</span>}
                          <div className={`msg-bubble${m.deleted ? ' deleted' : ''}`}>
                            {m.deleted ? (
                              <i>Message deleted</i>
                            ) : (
                              <>
                                {m.file && <Attachment message={m} />}
                                {m.body && <span className="msg-text">{m.body}</span>}
                              </>
                            )}
                          </div>
                          <span className="msg-meta">
                            {hm(d)}
                            {canDelete && (
                              <button type="button" className="msg-del" onClick={() => removeMessage(m)}>
                                <FiTrash2 /> Delete
                              </button>
                            )}
                          </span>
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>

              {error && <div className="msg-error">{error}</div>}
              {pendingFile && (
                <div className="msg-pending">
                  <FiPaperclip />
                  <span className="msg-pending-name">{pendingFile.name}</span>
                  <small>{fmtSize(pendingFile.size)}</small>
                  <button type="button" onClick={() => setPendingFile(null)} aria-label="Remove attachment"><FiX /></button>
                </div>
              )}
              {conv?.can_post === false ? (
                <div className="msg-readonly">Only HQ administrators post in Everyone. Their announcements appear here.</div>
              ) : (
              <footer className="msg-compose">
                {rec ? (
                  <div className="msg-rec">
                    <button type="button" className="msg-icon-btn" onClick={() => finishRecording(false)} title="Cancel" aria-label="Cancel the voice note">
                      <FiTrash2 />
                    </button>
                    <span className="msg-rec-dot" aria-hidden="true" />
                    <span className="msg-rec-time">Recording {clock(recMs)}</span>
                    <span className="msg-rec-hint">up to {clock(MAX_VOICE_MS)}</span>
                    <button type="button" className="msg-send" onClick={() => finishRecording(true)} title="Send voice note" aria-label="Send the voice note">
                      <FiSend />
                    </button>
                  </div>
                ) : (
                <>
                <button type="button" className="msg-icon-btn" onClick={() => fileRef.current?.click()} title="Attach a file" aria-label="Attach a file">
                  <FiPaperclip />
                </button>
                <button type="button" className="msg-icon-btn" onClick={() => camRef.current?.click()} title="Take a photo" aria-label="Take a photo">
                  <FiCamera />
                </button>
                <input ref={fileRef} type="file" style={{ display: 'none' }}
                  accept="image/*,.pdf,.xls,.xlsx,.csv,.doc,.docx,.txt"
                  onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
                <input ref={camRef} type="file" style={{ display: 'none' }} accept="image/*" capture="environment"
                  onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
                <textarea
                  rows={1}
                  value={text}
                  maxLength={4000}
                  placeholder="Write a messageâ€¦"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
                />
                {text.trim() || pendingFile ? (
                  <button type="button" className="msg-send" onClick={send} disabled={sending} aria-label="Send">
                    <FiSend />
                  </button>
                ) : (
                  <button type="button" className="msg-send" onClick={startRecording} disabled={sending} title="Record a voice note" aria-label="Record a voice note">
                    <FiMic />
                  </button>
                )}
                </>
                )}
              </footer>
              )}
            </>
          )}
        </section>
      </div>

      {modal === 'direct' && (
        <PeoplePicker title="New chat" onClose={() => setModal(null)}
          onPick={async (person) => { const r = await startDirectChat(person); await openConversation(r.data.id); }} />
      )}
      {modal === 'group' && (
        <GroupCreator onClose={() => setModal(null)}
          onCreate={async (title, members) => { const r = await createChatGroup(title, members); await openConversation(r.data.id); }} />
      )}
      {modal === 'members' && conv && (
        <MembersPanel conv={conv} members={thread.members} me={me} onClose={() => setModal(null)}
          onChanged={(members) => setThread((t) => ({ ...t, members }))} />
      )}
    </div>
  );
}

// â”€â”€ A message's file: photos inline, everything else as a download â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Attachment({ message }) {
  const { file } = message;
  const showable = isShowableImage(file.mime);
  const isAudio = /^audio\//i.test(String(file.mime || ''));
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!showable && !isAudio) return undefined;
    let objectUrl = null;
    let cancelled = false;
    getChatFile(message.id)
      .then((r) => { if (!cancelled) { objectUrl = URL.createObjectURL(r.data); setUrl(objectUrl); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [message.id, showable, isAudio]);

  const download = async () => {
    setBusy(true);
    try {
      const r = await getChatFile(message.id);
      const objectUrl = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = file.name || 'file';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
    } catch (_) {
      setFailed(true);
    }
    setBusy(false);
  };

  if (isAudio && !failed) {
    return (
      <div className="msg-voice">
        <FiMic className="msg-voice-icon" />
        {url
          ? <audio controls preload="metadata" src={url}>Voice note</audio>
          : <span className="msg-voice-loading">Loading voice noteâ€¦</span>}
      </div>
    );
  }
  if (showable && !failed) {
    return url ? (
      <button type="button" className="msg-photo" onClick={() => window.open(url, '_blank')} title="Open photo">
        <img src={url} alt={file.name || 'Photo'} />
      </button>
    ) : <span className="msg-photo loading" />;
  }
  return (
    <button type="button" className="msg-doc" onClick={download} disabled={busy}>
      <span className="msg-doc-icon"><FiFileText /></span>
      <span className="msg-doc-text">
        <b>{file.name}</b>
        <small>{failed ? 'Could not open â€” try again' : `${fmtSize(file.size)} Â· ${busy ? 'Downloadingâ€¦' : 'Download'}`}</small>
      </span>
      <FiDownload />
    </button>
  );
}

// â”€â”€ Modals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function Modal({ title, onClose, children, footer }) {
  return (
    <Portal>
      <div className="msg-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="msg-modal" role="dialog" aria-label={title}>
          <div className="msg-modal-head">
            <b>{title}</b>
            <button type="button" className="msg-icon-btn" onClick={onClose} aria-label="Close"><FiX /></button>
          </div>
          <div className="msg-modal-body">{children}</div>
          {footer && <div className="msg-modal-foot">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}

function usePeople() {
  const [people, setPeople] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    getChatPeople().then((r) => setPeople(r.data || [])).catch((e) => setError(errText(e, 'Could not load people.')));
  }, []);
  return { people, error };
}

// People grouped by place, HQ first.
function groupByPlace(people, query) {
  const q = query.trim().toLowerCase();
  const groups = {};
  for (const p of people) {
    const place = shortPlace(p.place);
    if (q && !`${p.name} ${place} ${p.role}`.toLowerCase().includes(q)) continue;
    (groups[place] = groups[place] || []).push(p);
  }
  return Object.entries(groups).sort(([a], [b]) => (a === 'HQ' ? -1 : b === 'HQ' ? 1 : a.localeCompare(b)));
}

// Tick list of people grouped by place, with "Select all" for everyone shown
// and for each place. Selecting respects the search: it ticks what is listed.
function PeopleChecklist({ people, query, chosen, setChosen }) {
  const groups = groupByPlace(people, query);
  const shown = groups.flatMap(([, list]) => list.map((p) => p.person));
  const allOn = (persons) => persons.length > 0 && persons.every((p) => chosen.includes(p));
  const setMany = (persons, on) => setChosen((c) => (on
    ? [...new Set([...c, ...persons])]
    : c.filter((x) => !persons.includes(x))));
  const toggle = (person) => setChosen((c) => (c.includes(person) ? c.filter((x) => x !== person) : [...c, person]));
  if (groups.length === 0) return <p className="msg-empty">{people.length ? 'Nobody matches that search.' : 'Nobody to add.'}</p>;
  return (
    <>
      <div className="msg-select-row">
        <button type="button" className="msg-select-all" onClick={() => setMany(shown, !allOn(shown))}>
          <span className={`msg-tick${allOn(shown) ? ' on' : ''}`}>{allOn(shown) && <FiCheck />}</span>
          {query.trim() ? `Select all shown (${shown.length})` : `Select everyone (${shown.length})`}
        </button>
      </div>
      {groups.map(([place, list]) => {
        const persons = list.map((p) => p.person);
        const on = allOn(persons);
        return (
          <div key={place} className="msg-people-group">
            <div className="msg-place-head">
              <span className="msg-people-place">{place}</span>
              <button type="button" className="msg-select-all sm" onClick={() => setMany(persons, !on)}>
                <span className={`msg-tick${on ? ' on' : ''}`}>{on && <FiCheck />}</span>
                All {list.length}
              </button>
            </div>
            {list.map((p) => {
              const picked = chosen.includes(p.person);
              return (
                <button type="button" key={p.person} className={`msg-person${picked ? ' on' : ''}`} onClick={() => toggle(p.person)}>
                  <span className="msg-av sm">{picked ? <FiCheck /> : initials(p.name)}</span>
                  <span className="msg-person-text"><b>{p.name}</b><small>{p.role}</small></span>
                </button>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

function PeoplePicker({ title, onClose, onPick }) {
  const { people, error } = usePeople();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pick = async (person) => {
    setBusy(true); setErr('');
    try { await onPick(person); } catch (e) { setErr(errText(e, 'Could not start the chat.')); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <label className="msg-search"><FiSearch /><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or depot" /></label>
      {(error || err) && <div className="msg-error">{error || err}</div>}
      {!people ? <p className="msg-empty">Loadingâ€¦</p> : groupByPlace(people, query).map(([place, list]) => (
        <div key={place} className="msg-people-group">
          <div className="msg-people-place">{place}</div>
          {list.map((p) => (
            <button type="button" key={p.person} className="msg-person" disabled={busy} onClick={() => pick(p.person)}>
              <span className="msg-av sm">{initials(p.name)}</span>
              <span className="msg-person-text"><b>{p.name}</b><small>{p.role}</small></span>
            </button>
          ))}
        </div>
      ))}
      {people && people.length === 0 && <p className="msg-empty">Nobody to message yet.</p>}
    </Modal>
  );
}

function GroupCreator({ onClose, onCreate }) {
  const { people, error } = usePeople();
  const [title, setTitle] = useState('');
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const create = async () => {
    if (!title.trim()) { setErr('Give the group a name.'); return; }
    if (!chosen.length) { setErr('Choose at least one member.'); return; }
    setBusy(true); setErr('');
    try { await onCreate(title.trim(), chosen); } catch (e) { setErr(errText(e, 'Could not create the group.')); setBusy(false); }
  };
  return (
    <Modal title="New group" onClose={onClose}
      footer={(
        <>
          <span className="msg-muted">{chosen.length} chosen</span>
          <button type="button" className="msg-primary-btn" disabled={busy} onClick={create}>{busy ? 'Creatingâ€¦' : 'Create group'}</button>
        </>
      )}>
      <label className="msg-field">Group name
        <input value={title} maxLength={80} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Kabwe team" />
      </label>
      <label className="msg-search"><FiSearch /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people" /></label>
      {(error || err) && <div className="msg-error">{error || err}</div>}
      {!people ? <p className="msg-empty">Loadingâ€¦</p> : <PeopleChecklist people={people} query={query} chosen={chosen} setChosen={setChosen} />}
    </Modal>
  );
}

function MembersPanel({ conv, members, me, onClose, onChanged }) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const change = async (add, remove) => {
    setBusy(true); setErr('');
    try {
      const r = await updateChatMembers(conv.id, add, remove);
      onChanged(r.data.members || []);
      setAdding(false);
    } catch (e) {
      setErr(errText(e, 'Could not change the members.'));
    }
    setBusy(false);
  };

  if (adding) {
    return (
      <AddMembers existing={members.map((m) => m.person)} busy={busy} err={err}
        onClose={() => setAdding(false)} onAdd={(list) => change(list, [])} />
    );
  }
  return (
    <Modal title={`${conv.title} Â· ${members.length} members`} onClose={onClose}
      footer={conv.can_manage ? (
        <button type="button" className="msg-primary-btn" onClick={() => setAdding(true)}><FiPlus /> Add people</button>
      ) : null}>
      {err && <div className="msg-error">{err}</div>}
      {conv.system === 'everyone' && (
        <p className="msg-note">Every active user is in Everyone automatically, including people added later. Only HQ administrators can post.</p>
      )}
      {members.map((m) => (
        <div key={m.person} className="msg-person static">
          <span className="msg-av sm">{initials(m.name)}</span>
          <span className="msg-person-text"><b>{m.name}{m.person === me?.person ? ' (you)' : ''}</b><small>{shortPlace(m.place)}</small></span>
          {conv.can_manage && m.person !== me?.person && (
            <button type="button" className="msg-remove" disabled={busy}
              onClick={() => { if (window.confirm(`Remove ${m.name} from this group?`)) change([], [m.person]); }}>
              Remove
            </button>
          )}
        </div>
      ))}
    </Modal>
  );
}

function AddMembers({ existing, busy, err, onClose, onAdd }) {
  const { people, error } = usePeople();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState([]);
  const available = (people || []).filter((p) => !existing.includes(p.person));
  return (
    <Modal title="Add people" onClose={onClose}
      footer={(
        <>
          <span className="msg-muted">{chosen.length} chosen</span>
          <button type="button" className="msg-primary-btn" disabled={busy || !chosen.length} onClick={() => onAdd(chosen)}>
            {busy ? 'Addingâ€¦' : 'Add to group'}
          </button>
        </>
      )}>
      <label className="msg-search"><FiSearch /><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search people" /></label>
      {(error || err) && <div className="msg-error">{error || err}</div>}
      {!people ? <p className="msg-empty">Loadingâ€¦</p>
        : available.length === 0 ? <p className="msg-empty">Everyone is already in this group.</p>
        : <PeopleChecklist people={available} query={query} chosen={chosen} setChosen={setChosen} />}
    </Modal>
  );
}

const CSS = `
.msg-page { --navy: #13306b; --ink: #0f172a; --muted: #64748b; --line: #e3e7ef; --ground: #f4f6fa; --red: #c8000a; }
.msg-shell {
  display: grid; grid-template-columns: 320px minmax(0, 1fr);
  height: calc(100vh - 130px); min-height: 440px;
  background: #fff; border: 1px solid var(--line); border-radius: 16px; overflow: hidden;
}
.msg-list { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); background: #fbfcfe; }
.msg-list-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 14px 14px 8px; }
.msg-list-head h2 { margin: 0; font-size: 18px; color: var(--ink); }
/* 2026-09-14 â€” HQ has two buttons; when they do not fit beside the title they
   drop under it instead of pushing "New chat" out of the column. */
.msg-row-gap { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
.msg-search { display: flex; align-items: center; gap: 8px; margin: 4px 14px 10px; padding: 8px 11px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: #94a3b8; }
.msg-search input { border: 0; outline: 0; flex: 1; min-width: 0; font-size: 14px; background: transparent; color: var(--ink); }
.msg-convos { flex: 1; overflow-y: auto; min-height: 0; }
.msg-convo { width: 100%; display: flex; gap: 10px; align-items: center; padding: 10px 14px; border: 0; border-left: 3px solid transparent; background: transparent; text-align: left; cursor: pointer; font: inherit; color: inherit; }
.msg-convo:hover { background: #f1f4f9; }
.msg-convo.on { background: #eaf0fa; border-left-color: var(--navy); }
.msg-av { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; background: var(--navy); color: #fff; font-weight: 700; font-size: 13px; }
.msg-av.grp { background: var(--red); }
.msg-av.sm { width: 34px; height: 34px; font-size: 12px; }
.msg-convo-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.msg-convo-top, .msg-convo-bottom { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.msg-convo-top b { font-size: 14px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-convo-top small { font-size: 11px; color: #94a3b8; white-space: nowrap; }
.msg-preview { font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-unread { flex: 0 0 auto; background: var(--red); color: #fff; font-size: 11px; font-weight: 700; border-radius: 999px; padding: 1px 7px; }
.msg-empty { color: #94a3b8; font-size: 13px; text-align: center; padding: 20px 14px; margin: 0; }

.msg-thread { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--ground); }
.msg-placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: #94a3b8; }
.msg-thread-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #fff; border-bottom: 1px solid var(--line); }
.msg-back { display: none; border: 0; background: transparent; padding: 6px; font-size: 20px; color: var(--ink); cursor: pointer; }
.msg-thread-title { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.msg-thread-title b { font-size: 15px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-thread-title small { font-size: 12px; color: var(--muted); }
.msg-body { flex: 1; overflow-y: auto; min-height: 0; padding: 14px 16px; display: flex; flex-direction: column; gap: 6px; }
.msg-day { display: flex; justify-content: center; margin: 8px 0 4px; }
.msg-day span { font-size: 11.5px; color: var(--muted); background: #fff; border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; }
.msg-line { display: flex; }
.msg-line.mine { justify-content: flex-end; }
.msg-stack { max-width: min(72%, 520px); display: flex; flex-direction: column; gap: 2px; }
.msg-line.mine .msg-stack { align-items: flex-end; }
.msg-sender { font-size: 11.5px; font-weight: 700; color: var(--navy); margin: 4px 0 0 2px; }
.msg-bubble { background: #fff; border: 1px solid var(--line); border-radius: 14px 14px 14px 4px; padding: 8px 11px; font-size: 14px; color: var(--ink); display: flex; flex-direction: column; gap: 6px; overflow-wrap: anywhere; }
.msg-line.mine .msg-bubble { background: var(--navy); border-color: var(--navy); color: #fff; border-radius: 14px 14px 4px 14px; }
.msg-bubble.deleted { background: transparent !important; color: var(--muted) !important; border-style: dashed !important; border-color: var(--line) !important; }
.msg-text { white-space: pre-wrap; }
.msg-meta { font-size: 11px; color: #94a3b8; display: flex; align-items: center; gap: 8px; margin: 0 2px; }
.msg-del { border: 0; background: transparent; color: #b91c1c; font-size: 11px; cursor: pointer; display: inline-flex; align-items: center; gap: 3px; padding: 0; }
.msg-photo { border: 0; padding: 0; background: #dbe2ec; border-radius: 10px; overflow: hidden; cursor: zoom-in; display: block; max-width: 260px; }
.msg-photo img { display: block; max-width: 260px; max-height: 260px; object-fit: cover; }
.msg-photo.loading { width: 220px; height: 140px; }
.msg-doc { display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); background: #f8fafc; color: var(--ink); border-radius: 10px; padding: 8px 10px; cursor: pointer; font: inherit; text-align: left; max-width: 300px; }
.msg-line.mine .msg-doc { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.25); color: #fff; }
.msg-doc-icon { flex: 0 0 auto; width: 32px; height: 38px; border-radius: 6px; background: #fdecec; color: var(--red); display: inline-flex; align-items: center; justify-content: center; }
.msg-doc-text { min-width: 0; display: flex; flex-direction: column; }
.msg-doc-text b { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-doc-text small { font-size: 11.5px; opacity: 0.75; }
.msg-error { margin: 0 14px 8px; padding: 8px 11px; background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; border-radius: 8px; font-size: 13px; }
.msg-pending { display: flex; align-items: center; gap: 8px; margin: 0 14px 6px; padding: 7px 10px; background: #fff; border: 1px solid var(--line); border-radius: 10px; font-size: 13px; color: var(--ink); }
.msg-pending-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.msg-pending small { color: var(--muted); }
.msg-pending button { border: 0; background: transparent; color: var(--muted); cursor: pointer; display: inline-flex; }
.msg-compose { display: flex; align-items: flex-end; gap: 6px; padding: 10px 12px; background: #fff; border-top: 1px solid var(--line); }
.msg-compose textarea { flex: 1; min-width: 0; resize: none; max-height: 120px; border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; font: inherit; font-size: 14px; outline: none; color: var(--ink); }
.msg-compose textarea:focus { border-color: var(--navy); }
.msg-icon-btn { flex: 0 0 auto; width: 38px; height: 38px; border: 1px solid var(--line); border-radius: 10px; background: #fff; color: var(--muted); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 17px; }
.msg-send { flex: 0 0 auto; width: 42px; height: 38px; border: 0; border-radius: 10px; background: var(--navy); color: #fff; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 17px; }
.msg-send:disabled { opacity: 0.45; cursor: default; }
.msg-primary-btn { display: inline-flex; align-items: center; gap: 6px; border: 0; border-radius: 9px; padding: 8px 12px; background: var(--navy); color: #fff; font: 600 13px/1 system-ui, sans-serif; cursor: pointer; white-space: nowrap; }
.msg-primary-btn:disabled { opacity: 0.55; cursor: default; }
.msg-ghost-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 9px; padding: 7px 11px; background: #fff; color: var(--navy); font: 600 13px/1 system-ui, sans-serif; cursor: pointer; white-space: nowrap; }
button:focus-visible, .msg-convo:focus-visible { outline: 2px solid var(--navy); outline-offset: 2px; }

.msg-overlay { position: fixed; top: 0; right: 0; bottom: 0; left: 0; background: rgba(15, 23, 42, 0.5); z-index: 3000; display: flex; align-items: center; justify-content: center; padding: 16px; }
.msg-modal { width: 100%; max-width: 440px; max-height: 86vh; background: #fff; border-radius: 14px; box-shadow: 0 24px 60px rgba(0,0,0,0.3); display: flex; flex-direction: column; overflow: hidden; }
.msg-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 14px 12px 18px; border-bottom: 1px solid var(--line); }
.msg-modal-head b { font-size: 16px; color: var(--ink); }
.msg-modal-head .msg-icon-btn { border: 0; }
.msg-modal-body { overflow-y: auto; padding: 12px 4px 12px 4px; }
.msg-modal-body .msg-search { margin: 0 14px 10px; }
.msg-modal-body .msg-error { margin: 0 14px 10px; }
.msg-modal-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--line); }
.msg-muted { color: var(--muted); font-size: 13px; }
.msg-field { display: flex; flex-direction: column; gap: 6px; margin: 0 14px 12px; font-size: 13px; font-weight: 600; color: #374151; }
.msg-field input { border: 1px solid var(--line); border-radius: 9px; padding: 9px 11px; font: inherit; font-size: 14px; font-weight: 400; outline: none; }
.msg-people-group { margin-bottom: 6px; }
.msg-people-place { font-size: 11.5px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; color: var(--muted); padding: 6px 18px 4px; }
.msg-person { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 18px; border: 0; background: transparent; text-align: left; cursor: pointer; font: inherit; color: inherit; }
.msg-person:hover { background: #f1f4f9; }
.msg-person.on { background: #eaf0fa; }
.msg-person.on .msg-av { background: #15803d; }
.msg-person.static { cursor: default; }
.msg-person.static:hover { background: transparent; }
.msg-person-text { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.msg-person-text b { font-size: 14px; color: var(--ink); }
.msg-person-text small { font-size: 12px; color: var(--muted); }
.msg-remove { border: 1px solid #fecaca; background: #fff; color: #b91c1c; border-radius: 8px; padding: 5px 10px; font-size: 12px; font-weight: 600; cursor: pointer; }

.msg-readonly { padding: 12px 16px; background: #fff; border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; text-align: center; }
.msg-note { margin: 0 18px 10px; padding: 8px 11px; background: #eef4ff; border: 1px solid #cddcff; border-radius: 8px; color: #1e3a8a; font-size: 13px; }
.msg-select-row { padding: 0 14px 6px; }
.msg-place-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-right: 14px; }
.msg-select-all { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--line); background: #fff; color: var(--navy); border-radius: 8px; padding: 6px 10px; font: 600 13px/1 system-ui, sans-serif; cursor: pointer; }
.msg-select-all.sm { padding: 3px 8px; font-size: 12px; }
.msg-tick { width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid #94a3b8; display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 11px; }
.msg-tick.on { background: #15803d; border-color: #15803d; }

.msg-notify { display: flex; align-items: center; gap: 8px; margin: 0 14px 8px; padding: 7px 10px; border: 1px dashed #93c5fd; border-radius: 9px; background: #eff6ff; color: #1d4ed8; font: 600 12.5px/1.3 system-ui, sans-serif; cursor: pointer; text-align: left; }
.msg-rec { flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0; }
.msg-rec-dot { width: 11px; height: 11px; border-radius: 50%; background: var(--red); animation: msgPulse 1s ease-in-out infinite; }
.msg-rec-time { font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
.msg-rec-hint { flex: 1; color: #94a3b8; font-size: 12px; }
@keyframes msgPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.msg-voice { display: flex; align-items: center; gap: 8px; background: #f1f5f9; border-radius: 999px; padding: 4px 10px 4px 12px; }
.msg-line.mine .msg-voice { background: rgba(255,255,255,0.92); }
.msg-voice-icon { color: var(--navy); flex: 0 0 auto; }
.msg-voice audio { height: 36px; width: 240px; max-width: 100%; }
.msg-voice-loading { font-size: 12.5px; color: var(--muted); padding: 8px 0; }
@media (prefers-reduced-motion: reduce) { .msg-rec-dot { animation: none; } }

@media (max-width: 768px) {
  .msg-voice audio { width: 190px; }
  .msg-shell { grid-template-columns: minmax(0, 1fr); height: calc(100dvh - 96px); border-radius: 12px; }
  .msg-shell.has-thread .msg-list { display: none; }
  .msg-shell:not(.has-thread) .msg-thread { display: none; }
  .msg-back { display: inline-flex; }
  .msg-list { border-right: 0; }
  .msg-list-head .msg-ghost-btn span, .msg-list-head .msg-primary-btn span { display: none; }
  .msg-stack { max-width: 85%; }
  .msg-photo, .msg-photo img { max-width: 220px; }
  .msg-thread-head .msg-ghost-btn span { display: none; }
}
@media (prefers-reduced-motion: reduce) { .msg-page * { scroll-behavior: auto !important; } }
`;
