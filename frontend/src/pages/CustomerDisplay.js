import React, { useState, useEffect } from 'react';

const CustomerDisplay = () => {
  const [cart, setCart] = useState(null); // null = idle
  const [screen, setScreen] = useState('idle'); // idle | cart | payment
  const [paymentData, setPaymentData] = useState(null); // { amount, total }
  const urlBizName = new URLSearchParams(window.location.search).get('bizName') || '';
  const [businessName, setBusinessName] = useState(urlBizName || 'Kelete');


  // Listen for cart updates from the POS window (via BroadcastChannel)
  useEffect(() => {
    const channel = new BroadcastChannel('customer_display');
    channel.onmessage = (e) => {
      if (e.data.type === 'business_info') { setBusinessName(e.data.businessName); }
      if (e.data.type === 'cart_update') { setCart(e.data.items); setScreen('cart'); }
      if (e.data.type === 'cart_clear') { setCart(null); setPaymentData(null); setScreen('idle'); }
      if (e.data.type === 'payment_received') {
        setPaymentData({ amount: e.data.amount, total: e.data.total });
        setScreen('payment');
      }
    };
    return () => channel.close();
  }, []);

  const total = cart ? cart.reduce((sum, i) => sum + parseFloat(i.total_price || 0), 0) : 0;

  // Blue gradient logo to match the Login page wine-glass emblem.
  const logoStyle = {
    background: 'linear-gradient(135deg, #1e40af 0%, #172554 100%)',
    borderRadius: 18,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 10px 24px rgba(30,64,175,0.55), inset 0 0 0 1px rgba(255,255,255,0.2)',
  };

  return (
    <div style={{
      minHeight: '100vh', background: 'linear-gradient(160deg, #0a0f1e 0%, #1e3a8a 40%, #050810 100%)',
      display: 'flex', flexDirection: 'column', color: '#fff', fontFamily: 'Inter, sans-serif',
      overflow: 'hidden',
    }}>

      {/* Header bar */}
      <div style={{ background: 'rgba(59,130,246,0.15)', borderBottom: '1px solid rgba(59,130,246,0.3)', padding: '16px 40px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ ...logoStyle, width: 40, height: 40, fontSize: 22 }}>🍷</div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 1 }}>{businessName}</div>
            <div style={{ fontSize: 12, color: '#93c5fd', letterSpacing: 2, textTransform: 'uppercase' }}>Point of Sale</div>
          </div>
        </div>
        <div style={{ fontSize: 13, color: '#9ca3af', textAlign: 'right' }}>
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '40px', justifyContent: screen === 'cart' ? 'flex-start' : 'center', alignItems: screen === 'cart' ? 'stretch' : 'center' }}>

        {/* Payment received screen */}
        {screen === 'payment' && paymentData && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 14, letterSpacing: 3, textTransform: 'uppercase', color: '#9ca3af', marginBottom: 24 }}>Amount Received</div>
            <div style={{ fontSize: 96, fontWeight: 900, color: '#22c55e', fontFamily: 'monospace', marginBottom: 16 }}>
              K{(parseFloat(paymentData.amount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
            </div>
            <div style={{ width: 60, height: 3, background: '#22c55e', margin: '0 auto 32px', borderRadius: 2 }} />
            <div style={{ fontSize: 22, color: '#9ca3af', marginBottom: 16 }}>
              Total Due: <span style={{ color: '#fff', fontWeight: 700 }}>K{(parseFloat(paymentData.total)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
            </div>
            {paymentData.amount >= paymentData.total ? (
              <div style={{ marginTop: 24, fontSize: 28, color: '#f59e0b', fontWeight: 700 }}>
                Change: <span style={{ fontFamily: 'monospace', fontSize: 48, fontWeight: 900 }}>K{(parseFloat((paymentData.amount - paymentData.total))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
              </div>
            ) : null}
          </div>
        )}

        {/* Idle screen */}
        {screen === 'idle' && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ ...logoStyle, width: 120, height: 120, fontSize: 64, margin: '0 auto 24px', transform: 'rotate(-4deg)' }}>🍷</div>
            <h1 style={{ fontSize: 64, fontWeight: 800, margin: '0 0 16px', color: '#fff', letterSpacing: 1 }}>
              {businessName ? `Welcome to ${businessName}!` : 'Welcome!'}
            </h1>
            <p style={{ fontSize: 28, color: '#93c5fd', margin: '0 0 60px', fontWeight: 300 }}>
              Thank you for shopping with us
            </p>

            {/* Divider */}
            <div style={{ width: 60, height: 3, background: '#3b82f6', margin: '0 auto 48px', borderRadius: 2 }} />

            {/* Developer info */}
            <div style={{ color: '#9ca3af', fontSize: 18, lineHeight: 2 }}>
              <div style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 3, color: '#6b7280', marginBottom: 8 }}>Powered by</div>
              <div style={{ fontSize: 24, fontWeight: 600, color: '#e5e7eb', marginBottom: 4 }}>SIDAN IT & Business Solutions</div>
              <div>📞 +260 775 722 196 / +260 775 722 228</div>
              <div>🌐 www.sidanitsolutions.com</div>
              <div>📍 Lusaka, Zambia</div>
            </div>
          </div>
        )}

        {/* Active cart */}
        {screen === 'cart' && cart && (
          <>
            <h2 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 20px', color: '#93c5fd', textTransform: 'uppercase', letterSpacing: 2 }}>
              Your Order
            </h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 20 }}>
              <thead>
                <tr style={{ borderBottom: '2px solid rgba(59,130,246,0.4)' }}>
                  <th style={{ textAlign: 'left', padding: '12px 0', color: '#9ca3af', fontWeight: 500, fontSize: 14, textTransform: 'uppercase', letterSpacing: 2 }}>Item</th>
                  <th style={{ textAlign: 'center', padding: '12px 0', color: '#9ca3af', fontWeight: 500, fontSize: 14, textTransform: 'uppercase', letterSpacing: 2 }}>Qty</th>
                  <th style={{ textAlign: 'right', padding: '12px 0', color: '#9ca3af', fontWeight: 500, fontSize: 14, textTransform: 'uppercase', letterSpacing: 2 }}>Price</th>
                </tr>
              </thead>
              <tbody>
                {cart.map((item, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <td style={{ padding: '16px 0', fontWeight: 500 }}>{item.product_name}</td>
                    <td style={{ padding: '16px 0', textAlign: 'center', color: '#93c5fd' }}>{item.quantity}</td>
                    <td style={{ padding: '16px 0', textAlign: 'right', fontWeight: 600 }}>${(parseFloat(parseFloat(item.total_price || 0))||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Total */}
            <div style={{ marginTop: 32, borderTop: '2px solid rgba(59,130,246,0.4)', paddingTop: 24, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 22, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 2 }}>Total</span>
              <span style={{ fontSize: 48, fontWeight: 800, color: '#3b82f6' }}>${(parseFloat(total)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</span>
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div style={{ padding: '12px 40px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'center' }}>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', letterSpacing: 2, textTransform: 'uppercase' }}>
          Kelete • Powered by SIDAN IT & Business Solutions • www.sidanitsolutions.com
        </span>
      </div>
    </div>
  );
};

export default CustomerDisplay;
