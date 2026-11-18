import React, { createContext, useState, useContext, useEffect } from 'react';
import i18n from '../i18n';

const LanguageContext = createContext(null);

// Thin wrapper around i18next. The existing useLanguage().t('key') API is
// preserved so we don't have to refactor every page that already uses it.
// New code can use react-i18next's useTranslation() directly if it prefers.
export const LanguageProvider = ({ children }) => {
  const [language, setLanguage] = useState(() => localStorage.getItem('lang') || 'ti');

  useEffect(() => {
    if (i18n.language !== language) i18n.changeLanguage(language);
  }, [language]);

  const changeLanguage = (code) => {
    setLanguage(code);
    localStorage.setItem('lang', code);
    i18n.changeLanguage(code);
  };

  const t = (key) => i18n.t(key);

  return (
    <LanguageContext.Provider value={{ language, changeLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);
export default LanguageContext;
