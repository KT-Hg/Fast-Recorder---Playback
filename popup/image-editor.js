import { showToast } from './utils.js';

export function initImageEditor() {
  const openBtn   = document.getElementById('openImageEditor');
  const modal     = document.getElementById('imageEditorModal');
  const cancelBtn = document.getElementById('imgEditorCancel');
  const dropZone  = document.getElementById('imgEditorDropZone');
  const fileInput = document.getElementById('imgEditorFileInput');
  const browseBtn = document.getElementById('imgEditorBrowseBtn');
  const clipBtn   = document.getElementById('imgEditorClipboardBtn');

  if (!openBtn || !modal) return;

  const isOpen = () => modal.classList.contains('show');

  function openModal() {
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    cancelBtn?.focus({ preventScroll: true });
  }

  function closeModal() {
    modal.classList.remove('show');
    openBtn.focus({ preventScroll: true });
    modal.setAttribute('aria-hidden', 'true');
  }

  openBtn.addEventListener('click', openModal);
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen()) { e.preventDefault(); closeModal(); }
  });

  /* Reading the file is async, so two sources can fire before the first one
   * resolves — two quick Ctrl+V presses used to open two maximized editor
   * windows. One window per gesture; the flag is only cleared on failure,
   * because success closes this popup anyway. */
  let launching = false;

  function launchEditor(file, sourceFileName = null) {
    if (launching) return;
    launching = true;
    fileToDataUrl(file)
      .then(dataUrl => {
        closeModal();
        chrome.runtime.sendMessage({ type: 'OPEN_IMAGE_EDITOR', dataUrl, sourceFileName }, () => {
          void chrome.runtime.lastError;
        });
        window.close();
      })
      .catch(() => {
        launching = false;
        showToast('Could not read that image', 'error');
      });
  }

  browseBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Only image files are supported', 'error'); return; }
    launchEditor(file, file.name);
  });

  clipBtn.addEventListener('click', () => {
    showToast('Press Ctrl+V to paste an image from the clipboard', 'info');
  });

  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer?.files?.[0];
    if (!file || !file.type.startsWith('image/')) {
      showToast('Only image files are supported', 'error');
      return;
    }
    launchEditor(file, file.name);
  });

  /* === Clipboard capture ===
   *
   * navigator.clipboard.read() would need the clipboardRead permission, so the
   * image is taken off the paste event instead. Chrome delivers that event to
   * whatever holds focus — and to <body> when nothing does — so one listener on
   * the document sees every Ctrl+V in the popup, with no hidden textarea needed
   * to park focus in.
   *
   * Text fields are the one exception. Ctrl+V in the Selector box while an image
   * happened to be on the clipboard used to open the editor and close the popup,
   * discarding the half-filled form; pastes aimed at an editable target are left
   * for that field to handle.
   */
  const EDITABLE = 'input, textarea, [contenteditable=""], [contenteditable="true"]';

  document.addEventListener('paste', (e) => {
    if (e.target?.closest?.(EDITABLE)) return;
    const file = imageFromItems(e.clipboardData?.items);
    if (file) {
      e.preventDefault();
      launchEditor(file, null);
      return;
    }
    // Only worth saying while the modal is up: there the user was told to press
    // Ctrl+V, so silence reads as a broken feature.
    if (isOpen()) showToast('No image on the clipboard — copy an image first', 'error');
  });

  function imageFromItems(items) {
    for (const item of items || []) {
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (file) return file;
    }
    return null;
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
