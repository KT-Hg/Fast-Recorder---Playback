/** theme.js — Light/dark theme persistence via chrome.storage.local. */

export const THEME_KEY = 'popupTheme';

/** Set `data-theme` on the root element and update the toggle button icon. */
export function applyTheme(theme) {
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  const toggleTheme = document.getElementById('toggleTheme');
  if (toggleTheme) {
    toggleTheme.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
}

/** Load persisted theme from storage and wire the toggle button. */
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
