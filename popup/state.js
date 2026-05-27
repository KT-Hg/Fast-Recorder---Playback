/**
 * state.js — Shared mutable state across popup modules.
 *
 * A single plain object exported as a named reference so all modules share
 * the same instance. No store pattern — mutate fields directly, load functions
 * read from background storage and write back here.
 */

export const state = {
  currentTabId: null,
  activatedTabs: new Set(),
  editing: null,           // { scenarioId, index } — non-null while editing an existing action
  dragFromIndex: null,
  scenariosCache: {},
  foldersCache: {},
  currentPickedSelectors: null,
  actionClipboard: null,
  sequenceClipboard: null,
  _switchCases: [],        // Working copy of cases while the switch-action editor is open
  pickerMode: false,
  runList: [],
  csvParsed: null,
  connectionRetryCount: 0,
  connectionCheckInterval: null,
  capturingHotkey: null,
  editingScheduleId: null, // null → creating new schedule; string ID → editing existing
  currentSchedules: [],
  previewRequestId: 0,     // Incremented on each preview request to discard stale responses
  _resetScheduleTimePicker: null, // Callback injected by the schedule module to reset its time picker
};
