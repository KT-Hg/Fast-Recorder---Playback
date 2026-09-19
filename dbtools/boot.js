/**
 * boot.js — the only part of this feature that runs on every page.
 *
 * Registered for all http(s) documents, so it is kept to a couple of DOM lookups
 * and nothing else: the rest of the integration is fetched only once a page has
 * identified itself as Adminer. That check is intentionally cheaper and looser
 * than the one in adapters/adminer.js — this decides whether it is worth loading
 * the adapter, and the adapter decides whether the page is really supported.
 *
 * Content scripts registered in the manifest are classic scripts, hence the
 * dynamic import: the modules under dbtools/ are ES modules shared with the
 * manager page and the Node selftest, and duplicating them as globals to save one
 * import would guarantee the two copies drift apart.
 */

(() => {
  if (window.__frpDbtoolsBooted) return;

  const generator = document.querySelector('meta[name="generator"]');
  const stamped = generator && /^Adminer/i.test(String(generator.content || ''));
  const masthead = Boolean(document.querySelector('a#h1[href*="adminer.org"], #h1 a[href*="adminer.org"]'));
  const shaped = Boolean(
    document.getElementById('menu') &&
    document.getElementById('content') &&
    document.querySelector('input[name="token"]'),
  );
  if (!stamped && !masthead && !shaped) return;

  window.__frpDbtoolsBooted = true;
  import(chrome.runtime.getURL('dbtools/content-main.js'))
    .then((mod) => mod.boot())
    .catch((err) => console.warn('[Fast Recorder] DB tools failed to load:', err));
})();
