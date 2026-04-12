/** theme.js — Theme toggle (light/dark) */

export const THEME_KEY = 'popupTheme';

export function applyTheme(theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  const toggleTheme = document.getElementById('toggleTheme');
  if (toggleTheme) {
    toggleTheme.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

export function initTheme() {
  chrome.storage.local.get([THEME_KEY], (res) => {
    const initial = res?.[THEME_KEY] === 'dark' ? 'dark' : 'light';
    applyTheme(initial);
  });

  const toggleTheme = document.getElementById('toggleTheme');
  if (toggleTheme) {
    toggleTheme.onclick = () => {
      const current = document.documentElement.getAttribute('data-theme') === 'dark'
        ? 'dark'
        : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      chrome.storage.local.set({ [THEME_KEY]: next });
    };
  }
}
