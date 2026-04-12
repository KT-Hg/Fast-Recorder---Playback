/**
 * state.js — Shared background service worker state
 * Exports: state
 */

export const state = {
  recording: false,
  recordingTabId: null,
  recordingScenarioId: null,
  pickMode: false,
  pendingCrop: null,
  currentActions: [],
  undoStack: [],
  redoStack: [],
  playback: {
    active: false,
    tabId: null,
    scenarioId: null,
    actionIndex: 0,
    totalActions: 0,
  },
  sequencePlayback: {
    active: false,
    runList: [],
    currentIndex: 0,
  },
  csvPlayback: {
    active: false,
    rows: [],
    currentRow: 0,
    scenarioId: null,
    delayBetween: 500,
  },
  segmentCapture: { active: false, tabId: null, dir: null },
};
