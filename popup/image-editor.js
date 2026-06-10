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
  }

  function closeModal() {
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
    showToast('Nhấn Ctrl+V để dán ảnh từ clipboard', 'info');
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
      showToast('Chỉ hỗ trợ file ảnh', 'error');
      return;
    }
    fileToDataUrl(file).then(url => launchEditor(url, file.name));
  });

  // navigator.clipboard.read() requires clipboardRead permission; hidden textarea avoids that.
  const pasteCapture = document.createElement('textarea');
  pasteCapture.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;width:1px;height:1px;';
  pasteCapture.setAttribute('tabindex', '-1');
  pasteCapture.setAttribute('aria-label', 'paste capture');
  document.body.appendChild(pasteCapture);

  document.addEventListener('focusout', () => {
    // activeElement updates asynchronously after focusout
    setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body || a === pasteCapture) {
        pasteCapture.focus({ preventScroll: true });
      }
    }, 0);
  });
  pasteCapture.focus({ preventScroll: true });

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

  pasteCapture.addEventListener('paste', (e) => {
    e.preventDefault();
    handlePasteItems(e.clipboardData?.items);
  });

  // pasteCapture loses focus when a real input is active; document.paste catches that case.
  document.addEventListener('paste', (e) => {
    if (e.target === pasteCapture) return; // already handled above
    handlePasteItems(e.clipboardData?.items);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
