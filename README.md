# Fast Recorder & Playback

A Chrome Manifest V3 extension that records browser interactions and replays them with conditional logic, variable substitution, scheduling, and CSV-driven data execution — no coding required.

---

## Features

| Category | Capabilities |
|---|---|
| **Recording** | `click` and `input` events (input debounced to one action per field). All other action types are added manually. |
| **Playback** | Single scenario, sequence, loop N×, scheduled (one-off or daily), CSV data-driven; runs inside iframes and resumes after a mid-playback page reload |
| **Actions** | 16 action types including upload file, conditions, switch branching, readDOM, JS script |
| **Variables** | 4 types: Static, Random (alpha/numeric/alphanumeric/datetime), Pick, Fallback — `${varName}` substitution across selectors, values, URLs, and scripts |
| **Upload File** | Inject local files into `<input type="file">` or drag-and-drop zones; supports multiple files and `${variable}` filenames |
| **Screenshot** | Visible, full page, scroll (V/H), segment, element — with crop editor, standalone image editor, image diff, and watermark |
| **Highlight** | Select text on any page to highlight it in 5 colours with notes; auto-restored on revisit, scoped by URL patterns |
| **CSV Run** | Run a scenario once per row; export results to XLSX / HTML / ZIP with screenshots |
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

### Capture
- Screenshot: Visible, Full Page, Scroll V/H, Segment V/H, Element
- Crop/edit mode for all capture types
- Image diff tool (pixel-level comparison)
- Standalone image editor for any image from the clipboard or a file

### Highlight
- Select text on a page to highlight it in one of 5 colours (yellow, green, pink, blue, orange), with an optional note per highlight
- Highlights are re-applied automatically on the next visit (a `MutationObserver` re-runs restoration on late-loading content)
- Browse, search, and filter every highlight by colour or by page; per-page and total counts
- **URL Patterns** — wildcards in path *and* subdomain (`site.com/*/settings`, `*.myapp.com/app/*`) decide where highlighting is active; a builder turns the current tab's URL into a pattern
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
chrome.storage.local (5 MB — device-local)
  scenarios, folders, variables, schedules
  settings (watermark, screenshot config, theme, tab order)
  highlights (hl_v1) and highlight URL patterns (hl_patterns_v1)
  csvRunResults (text results only), _csvRows (rows of the active CSV run)
  updateStatus, updateAvailableSince, lastUpdateAt (daily version check + lock)
  Pending context flags (pick, drag-drop, form draft)
  activatedTabs whitelist

chrome.storage.sync (100 KB — synced across devices)
  hotkeys, screenshot save mode + filename prefix,
  segment scroll speeds, notification preference

chrome.storage.session (1 MB — survives SW restart, lost on browser close)
  undoStacks — max 50 snapshots per stack, LRU-capped at 20 scenarios
  Recording buffer (rec_*) and CSV checkpoint (csv_pending, 30 min TTL)

IndexedDB — FastRecorder_CsvScreenshots (disk, no hard quota)
  CSV screenshot results: key = "rowIndex:varName", value = base64 PNG
  No extra permissions needed — safe for Web Store publication
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
| `hl_v1` | `Record<url, Highlight[]>` | Saved highlights, keyed by page URL |
| `hl_patterns_v1` | `string[]` | URL patterns where highlighting is active |
| `updateStatus` | `object` | Result of the daily Web Store version check |
| `updateAvailableSince` | `number` | First sighting of a pending update — grace-clock start |
| `lastUpdateAt` | `number` | When this install last changed version — lock deadline anchor |

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

Six capture modes — all support optional watermark overlay and crop/edit:

| Mode | Method | Notes |
|---|---|---|
| Visible | `chrome.tabs.captureVisibleTab()` | Viewport only |
| Full Page | CDP + `setDeviceMetricsOverride` | Handles fixed elements |
| Scroll V/H | CDP + scroll animation | Stitched panorama |
| Segment V/H | CDP + user-marked range | Start → scroll → stop |
| Element | CDP + `getBoundingClientRect` | Exact element bounds |

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

---

## Design Principles

1. **Zero dependencies** — No npm, no bundler, no external CDNs
2. **Storage-first state** — All durable state in `chrome.storage`; in-memory is a cache
3. **Graceful degradation** — Failed actions are logged, not fatal; playback continues
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
