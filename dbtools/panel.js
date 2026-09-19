/**
 * panel.js — the floating panel inside Adminer.
 *
 * Everything lives in a shadow root with its own reset. Adminer is usually
 * running behind somebody's theme or plugin, and this panel has to look the same
 * and keep working whichever one it is — an injected `div` inheriting a theme's
 * `table { width: 100% }` is exactly how injected UI ends up unreadable.
 *
 * The panel is deliberately small. It says whether a session is recording, how
 * much is in it, and offers the three things wanted mid-test: start/stop, the
 * preview, and roll back everything. Anything that needs reading — per-row diffs,
 * partial selection, settings — belongs on the manager page, which has room for it.
 *
 * The preview is not optional. Rollback statements are always rendered and shown
 * before anything is sent, because a rollback the user cannot read first is one
 * they cannot trust.
 */

import { t } from './i18n.js';

const HOST_ID = 'frp-dbtools-panel';

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
.wrap {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  width: 300px; background: #1f2430; color: #e6e9ef;
  border: 1px solid #39405180; border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.35); font-size: 13px; line-height: 1.45;
}
.wrap.collapsed { width: auto; }
.head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #5a6274; flex: none; }
.dot.rec { background: #ef4444; box-shadow: 0 0 0 3px #ef444433; }
.title { font-weight: 600; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chev { opacity: .6; font-size: 11px; }
.body { padding: 0 10px 10px; display: grid; gap: 8px; }
.collapsed .body { display: none; }
.meta { color: #9aa3b5; font-size: 12px; }
.name { font-weight: 600; word-break: break-word; }
.row { display: flex; gap: 6px; flex-wrap: wrap; }
button {
  font: inherit; padding: 5px 9px; border-radius: 6px; cursor: pointer;
  background: #2b3242; color: #e6e9ef; border: 1px solid #3b4358;
}
button:hover { background: #343c4f; }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.danger  { background: #b91c1c; border-color: #b91c1c; color: #fff; }
button:disabled { opacity: .5; cursor: default; }
.log { max-height: 110px; overflow: auto; font-size: 12px; color: #9aa3b5; display: grid; gap: 3px; }
.log .warn { color: #fbbf24; }
.log .err  { color: #f87171; }
.log .ok   { color: #4ade80; }

.modal {
  position: fixed; inset: 0; z-index: 2147483001; background: rgba(8,10,16,.6);
  display: flex; align-items: center; justify-content: center; padding: 24px;
}
.sheet {
  background: #1f2430; color: #e6e9ef; border: 1px solid #39405180; border-radius: 12px;
  width: min(760px, 100%); max-height: 100%; display: flex; flex-direction: column;
  box-shadow: 0 20px 60px rgba(0,0,0,.5);
}
.sheet h2 { margin: 0; padding: 12px 14px; font-size: 14px; border-bottom: 1px solid #39405180; }
.sheet pre {
  margin: 0; padding: 12px 14px; overflow: auto; flex: 1; white-space: pre-wrap; word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #d7dbe5;
}
.sheet .note { padding: 0 14px 10px; font-size: 12px; color: #fbbf24; }
.sheet .foot { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 14px; border-top: 1px solid #39405180; }
@media (prefers-color-scheme: light) {
  .wrap, .sheet { background: #ffffff; color: #1b2030; border-color: #d7dbe5; }
  button { background: #f1f3f7; color: #1b2030; border-color: #ccd2de; }
  button:hover { background: #e6eaf2; }
  .meta, .log { color: #5c6579; }
  .sheet pre { color: #1b2030; }
}
`;

export function mountPanel(handlers = {}) {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = CSS;
  shadow.append(style);

  const wrap = document.createElement('div');
  wrap.className = 'wrap collapsed';
  wrap.innerHTML = `
    <div class="head"><span class="dot"></span><span class="title"></span><span class="chev">▲</span></div>
    <div class="body">
      <div class="name"></div>
      <div class="meta"></div>
      <div class="row buttons"></div>
      <div class="log"></div>
    </div>`;
  shadow.append(wrap);
  (document.body || document.documentElement).append(host);

  const els = {
    wrap,
    dot: wrap.querySelector('.dot'),
    title: wrap.querySelector('.title'),
    name: wrap.querySelector('.name'),
    meta: wrap.querySelector('.meta'),
    buttons: wrap.querySelector('.buttons'),
    log: wrap.querySelector('.log'),
    chev: wrap.querySelector('.chev'),
  };

  els.wrap.querySelector('.head').addEventListener('click', () => {
    const collapsed = wrap.classList.toggle('collapsed');
    els.chev.textContent = collapsed ? '▲' : '▼';
    try { localStorage.setItem('frpDbtoolsCollapsed', collapsed ? '1' : '0'); } catch { /* private mode */ }
  });
  try {
    if (localStorage.getItem('frpDbtoolsCollapsed') === '0') {
      wrap.classList.remove('collapsed');
      els.chev.textContent = '▼';
    }
  } catch { /* private mode */ }

  function button(label, onClick, cls = '') {
    const el = document.createElement('button');
    el.textContent = label;
    if (cls) el.className = cls;
    el.addEventListener('click', onClick);
    return el;
  }

  function render(state) {
    const { session, engine } = state;
    const recording = Boolean(session && !session.closedAt);
    els.dot.className = `dot${recording ? ' rec' : ''}`;

    if (!session) {
      els.title.textContent = t('panel.title');
      els.name.textContent = t('panel.noSession');
      els.meta.textContent = t('panel.engine', { engine });
      els.buttons.replaceChildren(button(t('panel.start'), handlers.onStart, 'primary'));
      return;
    }

    const changes = (session.changes || []).filter((c) => !c.undone);
    const tables = new Set(changes.map((c) => c.table)).size;
    els.title.textContent = `${session.name} · ${changes.length}`;
    els.name.textContent = session.name;
    els.meta.textContent =
      `${t('panel.changes', { n: changes.length })} · ${t('panel.tables', { n: tables })} · ${t('panel.engine', { engine })}`;

    els.buttons.replaceChildren(
      button(t('panel.rollbackAll'), handlers.onRollbackAll, 'danger'),
      button(t('panel.exportSql'), handlers.onExportSql),
      button(t('panel.view'), handlers.onView),
      button(recording ? t('panel.stop') : t('panel.start'), recording ? handlers.onStop : handlers.onStart),
    );
  }

  function log(message, kind = '') {
    const line = document.createElement('div');
    if (kind) line.className = kind;
    line.textContent = message;
    els.log.prepend(line);
    while (els.log.childElementCount > 40) els.log.lastElementChild.remove();
  }

  function expand() {
    wrap.classList.remove('collapsed');
    els.chev.textContent = '▼';
  }

  /**
   * Show the statements and wait for an answer.
   * Resolves true to run them, false to walk away.
   */
  function preview({ title, sql, note, confirmLabel }) {
    return new Promise((resolve) => {
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.innerHTML = `
        <div class="sheet">
          <h2></h2>
          <pre></pre>
          <div class="note"></div>
          <div class="foot"></div>
        </div>`;
      modal.querySelector('h2').textContent = title;
      modal.querySelector('pre').textContent = sql;
      const noteEl = modal.querySelector('.note');
      if (note) noteEl.textContent = note; else noteEl.remove();

      const close = (value) => { modal.remove(); resolve(value); };
      const foot = modal.querySelector('.foot');
      foot.append(
        button(t('rollback.copy'), async () => {
          try {
            await navigator.clipboard.writeText(sql);
            log(t('rollback.copied'), 'ok');
          } catch {
            // Clipboard can be refused without a user gesture chain; the text is
            // on screen and selectable, so this is a nicety, not a failure.
          }
        }),
        button(t('rollback.cancel'), () => close(false)),
        button(confirmLabel, () => close(true), 'primary'),
      );
      modal.addEventListener('click', (e) => { if (e.target === modal) close(false); });
      shadow.append(modal);
    });
  }

  return { render, log, preview, expand, destroy: () => host.remove(), host };
}
