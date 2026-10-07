import React, { useRef } from 'react';
import { FiPrinter, FiX } from 'react-icons/fi';

const PrintPreview = ({ html, onClose }) => {
  const iframeRef = useRef();

  const handlePrint = () => {
    if (window.electronAPI?.printSilent) {
      window.electronAPI.printSilent(html);
      onClose();
    } else if (iframeRef.current) {
      iframeRef.current.contentWindow.focus();
      iframeRef.current.contentWindow.print();
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 2000, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#1e293b', borderRadius: 12, padding: 12, width: '100%', maxWidth: 480, maxHeight: '90vh', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#cbd5e1', fontWeight: 600, fontSize: 14 }}>Print Preview</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handlePrint} style={{ padding: '7px 18px', background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <FiPrinter size={14} /> Print
            </button>
            <button onClick={onClose} style={{ padding: '7px 12px', background: '#374151', color: '#94a3b8', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <FiX size={14} /> Close
            </button>
          </div>
        </div>
        <iframe
          ref={iframeRef}
          srcDoc={html}
          title="Print Preview"
          style={{ width: '100%', minHeight: 420, flex: 1, border: 'none', borderRadius: 8, background: '#fff' }}
        />
      </div>
    </div>
  );
};

export default PrintPreview;
