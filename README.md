# Pocket QA

A Chrome Manifest V3 extension that records browser interactions and replays them with conditional logic, variable substitution, scheduling, and CSV-driven data execution — no coding required.

> Formerly **Fast Recorder & Playback** (renamed 2026-09-26, together with the repository and its GitHub Pages URL). A few internal identifiers keep the old name on purpose, because renaming them would orphan data that installed copies already hold: the IndexedDB names (`FastRecorder_*`) and the `frp…` keys and DOM ids of the Adminer panel, which the sibling extensions also look for.

---

## Features

| Category | Capabilities |
|---|---|
| **Recording** | `click` and `input` events (input debounced to one action per field). All other action types are added manually. |
| **Playback** | Single scenario, sequence, loop N×, scheduled (one-off or daily), CSV data-driven; runs inside iframes and resumes after a mid-playback page reload |
| **Actions** | 16 action types including upload file, conditions, switch branching, readDOM, JS script |
| **Variables** | 4 types: Static, Random (alpha/numeric/alphanumeric/datetime), Pick, Fallback — `${varName}` substitution across selectors, values, URLs, and scripts |
| **Upload File** | Inject local files into `<input type="file">` or drag-and-drop zones; supports multiple files and `${variable}` filenames |
| **Screenshot** | Visible, full page, scroll (V/H), segment, element, whole OS window — with crop editor, standalone image editor, image diff, and watermark |
| **Highlight** | Select text on any page to highlight it in 5 colours with notes; auto-restored on revisit, scoped by URL patterns |
| **CSV Run** | Run a scenario once per row; export results to XLSX / HTML / ZIP with screenshots |
| **SQL Test Cases** | Vietnamese/English. Parse a SELECT/INSERT/UPDATE/DELETE statement and derive a test case list — EP + BVA, decision table / MC-DC, NULL & 3-valued logic, JOIN cardinality, grouping and paging — with one panel for editing the sample values every case draws on, exported as CSV or JSON |
| **DB Test Session** | Records every row changed through **Adminer** — edit form, grid edits, bulk delete, `INSERT`, and hand-written SQL — and rolls a whole test run back, with a preview of the exact SQL and a drift check per row. (Whole-table snapshots, backup tables and rollback after Playback are built but temporarily hidden.) |
| **Export** | Scenario JSON, folder JSON, full backup/restore, JS Bookmarklet, Selenium Python |
| **UI** | Dark/light theme, 5 drag-to-reorder tabs, collapsible cards, hotkeys |

---

## Installation

Requires **Chrome 109 or newer**.

1. Clone or download this repository
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** → select this folder
5. Pin the extension icon for easy access

> No build step, no npm, no bundler required.

---

## Quick Start

1. Navigate to the page you want to automate
2. Open the extension popup → click **Activate** in the status bar
3. Go to the **Record & Play** tab → click **▶ Start Recording**
4. Click and type on the page — those are the two event types the recorder captures
5. Click **■ Stop** → name and save the scenario
6. Add any further steps (hover, drag & drop, navigate, screenshot, upload…) with **Add Action**
7. Click **▶ Play** to replay

---

## Popup Tabs

The popup has five tabs, reorderable by drag-and-drop. The last active tab is remembered across sessions.

### Record & Play
- Start/stop recording; undo/redo on the action list (up to 50 steps, cleared by **New** or loading another scenario)
- Add manual actions (all 16 types)
- Save and manage scenarios (rename, duplicate, move to folder, delete)
- Playback controls: loop count, loop delay
- Sequence playback (run multiple scenarios in order, each with its own delay)

### Data
- Global variables table (`${varName}` → value)
- **Export Code** — generate a standalone JS Bookmarklet or Selenium Python script from any saved scenario
- Scheduled playback at a set time — one-off, or **Repeat daily**
- CSV data-driven runs (one scenario execution per CSV row)
- **SQL Test Case Designer** — opens `sqlcases.html` in its own tab (see below)
- **DB Test Session** — opens `dbtools.html`: the changes recorded in Adminer and the SQL to undo them

### Capture
- Screenshot: Visible, Full Page, Scroll V/H, Segment V/H, Element, Window
- Crop/edit mode for all capture types
- Image diff tool (pixel-level comparison)
- Standalone image editor for any image from the clipboard or a file

### Highlight
- Select text on a page to highlight it in one of 5 colours (yellow, green, pink, blue, orange), with an optional note per highlight
- Highlights are re-applied automatically on the next visit (a `MutationObserver` re-runs restoration on late-loading content)
- Browse, search, and filter every highlight by colour or by page; per-page and total counts
- **URL Patterns** — wildcards in path *and* subdomain (`site.com/*/settings`, `*.myapp.com/app/*`) group several pages under one shared set of highlights; a builder turns the current tab's URL into a pattern
  - Adding or removing a pattern re-groups what is already stored, so highlights never go missing when the rules change — each one records the page it was made on
  - A pattern that names no query string matches any query (`site.com/products` covers `?page=2`); one that names a query is matched against it
  - `#anchor` links are ignored (same document), while `#/route` and `#!/route` hashes are kept — a hash router names a real page
- Export all highlights as JSON

### Settings
- Hotkey bindings (configurable, synced across devices)
- Screenshot save mode (auto/ask), filename prefix
- Watermark (format, font size)
- Segment scroll speed (V/H)
- Notifications on playback complete
- Import/Export scenarios and folders
- Backup/Restore all data

---

## Action Types

### DOM Actions *(executed by content script on page)*
| Type | Description |
|---|---|
| `click` | Mouse click on target element |
| `input` | Set value + fire input/change/blur events |
| `hover` | mouseover/mouseenter/mousemove events |
| `dropdown` | Trusted click via CDP — for native dropdowns that ignore a synthetic JS click. Selector only, no value. |
| `dragdrop` | HTML5 drag from source selector to target selector |

`click`, `input`, `hover` support **Child Condition**: the selector targets a parent container, and a matching child is found by value, text, id, class, or input type.

### Navigation & Control *(executed by background service worker)*
| Type | Description |
|---|---|
| `navigate` | Go to URL (`chrome.tabs.update`) |
| `wait` | Pause for N milliseconds |
| `script` | Run arbitrary JavaScript via CDP (bypasses page CSP) |

### Control Flow
| Type | Description |
|---|---|
| `condition` | 12-type DOM/URL check → skip next N actions if false |
| `switch` | Variable value → run matching named scenario |

**Condition types:** `elementExists`, `elementNotExists`, `elementVisible`, `elementHidden`, `textContains`, `textEquals`, `valueEquals`, `valueContains`, `urlContains`, `urlEquals`, `hasClass`, `hasAttribute`

### Data, Screenshot & File
| Type | Description |
|---|---|
| `readdom` | Extract text/value/attribute → store as `${varName}` |
| `screenshot` | Capture visible viewport |
| `screenshot_full` | Full page via CDP |
| `screenshot_element` | Specific element via CDP clip |
| `screenshot_tovar` | Visible / full page / element → the variable receives the **filename**; the image itself is carried into the CSV export |
| `uploadFile` | Inject local file(s) into `<input type="file">` (CDP) or drag-and-drop zone (DataTransfer bridge); supports multiple files and `${variable}` filenames |

---

## Export Code

From the **Data** tab → **Export Code** card, select any saved scenario and generate a standalone script in two formats:

### ⚡ JS Bookmarklet

- Runs directly in the browser console or as a saved bookmark URL
- No Selenium or Python required
- Supported actions: `click`, `input`, `hover`, `dropdown`, `dragdrop`, `navigate`, `wait`, `script`, `readdom`, `condition`
- Skipped actions: `screenshot*` (require Extension API), `switch`
- Not supported: `uploadFile` (no way to reach the local filesystem from a bookmarklet) — emitted as a skipped step
- Selectors: a `_qsel()` helper injected into the generated script dispatches by shape — selectors starting with `/` or `(` go through `document.evaluate` (XPath), everything else through `document.querySelector`
- Copy as a single-line bookmark URL or download as a `.js` file

**Output example:**
```js
javascript:(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const getEl = (sel, timeout = 5000) => new Promise(...);
  const setInput = (el, value) => { ... };

  // --- VARIABLES ---
  const username = "alice";

  // --- MAIN FLOW ---
  try {
    // Step 1: navigate
    window.location.href = "https://example.com/login";
    ...
  } catch (err) { alert('Error: ' + err.message); }
})();
```

### 🐍 Selenium Python

- Generates a ready-to-run `.py` script using `selenium` 4.x
- Supported actions: every type except `switch` and `uploadFile` — including **screenshot**, which the bookmarklet cannot do
- `input` actions auto-detect `<select>` elements at runtime — uses `Select.select_by_value()` with fallback to `select_by_visible_text()`
- `condition` actions use `find_elements()` (returns list, never raises)
- `switch` is skipped (extension-specific scenario routing) and `uploadFile` is emitted as an unsupported step — both are commented into the generated script rather than silently dropped

**Settings available in the modal:**

| Setting | Default | Description |
|---|---|---|
| Starting URL | *(empty)* | `driver.get()` call injected before step 1 if no `navigate` action exists. Use **⊕** to fill from the current browser tab. |
| WebDriver | Chrome | `Chrome`, `Firefox`, `Edge`, `Safari` |
| Delay between steps (ms) | 500 | `time.sleep()` added after each action |
| Element wait timeout (ms) | 10 000 | `WebDriverWait(driver, N)` timeout |

**Output example:**
```python
import time
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait, Select
from selenium.webdriver.support import expected_conditions as EC

# ============================
# SCENARIO: Login Form
# ============================
driver = webdriver.Chrome()
driver.implicitly_wait(10)

driver.get("https://example.com/login")

# --- VARIABLES ---
username = "alice"

# --- MAIN FLOW ---
try:
    # Step 1: input
    el1 = WebDriverWait(driver, 10).until(EC.presence_of_element_located((By.CSS_SELECTOR, "#email")))
    if el1.tag_name == 'select':
        try:
            Select(el1).select_by_value(f"{username}")
        except Exception:
            Select(el1).select_by_visible_text(f"{username}")
    else:
        el1.clear()
        el1.send_keys(f"{username}")
    time.sleep(0.5)

    print("✅ Scenario 'Login Form' completed successfully.")

except Exception as e:
    print(f"❌ Error: {e}")
    raise

finally:
    driver.quit()
```

---

## SQL Test Case Designer

Opened from **Data → Analyze a SQL query**, this is a standalone page (`sqlcases.html`) that parses a SQL
statement and derives a numbered test case list from it. Nothing is sent anywhere — tokenising, parsing and
generation all run locally in the page.

**Scope:** `SELECT` (joins, `WHERE`, `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`/`OFFSET`, `UNION`, CTEs, `CASE`)
plus `INSERT`, `UPDATE` and `DELETE`. MySQL backticks, SQL Server brackets and ANSI double quotes are all
accepted, as are the `?` / `:name` / `@name` / `$1` parameter markers. Both MySQL (`INTERVAL 6 MONTH`) and
PostgreSQL (`INTERVAL '6 months'`) interval syntax parse.

**Language:** Vietnamese by default, English via the 🌐 button in the top bar; the choice is remembered.
Generation runs in the active language rather than translating afterwards, so an export always matches what is
on screen. SQL keywords stay in English in both — they are what the tester has to match against the query.
Catalogs live in [`sqlcases/i18n/`](sqlcases/i18n/); `technique` and `priority` stay stable English codes
internally and are localised only for display, so filtering and the JSON export are language-independent.

### Layout

The results column is a fixed shell rather than a scrolling one: **the case table is the only thing on the page
that scrolls**. Findings, coverage, the inferred schema and the parsed analysis are `<details>` panels that sit
shut by default, each showing a count in its summary line — `1 warning · 1 note`, `WHERE 100% / 100%`,
`3 tables · 11 columns` — so nothing important becomes invisible when collapsed. Findings open by themselves
when the query has an actual error in it.

That replaces an earlier arrangement where the column scrolled *and* the table inside it scrolled, putting two
vertical scrollbars side by side and squeezing the table as soon as a query produced findings and a coverage
card. Panel open/closed state is remembered per user. Below 900px the two columns stack and the page itself
becomes the scroller.

### Techniques

| Technique | What it produces |
|---|---|
| **EP + BVA** | One representative value per equivalence class of each predicate, plus the boundary and its two neighbours. Step size follows the inferred type — `1` for an integer, `0.01` for money, a day for a date, a second for a timestamp. String columns get length / empty / whitespace boundaries instead. |
| **Decision Table + Coverage** | The full 2ⁿ rule table while the condition count stays under the configured limit, then **MC/DC** — one rule pair per condition. Reports conditions that cannot independently affect the outcome, and gives `CASE` expressions branch coverage including the implicit NULL branch of a missing `ELSE`. |
| **NULL & 3-valued logic** | The specific NULL behind each behaviour: `<>` dropping NULL rows, `NOT IN` returning nothing on a NULL subquery result, `COUNT(col)` vs `COUNT(*)`, NULL join keys never matching, NULL grouping keys collapsing into one group, engine-specific NULL placement in `ORDER BY`, nullability of written columns. |
| **JOIN / GROUP BY / ORDER-LIMIT** | Every join at 1:1, orphan and 1:n cardinality; a `WHERE` predicate on an outer-joined table silently turning it into an inner join; empty / single / multiple groups; ties in `ORDER BY`; pages at, below and beyond the row count. |

Above the case list, **findings** call out defects the query itself carries — a comma join, `= NULL`, a
`DELETE` with no `WHERE`, an aggregate sitting above a 1:n join — and **coverage** reports condition and
decision coverage per clause.

### Test data for manual runs

Clicking a case expands it into the rows that case needs and the query to run once they exist — read-and-type
fixtures for a manual tester, not `INSERT` statements.

**Inferred schema.** There is no real schema, so one is derived from the query: the columns it mentions, types
from the analysis, a primary key guessed from naming, and foreign keys read off the join conditions —
`ON o.user_id = u.id` is a statement about how two tables relate, which is exactly what linking fixture rows
requires. The left-hand panel shows what was inferred, because every generated value depends on it; a wrong
guess is visible there before anyone types the data in.

**Rows to prepare.** One block per table, with the value under test highlighted and child rows already pointing
at the parent row generated beside them. Conditions that are about row *counts* rather than column values are
honoured as such: `HAVING COUNT(o.id) > 3` seeds four child rows, and a join-orphan case seeds none at all.

**Query to run afterwards.** The original statement with its expected outcome recorded next to it, so a manual
run is self-checking.

Values come from the analysis, never from parsing a case's prose — that prose is translated, and re-reading it
would break the moment the page is in Vietnamese. Requirements that cannot be expressed as a row ("the subquery
must return no rows") are listed as such instead of quietly seeding something that does not reproduce the case.

### Sample values

Every value in the results is either read from the query or invented by the tool, and the invented ones are
collected into a single editable panel — **Sample values**, on the left, under the inferred schema. Change one
there and generation re-runs, so the cases and the fixture rows that use it change together instead of being
corrected case by case.

Two kinds of value are editable, because they enter the results by two different routes:

| | What it is | What changes when you set it |
|---|---|---|
| **Bind parameters** | `:amount`, `@id`, `?` — the markers the query has instead of a value | The parameter is treated as a literal from that point on, so `age >= :min` with `:min = 18` produces the real `17 / 18 / 19` boundary trio instead of `:min - 1`. The inferred type follows the value, exactly as it would for a literal written into the query. |
| **Column samples** | The filler used for a column no predicate constrains | Every fixture cell that would have held `name_1`, and every case that asks for "any non-NULL value" for that column. |

Anonymous `?` markers are numbered in source order (`?1`, `?2`) so two of them can hold different values; a
named parameter is one entry however often it appears. Primary and foreign keys are deliberately not editable —
those link the fixture rows to each other, and typing over them would break the join the fixture exists to
exercise. Each row shows how far the value reaches (`14 cells`, `1 condition`), so a value nothing uses says so
rather than looking like it had an effect.

Values are keyed by table *name* rather than alias, so rewriting `users u` as `users usr` keeps them, and they
persist across sessions. A value that does not look like the column's type — `abc` in an integer column — is
still used exactly as typed, and flagged rather than silently dropped. `↺` restores one generated value,
**Reset all** clears the book.

Because these values are not in the query text, they are reported above the results: `Values from the
sample-value book are in use: :min = 18`. Unbound parameters are reported too, since they are the reason a
boundary case can only describe itself relatively.

### Export

- **CSV** — UTF-8 with BOM, CRLF, every field quoted; opens cleanly in Excel (Vietnamese diacritics included)
  and imports into TestRail/Jira. Headers and case text follow the active language.
- **JSON** — the cases plus the parsed analysis (tables, joins, numbered conditions with inferred types,
  grouping, paging, parameters, findings, coverage) and the sample values in force, so a reader can tell where
  a value that is not in the SQL came from.
- **Data CSV** — one file per table, every fixture row tagged with the case it belongs to.
- **Verify SQL** — the query per case, with its expected result as a comment above it.

### Regression guard

```bash
node sqlcases/selftest.mjs
```

No framework or dependencies. Beyond a no-throw sweep it asserts **clause completeness** — that `GROUP BY`,
`HAVING`, `ORDER BY` and `LIMIT` actually reached the model. A parser that stops mid-statement still returns an
AST and still reports no error; it just silently drops every clause after the point it lost the thread, which is
exactly the failure that guard exists to catch.

It covers the **value book** end to end: that typed text becomes the right SQL literal for the column type,
that binding a parameter makes boundary cases concrete and clearing it puts them back exactly as they were,
that a column sample reaches both the case prose and the fixture row through the table alias, and that keys are
never offered as editable values.

It also covers the **translation catalogs**, for the same reason: a missing key degrades to the key itself
(`st.orphanKept` appearing in a case description) rather than crashing, so the suite generates every query shape
in both languages and asserts no key was missed, no placeholder differs between catalogs, and no raw key leaks
into the output.

Fixture generation is covered too: that a foreign key points at the parent row generated beside it, that a
boundary value actually lands in the row and is flagged, that `HAVING COUNT` drives the child-row count, and
that each per-table CSV comes out square.

### Limits

- Only the outer statement is analysed. CTEs and subqueries are flagged; paste each one separately for its own cases.
- There is no schema, so column types are inferred from comparison literals first and column names second.
  When neither settles it, the boundary value is a placeholder and the case says so.
- Expected results state what SQL semantics require, not what the current data contains.
- Generated data covers the columns the query mentions. A `NOT NULL` column the query never names is invisible
  to the tool, so a real insert may still need values it does not supply.

---

## DB Test Session & Rollback (Adminer)

Testing against master data means changing it: a flag here, a rate there, twenty rows of a lookup table. Putting
it back afterwards is the part nobody enjoys, and the part that goes wrong quietly.

This records every write made through **Adminer** into a *session*, and rolls the session back on request. It is
not a transaction — Adminer opens a new connection per request, so `BEGIN` cannot span two page loads — it is a
changeset kept by the extension, replayed backwards as ordinary SQL you read before it runs.

Design notes and the phases beyond what is built: [`docs/adminer-rollback-plan.md`](docs/adminer-rollback-plan.md).

### Using it

1. Open Adminer. A small panel appears bottom-right; nothing is recorded until you start a session. The
   **Adminer panel** switch on the DB Test Session card turns the whole thing off and on — off, no panel appears
   and nothing is recorded, and the Adminer tabs already open follow along without a reload.
2. **▶ Start session** — name the run. If the test goes through the application rather than Adminer, open **⋯**
   on the panel and press **📸 Snapshot** too, naming the tables it touches. Snapshot and Backup live behind that
   **⋯** because they are occasional, heavier decisions than the buttons next to them.
3. Change data as you normally would. A warning while the panel is shut — a row whose old values could not be
   read, a change that cannot be undone — puts a **⚠ n** badge on the panel's header, because a warning written
   to a log nobody can see is not a warning. Each log line carries its time; click a *Recorded* line to open that
   change, diff open, on the manager page. Reminders and status lines ("copied", "still has 3 changes not rolled
   back", "recording into … again") fade out after about eight seconds; what was recorded, what a rollback did and
   what failed stay. If the panel covers something, **⇤** in its header moves it to the other corner.
4. **↺ Roll back all**, or **↺ Undo last** (<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> outside a text field)
   for just the change you made a moment ago. The preview opens with a line per change (grouped by table once
   there are more than twelve) — what it is, and what undoing it does to how many rows, including the ones it
   is going to skip and why — and then the exact SQL underneath. Confirm and the recorded changes are undone
   first, then the snapshotted tables are put back. Afterwards the log says what was skipped and, if the
   database refused a statement, what it said. A row someone else changed in the meantime is shown as a table
   (column / recorded / now) with **Skip these rows** or **Overwrite anyway**. A session is not spent by one
   rollback: press it again — after another run of the same test, or after the data moved — and it offers the
   same undo a second time, saying that is what it is.
5. **↷ Re-apply** appears once something has been rolled back, for the step nobody plans for: the rollback ran,
   something was wrong, and the same rows have to go back to the values the test gave them. It is the changeset
   run the other way — oldest change first, so a row exists again before the edit that followed it — with the
   same preview and the same drift check, so a row someone else has written over since is shown before anything
   is overwritten. One thing it will not repeat: a statement you typed on the SQL page, where the capture read
   the old values but never the new ones. That one is listed as skipped, with the reason, rather than guessed at
   — run the statement again yourself. On the manager page, **↷** on a change re-applies just that one.
6. **■ End** does not make the session disappear. It stays on the panel, marked *Ended*, still one click from
   **↺ Roll back all**, with **↻ Resume** to record into it again and **▶ New session** for the next one. Click
   the session's **name** on the panel for every session on this database, each with its own **↻ Resume**; past
   six of them a filter appears, and Enter resumes the first match. One session records per database: resuming
   or starting another ends whichever was recording, and says so first.

**Data → DB Test Session** opens the full page — and the card itself says which session is recording, one click
from it. The page lists every change with the row it touched (`id=2`), a **↺** to undo just that one and a **↷** to put it back, its
before/after per column (diffs stay open while new changes arrive), the session's snapshots and backup tables,
and `.sql` / `.json` export. **Clean up…** deletes ended sessions with nothing left to undo (those still holding
changes are one tick away; those that still own a backup table are kept). **View** on the panel reuses an open
copy of the page rather than opening another. The panel follows the extension's light/dark setting. The rollback
button there says what it is about to do rather than what it is called — **Roll back all 12** with nothing
ticked, **Roll back 3 selected** with three, **Run 3 again** when a ticked change has already been undone.
**Re-apply** beside it counts the changes that were rolled back, because those are the ones it would run. The
run itself happens in the Adminer tab (the extension's own fetch would not carry Adminer's session cookie), so
the page says to confirm it over there and reports what came back — and when no Adminer tab is open for that
database, **Open Adminer** opens one and carries on once its panel answers. The **?** on that card is the in-popup guide.
The panel and the page are in English; 🌐 on the page switches to Vietnamese.

### What it records

| Where you changed it | What is captured | How it is undone |
|---|---|---|
| Row edit form (`?edit=`) | The values in the form **at load** — before you touched them | `UPDATE` back, only the columns that changed |
| "Save and continue editing" on that form | The row as the previous save left it, and as the database holds it afterwards (read back, so `now()` / `md5()` are the real values) | `UPDATE` back, one change per save |
| Delete button on that form | The whole row | `INSERT` it back |
| A cell edited in the grid (Ctrl+click, or `Modify`) | Each edited row, read through its edit form before the save; read again after | `UPDATE` back, only the columns that actually changed |
| Ticked rows → **Delete**, or **Whole result** → **Delete** | Every row it is about to delete — for *whole result*, all rows the search matches, not just the page | `INSERT` them back |
| Ticked rows → **Edit** (mass edit) | Each row before; the columns moved off *original* | `UPDATE` back |
| `UPDATE` / `DELETE` typed on the SQL page | The affected rows, read **before** the statement runs | `UPDATE` / `INSERT` per row |
| `INSERT` — edit form, **Clone**, or typed on the SQL page | The new row's key: typed into the form, from Adminer's *"Item 42 has been inserted"*, spelled out as literals in the statement, or found by comparing the table's keys before and after | `DELETE` of exactly those rows |

The old values on the edit form are free: they are already in the inputs when the page loads. Everywhere else the
rows are found first and each one is read through its own edit form, because Adminer abbreviates long text in a
grid and a shortened value restored as if it were the whole one would corrupt the row it was meant to protect. A
text key longer than 64 characters reaches the grid as an MD5 hash; the row is found by the hash and the undo uses
the real value read from it.

### Snapshots and backup tables

> **Temporarily hidden.** Snapshots, backup tables and the Playback guard are switched off by
> `TABLE_COPIES` in [`dbtools/features.js`](dbtools/features.js): nothing below is offered or run, including
> for sessions that already hold one. Rollback covers the change log only. Set the flag to `true` to bring it back.

The change log only sees writes made through Adminer. For a test that drives the application:

- **⋯ → 📸 Snapshot** copies whole tables into the session (`SELECT *` through the SQL page, which does not shorten
  values; 5,000 rows per table by default). On rollback each table is compared with its snapshot on the key and
  put back with `DELETE` for rows added since, `UPDATE` for rows that moved (only the columns that moved), and
  `INSERT` for rows removed — whoever made the change.
- **⋯ → 🗄 Backup** creates `<table>_bak_<yyyymmdd_hhmmss>` in the database with `CREATE TABLE … AS SELECT`
  (`SELECT … INTO` on SQL Server). It survives a lost laptop and removing the extension. Restoring diffs it
  against the table the same way; a table too large to diff is emptied and copied back, and the preview says so.

### Rolling back after Playback

> **Temporarily hidden** with snapshots (see above) — it works by snapshotting tables before the run.

Tick **Roll the database back after each Playback run** on the DB Test Session card, and choose the database and
the tables to snapshot under **Settings** on the manager page. Every Playback run — a scenario, a sequence, or a
CSV run — then opens a session and snapshots those tables before it starts, and rolls the session back when it
ends, without a preview (the person asked for it up front; rows someone else changed meanwhile are skipped, never
overwritten). An Adminer tab on that database has to be open: without one the run is refused, because changing
the data with no way back is the thing the setting exists to prevent.

### What it refuses to do

A refusal is shown on the change, not swallowed:

- a table with no primary or unique key — the undo predicate would match every row;
- a statement writing more than one table, or with no `WHERE`;
- a column it could not read (BLOB, file input);
- more affected rows than the configured cap (200 by default);
- a CSV import in the grid;
- an `INSERT` whose new rows could not be told apart (a table larger than the key-scan cap, 10,000 rows).

Finding an `INSERT`'s rows by comparing keys also catches a row someone else inserted in the same second; the
change is marked *found by difference* so you can see which ones those are.

Other things it cannot put back, and says so: a column with `ON UPDATE CURRENT_TIMESTAMP`, and rows removed by
`ON DELETE CASCADE` behind a delete.

### Drift

Before undoing a change it re-reads the row. If a column it wrote now holds something else, someone changed it
after you did — the row is named, with the value it expected and the value it found, and you decide whether to
skip it or overwrite. Only the columns that change wrote are compared, so a colleague editing a different column
of the same row is not a conflict, and drift is checked per change at the moment it is undone, so a session that
edited a row and then bulk-updated it does not report itself.

### Notes

- Nothing leaves the browser. The changeset is `chrome.storage.local`, keyed by origin + driver + server +
  database, and a changeset recorded against one database is never offered on another.
- Rollback runs from the Adminer tab, never from the extension page: a request from the extension's own origin
  is cross-site, and Adminer's PHP session cookie would not be sent with it.
- Statements are re-run newest first, one change per submission, and stop at the first failure — so what is
  marked undone is what actually was.

### Tests

```bash
node dbtools/selftest.mjs      # undo generation, quoting, predicates, catalogs — no dependencies
bash dbtools/e2e/setup.sh      # then, in another terminal:
node dbtools/e2e/run.mjs       # the extension against a real Adminer over a real database
```

The second one exists because half of this feature is a claim about somebody else's HTML, and every one of those
claims turned out to be different from the obvious guess — see [`dbtools/e2e/README.md`](dbtools/e2e/README.md).

---

## Variable System

```
Priority (highest → lowest):
  1. CSV row columns       — per-row override
  2. readdom results       — accumulated during current run
  3. chrome.storage.local  — global persistent variables
```

**Token syntax:** `${varName}` — applied to: selector, value, URL, JS code, expected value, switchVar, folderPath, fileNames

**Variable types:**

| Type | Storage format | Resolved at run start |
|---|---|---|
| Static | Plain string | Used as-is |
| Random | `{random:alpha\|numeric\|alphanumeric\|datetime:len}` | Generated fresh each run; `datetime` → `YYYY-MM-DD_HH-MM-SS` |
| Pick | `{pick:val1\|val2\|val3}` | One value chosen randomly per run; CSV column overrides |
| Fallback | `{fallback:A\|B\|C}` | Tries A→B→C in order with Child Condition; sticky per run |

**Scope:** one loop iteration — built fresh at start, cleared at loop start, never persisted.

```
Example:
  globalVars  = { baseUrl: "https://example.com" }
  csvRowVars  = { username: "alice" }

  Action: navigate → url: ${baseUrl}/login  →  "https://example.com/login"
  Action: input   → value: ${username}       →  "alice"
  Action: readdom → varName: greeting        →  adds greeting to resolvedVars
  Action: input   → value: ${greeting}       →  "Welcome, Alice!"
```

---

## Hotkeys

All hotkeys are configurable in the **Settings** tab and synced via `chrome.storage.sync`.

| Action | Default |
|---|---|
| Start Recording | `Alt+R` |
| Stop Recording | `Alt+S` |
| Screenshot (Visible) | `Alt+P` |
| Screenshot (Full Page) | `Alt+Shift+F` |
| Screenshot (Scroll V) | `Alt+V` |
| Screenshot (Scroll H) | `Alt+H` |
| Segment V — Start | `Alt+Shift+V` |
| Segment H — Start | `Alt+Shift+H` |
| Segment — Stop & Capture | `Alt+X` |
| Screenshot (Element) | `Alt+E` |

> **Start/Stop Recording hotkeys only fire on activated tabs.** The content script verifies `IS_TAB_ACTIVATED` before acting — the check is enforced at the logic layer, not just the UI.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  popup.html + popup/*.js  (UI Layer — ES modules)           │
│  main · variables · settings · screenshots · highlight      │
│  export-bookmarklet · export-selenium · update-banner       │
│  Sends messages → background.js                             │
└──────────────────────────┬───────────────────────────────────┘
                           │ chrome.runtime.sendMessage
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  background.js + bg/*.js  (Service Worker — Orchestrator)   │
│  Message router · State machine · Storage CRUD              │
│  Playback engine · Screenshot/CDP · Alarms · Update check   │
└──────────────────────────┬───────────────────────────────────┘
                           │ chrome.tabs.sendMessage
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  content.js  (Page Context — Execution Layer, all frames)   │
│  DOM event capture · Selector generation (8 candidates)     │
│  Action execution · Condition evaluation · Hotkey listener  │
│  Highlight engine (selection, restore, URL patterns)        │
└──────────────────────────────────────────────────────────────┘
```

`content.js` is injected into **all frames**; recorded actions carry the originating `frameId` so playback targets the right frame.

`sqlcases.html` + `sqlcases/*.js` sit outside that pipeline: the SQL Test Case Designer is a self-contained
page that never messages the service worker or touches a tab. It is opened from the Data tab and uses
`chrome.storage.local` only to remember the last query, the technique toggles and the shared theme.

`dbtools/` sits outside it too, with its own content script:

```
dbtools/boot.js            registered for all http(s) pages; two DOM lookups, then
                           dynamically imports the rest only on an Adminer page
dbtools/content-main.js    capture (edit form, SQL page), panel, rollback driver
dbtools/adapters/adminer.js  every assumption about Adminer's HTML, in one file
dbtools/{params,sqlquote,undo,sqlcapture}.js   pure logic, shared with the Node selftest
dbtools/{session,executor,rollback,panel,i18n}.js
dbtools.html + dbtools/manager.js              the review-and-roll-back page
```

The service worker's only involvement is opening that page. Rollback is driven from the Adminer tab, because a
request from the extension's own origin is cross-site and would not carry Adminer's session cookie.

### System States

The service worker enforces mutual exclusion — only one primary state at a time:

| State | Badge | Trigger |
|---|---|---|
| **IDLE** | — | Default |
| **RECORDING** | ● REC (red) | START_RECORD |
| **PLAYING** | ▶ (green) | START_PLAYBACK_SCENARIO |
| **SEQUENCING** | ▶▶ (green) | START_SEQUENCE_PLAYBACK |
| **CSV_PLAYING** | ▶ (green) | START_CSV_PLAYBACK |

Orthogonal states (can overlay IDLE): **PICK_MODE**, **SEGMENT_CAPTURING**

> **Important:** The service worker resets all in-memory state on idle (~30 s). An in-progress recording interrupted by SW restart loses the `currentActions` buffer. `chrome.storage` is never affected.

---

## Storage

```
chrome.storage.local (10 MB, 5 MB before Chrome 114 — device-local)
  scenarios, folders, variables, schedules
  settings (watermark, screenshot config, theme, tab order)
  highlights (hl_v1) and highlight URL patterns (hl_patterns_v1)
  csvRunResults (text results only), _csvRows (rows of the active CSV run)
  updateStatus, updateAvailableSince, lastUpdateAt, remoteConfig (version check + lock)
  Pending context flags (pick, drag-drop, form draft)
  activatedTabs whitelist
  dbtoolsSessions / dbtoolsActive / dbtoolsPending / dbtoolsKeyCols / dbtoolsSettings
    (Adminer test sessions: the changeset, which session is recording per
     connection, a capture awaiting confirmation, and the key columns per table)

chrome.storage.sync (100 KB — synced across devices)
  hotkeys, screenshot save mode + filename prefix,
  segment scroll speeds, notification preference

chrome.storage.session (1 MB — survives SW restart, lost on browser close)
  undoStacks — max 50 snapshots per stack, LRU-capped at 20 scenarios
  Recording buffer (rec_*) and CSV checkpoint (csv_pending, 30 min TTL)

IndexedDB — FastRecorder_CsvScreenshots (disk, no hard quota)
  CSV screenshot results: key = "rowIndex:varName", value = base64 PNG
  No extra permissions needed — safe for Web Store publication

IndexedDB — FastRecorder_DbtoolsSnapshots (disk, no hard quota)
  DB Test Session table snapshots: key = snapshot id, value = { columns, rows }
  Opened only in the extension origin; the Adminer panel (a content script)
  reads and writes through the service worker (message "dbtools-snap")
```

### Key Settings Stored in `chrome.storage.local`

| Key | Type | Description |
|---|---|---|
| `scenarios` | `Record<id, Scenario>` | All saved scenarios |
| `folders` | `Record<id, Folder>` | Folder tree |
| `variables` | `Record<name, value>` | Global variables |
| `schedules` | `Schedule[]` | Scheduled playback entries |
| `activatedTabs` | `number[]` | Tab IDs with content script active |
| `lastTab` | `string` | Last active tab panel ID |
| `tabOrder` | `string[]` | Custom tab button order |
| `hotkeys` | `object` | Hotkey bindings (local fallback) |
| `popupTheme` | `"light"\|"dark"` | UI theme |
| `manualFormDraft` | `object` | Persisted Add Action form state |
| `playbackCheckpoint` | `object` | Resume point after mid-playback tab reload (60 s TTL) |
| `hl_v1` | `Record<url, Highlight[]>` | Saved highlights, keyed by the *normalized* URL (a matching pattern, else the page URL minus any `#anchor`). Each entry keeps `srcUrl` — the page it was made on — so the whole store can be re-grouped when patterns change |
| `hl_patterns_v1` | `string[]` | URL patterns grouping pages under one shared highlight set |
| `updateStatus` | `object` | Result of the daily Web Store version check |
| `updateAvailableSince` | `number` | First sighting of a pending update — grace-clock start |
| `lastUpdateAt` | `number` | When this install last changed version — lock deadline anchor |
| `remoteConfig` | `object` | Cached critical-release floor (`minVersion`, `hardLock`, `message`, `fetchedAt`) |
| `autoApplyAt` / `autoApplyTries` | `number` | Cooldown and budget for the self-restart that installs a critical update |

---

## Selector Strategy

During recording, `getAllSelectors()` stores up to 8 selector candidates per element: `css`, `xpath`, `fullXpath`, `id`, `name`, `text` (+ `textTag`), `testId`, `dataId`. Unstable ids (React fiber ids like `:r0:`, and UUIDs) are rejected by `_isDynamicId()`; `text` is only stored for link/button/heading-like tags with ≤ 50 characters.

`findElementWithFallback()` turns those into 9 lookup strategies, tried in this order — most precise first, most ambiguous last:

```
  1. fullXpath   — Absolute XPath (exact recorded position)
  2. id          — document.getElementById (unique by spec)
  3. xpath       — Relative, id-anchored XPath
  4. css         — Computed CSS path
  5. cssShadow   — Same CSS path, recursed through open shadow roots
  6. testId      — [data-testid="..."]
  7. dataId      — [data-id="..."]
  8. name        — [name="..."]
  9. text        — Exact text content match on the recorded tag name
```

Strategy 5 exists because web components (LitElement, Stencil, …) render into shadow roots that `document.querySelector` cannot see.

If all strategies fail, the system waits using `MutationObserver` up to the configured timeout before reporting failure.

---

## Screenshot Capture

Seven capture modes — all support optional watermark overlay and crop/edit:

| Mode | Method | Notes |
|---|---|---|
| Visible | `chrome.tabs.captureVisibleTab()` | Viewport only |
| Full Page | CDP + `setDeviceMetricsOverride` | Handles fixed elements |
| Scroll V/H | CDP + scroll animation | Stitched panorama |
| Segment V/H | CDP + user-marked range | Start → scroll → stop |
| Element | CDP + `getBoundingClientRect` | Exact element bounds |
| Window | `desktopCapture` + `getUserMedia` | A whole OS window, browser chrome and all |

### Countdown before a visible capture

*Settings → Countdown* delays the visible capture by 3, 5 or 10 seconds so a
dropdown or hover state can be opened before the shot. The **service worker owns
the timer**, and only delegates the display:

- On an http/https/file tab the countdown pill is drawn by `content.js`, which
  acks the request and fires the capture itself when the count ends — cancellable
  with the pill's ✕ or **Esc**. The request is pinned to `frameId: 0`, so a page
  full of iframes gets one countdown and one shot, not one per frame.
- **On every other tab** — this extension's own pages (`sqlcases.html`,
  `editor.html`), `chrome://`, the Web Store — there is no content script to ask,
  because `content_scripts.matches` does not cover those schemes. The count then
  runs on the **toolbar badge** and the worker takes the shot itself, reporting the
  result as a notification since the popup is gone by then. The same fallback
  covers an ordinary page whose content script was never injected (one that was
  already open when the extension was installed or reloaded).

The capture itself always worked on those tabs; before the worker owned the
timer, only the countdown message did not, so switching the countdown on made the
button appear to do nothing at all there.

### Window capture

Every other mode goes through the page renderer, which by design sees nothing
outside the page viewport — no tab strip, no omnibox, no DevTools. This one goes
through the OS compositor instead, so it photographs **any application window**
exactly as it appears on screen: a browser window with DevTools docked, but just
as well an editor, a terminal or a design tool.

- **Optional permission.** `desktopCapture` is not requested at install time. The
  first use opens a capture window that asks for it; declining leaves every other
  feature untouched.
- **Why a separate window** (`capture-window.html`): the action popup is destroyed
  the moment the permission prompt or the window picker takes focus, and Chrome
  binds the desktop stream to the render frame that called `chooseDesktopMedia` —
  so the picker and `getUserMedia` must run in the same long-lived frame. Neither
  the service worker nor an offscreen document can host that.
- **The capture window is 960×720 on purpose.** Chrome sizes the window picker to
  fit its owner window; at the original 460×260 the thumbnail grid consumed the
  dialog and the Share button was clipped off, unreachable without maximising.
- **Only windows are offered**, never whole screens: capturing a screen would put
  the capture window itself into the shot, and it cannot be hidden without also
  stopping the frame delivery the page depends on.
- **Blank frames are rejected, not saved.** A desktop capturer's first frames are
  uniform black — the window is enumerated before its content is composited — and
  drawing one produces a black PNG with no error anywhere. The page inspects a
  downscaled copy of each frame and retries for ~5 s before giving up with a real
  error message.
- **Physical pixels.** The image is the window at device scale — a 1200×800 window
  at 128 % DPI produces a 1544×1032 PNG, not 1200×800.
- **Watermark stamps the timestamp only.** The `{url}` token is dropped rather
  than filled: this mode photographs whatever window was picked, which is often
  not a tab and often not a browser at all, so no URL describes it honestly. The
  separator left behind by the empty token is collapsed, so the bar reads as one
  clean line.
- **Countdown**, when *Settings -> screenshot countdown* is on, uses the same
  seconds as a visible capture. It runs **after** the window is picked, so there
  is time to switch to that window and open a menu or hover a control before the
  shot. The count is **never drawn in the capture window** — by the time it runs the
  user has been told to go and arrange the target, which raises that window over
  this one. It shows in a **Document Picture-in-Picture window**, the one
  always-on-top window Chrome grants a page (`chrome.windows` has no such option),
  and on the **toolbar badge**, which rides on the target itself whenever the target
  is a Chrome window. PiP needs transient user activation, so it is requested on the
  click that starts the capture, before the picker spends the gesture; where PiP is
  unavailable (Chrome under 116) the badge carries the count alone. The badge is
  cleared and given ~300 ms to repaint before the frame is taken, so it is never
  photographed. Neither surface lands in the image: this mode captures the target
  window's own surface, which overlapping windows do not appear in.
- **Cancelling** works from the moment Share is pressed until the shot is taken:
  the **Cancel** button in the floating countdown window, the **Cancel** button in
  the capture window, or **Esc** in either. The abort is checked where the flow
  already waits — the frame-ready loop and the countdown — so it never interrupts a
  half-finished draw. The stream is stopped, nothing is saved, and the capture
  window returns to its picker button rather than reporting an error. Before Share,
  the picker's own Cancel does the same.
- **The capture window closes before the save begins.** Chrome parents the "Save
  file as" dialog to the focused browser window; while the capture window was
  still up and closing on its own schedule, it took that dialog down with it
  before a folder could be chosen. The worker now waits for the window to be gone
  and only then downloads — and reports the result by notification, since nothing
  of the extension's own UI is left on screen.
- **Not automatable.** It needs a user gesture and a manual pick, so it cannot be
  used as a step inside record/playback.
- A **minimised** target window cannot be captured; restore it first.

**Browser zoom** is normalised to 100 % before full-page and scroll captures and restored afterwards, so a zoomed page does not produce a distorted image. Segment captures deliberately keep the user's zoom: the segment clip rect was measured at that zoom, and resetting it would reflow the layout and point the clip at the wrong content.

**Watermark** is applied in the service worker via `OffscreenCanvas` — supports `{url}` and `{datetime}` tokens, configurable font size.

**Image Diff** tool compares two screenshots pixel-by-pixel with adjustable sensitivity threshold. A standalone **Image Editor** (`editor.html`, opened in a detached window) can crop and annotate any image from the clipboard or a file.

---

## CSV Data-Driven Runs

1. Select a scenario
2. Upload a CSV file (first row = headers = variable names)
3. The scenario runs once per row; each row's columns override `${varName}` tokens
4. Live progress shown in the Now Playing mini panel
5. Results exported as **XLSX** (images in cells), **HTML** (embedded images), or **ZIP** (screenshot files + CSV). Changing the format after a run clears the accumulated results.
6. `screenshot_tovar` actions save screenshots per row into the export

---

## Tab Navigation

- Tabs can be **reordered by drag and drop** — order is saved to `chrome.storage.local`
- The **last active tab** is restored when the popup reopens
- On first use (no saved state), the **first tab in current order** is shown
- Default order: **Record & Play → Data → Capture → Highlight → Settings**

---

## Update Check

A daily alarm calls `chrome.runtime.requestUpdateCheck()` — the official API that asks Chrome to compare the installed version against the published one. No extra host permission and no scraping of the store listing. The single source of truth is `chrome.storage.local.updateStatus`:

```
{ state: "available" | "current" | "unavailable",
  currentVersion, latestVersion?, checkedAt, downloaded?, reason? }
```

Unpacked/dev installs cannot be checked — `requestUpdateCheck()` throws there, which is recorded as `"unavailable"` so the popup stays quiet instead of nagging about an update it cannot verify.

### Update Lock

Once the store has a newer version, the user has a grace period to install it; after that, anything that *starts* a capture, a recording or a playback run is refused until the update is applied. Read-only actions, `STOP_*`, export and backup stay available so a locked install can still be stopped and emptied.

The deadline (`bg/update-lock.js`) is the later of:

* `lastUpdateAt + 30 days` — 30 days since this install last changed version, and
* `updateAvailableSince + 7 days` — a floor, so someone who sat on the newest build for months is not locked the instant a release ships.

The last 5 days before the deadline show a non-dismissible countdown banner.

| Key | Meaning |
|---|---|
| `updateAvailableSince` | First sighting of the pending update; also the "is an update pending" flag. Kept outside `updateStatus`, which is overwritten on every check — one offline check would otherwise reset the grace clock. |
| `lastUpdateAt` | When this install last changed version; written by `onInstalled`, so applying an update lifts the lock immediately. |

Enforcement lives in the service worker (`LOCKED_MESSAGE_TYPES` in `background.js` and the guard in `bg/screenshot.js`), because hotkeys and scheduled runs never pass through the popup. The popup's greyed-out buttons and click guard are UX only. A dev install never sets `updateAvailableSince`, so it can never lock itself.

### Critical releases

A version floor cannot ship inside the extension — users on the broken build would have to update in order to receive the rule telling them to update. So it lives in a JSON file fetched daily from GitHub Pages (`bg/remote-config.js`), published from `docs/update-config.json`:

```json
{ "minVersion": "1.0.9", "hardLock": true, "message": "Security fix" }
```

`hardLock` locks every install below `minVersion` immediately, skipping the grace period. Once Chrome reports the CRX downloaded (`onUpdateAvailable`), `maybeAutoApply()` restarts the extension to install it — no user action at all — deferring while a recording or playback run is in progress.

Because this file can disable the extension for everyone, the client treats it as hostile input: a hard lock still requires Chrome to have independently confirmed a newer version on the store (so a wrong `minVersion` cannot strand anyone), unreachable/malformed/expired configs fail open, a cached config stops applying after 7 days without a refresh, and the self-restart is capped at once per 30 minutes and 3 times per version. See `docs/update-config.README.md`.

---

## Permissions

| Permission | Purpose |
|---|---|
| `<all_urls>` | Content script injection on any site |
| `debugger` | CDP access: full-page/element screenshots, `script` actions, `dropdown` trusted clicks, `uploadFile` into file inputs |
| `scripting` | Inject content scripts on demand |
| `alarms` | Per-schedule alarms (`sched_<id>`), playback keep-alive, daily Web Store update check |
| `downloads` | Auto-save screenshots without file picker |
| `windows` | Open screenshot editor as detached window |
| `notifications` | Completion alerts when popup is closed |
| `tabs` | Read tab info; navigate tabs during playback |
| `storage` | All persistent data |

**Optional permission** (requested on first use, never at install):

| Permission | Purpose |
|---|---|
| `desktopCapture` | Window capture — lets Chrome show the window picker |

**Web-accessible resources.** `dbtools/*.js` plus `sqlcases/tokenizer.js` and `sqlcases/parser.js` are exposed to
pages, because the Adminer integration loads as ES modules through a dynamic `import()` from its content script
and the SQL parser is shared with it. The cost of that is the usual one: a page can detect the extension by
requesting one of those URLs. The alternative — a second, bundled copy of the same logic as globals — would have
guaranteed the two copies drift apart.

---

## Design Principles

1. **Zero dependencies** — No npm, no bundler, no external CDNs
2. **Storage-first state** — All durable state in `chrome.storage`; in-memory is a cache
3. **Graceful degradation** — A failed action is never fatal: playback pauses and a popup on the page asks to Retry, Skip (logged as failed, playback continues) or Stop; on pages that cannot show it, the failure is notified and playback continues
4. **Non-destructive** — Undo/redo for all edits; export before import
5. **Explicit over magic** — No implicit retries or hidden variable scopes

---

## Code Quality Standards

All source files follow a uniform comment policy enforced across the codebase:

| Rule | Standard |
|---|---|
| **Language** | English only in all comments, JSDoc, and non-bilingual strings. Exception: the `{ vi, en }` bilingual data objects in `popup/main.js` help content. |
| **Content** | Comments explain **WHY** — business rules, edge cases, workarounds, performance constraints, API limits, magic numbers. Never restate what the code already says. |
| **JSDoc** | Required for all exported functions and non-trivial module-level functions (`@param`, `@returns`). |
| **No audit refs** | No `// Fix #N`, `P0-E fix`, or `XSS-NEW-N` codes — replaced with descriptive context. |
| **No dead code** | Commented-out code is deleted; use git history instead. |

### Key Technical Constraints (WHY knowledge)

These non-obvious system constraints are documented in source comments and should not be removed:

- **CDP session serialization** — All CDP captures for the same tab are serialized through `_queueScreenshot` to prevent "Another debugger is already attached" errors from concurrent attach calls.
- **`captureTabDouble` 80ms delay** — Discarding the first frame and waiting ~80ms lets the compositor finish before the stable second frame is captured.
- **4000px CDP clip limit** — `Page.captureScreenshot` silently corrupts output beyond 4000px per dimension. Full-page captures tile in 4000px bands.
- **Tile-via-CSS-transform** — Full-page stitching uses CSS transforms to position content (not `window.scroll`), avoiding fixed/sticky element repositioning artifacts.
- **16384px OOM guard** — `OffscreenCanvas` allocations are capped at 16384px per side to stay within GPU driver limits.
- **Zoom normalisation** — Browser zoom compounds with the CDP device-metrics override, shrinking the emulated layout viewport and flipping sites into their mobile layout. Full/scroll captures reset zoom to 100 % first and restore it on both the success and failure paths; segment captures skip the reset because their clip rect was measured at the current zoom.
- **`_isDynamicId` filter** — React fiber ids (`:r0:`) and UUIDs are regenerated on every render, so they are excluded from both the `css` path and the `id` candidate rather than producing a selector that breaks on the next page load.
- **`_csvDoneActive` flag** — Guards the idle polling branch from clearing the 3-minute CSV done bar on the next poll tick after a CSV run completes.
- **Double rAF** — CSS transition initialization requires two `requestAnimationFrame` ticks so the browser commits the reset paint before the shrink animation begins.
- **`previewRequestId` guard** — Stale preview responses are discarded by comparing the request ID incremented before the async call against the module-level counter.
