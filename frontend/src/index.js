import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './ux/kelete-ux.css'; // UX-1 shared styles (k- classes, focus rings, small-screen rules)
import './i18n'; // init i18next before App mounts so t() works on first render
import App from './App';
import installForceUppercase from './utils/forceUppercase';

// 2026-09-16 — every text box types in capital letters (utils/forceUppercase.js).
installForceUppercase();

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
