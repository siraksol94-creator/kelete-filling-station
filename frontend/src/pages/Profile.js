import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getSettings, updateProfile, updateBusiness } from '../services/api';
import { FiSave, FiUser, FiMail, FiPhone, FiMapPin, FiBriefcase } from 'react-icons/fi';

// Profile — identity-only settings. POS/device config lives in SystemSettings.
// Two tabs: Company (business identity) and My Account (the signed-in user).
const Profile = () => {
  const { user } = useAuth();
  const [tab, setTab] = useState('company');

  const [form, setForm] = useState({
    // Company
    businessName: '', businessPhone: '', businessEmail: '', businessAddress: '', tpin: '',
    // My Account
    firstName: '', lastName: '', email: '', phone: '', address: '', role: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings().then(res => {
      const u = res.data?.user || {};
      const b = res.data?.business || {};
      setForm({
        businessName:    b.business_name    || '',
        businessPhone:   b.business_phone   || '',
        businessEmail:   b.business_email   || '',
        businessAddress: b.business_address || '',
        tpin:            b.tpin             || '',
        firstName: u.first_name || '',
        lastName:  u.last_name  || '',
        email:     u.email      || '',
        phone:     u.phone      || '',
        address:   u.address    || '',
        role:      u.role       || '',
      });
    }).catch(() => {});
  }, []);

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const saveCompany = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await updateBusiness({
        business_name:    form.businessName,
        business_phone:   form.businessPhone,
        business_email:   form.businessEmail,
        business_address: form.businessAddress,
        tpin:             form.tpin,
      });
      alert('Company info saved.');
    } catch { alert('Failed to save. Please try again.'); }
    setSaving(false);
  };

  const saveAccount = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await updateProfile({
        firstName: form.firstName,
        lastName:  form.lastName,
        email:     form.email,
        phone:     form.phone,
        address:   form.address,
      });
      alert('Account info saved.');
    } catch { alert('Failed to save. Please try again.'); }
    setSaving(false);
  };

  const getInitials = () =>
    `${(form.firstName || '?')[0]}${(form.lastName || '?')[0]}`.toUpperCase();

  // Reusable tab button — green when active, neutral otherwise
  const TabBtn = ({ id, label, icon }) => (
    <button type="button" onClick={() => setTab(id)}
      style={{
        padding: '10px 22px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
        background: tab === id ? '#fff' : 'transparent',
        color: tab === id ? '#16a34a' : '#6b7280',
        border: 'none', borderBottom: `3px solid ${tab === id ? '#16a34a' : 'transparent'}`,
        display: 'inline-flex', alignItems: 'center', gap: 8,
      }}>
      {icon} {label}
    </button>
  );

  return (
    <div className="page-content">
      <div className="page-header">
        <div>
          <h1>Profile</h1>
          <p>Your company identity and your own account</p>
        </div>
      </div>

      <div className="profile-layout">
        <div className="profile-sidebar-card">
          <div className="profile-avatar">{getInitials()}</div>
          <h3>{form.firstName} {form.lastName}</h3>
          <span className="profile-role">{form.role}</span>
          <div className="profile-status"><span className="status-dot active"></span> Active</div>
          <div className="profile-contact-info">
            <div className="profile-contact-item"><FiMail   size={14} /> {form.email   || '—'}</div>
            <div className="profile-contact-item"><FiPhone  size={14} /> {form.phone   || '—'}</div>
            <div className="profile-contact-item"><FiMapPin size={14} /> {form.address || '—'}</div>
          </div>
          <div style={{ marginTop: 18, padding: '10px 12px', background: '#f9fafb', borderRadius: 8, fontSize: 12, color: '#6b7280' }}>
            <div style={{ fontWeight: 600, color: '#374151', marginBottom: 4 }}>{form.businessName || '—'}</div>
            <div>{form.businessPhone || '—'}</div>
            <div>{form.businessEmail || '—'}</div>
          </div>
        </div>

        <div className="profile-form-card">
          <div style={{ borderBottom: '1px solid #e5e7eb', marginBottom: 18, display: 'flex', gap: 4 }}>
            <TabBtn id="company"  label="Company"    icon={<FiBriefcase size={15} />} />
            <TabBtn id="account"  label="My Account" icon={<FiUser size={15} />} />
          </div>

          {tab === 'company' && (
            <form onSubmit={saveCompany}>
              <div className="form-section">
                <h3 className="form-section-title"><FiBriefcase /> Business Information</h3>
                <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
                  This is the company identity that appears on receipts and reports.
                </p>
                <div className="form-grid">
                  <div className="form-group">
                    <label>Registered Name</label>
                    <input type="text" name="businessName" value={form.businessName} onChange={handleChange} placeholder="e.g. Kelete Investments" />
                  </div>
                  <div className="form-group">
                    <label>TPIN</label>
                    <input type="text" name="tpin" value={form.tpin} onChange={handleChange} placeholder="e.g. 1002581703" />
                  </div>
                  <div className="form-group">
                    <label>Business Phone</label>
                    <input type="tel" name="businessPhone" value={form.businessPhone} onChange={handleChange} />
                  </div>
                  <div className="form-group">
                    <label>Business Email</label>
                    <input type="email" name="businessEmail" value={form.businessEmail} onChange={handleChange} />
                  </div>
                  <div className="form-group" style={{ gridColumn: 'span 2' }}>
                    <label>Physical Address <small style={{ color: '#9ca3af', fontWeight: 400 }}>(this branch)</small></label>
                    <input type="text" name="businessAddress" value={form.businessAddress} onChange={handleChange} placeholder="e.g. Ben Bella Road, Lusaka" />
                  </div>
                </div>
              </div>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  <FiSave /> {saving ? 'Saving...' : 'Save Company Info'}
                </button>
              </div>
            </form>
          )}

          {tab === 'account' && (
            <form onSubmit={saveAccount}>
              <div className="form-section">
                <h3 className="form-section-title"><FiUser /> Personal Information</h3>
                <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 14 }}>
                  Your own account details. Signed in as <strong>{user?.email || form.email || '—'}</strong>.
                </p>
                <div className="form-grid">
                  <div className="form-group">
                    <label>First Name</label>
                    <input type="text" name="firstName" value={form.firstName} onChange={handleChange} />
                  </div>
                  <div className="form-group">
                    <label>Last Name</label>
                    <input type="text" name="lastName" value={form.lastName} onChange={handleChange} />
                  </div>
                  <div className="form-group">
                    <label>Username</label>
                    <input type="text" name="email" value={form.email} onChange={handleChange} />
                  </div>
                  <div className="form-group">
                    <label>Phone</label>
                    <input type="tel" name="phone" value={form.phone} onChange={handleChange} />
                  </div>
                  <div className="form-group" style={{ gridColumn: 'span 2' }}>
                    <label>Address</label>
                    <input type="text" name="address" value={form.address} onChange={handleChange} />
                  </div>
                  <div className="form-group">
                    <label>Role</label>
                    <input type="text" value={form.role} disabled style={{ background: '#f9fafb', color: '#6b7280' }} />
                    <small style={{ color: '#9ca3af', fontSize: 11 }}>Role is managed by an Administrator from the Users page.</small>
                  </div>
                </div>
              </div>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  <FiSave /> {saving ? 'Saving...' : 'Save Account'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default Profile;
