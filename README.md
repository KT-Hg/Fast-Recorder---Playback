# Fast Recorder & Playback

A Chrome Manifest V3 extension that records browser interactions and replays them with conditional logic, variable substitution, scheduling, and CSV-driven data execution — no coding required.

---

## Features

| Category | Capabilities |
|---|---|
| **Recording** | Click, input, hover, drag & drop, navigate, scroll events |
| **Playback** | Single scenario, sequence, loop N×, scheduled (daily), CSV data-driven |
| **Actions** | 14 action types including conditions, switch branching, readDOM, JS script |
| **Variables** | Global `${varName}` substitution across selectors, values, URLs, and scripts |
| **Screenshot** | Visible, full page, scroll (V/H), segment, element — with crop editor and watermark |
| **CSV Run** | Run a scenario once per row; export results to XLSX/CSV/HTML with screenshots |
| **Export** | Scenario JSON, folder JSON, full backup/restore, JS bookmarklet |
| **UI** | Dark/light theme, drag-to-reorder tabs, collapsible cards, hotkeys |

---

## Installation

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
4. Perform your actions on the page
5. Click **■ Stop** → name and save the scenario
6. Click **▶ Play** to replay

---

## Popup Tabs

The popup has four tabs, reorderable by drag-and-drop. The last active tab is remembered across sessions.

### Record & Play
- Start/stop recording, undo/redo recorded actions
- Add manual actions (all 14 types)
- Save and manage scenarios (rename, duplicate, move to folder, delete)
- Playback controls: loop count, loop delay
- Sequence playback (run multiple scenarios in order)

### Data
- Global variables table (`${varName}` → value)
- Scheduled playback (daily at a set time)
- CSV data-driven runs (one scenario execution per CSV row)

### Capture
- Screenshot: Visible, Full Page, Scroll V/H, Segment V/H, Element
- Crop/edit mode for all capture types
- Image diff tool (pixel-level comparison)

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

### Data & Screenshot
| Type | Description |
|---|---|
| `readdom` | Extract text/value/attribute → store as `${varName}` |
| `screenshot` | Capture visible viewport |
| `screenshot_full` | Full page via CDP |
| `screenshot_element` | Specific element via CDP clip |
| `screenshot_tovar` | Any mode → store filename/base64 in variable for CSV export |

---

## Variable System

```
Priority (highest → lowest):
  1. CSV row columns       — per-row override
  2. readdom results       — accumulated during current run
  3. chrome.storage.local  — global persistent variables
```

**Token syntax:** `${varName}` — applied to: selector, value, URL, JS code, expected value, switchVar

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
| Screenshot (Full Page) | `Alt+F` |
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
│  popup.html / popup.js  (UI Layer)                          │
│  Sends messages → background.js                             │
└──────────────────────────┬───────────────────────────────────┘
                           │ chrome.runtime.sendMessage
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  background.js  (Service Worker — Orchestrator)             │
│  Message router · State machine · Storage CRUD              │
│  Playback engine · Screenshot orchestrator · Alarms         │
└──────────────────────────┬───────────────────────────────────┘
                           │ chrome.tabs.sendMessage
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  content.js  (Page Context — Execution Layer)               │
│  DOM event capture · Selector generation (8 strategies)     │
│  Action execution · Condition evaluation · Hotkey listener  │
└──────────────────────────────────────────────────────────────┘
```

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
  settings (hotkeys, watermark, screenshot config, theme, tab order)
  csvRunResults, csvScreenshots
  Pending context flags (pick, drag-drop, form draft)
  activatedTabs whitelist

chrome.storage.sync (100 KB — synced across devices)
  hotkeys, segment scroll speeds, notification preference

chrome.storage.session (1 MB — survives SW restart, lost on browser close)
  undoStacks per scenario (max 50 snapshots each)
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

---

## Selector Strategy

During recording, `generateSelectors()` produces up to 8 selector candidates per element:

```
Priority (tried in order during playback):
  1. id          — #elementId
  2. testId      — [data-testid="..."]
  3. dataId      — [data-id="..."] / [data-cy="..."] etc.
  4. name        — [name="..."]
  5. css         — Computed CSS path
  6. xpath       — Relative XPath
  7. text        — Element text content match
  8. fullXpath   — Absolute XPath (most stable but verbose)
```

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

**Watermark** is applied in the service worker via `OffscreenCanvas` — supports `{url}` and `{datetime}` tokens, configurable font size.

**Image Diff** tool compares two screenshots pixel-by-pixel with adjustable sensitivity threshold.

---

## CSV Data-Driven Runs

1. Select a scenario
2. Upload a CSV file (first row = headers = variable names)
3. The scenario runs once per row; each row's columns override `${varName}` tokens
4. Live progress shown in the Now Playing mini panel
5. Results exported as **XLSX** (images in cells), **CSV** (file paths), or **HTML** (embedded images)
6. `screenshot_tovar` actions save screenshots per row into the export

---

## Tab Navigation

- Tabs can be **reordered by drag and drop** — order is saved to `chrome.storage.local`
- The **last active tab** is restored when the popup reopens
- On first use (no saved state), the **first tab in current order** is shown
- Default order: **Record & Play → Data → Capture → Settings**

---

## Permissions

| Permission | Purpose |
|---|---|
| `<all_urls>` | Content script injection on any site |
| `debugger` | CDP access for full-page and element screenshots |
| `scripting` | Execute `script` actions; inject content scripts on demand |
| `alarms` | Per-schedule daily alarms (`sched_<id>`) |
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
