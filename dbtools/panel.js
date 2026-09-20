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
button.more { padding: 5px 8px; line-height: 1; }
button.more.on { background: #3b4358; }
[hidden] { display: none !important; }
/* The log is the one part that grows without asking, so it scrolls inside a fixed
   height. The scrollbar is drawn rather than left to the platform: the panel sits
   on somebody else's page in a dark box, and the default Windows bar is a wide
   light-grey slab that reads as part of Adminer rather than part of this. */
.log {
  max-height: 128px; overflow-y: auto; overscroll-behavior: contain;
  font-size: 12px; color: #9aa3b5; display: grid; gap: 3px; padding-right: 2px;
  scrollbar-width: thin; scrollbar-color: #4b5468 transparent;
}
.log::-webkit-scrollbar { width: 10px; }
.log::-webkit-scrollbar-track { background: transparent; }
.log::-webkit-scrollbar-thumb {
  background: #4b5468; border-radius: 999px;
  border: 3px solid transparent; background-clip: content-box;
}
.log::-webkit-scrollbar-thumb:hover { background: #5c6780; background-clip: content-box; }
.log div { word-break: break-word; }
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
  scrollbar-width: thin; scrollbar-color: #4b5468 transparent;
}
.sheet pre::-webkit-scrollbar { width: 12px; height: 12px; }
.sheet pre::-webkit-scrollbar-track { background: transparent; }
.sheet pre::-webkit-scrollbar-thumb {
  background: #4b5468; border-radius: 999px;
  border: 3px solid transparent; background-clip: content-box;
}
.sheet pre::-webkit-scrollbar-thumb:hover { background: #5c6780; background-clip: content-box; }
.sheet .note { padding: 0 14px 10px; font-size: 12px; color: #fbbf24; }
.sheet .body { padding: 0 14px; }
.sheet .field { display: grid; gap: 5px; padding: 12px 0 4px; font-size: 12px; color: #9aa3b5; }
.sheet .field input {
  font: inherit; font-size: 13px; padding: 7px 9px; border-radius: 6px;
  background: #171b24; color: #e6e9ef; border: 1px solid #3b4358;
}
.sheet .field input:focus { outline: none; border-color: #2563eb; }
.sheet .foot { display: flex; gap: 8px; justify-content: flex-end; padding: 10px 14px; border-top: 1px solid #39405180; }
@media (prefers-color-scheme: light) {
  .wrap, .sheet { background: #ffffff; color: #1b2030; border-color: #d7dbe5; }
  button { background: #f1f3f7; color: #1b2030; border-color: #ccd2de; }
  button:hover { background: #e6eaf2; }
  button.more.on { background: #dbe1ec; }
  .meta, .log { color: #5c6579; }
  .sheet pre { color: #1b2030; }
  .sheet .field { color: #5c6579; }
  .sheet .field input { background: #f7f8fb; color: #1b2030; border-color: #ccd2de; }
  .log, .sheet pre { scrollbar-color: #c2c9d6 transparent; }
  .log::-webkit-scrollbar-thumb, .sheet pre::-webkit-scrollbar-thumb { background: #c2c9d6; background-clip: content-box; }
  .log::-webkit-scrollbar-thumb:hover, .sheet pre::-webkit-scrollbar-thumb:hover { background: #a7b0c2; background-clip: content-box; }
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
      <div class="row advanced" hidden></div>
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
    advanced: wrap.querySelector('.advanced'),
    log: wrap.querySelector('.log'),
    chev: wrap.querySelector('.chev'),
  };

  // Snapshotting a whole table and creating a backup table are occasional,
  // heavier decisions than the four buttons above them, so they sit behind "⋯"
  // rather than in the row someone reaches for mid-test. The choice sticks, per
  // site, like the collapsed state does.
  let advancedOpen = false;
  try { advancedOpen = localStorage.getItem('frpDbtoolsAdvanced') === '1'; } catch { /* private mode */ }

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

    // What the session holds, not what is left to undo. Counting only the
    // not-yet-undone changes left a rolled-back session reading "0 changes" with
    // its changes plainly listed on the manager page — and they are still there,
    // and can be rolled back again.
    const changes = session.changes || [];
    const tables = new Set(changes.map((c) => c.table)).size;
    const snaps = (session.snapshots || []).length;
    els.title.textContent = `${session.name} · ${changes.length}`;
    els.name.textContent = session.name;
    els.meta.textContent =
      `${t('panel.changes', { n: changes.length })} · ${t('panel.tables', { n: tables })}`
      + (snaps ? ` · ${t('panel.snapshots', { n: snaps })}` : '')
      + ` · ${t('panel.engine', { engine })}`;

    const list = [
      button(t('panel.rollbackAll'), handlers.onRollbackAll, 'danger'),
      button(t('panel.exportSql'), handlers.onExportSql),
      button(t('panel.view'), handlers.onView),
      button(recording ? t('panel.stop') : t('panel.start'), recording ? handlers.onStop : handlers.onStart),
    ];

    // Snapshots belong at the start of a test, so they are only offered while the
    // session is recording; a backup table can be made at any time.
    const extra = [];
    if (recording && handlers.onSnapshot) extra.push(button(t('panel.snapshot'), handlers.onSnapshot));
    if (handlers.onBackup) extra.push(button(t('panel.backup'), handlers.onBackup));
    if (extra.length) list.push(button('⋯', toggleAdvanced, `more${advancedOpen ? ' on' : ''}`));

    els.buttons.replaceChildren(...list);
    els.advanced.replaceChildren(...extra);
    els.advanced.hidden = !extra.length || !advancedOpen;
  }

  function toggleAdvanced() {
    advancedOpen = !advancedOpen;
    els.advanced.hidden = !advancedOpen;
    const more = els.buttons.querySelector('.more');
    if (more) more.classList.toggle('on', advancedOpen);
    try { localStorage.setItem('frpDbtoolsAdvanced', advancedOpen ? '1' : '0'); } catch { /* private mode */ }
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
   * The sheet every question in this panel is asked in: a heading, a body, a note,
   * and the buttons. Escape and a click outside answer the same as Cancel.
   */
  function sheet({ title, note, buttons, onDismiss }) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <div class="sheet">
        <h2></h2>
        <div class="body"></div>
        <div class="note"></div>
        <div class="foot"></div>
      </div>`;
    modal.querySelector('h2').textContent = title;
    const noteEl = modal.querySelector('.note');
    if (note) noteEl.textContent = note; else noteEl.remove();
    modal.querySelector('.foot').append(...buttons(close));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    shadow.append(modal);

    function close() {
      modal.remove();
      onDismiss();
    }
    return { modal, body: modal.querySelector('.body'), close };
  }

  /**
   * Show the statements and wait for an answer.
   * Resolves true to run them, false to walk away.
   */
  function preview({ title, sql, note, confirmLabel }) {
    return new Promise((resolve) => {
      let answered = false;
      const done = (value) => { answered = true; resolve(value); };
      const view = sheet({
        title,
        note,
        onDismiss: () => { if (!answered) resolve(false); },
        buttons: (close) => [
          button(t('rollback.copy'), async () => {
            try {
              await navigator.clipboard.writeText(sql);
              log(t('rollback.copied'), 'ok');
            } catch {
              // Clipboard can be refused without a user gesture chain; the text is
              // on screen and selectable, so this is a nicety, not a failure.
            }
          }),
          button(t('rollback.cancel'), () => { done(false); close(); }),
          button(confirmLabel, () => { done(true); close(); }, 'primary'),
        ],
      });
      const pre = document.createElement('pre');
      pre.textContent = sql;
      view.body.replaceWith(pre);
    });
  }

  /**
   * Ask for one line of text — a session name, a list of tables — in that same
   * sheet rather than through `window.prompt`, whose box belongs to the browser
   * and looks nothing like the rest of this.
   *
   * Resolves the text, or null when dismissed, exactly like `prompt` did.
   */
  function ask({ title, label, value = '', note, confirmLabel, placeholder }) {
    return new Promise((resolve) => {
      let answered = false;
      const done = (text) => { answered = true; resolve(text); };
      const view = sheet({
        title,
        note,
        onDismiss: () => { if (!answered) resolve(null); },
        buttons: (close) => [
          button(t('rollback.cancel'), () => { done(null); close(); }),
          button(confirmLabel, () => { done(input.value); close(); }, 'primary'),
        ],
      });

      const field = document.createElement('label');
      field.className = 'field';
      const caption = document.createElement('span');
      caption.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = value;
      if (placeholder) input.placeholder = placeholder;
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        done(input.value);
        view.close();
      });
      field.append(caption, input);
      view.body.append(field);
      input.focus();
      input.select();
    });
  }

  return { render, log, preview, ask, expand, destroy: () => host.remove(), host };
}
