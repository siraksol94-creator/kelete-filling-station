import React, { createContext, useState, useContext, useEffect } from 'react';
import { login as loginAPI } from '../services/api';

const AuthContext = createContext(null);

// Maps new page keys → old flat permission keys (backward compat for existing users)
const LEGACY_MAP = {
  POS:              'POS',
  SalesReport:      'Sales',
  SalesInventory:   'Sales',
  CashReport:       'Sales',
  SalesBinCard:     'Sales',
  Sales:            'Sales',
  Reports:          'Reports',
  Items:            'Stock',
  GRN:              'GRN',
  SIV:              'SIV',
  Production:       'SIV',
  SalesReturns:     'SIV',
  Inventory:        'Stock',
  BinCard:          'Stock',
  StockAdjustment:  'Stock',
  Categories:       'Stock',
  ExpiryReport:     'GRN',
  StockCount:       'Stock',
  CashReceipt:         'Accounting',
  PaymentVoucher:      'Accounting',
  PvTypes:             'Accounting',
  CashBook:            'Accounting',
  AccountPayables:     'Accounting',
  AccountReceivables:  'Accounting',
  ProfitReport:        'Accounting',
  Suppliers:           'Suppliers',
  Customers:           'Customers',
  // 2026-09-03 — pages that used to render off another page's permission and
  // now carry their own key. Mapped to the same legacy group as their old
  // parent so a user still holding a flat permission ('Stock', 'Sales', 'GRN')
  // keeps exactly what they had. Users on granular Page:Action permissions are
  // handled by backend/scripts/expand_permissions_2026_09.js instead.
  QuickPrice:       'Stock',    // was Items
  OpeningBalance:   'Stock',    // was Items
  SalesStockCard:   'Stock',    // was Inventory
  IncomingStock:    'Stock',    // was Inventory
  BranchTransfers:  'Stock',    // was Inventory
  VATReport:        'Sales',    // was SalesReport
  EmptyVouchers:    'GRN',      // was GRN / SIV
  StockReconciliation: 'Stock',
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedUser = localStorage.getItem('user');
    if (savedUser && token) {
      setUser(JSON.parse(savedUser));
    }
    setLoading(false);
  }, [token]);

  const login = async (email, password, licenseKey) => {
    const response = await loginAPI({ email, password, ...(licenseKey ? { licenseKey } : {}) });
    const { token: newToken, user: userData } = response.data;
    localStorage.setItem('token', newToken);
    localStorage.setItem('user', JSON.stringify(userData));
    setToken(newToken);
    setUser(userData);
    return userData;
  };

  const loginWithToken = (token, userData) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(userData));
    setToken(token);
    setUser(userData);
  };

  const logout = () => {
    // 2026-09-18 — hand the phone back before dropping the session, or the
    // next cashier on that till gets this one's notifications. Deliberately
    // not awaited: logging out must never wait on the network.
    try {
      import('../utils/pushNotifications')
        .then(m => m.stopPushNotifications())
        .catch(() => {});
    } catch (_) {}
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    setToken(null);
    setUser(null);
  };

  // Returns true if user has full (unrestricted) access
  const isAllAccess = () => {
    if (!user) return false;
    if (user.role === 'Administrator') return true;
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    return perms.includes('All') || perms.includes('Full Access');
  };

  // Returns true if user has a specific permission key
  // Supports new format ('GRN:Delete') and old flat format ('GRN', 'Accounting')
  const hasPermission = (key) => {
    if (!user) return false;
    if (isAllAccess()) return true;
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    if (perms.includes(key)) return true;
    // Backward compat: old flat perm implies all actions for that page
    if (key.includes(':')) {
      const page = key.split(':')[0];
      const legacy = LEGACY_MAP[page];
      if (legacy && perms.includes(legacy)) return true;
    }
    return false;
  };

  // Returns true if user has ANY permission for any of the given page keys
  // Used for sidebar visibility — visible if user has at least one action on that page
  const hasPageAccess = (...pages) => {
    if (!user) return false;
    if (isAllAccess()) return true;
    return pages.some(page =>
      ['View', 'Add', 'Edit', 'Delete'].some(action => hasPermission(`${page}:${action}`))
    );
  };

  return (
    <AuthContext.Provider value={{
      user, token, login, loginWithToken, logout, loading,
      isAuthenticated: !!token,
      hasPermission, hasPageAccess, isAllAccess,
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
export default AuthContext;
