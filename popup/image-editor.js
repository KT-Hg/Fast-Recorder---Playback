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

  function openModal() {
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    bindPasteCapture();
  }

  function closeModal() {
    unbindPasteCapture();
    modal.classList.remove('show');
    openBtn.focus({ preventScroll: true });
    modal.setAttribute('aria-hidden', 'true');
  }

  openBtn.addEventListener('click', openModal);
  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  function launchEditor(dataUrl, sourceFileName = null) {
    closeModal();
    chrome.runtime.sendMessage({ type: 'OPEN_IMAGE_EDITOR', dataUrl, sourceFileName }, () => {
      void chrome.runtime.lastError;
    });
    window.close();
  }

  browseBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file || !file.type.startsWith('image/')) return;
    fileToDataUrl(file).then(url => launchEditor(url, file.name));
    fileInput.value = '';
  });

  clipBtn.addEventListener('click', () => {
    pasteCapture.focus({ preventScroll: true });
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
    fileToDataUrl(file).then(url => launchEditor(url, file.name));
  });

  /* === Clipboard capture ===
   *
   * navigator.clipboard.read() would need the clipboardRead permission; focusing a
   * hidden textarea and reading the paste event avoids that.
   *
   * Everything below is bound only while the modal is open, and unbound when it
   * closes. Previously both listeners lived for the whole popup session, which
   * caused two distinct problems:
   *
   *   - the focusout handler pulled focus back into an off-screen textarea any
   *     time focus reached <body>, so tabbing out of the last field or clicking
   *     empty space silently moved the caret somewhere invisible;
   *   - the document-level paste handler had no target check, so pressing Ctrl+V
   *     in the Selector box while an image happened to be on the clipboard opened
   *     the image editor and closed the popup, discarding the half-filled form.
   */
  const pasteCapture = document.createElement('textarea');
  pasteCapture.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;width:1px;height:1px;';
  pasteCapture.setAttribute('tabindex', '-1');
  pasteCapture.setAttribute('aria-hidden', 'true');
  document.body.appendChild(pasteCapture);

  function handlePasteItems(items) {
    if (!items) return false;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        fileToDataUrl(file).then(url => launchEditor(url, null));
        return true;
      }
    }
    return false;
  }

  const onFocusOut = () => {
    // activeElement updates asynchronously after focusout.
    setTimeout(() => {
      if (!modal.classList.contains('show')) return;
      const a = document.activeElement;
      if (!a || a === document.body) pasteCapture.focus({ preventScroll: true });
    }, 0);
  };

  const onCapturePaste = (e) => {
    e.preventDefault();
    handlePasteItems(e.clipboardData?.items);
  };

  // Catches Ctrl+V while focus sits on a real control inside the modal (the drop
  // zone, the Browse button). Anything outside the modal is left alone.
  const onDocumentPaste = (e) => {
    if (e.target === pasteCapture) return; // handled by onCapturePaste
    if (!modal.contains(e.target) && e.target !== document.body) return;
    handlePasteItems(e.clipboardData?.items);
  };

  let pasteBound = false;
  function bindPasteCapture() {
    if (pasteBound) return;
    pasteBound = true;
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('paste', onDocumentPaste);
    pasteCapture.addEventListener('paste', onCapturePaste);
    pasteCapture.focus({ preventScroll: true });
  }
  function unbindPasteCapture() {
    if (!pasteBound) return;
    pasteBound = false;
    document.removeEventListener('focusout', onFocusOut);
    document.removeEventListener('paste', onDocumentPaste);
    pasteCapture.removeEventListener('paste', onCapturePaste);
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
