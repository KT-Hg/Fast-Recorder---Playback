/**
 * run.mjs — the Adminer rollback feature, driven end to end.
 *
 * Loads the unpacked extension into Chromium, points it at a real Adminer over a
 * real SQLite database (see setup.sh), and asserts against the database itself
 * rather than against the UI: the only claim that matters is that the data came
 * back, byte for byte, including the difference between NULL and ''.
 *
 * Usage:  node dbtools/e2e/run.mjs [baseUrl] [dbPath]
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BASE = process.argv[2] || 'http://127.0.0.1:8123/index.php';
const DB = process.argv[3] || '/tmp/adminer-e2e/test.db';
const CONN = 'sqlite=&username=&db=test.db';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright is not installed here — `npm install playwright`, or run with');
  console.error('NODE_PATH pointing at an install and import it by path.');
  process.exit(2);
}

/* === The database, read and written behind the browser's back ═════════════ */

const php = (code) => execFileSync('php', ['-r', code]).toString();
const rows = () => JSON.parse(php(
  `$db=new SQLite3("${DB}");$r=$db->query("SELECT id,code,value,note FROM m_generic ORDER BY id");`
  + '$o=[];while($x=$r->fetchArray(SQLITE3_ASSOC))$o[]=$x;echo json_encode($o);'));

function reseed() {
  php(`$db=new SQLite3("${DB}");$db->exec("DELETE FROM m_generic");`
    + '$seed=[[1,"TAX","10","thue"],[2,"CUR","VND",null],[3,"MST","0101","ma so thue"],[4,"LIM","100",""],[5,"FLG","Y","co"]];'
    + 'foreach($seed as $r){$s=$db->prepare("INSERT INTO m_generic (id,code,value,note,updated_at) VALUES (?,?,?,?,?)");'
    + '$s->bindValue(1,$r[0]);$s->bindValue(2,$r[1]);$s->bindValue(3,$r[2]);'
    + 'if($r[3]===null)$s->bindValue(4,null,SQLITE3_NULL);else $s->bindValue(4,$r[3]);'
    + '$s->bindValue(5,"2026-01-01 00:00:00");$s->execute();}');
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : ' — ' + detail}`);
  if (!ok) failures++;
}

/* === Driving Adminer ═════════════════════════════════════════════════════ */

async function login(page) {
  await page.goto(BASE);
  await page.selectOption('select[name="auth[driver]"]', 'sqlite');
  await page.fill('input[name="auth[db]"]', 'test.db');
  await page.click('input[type="submit"]');
  await page.waitForLoadState('load');
}

async function startSession(page) {
  await page.waitForSelector('#frp-dbtools-panel', { state: 'attached' });
  // The panel remembers whether it was collapsed, so expand it only if it is.
  if (await page.locator('#frp-dbtools-panel .wrap.collapsed').count()) {
    await page.click('#frp-dbtools-panel .head');
  }
  // The panel offers "end" instead of "start" while a session is recording, and
  // the second half of this run reuses the same browser profile. Buttons are found
  // by what they do (`data-act`), not by their label: after End the ended session
  // stays on the panel and its start button reads "New session".
  const stop = page.locator('#frp-dbtools-panel [data-act="stop"]');
  if (await stop.count()) {
    await stop.click();
    await page.waitForTimeout(300);
  }
  await page.click('#frp-dbtools-panel .buttons [data-act="start"]');
  // The name is asked for in the panel's own sheet, not in a browser dialog.
  await page.fill('#frp-dbtools-panel .sheet input', 'E2E');
  await page.click('#frp-dbtools-panel .sheet .foot button:last-child');
  await page.waitForTimeout(400);
  return page.locator('#frp-dbtools-panel .title').textContent();
}

/** Adminer hides its textarea behind a highlighter; type where a person types. */
async function typeQuery(page, sql) {
  await page.waitForSelector('textarea[name="query"]', { state: 'attached' });
  await page.evaluate((text) => {
    const ta = document.querySelector('textarea[name="query"]');
    const editor = ta.previousElementSibling;
    editor.focus();
    editor.textContent = text;
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  }, sql);
}

const panelTitle = (page) => page.locator('#frp-dbtools-panel .title').textContent();

/* === Run ═════════════════════════════════════════════════════════════════ */

reseed();

const ctx = await chromium.launchPersistentContext('', {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${REPO}`, `--load-extension=${REPO}`],
});

try {
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept('E2E'));

  console.log('\nRecording and rolling back');
  await login(page);
  check('logged into Adminer', (await page.title()).includes('test.db'), await page.title());
  check('the panel mounts', (await page.locator('#frp-dbtools-panel').count()) === 1);
  check('a session starts', (await startSession(page)).includes('E2E'), await panelTitle(page));

  // 1. Edit one row: a value changes and a NULL becomes text.
  await page.goto(`${BASE}?${CONN}&edit=m_generic&where%5Bid%5D=2`);
  await page.waitForSelector('textarea[name="fields[value]"]');
  await page.fill('textarea[name="fields[value]"]', 'XXX');
  await page.selectOption('select[name="function[note]"]', '');
  await page.fill('textarea[name="fields[note]"]', 'ghi chu moi');
  await page.click('input[type="submit"][value="Save"]');
  await page.waitForLoadState('load');
  await page.waitForTimeout(600);

  let now = rows();
  check('the edit reached the database', now[1].value === 'XXX' && now[1].note === 'ghi chu moi',
    JSON.stringify(now[1]));
  check('the edit was recorded', (await panelTitle(page)).includes('· 1'), await panelTitle(page));

  // 1b. "Save and continue edit" saves over AJAX and never submits the form. Twice
  //     on the same page: the second save's "before" is the first one's "after".
  await page.goto(`${BASE}?${CONN}&edit=m_generic&where%5Bid%5D=1`);
  await page.waitForSelector('textarea[name="fields[note]"]');
  await page.fill('textarea[name="fields[note]"]', 'tiep tuc');
  await page.click('input[name="insert"]');
  await page.waitForTimeout(1200);
  await page.fill('textarea[name="fields[value]"]', 'T2');
  await page.click('input[name="insert"]');
  await page.waitForTimeout(1200);

  now = rows();
  check('both AJAX saves reached the database', now[0].note === 'tiep tuc' && now[0].value === 'T2',
    JSON.stringify(now[0]));
  check('both AJAX saves were recorded', (await panelTitle(page)).includes('· 3'), await panelTitle(page));

  // 2. A hand-written bulk update on the SQL page.
  await page.goto(`${BASE}?${CONN}&sql=`);
  await typeQuery(page, "UPDATE m_generic SET value='Z' WHERE id <= 3");
  await page.click('input[type="submit"][value="Execute"]');
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);

  now = rows();
  check('the bulk update ran', now.slice(0, 3).every((r) => r.value === 'Z'),
    JSON.stringify(now.map((r) => r.value)));
  check('the bulk update was recorded', (await panelTitle(page)).includes('· 4'), await panelTitle(page));

  // 3. Roll the whole session back.
  await page.click('#frp-dbtools-panel button:has-text("Roll back all")');
  await page.waitForSelector('#frp-dbtools-panel .sheet pre');
  // The SQL is the contract, but the lines above it are what gets read.
  const summary = await page.locator('#frp-dbtools-panel .sheet .summary').textContent().catch(() => '');
  check('the preview says what it does before showing the SQL', /row\(s\)/.test(summary), summary);
  await page.click('#frp-dbtools-panel .sheet .foot button:last-child');
  await page.waitForTimeout(3000);

  now = rows();
  check('row 1 is back', now[0].value === '10', JSON.stringify(now[0]));
  check('row 1 note is back, through both AJAX saves', now[0].note === 'thue', JSON.stringify(now[0]));
  check('row 2 value is back', now[1].value === 'VND', JSON.stringify(now[1]));
  check('row 2 note is NULL again, not an empty string', now[1].note === null,
    JSON.stringify(now[1].note));
  check('row 3 is back', now[2].value === '0101', JSON.stringify(now[2]));
  check('rows nobody touched are untouched', now[3].value === '100' && now[4].value === 'Y',
    JSON.stringify(now.slice(3)));

  /* ── Delete, drift, and the manager page ───────────────────────────────── */

  console.log('\nDelete, drift and the manager page');
  reseed();
  const page2 = await ctx.newPage();
  page2.on('dialog', (d) => d.accept('E2E drift'));
  await login(page2);
  await startSession(page2);

  // 4. Delete a row through the edit form.
  await page2.goto(`${BASE}?${CONN}&edit=m_generic&where%5Bid%5D=4`);
  await page2.waitForSelector('input[name="delete"]');
  await page2.click('input[name="delete"]');
  await page2.waitForLoadState('load');
  await page2.waitForTimeout(700);
  now = rows();
  check('the delete reached the database', now.length === 4 && !now.some((r) => r.id === 4),
    JSON.stringify(now.map((r) => r.id)));
  check('the delete was recorded', (await panelTitle(page2)).includes('· 1'), await panelTitle(page2));

  // 5. Edit another row, then change it from outside — that is drift.
  await page2.goto(`${BASE}?${CONN}&edit=m_generic&where%5Bid%5D=5`);
  await page2.waitForSelector('textarea[name="fields[value]"]');
  await page2.fill('textarea[name="fields[value]"]', 'N');
  await page2.click('input[type="submit"][value="Save"]');
  await page2.waitForLoadState('load');
  await page2.waitForTimeout(700);
  check('two changes are recorded', (await panelTitle(page2)).includes('· 2'), await panelTitle(page2));

  php(`$db=new SQLite3("${DB}");$db->exec("UPDATE m_generic SET value='SOMEONE_ELSE' WHERE id=5");`);

  await page2.click('#frp-dbtools-panel button:has-text("Roll back all")');
  await page2.waitForSelector('#frp-dbtools-panel .sheet pre');
  await page2.click('#frp-dbtools-panel .sheet .foot button:last-child');
  const driftSheet = await page2
    .waitForSelector('#frp-dbtools-panel .sheet h2:has-text("changed after you edited")', { timeout: 8000 })
    .then(() => true).catch(() => false);
  check('drift is reported before anything is overwritten', driftSheet);
  // The drift question is a table now — column, recorded, now — not a code block.
  const driftText = await page2.locator('#frp-dbtools-panel .sheet .grid').textContent().catch(() => '');
  check('the drift names the value that is actually there', driftText.includes('SOMEONE_ELSE'), driftText);

  await page2.click('#frp-dbtools-panel .sheet [data-act="cancel"]');   // "Skip these rows"
  await page2.waitForTimeout(3000);
  now = rows();
  check('the drifted row was left alone', now.find((r) => r.id === 5).value === 'SOMEONE_ELSE',
    JSON.stringify(now.find((r) => r.id === 5)));
  check('the deleted row came back', now.some((r) => r.id === 4 && r.value === '100'),
    JSON.stringify(now.map((r) => r.id)));
  check('and its empty-string note did not come back as NULL',
    now.find((r) => r.id === 4).note === '', JSON.stringify(now.find((r) => r.id === 4)));

  // 6. The manager page.
  const worker = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(worker.url()).host;
  const mgr = await ctx.newPage();
  await mgr.goto(`chrome-extension://${extId}/dbtools.html`);
  await mgr.waitForSelector('.sess', { timeout: 8000 });
  check('the manager lists the sessions', (await mgr.locator('.sess').count()) >= 1);
  await mgr.locator('.sess').first().click();
  await mgr.waitForTimeout(300);
  check('it renders the changes', (await mgr.locator('.change').count()) >= 2,
    String(await mgr.locator('.change').count()));
  await mgr.locator('.change').first().click();
  await mgr.waitForTimeout(200);
  check('it renders a before/after table',
    /value|note/i.test(await mgr.locator('.change table.diff').first().textContent()));
  check('an undone change is marked as such', (await mgr.locator('.change.undone').count()) >= 1);

  /* ── The grid, INSERT, and a snapshot ──────────────────────────────────── */

  console.log('\nThe grid, INSERT and a table snapshot');
  reseed();
  const page3 = await ctx.newPage();
  page3.on('dialog', (d) => d.accept());   // Adminer's own confirm() on Delete
  await login(page3);
  await startSession(page3);
  await page3.click('#frp-dbtools-panel button:has-text("⋯")');
  await page3.click('#frp-dbtools-panel button:has-text("Snapshot")');
  await page3.fill('#frp-dbtools-panel .sheet input', 'm_generic');
  await page3.click('#frp-dbtools-panel .sheet .foot button:last-child');
  await page3.waitForTimeout(1500);
  check('the table is snapshotted', /snapshot/i.test(await page3.locator('#frp-dbtools-panel .meta').textContent()),
    await page3.locator('#frp-dbtools-panel .meta').textContent());

  // 7. A cell edited in the grid, in Modify mode.
  await page3.goto(`${BASE}?${CONN}&select=m_generic&modify=1`);
  await page3.fill('tr:has(input[name="check[]"][value="where%5Bid%5D=2"]) [name$="[value]"]', 'GRID');
  await page3.click('input[type="submit"][value="Save"]');
  await page3.waitForLoadState('load');
  await page3.waitForTimeout(1500);
  now = rows();
  check('the grid edit reached the database', now[1].value === 'GRID', JSON.stringify(now[1]));
  check('only the row that changed was recorded', (await panelTitle(page3)).includes('· 1'), await panelTitle(page3));

  // 8. Two ticked rows deleted from the grid.
  await page3.goto(`${BASE}?${CONN}&select=m_generic`);
  await page3.check('input[name="check[]"][value="where%5Bid%5D=4"]');
  await page3.check('input[name="check[]"][value="where%5Bid%5D=5"]');
  await page3.click('input[name="delete"]');
  await page3.waitForLoadState('load');
  await page3.waitForTimeout(1500);
  check('the bulk delete reached the database', rows().length === 3, JSON.stringify(rows().map((r) => r.id)));
  check('it was recorded', (await panelTitle(page3)).includes('· 2'), await panelTitle(page3));

  // 9. An INSERT through the edit form, its key left to the database.
  await page3.goto(`${BASE}?${CONN}&edit=m_generic`);
  await page3.fill('textarea[name="fields[code]"]', 'NEW');
  await page3.fill('textarea[name="fields[value]"]', 'N1');
  await page3.click('input[type="submit"][value="Save"]');
  await page3.waitForLoadState('load');
  await page3.waitForTimeout(1500);
  check('the insert reached the database', rows().some((r) => r.code === 'NEW'), JSON.stringify(rows()));
  check('the insert was recorded with its new key', (await panelTitle(page3)).includes('· 3'), await panelTitle(page3));

  // 10. A change made behind Adminer's back — only the snapshot knows about it.
  php(`$db=new SQLite3("${DB}");$db->exec("UPDATE m_generic SET note='CHANGED BY THE APP' WHERE id=3");`);

  await page3.click('#frp-dbtools-panel button:has-text("Roll back all")');
  await page3.waitForSelector('#frp-dbtools-panel .sheet pre');
  await page3.click('#frp-dbtools-panel .sheet .foot button:last-child');
  const snapSheet = await page3
    .waitForSelector('#frp-dbtools-panel .sheet h2:has-text("snapshot")', { timeout: 10000 })
    .then(() => true).catch(() => false);
  check('the snapshot restore is offered after the change log', snapSheet);
  if (snapSheet) await page3.click('#frp-dbtools-panel .sheet .foot button:last-child');
  await page3.waitForTimeout(3000);

  now = rows();
  const seed = [['1', 'TAX', '10', 'thue'], ['2', 'CUR', 'VND', null], ['3', 'MST', '0101', 'ma so thue'],
    ['4', 'LIM', '100', ''], ['5', 'FLG', 'Y', 'co']];
  check('every row is back exactly as seeded — the inserted one gone, the deleted ones back, NULL and \'\' apart',
    now.length === 5 && now.every((r, i) => String(r.id) === seed[i][0] && r.code === seed[i][1]
      && String(r.value) === seed[i][2] && r.note === seed[i][3]), JSON.stringify(now));
} finally {
  await ctx.close();
}

console.log(failures ? `\n${failures} FAILED` : '\nAll end-to-end checks passed.');
process.exit(failures ? 1 : 0);
