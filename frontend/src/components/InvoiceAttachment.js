// Reusable invoice attachment picker — upload PDF/image from disk OR camera capture.
// Used in GRN and Payment Voucher forms.
//
// Props:
//   value   — current attachment path stored on the record (or null)
//   onChange(newPath | null) — called after a successful upload or removal
//   kind    — short tag used in the filename (e.g. 'grn', 'pv')
//   disabled
import React, { useRef, useState } from 'react';
import { FiPaperclip, FiCamera, FiX, FiFileText, FiImage, FiUpload, FiEye } from 'react-icons/fi';
import { uploadInvoiceAttachment, deleteInvoiceAttachment } from '../services/api';

const InvoiceAttachment = ({ value, onChange, kind = 'invoice', disabled = false }) => {
  const fileRef = useRef(null);
  const camRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const apiBase = (process.env.REACT_APP_API_URL || '/api').replace(/\/api\/?$/, '');
  const fullUrl = value ? `${apiBase}/uploads/${value}` : null;
  const isPdf = (value || '').toLowerCase().endsWith('.pdf');

  const doUpload = async (file) => {
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const res = await uploadInvoiceAttachment(file, kind);
      onChange(res.data.path);
    } catch (e) {
      // Surface the real cause so 404 / 401 / multer errors don't just say "failed".
      const status = e.response?.status;
      const serverMsg = e.response?.data?.error;
      const reason = serverMsg
        || (status === 404 ? 'Upload route not found — restart the backend so /api/attachments loads'
        :  status === 401 ? 'Not authenticated — log in again'
        :  status === 413 ? 'File too large (max 10 MB)'
        :  status === 400 ? 'Invalid file type (PDF or image only)'
        :  status ? `Server error (${status})`
        :  e.message || 'Network error — is the backend running?');
      setErr(reason);
      // eslint-disable-next-line no-console
      console.error('[InvoiceAttachment] upload failed', { status, serverMsg, error: e });
    }
    setBusy(false);
  };

  const handleRemove = async () => {
    if (!value) return;
    if (!window.confirm('Remove this attachment?')) return;
    try { await deleteInvoiceAttachment(value); } catch { /* orphaned file is fine */ }
    onChange(null);
  };

  if (value) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8 }}>
        {isPdf ? <FiFileText size={18} color="#16a34a" /> : <FiImage size={18} color="#16a34a" />}
        <div style={{ flex: 1, fontSize: 12, color: '#166534', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {value.replace(/^invoices\//, '')}
        </div>
        <a href={fullUrl} target="_blank" rel="noopener noreferrer"
          title="View attachment"
          style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 8px', background: '#fff', color: '#16a34a', border: '1px solid #bbf7d0', borderRadius: 6, fontSize: 11, fontWeight: 600, textDecoration: 'none', gap: 4 }}>
          <FiEye size={12} /> View
        </a>
        {!disabled && (
          <button type="button" onClick={handleRemove} title="Remove attachment"
            style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 8px', background: '#fff', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer', gap: 4 }}>
            <FiX size={12} /> Remove
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="button" disabled={disabled || busy} onClick={() => fileRef.current?.click()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: '#eff6ff', color: '#1d4ed8', border: '1px dashed #93c5fd', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' }}>
          <FiUpload size={14} /> {busy ? 'Uploading…' : 'Choose file (PDF / image)'}
        </button>
        <button type="button" disabled={disabled || busy} onClick={() => camRef.current?.click()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', background: '#fef3c7', color: '#b45309', border: '1px dashed #fcd34d', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: disabled ? 'not-allowed' : 'pointer' }}>
          <FiCamera size={14} /> Take photo
        </button>
        <input ref={fileRef} type="file" accept="application/pdf,image/*" style={{ display: 'none' }}
          onChange={(e) => { doUpload(e.target.files?.[0]); e.target.value = ''; }} />
        <input ref={camRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
          onChange={(e) => { doUpload(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {err && <div style={{ marginTop: 6, color: '#dc2626', fontSize: 11 }}><FiPaperclip size={10} /> {err}</div>}
    </div>
  );
};

export default InvoiceAttachment;
