import { useEffect, useState } from 'react';

export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('gbrain-admin-theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* Storage can be disabled; the control still works. */ }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('gbrain-admin-theme', theme); } catch { /* Optional preference. */ }
  }, [theme]);
  return <button className="btn btn-secondary" type="button"
    aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
    {theme === 'dark' ? 'Light theme' : 'Dark theme'}
  </button>;
}
