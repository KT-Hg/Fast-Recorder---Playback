/**
 * state.js
 * Shared mutable state across popup modules.
 * Exports: state object with all shared variables.
 */

/* === Shared State === */

export const state = {
  currentTabId: null,
  activatedTabs: new Set(),
  editing: null, // { scenarioId, index } when editing an existing action
  dragFromIndex: null,
  scenariosCache: {},
  foldersCache: {},
  currentPickedSelectors: null,
  actionClipboard: null,
  sequenceClipboard: null,
  _switchCases: [],
  pickerMode: false,
  runList: [],
  csvParsed: null,
  connectionRetryCount: 0,
  connectionCheckInterval: null,
  capturingHotkey: null,
  editingScheduleId: null,
  currentSchedules: [],
  previewRequestId: 0,
  _resetScheduleTimePicker: null,
};
