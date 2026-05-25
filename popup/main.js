/**
 * main.js — Core popup logic (recording, scenarios, playback, schedule, CSV)
 * This module contains tightly-coupled UI logic that shares many DOM references.
 * Split from the original monolithic popup.js; uses shared utils and state.
 *
 * Exports: initMain
 */

import { escHtml, getActionIcon, showToast, showConfirm, showAlert,
         lockScroll, unlockScroll, validateNumberInput,
         safeSendTabMessage, isEligibleTab, debounce } from './utils.js';
import { updateRangeFill } from './settings.js';
import { startConnectionCheck, setCsvDoneBar, clearCsvDoneBar, openPbPanel } from './connection.js';
import { addVariableRow } from './variables.js';

/* === Init Main === */

export function initMain() {

/* === Timing constants === */
const FOCUS_DELAY_MS   = 50;   // wait for modal DOM to paint before focusing
const PICKER_RESET_DELAY_MS = 150; // brief wait after stop-record before preview

/* === Module state === */
let scenariosCache = {};
let foldersCache = {};
let editing = null;
let dragFromIndex = null;
let currentPickedSelectors = null;
let currentPickedDragdropTargetSelectors = null;
let actionClipboard = null;
let pickerMode = false;

/* === CONDITION HELP MODAL === */
let _condLang = 'vi';

const COND_DATA = [
  {
    badge: 'ch-badge-elem', badgeLabel: { vi: 'Element', en: 'Element' },
    title: { vi: 'elementExists — Element tồn tại', en: 'elementExists — Element exists' },
    desc: { vi: 'Kiểm tra element có xuất hiện trong DOM không (dù đang ẩn). Nếu KHÔNG tồn tại → skip N actions tiếp theo.', en: 'Check if the element exists in the DOM (even if hidden). If NOT found → skip the next N actions.' },
    selectorReq: true, valueReq: false,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value — không cần', en: 'Expected value — not needed' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#submit-btn', note: { vi: '→ Nếu nút #submit-btn không có trong trang, bỏ qua N action kế tiếp', en: '→ If #submit-btn is not on the page, skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-elem', badgeLabel: { vi: 'Element', en: 'Element' },
    title: { vi: 'elementNotExists — Element không tồn tại', en: 'elementNotExists — Element does not exist' },
    desc: { vi: 'Kiểm tra element KHÔNG có trong DOM. Dùng để chờ loading spinner biến mất trước khi thao tác tiếp.', en: 'Check that the element is NOT in the DOM. Useful to wait for a loading spinner to disappear before continuing.' },
    selectorReq: true, valueReq: false,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value — không cần', en: 'Expected value — not needed' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '.loading-spinner', note: { vi: '→ Nếu spinner vẫn còn, bỏ qua N action kế tiếp', en: '→ If spinner is still present, skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-elem', badgeLabel: { vi: 'Element', en: 'Element' },
    title: { vi: 'elementVisible — Element đang hiển thị', en: 'elementVisible — Element is visible' },
    desc: { vi: 'Kiểm tra element tồn tại VÀ thực sự nhìn thấy được (display≠none, visibility≠hidden, opacity≠0, kích thước &gt;0).', en: 'Check that the element exists AND is truly visible (display≠none, visibility≠hidden, opacity≠0, size&gt;0).' },
    selectorReq: true, valueReq: false,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value — không cần', en: 'Expected value — not needed' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#error-message', note: { vi: '→ Nếu thông báo lỗi đang ẩn, bỏ qua N action kế tiếp', en: '→ If the error message is hidden, skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-elem', badgeLabel: { vi: 'Element', en: 'Element' },
    title: { vi: 'elementHidden — Element đang ẩn', en: 'elementHidden — Element is hidden' },
    desc: { vi: 'Kiểm tra element ẩn hoặc không tồn tại. Ngược lại với elementVisible.', en: 'Check that the element is hidden or does not exist. Opposite of elementVisible.' },
    selectorReq: true, valueReq: false,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value — không cần', en: 'Expected value — not needed' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#modal-overlay', note: { vi: '→ Nếu modal vẫn đang hiển thị, bỏ qua N action kế tiếp', en: '→ If the modal is still visible, skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-text', badgeLabel: { vi: 'Text', en: 'Text' },
    title: { vi: 'textContains — Text chứa chuỗi', en: 'textContains — Text contains string' },
    desc: { vi: 'Kiểm tra nội dung text của element có chứa chuỗi được chỉ định không (phân biệt hoa thường).', en: 'Check if the element\'s text content contains the specified string (case-sensitive).' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: 'h1.page-title', expected: 'Dashboard', note: { vi: '→ Nếu tiêu đề không chứa "Dashboard", bỏ qua N action kế tiếp', en: '→ If the title does not contain "Dashboard", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-text', badgeLabel: { vi: 'Text', en: 'Text' },
    title: { vi: 'textEquals — Text khớp chính xác', en: 'textEquals — Text matches exactly' },
    desc: { vi: 'Kiểm tra nội dung text của element bằng đúng với giá trị mong đợi (trim whitespace).', en: 'Check that the element\'s text content exactly equals the expected value (whitespace trimmed).' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#status-badge', expected: 'Active', note: { vi: '→ Nếu badge không hiển thị đúng "Active", bỏ qua N action kế tiếp', en: '→ If badge does not show exactly "Active", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-value', badgeLabel: { vi: 'Value', en: 'Value' },
    title: { vi: 'valueEquals — Giá trị input khớp chính xác', en: 'valueEquals — Input value matches exactly' },
    desc: { vi: 'Kiểm tra thuộc tính <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">.value</code> của input/select/textarea bằng đúng giá trị mong đợi.', en: 'Check that the <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">.value</code> of an input/select/textarea exactly equals the expected value.' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#username', expected: 'john.doe', note: { vi: '→ Nếu input chưa điền đúng "john.doe", bỏ qua N action kế tiếp', en: '→ If input does not contain exactly "john.doe", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-value', badgeLabel: { vi: 'Value', en: 'Value' },
    title: { vi: 'valueContains — Giá trị input chứa chuỗi', en: 'valueContains — Input value contains string' },
    desc: { vi: 'Kiểm tra thuộc tính <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">.value</code> của input có chứa chuỗi không.', en: 'Check that the <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">.value</code> of an input contains the specified string.' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#search-box', expected: 'product', note: { vi: '→ Nếu ô tìm kiếm không chứa "product", bỏ qua N action kế tiếp', en: '→ If the search box does not contain "product", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-url', badgeLabel: { vi: 'URL', en: 'URL' },
    title: { vi: 'urlContains — URL hiện tại chứa chuỗi', en: 'urlContains — Current URL contains string' },
    desc: { vi: 'Kiểm tra URL của tab hiện tại có chứa chuỗi không. <strong>Không cần Selector.</strong>', en: 'Check if the current tab\'s URL contains the specified string. <strong>No Selector needed.</strong>' },
    selectorReq: false, valueReq: true,
    selectorLabel: { vi: 'Selector — không cần', en: 'Selector — not needed' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, expected: '/dashboard', note: { vi: '→ Nếu URL không chứa "/dashboard", bỏ qua N action kế tiếp', en: '→ If URL does not contain "/dashboard", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-url', badgeLabel: { vi: 'URL', en: 'URL' },
    title: { vi: 'urlEquals — URL hiện tại khớp chính xác', en: 'urlEquals — Current URL matches exactly' },
    desc: { vi: 'Kiểm tra URL của tab hiện tại bằng đúng với chuỗi chỉ định. <strong>Không cần Selector.</strong>', en: 'Check that the current tab\'s URL exactly matches the specified string. <strong>No Selector needed.</strong>' },
    selectorReq: false, valueReq: true,
    selectorLabel: { vi: 'Selector — không cần', en: 'Selector — not needed' },
    valueLabel: { vi: 'Expected value ✓', en: 'Expected value ✓' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, expected: 'https://app.example.com/home', note: { vi: '→ Nếu URL khác, bỏ qua N action kế tiếp', en: '→ If URL is different, skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-attr', badgeLabel: { vi: 'Attribute', en: 'Attribute' },
    title: { vi: 'hasClass — Element có CSS class', en: 'hasClass — Element has CSS class' },
    desc: { vi: 'Kiểm tra element có chứa CSS class được chỉ định không.', en: 'Check if the element contains the specified CSS class.' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓ (tên class)', en: 'Expected value ✓ (class name)' },
    examples: [{ label: { vi: 'Ví dụ', en: 'Example' }, selector: '#nav-home', expected: 'active', note: { vi: '→ Nếu #nav-home không có class "active", bỏ qua N action kế tiếp', en: '→ If #nav-home does not have class "active", skip the next N actions' } }]
  },
  {
    badge: 'ch-badge-attr', badgeLabel: { vi: 'Attribute', en: 'Attribute' },
    title: { vi: 'hasAttribute — Element có thuộc tính HTML', en: 'hasAttribute — Element has HTML attribute' },
    desc: { vi: 'Kiểm tra element có attribute HTML. Nếu Expected value có dạng <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">attr=value</code> thì kiểm tra cả giá trị; nếu chỉ là tên attribute thì kiểm tra sự tồn tại.', en: 'Check if the element has an HTML attribute. If Expected value is in <code style="background:var(--secondary-bg);padding:1px 4px;border-radius:3px;font-size:11px;">attr=value</code> format, both attribute and value are checked; if just an attribute name, only existence is checked.' },
    selectorReq: true, valueReq: true,
    selectorLabel: { vi: 'Selector ✓', en: 'Selector ✓' },
    valueLabel: { vi: 'Expected value ✓ (tên attr hoặc attr=value)', en: 'Expected value ✓ (attr name or attr=value)' },
    examples: [
      { label: { vi: 'Ví dụ 1 — chỉ kiểm tra sự tồn tại', en: 'Example 1 — check existence only' }, selector: '#submit-btn', expected: 'disabled', note: { vi: '→ Nếu nút không có attribute disabled, bỏ qua', en: '→ If button has no disabled attribute, skip' } },
      { label: { vi: 'Ví dụ 2 — kiểm tra giá trị', en: 'Example 2 — check value' }, selector: '#user-panel', expected: 'data-role=admin', note: { vi: '→ Nếu data-role khác "admin", bỏ qua', en: '→ If data-role is not "admin", skip' } }
    ]
  }
];

function buildConditionHelpHTML(lang) {
  return COND_DATA.map(item => {
    const examplesHtml = item.examples.map(ex => {
      let rows = `<span class="ex-label">${ex.label[lang]}</span>`;
      if (ex.selector) rows += `\n            <span class="ex-key">Selector:</span> <span class="ex-val">${ex.selector}</span><br>`;
      if (ex.expected) rows += `\n            <span class="ex-key">Expected:</span> <span class="ex-val">${ex.expected}</span><br>`;
      rows += `\n            <span class="ex-note">${ex.note[lang]}</span>`;
      return rows;
    }).join('<br><br>\n            ');

    return `<div class="ch-item">
          <div class="ch-name">
            <span class="ch-badge ${item.badge}">${item.badgeLabel[lang]}</span>
            <span class="ch-title">${item.title[lang]}</span>
          </div>
          <p class="ch-desc">${item.desc[lang]}</p>
          <div class="ch-fields">
            <span class="ch-field${item.selectorReq ? ' required' : ''}">${item.selectorLabel[lang]}</span>
            <span class="ch-field${item.valueReq ? ' required' : ''}">${item.valueLabel[lang]}</span>
          </div>
          <div class="ch-example">
            ${examplesHtml}
          </div>
        </div>`;
  }).join('\n\n        ');
}

function applyCondLang(lang) {
  _condLang = lang;
  const isVi = lang === 'vi';
  document.getElementById('condHelpTitle').textContent = isVi ? 'Hướng dẫn Condition (If)' : 'Condition (If) Guide';
  document.getElementById('conditionHelpClose').textContent = isVi ? '✕ Đóng' : '✕ Close';
  document.getElementById('condLangToggle').textContent = isVi ? 'EN' : 'VI';
  document.getElementById('conditionHelpBody').innerHTML = buildConditionHelpHTML(lang);
  chrome.storage.local.set({ condHelpLang: lang });
}

function _getFocusableElements(container) {
  return Array.from(container.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  ));
}

function _openModal(modalId, firstFocusSelector) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.add("show");
  lockScroll();
  // Focus first focusable element
  const target = firstFocusSelector
    ? modal.querySelector(firstFocusSelector)
    : _getFocusableElements(modal)[0];
  setTimeout(() => target?.focus(), FOCUS_DELAY_MS);
}

function _closeModal(modalId, returnFocusEl) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.classList.remove("show");
  unlockScroll();
  returnFocusEl?.focus();
}

function _attachModalKeyHandlers(modalId, closeFn) {
  const modal = document.getElementById(modalId);
  if (!modal) return;
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeFn(); return; }
    if (e.key !== "Tab") return;
    const focusable = _getFocusableElements(modal);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  });
}

let _condHelpOpener = null;
document.getElementById("conditionHelpBtn")?.addEventListener("click", (e) => {
  _condHelpOpener = e.currentTarget;
  chrome.storage.local.get('condHelpLang', ({ condHelpLang }) => {
    applyCondLang(condHelpLang || 'vi');
  });
  _openModal("conditionHelpModal", "#conditionHelpClose");
});

_attachModalKeyHandlers("conditionHelpModal", () => _closeModal("conditionHelpModal", _condHelpOpener));

document.getElementById("condLangToggle")?.addEventListener("click", () => {
  applyCondLang(_condLang === 'vi' ? 'en' : 'vi');
});

document.getElementById("conditionHelpClose")?.addEventListener("click", () => {
  _closeModal("conditionHelpModal", _condHelpOpener);
});

document.getElementById("conditionHelpModal")?.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) { _closeModal("conditionHelpModal", _condHelpOpener); }
});

/* === CARD HELP MODALS === */
const CARD_HELP_DATA = {
  recording: {
    title: { vi: 'Hướng dẫn Recording', en: 'Recording Guide' },
    vi: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">▶ Start Recording</span><span class="ch-title">Bắt đầu ghi</span></div><p class="ch-desc">Nhấn để bắt đầu ghi trên tab hiện tại. Extension tự động ghi nhận: <b>click chuột</b>, <b>nhập liệu</b> (input/textarea/select), và <b>điều hướng trang</b> (navigate). Badge trên icon extension chuyển sang đỏ <b>REC</b> khi đang ghi.</p><p class="ch-desc" style="margin-top:4px;">⚠️ Ghi nhận theo thời gian thực — mỗi lần nhấn phím hoặc click đều được lưu ngay. Có thể dùng Undo ↩ để bỏ action vừa ghi nếu nhấn nhầm.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">■ Stop</span><span class="ch-title">Dừng ghi</span></div><p class="ch-desc">Kết thúc phiên ghi. Toàn bộ action được chuyển vào danh sách bên dưới (và giữ nguyên cho đến khi bạn nhấn <b>New</b> hoặc tải một scenario khác).</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">↩ Undo &nbsp;↪ Redo</span><span class="ch-title">Hoàn tác / làm lại</span></div><p class="ch-desc">Hoàn tác hoặc làm lại thao tác thêm/xóa/sửa action trong danh sách. Hỗ trợ tới <b>50 bước</b> undo. Lưu ý: undo stack bị xóa khi nhấn <b>New</b> hoặc tải scenario mới.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Preview Actions</span><span class="ch-title">Xem & chỉnh sửa danh sách</span></div><p class="ch-desc">Mở rộng danh sách action đã ghi. Trong preview bạn có thể:<br>• <b>Kéo thả</b> để đổi thứ tự<br>• <b>✎</b> để sửa action (selector, value, delay, label)<br>• <b>⊘</b> để tạm tắt một action mà không xóa<br>• <b>🗑</b> để xóa action<br>• Badge số lượng hiển thị tổng số action hiện có.</p></div>`,
    en: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">▶ Start Recording</span><span class="ch-title">Start recording</span></div><p class="ch-desc">Click to start recording on the current tab. The extension automatically captures: <b>mouse clicks</b>, <b>keyboard input</b> (input/textarea/select), and <b>page navigation</b>. The extension badge turns red <b>REC</b> while recording.</p><p class="ch-desc" style="margin-top:4px;">⚠️ Recorded in real time — every keypress and click is saved immediately. Use Undo ↩ to remove any accidental actions.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">■ Stop</span><span class="ch-title">Stop recording</span></div><p class="ch-desc">End the recording session. All actions are moved to the list below and kept until you click <b>New</b> or load a different scenario.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">↩ Undo &nbsp;↪ Redo</span><span class="ch-title">Undo / Redo</span></div><p class="ch-desc">Undo or redo add/remove/edit operations on the action list. Supports up to <b>50 undo steps</b>. The stack is cleared when you click <b>New</b> or load a new scenario.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Preview Actions</span><span class="ch-title">View & edit action list</span></div><p class="ch-desc">Expand the recorded action list. In preview you can:<br>• <b>Drag & drop</b> to reorder<br>• <b>✎</b> to edit an action (selector, value, delay, label)<br>• <b>⊘</b> to temporarily disable an action without deleting<br>• <b>🗑</b> to delete an action<br>• The count badge shows the total number of actions.</p></div>`
  },
  addManual: {
    title: { vi: 'Hướng dẫn Add Manual Action', en: 'Add Manual Action Guide' },
    vi: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">① Selector</span><span class="ch-title">Chọn element mục tiêu</span></div><p class="ch-desc">Xác định element nào sẽ bị tác động. Chọn loại selector phù hợp:<br>
        • <b>CSS</b> — ví dụ: <code>#submit-btn</code>, <code>.form-input</code>, <code>div &gt; span</code><br>
        • <b>XPath</b> — ví dụ: <code>//button[@type="submit"]</code><br>
        • <b>ID</b> — chỉ nhập giá trị id, ví dụ: <code>submit-btn</code><br>
        • <b>Name</b> — giá trị của thuộc tính <code>name</code>, ví dụ: <code>email</code><br>
        • <b>Text</b> — text hiển thị của element, ví dụ: <code>Đăng nhập</code><br>
        • <b>Full XPath</b> — đường dẫn tuyệt đối, ví dụ: <code>/html/body/div[1]/button</code><br><br>
        🎯 Nhấn nút <b>picker</b> để click trực tiếp lên element trên trang — extension tự động điền tất cả loại selector có thể dùng.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">② Action Type</span><span class="ch-title">Loại hành động</span></div><p class="ch-desc">
        • <b>Click</b> — click vào element. Với checkbox/radio: tự toggle trạng thái checked.<br>
        • <b>Input</b> — nhập giá trị vào ô text, textarea, hoặc chọn option trong &lt;select&gt;. Tự kích hoạt sự kiện <code>input</code> và <code>change</code>.<br>
        • <b>Navigate</b> — điều hướng đến URL. Extension chờ trang tải xong (<code>status: complete</code>) trước khi tiếp tục action kế tiếp.<br>
        • <b>Run JS</b> — chạy đoạn code JavaScript tùy ý trong ngữ cảnh trang. Ví dụ: <code>window.scrollTo(0, 500)</code> hoặc <code>document.title = 'Test'</code>.<br>
        • <b>Condition (If)</b> — kiểm tra điều kiện; nếu <b>FALSE</b> thì bỏ qua N action tiếp theo. Nhấn nút <b>?</b> bên cạnh dropdown để xem hướng dẫn chi tiết.<br>
        • <b>Screenshot (Visible)</b> — chụp phần nhìn thấy của trang.<br>
        • <b>Screenshot (Full Page)</b> — chụp toàn bộ trang (cuộn xuống và ghép lại).</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">③ Value</span><span class="ch-title">Giá trị</span></div><p class="ch-desc">
        • <b>Input</b>: text sẽ được nhập vào field<br>
        • <b>Navigate</b>: URL đầy đủ, ví dụ <code>https://example.com/login</code><br>
        • <b>Run JS</b>: code JavaScript (nhiều dòng được hỗ trợ)<br>
        • <b>Screenshot</b>: tên file tuỳ chọn (bỏ trống = dùng prefix mặc định)<br><br>
        Hỗ trợ biến động: <code>\${varName}</code> được thay thế bằng giá trị từ Variables table khi chạy.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">④ Delay</span><span class="ch-title">Thời gian chờ sau action</span></div><p class="ch-desc">Thời gian chờ (ms) <b>sau khi</b> action thực hiện xong trước khi chuyển sang action tiếp theo. Ví dụ: đặt <code>1000</code> để chờ 1 giây sau khi click submit để trang có thời gian phản hồi. Mặc định = 0 (không chờ).</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">⑤ Label</span><span class="ch-title">Nhãn ghi chú</span></div><p class="ch-desc">Tên hiển thị trong danh sách action để dễ nhận biết. Không ảnh hưởng đến việc thực thi. Ví dụ: <i>"Click nút đăng nhập"</i>, <i>"Nhập email"</i>.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-purple">Variables</span><span class="ch-title">Bảng biến động</span></div><p class="ch-desc">Khai báo cặp <code>key = value</code> trong bảng. Dùng <code>\${key}</code> ở bất kỳ trường nào (selector, value, URL, JS code). Biến được lưu vào <code>chrome.storage.local</code> và tải lại tự động mỗi khi mở popup.<br><br>
        • <b>+ Add Row</b>: thêm dòng biến mới<br>
        • <b>Random</b>: tạo biến ngẫu nhiên (UUID, timestamp, số…)<br>
        • <b>Save Variables</b>: lưu thay đổi<br>
        • <b>Reload</b>: tải lại từ storage (bỏ thay đổi chưa lưu)</p></div>`,
    en: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">① Selector</span><span class="ch-title">Target element</span></div><p class="ch-desc">Identify which element to act on. Choose the appropriate selector type:<br>
        • <b>CSS</b> — e.g. <code>#submit-btn</code>, <code>.form-input</code>, <code>div &gt; span</code><br>
        • <b>XPath</b> — e.g. <code>//button[@type="submit"]</code><br>
        • <b>ID</b> — just the id value, e.g. <code>submit-btn</code><br>
        • <b>Name</b> — the element's <code>name</code> attribute, e.g. <code>email</code><br>
        • <b>Text</b> — visible text of the element, e.g. <code>Sign In</code><br>
        • <b>Full XPath</b> — absolute path, e.g. <code>/html/body/div[1]/button</code><br><br>
        Click the <b>picker (🎯)</b> button to pick an element directly from the page — all selector types are filled automatically.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">② Action Type</span><span class="ch-title">Action type</span></div><p class="ch-desc">
        • <b>Click</b> — click the element. Toggles checked state for checkbox/radio.<br>
        • <b>Input</b> — set a value on a text input, textarea, or &lt;select&gt;. Fires <code>input</code> and <code>change</code> events automatically.<br>
        • <b>Hover</b> — simulate mouse hover (fires <code>mouseover</code> / <code>mouseenter</code> / <code>mousemove</code>).<br>
        • <b>Drag &amp; Drop</b> — drag the source element (Selector above) and drop it onto a target element.<br>
        • <b>Navigate</b> — go to a URL. Waits for <code>status: complete</code> before continuing.<br>
        • <b>Wait (ms)</b> — pause for a fixed number of milliseconds. No selector needed.<br>
        • <b>Run JS</b> — execute arbitrary JavaScript via CDP (bypasses page CSP). E.g. <code>window.scrollTo(0, 500)</code>.<br>
        • <b>Condition (If)</b> — evaluate a condition; if <b>FALSE</b>, skip the next N actions. Click <b>?</b> next to the dropdown for condition types.<br>
        • <b>Switch (Variable → Scenario)</b> — branch to a different scenario based on a variable value. Define cases value → scenario.<br>
        • <b>Read DOM → Variable</b> — read an element's text, value, or attribute and store it in a variable for later use.<br>
        • <b>Screenshot (Visible)</b> — capture the visible viewport.<br>
        • <b>Screenshot (Full Page)</b> — capture the entire page by scrolling and stitching tiles.<br>
        • <b>Screenshot (Element)</b> — capture a specific element by its selector.<br>
        • <b>Screenshot → Variable (CSV)</b> — capture a screenshot and store the filename/base64 in a variable (useful for CSV export with images).</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-purple">Child Condition</span><span class="ch-title">Find child element by condition</span></div><p class="ch-desc">Available for <b>Click</b>, <b>Input</b>, <b>Hover</b>. When filled, the <b>Selector</b> field becomes the <b>parent container</b>, and the extension searches its children for one matching the condition:<br>
        • <b>value equals</b> — matches <code>el.value === "..."</code> (inputs, selects, checkboxes)<br>
        • <b>text contains</b> — matches elements whose text content contains the string (case-insensitive)<br>
        Leave both empty to act on the selector directly as usual.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">③ Value</span><span class="ch-title">Value</span></div><p class="ch-desc">
        • <b>Input</b>: text to type into the field<br>
        • <b>Navigate</b>: full URL, e.g. <code>https://example.com/login</code><br>
        • <b>Wait</b>: milliseconds to pause, e.g. <code>2000</code> = 2 s<br>
        • <b>Run JS</b>: JavaScript code (multi-line supported)<br>
        • <b>Screenshot</b>: optional filename (leave empty to use the default prefix)<br><br>
        Supports dynamic variables: <code>\${varName}</code> is replaced with the value from the Variables table at runtime.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">④ Delay</span><span class="ch-title">Post-action delay</span></div><p class="ch-desc">Wait time (ms) <b>after</b> the action completes before moving to the next action. E.g. <code>1000</code> = wait 1 s after clicking Submit to let the page respond. Default = 0 (no wait).</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">⑤ Label</span><span class="ch-title">Label / note</span></div><p class="ch-desc">Display name shown in the action list for easy identification. Does not affect execution. E.g. <i>"Click login button"</i>, <i>"Enter email"</i>.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-purple">Variables</span><span class="ch-title">Variable table</span></div><p class="ch-desc">Declare <code>key = value</code> pairs in the table. Use <code>\${key}</code> anywhere (selector, value, URL, JS code). Variables are saved to <code>chrome.storage.local</code> and auto-loaded on popup open.<br><br>
        • <b>+ Add Row</b>: add a new variable row<br>
        • <b>Random</b>: generate a random variable (UUID, timestamp, number…)<br>
        • <b>Save Variables</b>: save changes<br>
        • <b>Reload</b>: reload from storage (discard unsaved changes)</p></div>`
  },
  save: {
    title: { vi: 'Hướng dẫn Save Scenario', en: 'Save Scenario Guide' },
    vi: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Scenario Name</span><span class="ch-title">Tên scenario</span></div><p class="ch-desc">Nhập tên để lưu scenario. Tên là <b>bắt buộc</b> — ô sẽ hiển thị viền đỏ nếu để trống khi nhấn Save. Tên có thể chứa ký tự đặc biệt, khoảng trắng, tiếng Việt. Hai scenario khác thư mục có thể cùng tên.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Folder</span><span class="ch-title">Thư mục</span></div><p class="ch-desc">Chọn thư mục để phân loại scenario. Nhấn <b>+ Folder</b> để tạo thư mục mới ngay từ đây (sẽ đồng bộ với danh sách trong Manage Folders). Chọn <i>"No Folder"</i> nếu không cần phân loại.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">New</span><span class="ch-title">Tạo scenario mới</span></div><p class="ch-desc">Xóa toàn bộ action đang có và reset về trạng thái trống để bắt đầu scenario mới. Sẽ có hộp xác nhận trước khi xóa. <b>Không xóa scenario đã lưu</b> — chỉ xóa buffer đang làm việc.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Save Scenario</span><span class="ch-title">Lưu</span></div><p class="ch-desc">Lưu toàn bộ action hiện tại vào storage với tên đã nhập. Nếu đã có scenario cùng tên trong cùng thư mục, sẽ hỏi xác nhận <b>ghi đè</b>. Sau khi lưu, tên scenario tiếp tục hiển thị để tiện lưu lại nhiều lần khi chỉnh sửa.</p></div>`,
    en: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Scenario Name</span><span class="ch-title">Scenario name</span></div><p class="ch-desc">Enter a name to save the scenario. Name is <b>required</b> — the field shows a red border if empty when you click Save. Names can include special characters, spaces, and non-ASCII text. Two scenarios in different folders can share the same name.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Folder</span><span class="ch-title">Folder</span></div><p class="ch-desc">Select a folder to organize the scenario. Click <b>+ Folder</b> to create a new folder directly from here (it will sync with the Manage Folders list). Choose <i>"No Folder"</i> if no classification is needed.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">New</span><span class="ch-title">New scenario</span></div><p class="ch-desc">Clear all current actions and reset to a blank state for a new scenario. A confirmation dialog appears first. <b>Does not delete saved scenarios</b> — only clears the current working buffer.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Save Scenario</span><span class="ch-title">Save</span></div><p class="ch-desc">Save all current actions to storage under the entered name. If a scenario with the same name exists in the same folder, you will be asked to confirm <b>overwrite</b>. After saving, the name remains displayed for convenient re-saving after edits.</p></div>`
  },
  manage: {
    title: { vi: 'Hướng dẫn Manage Scenarios', en: 'Manage Scenarios Guide' },
    vi: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Search</span><span class="ch-title">Tìm kiếm realtime</span></div><p class="ch-desc">Gõ từ khoá để lọc danh sách theo tên scenario ngay lập tức (không cần nhấn Enter). Kết hợp với bộ lọc Folder để thu hẹp kết quả.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Sort</span><span class="ch-title">Sắp xếp</span></div><p class="ch-desc">4 chế độ sắp xếp: <b>Newest</b> (mới nhất trước), <b>Oldest</b> (cũ nhất trước), <b>Name A→Z</b>, <b>Name Z→A</b>. Trạng thái sắp xếp được nhớ giữa các lần mở popup.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">▶ Play</span><span class="ch-title">Chạy scenario</span></div><p class="ch-desc">Chạy scenario đang chọn trên tab hiện tại. Badge icon chuyển sang xanh lá <b>▶</b>. Extension lần lượt thực hiện từng action, chờ page load nếu có Navigate, áp dụng delay nếu có. Nhấn <b>■ Stop</b> để dừng giữa chừng — action đang thực hiện sẽ hoàn tất trước khi dừng.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">✎ Rename</span><span class="ch-title">Đổi tên</span></div><p class="ch-desc">Nhấn ✎ để mở ô nhập tên mới ngay bên dưới. Nhập tên mới và nhấn <b>✓ Rename</b> để xác nhận, hoặc <b>✕</b> để huỷ. Tên mới không được trùng với scenario khác trong cùng thư mục.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">⧉ Duplicate</span><span class="ch-title">Nhân bản</span></div><p class="ch-desc">Tạo bản sao hoàn chỉnh (toàn bộ actions) của scenario đang chọn. Tên bản sao = tên gốc + <i>" (copy)"</i>. Bản sao được lưu trong cùng thư mục với scenario gốc.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">⇄ Move</span><span class="ch-title">Chuyển thư mục</span></div><p class="ch-desc">Nhấn ⇄ để mở dropdown chọn thư mục đích, sau đó nhấn <b>Move</b>. Scenario sẽ được chuyển sang thư mục mới; tất cả action và dữ liệu giữ nguyên.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-red">🗑 Delete</span><span class="ch-title">Xóa vĩnh viễn</span></div><p class="ch-desc">Xóa scenario khỏi storage, <b>không thể hoàn tác</b>. Sẽ có hộp xác nhận trước khi xóa. Nếu scenario này đang được dùng trong Scheduled Playback hoặc Sequence, các lịch/queue đó không tự cập nhật — cần xóa thủ công.</p></div>`,
    en: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Search</span><span class="ch-title">Real-time search</span></div><p class="ch-desc">Type a keyword to filter the list by scenario name instantly (no Enter needed). Combine with the Folder filter to narrow results.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Sort</span><span class="ch-title">Sort order</span></div><p class="ch-desc">4 sort modes: <b>Newest</b>, <b>Oldest</b>, <b>Name A→Z</b>, <b>Name Z→A</b>. The selected sort is remembered between popup sessions.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">▶ Play</span><span class="ch-title">Run scenario</span></div><p class="ch-desc">Run the selected scenario on the current tab. The badge turns green <b>▶</b>. The extension executes each action in order, waits for page load on Navigate actions, and applies any per-action delay. Click <b>■ Stop</b> to stop — the current action will complete before stopping.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">✎ Rename</span><span class="ch-title">Rename</span></div><p class="ch-desc">Click ✎ to show an inline input below. Enter the new name and click <b>✓ Rename</b> to confirm, or <b>✕</b> to cancel. The new name must not conflict with another scenario in the same folder.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">⧉ Duplicate</span><span class="ch-title">Duplicate</span></div><p class="ch-desc">Create a full copy (all actions) of the selected scenario. The copy's name = original name + <i>" (copy)"</i>. The copy is saved in the same folder as the original.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">⇄ Move</span><span class="ch-title">Move to folder</span></div><p class="ch-desc">Click ⇄ to show a folder dropdown, then click <b>Move</b>. The scenario moves to the new folder; all actions and data are preserved.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-red">🗑 Delete</span><span class="ch-title">Permanently delete</span></div><p class="ch-desc">Delete the scenario from storage — <b>cannot be undone</b>. A confirmation dialog appears first. If this scenario is used in Scheduled Playback or Sequence queues, those entries are not auto-removed — you must delete them manually.</p></div>`
  },
  folders: {
    title: { vi: 'Hướng dẫn Manage Folders', en: 'Manage Folders Guide' },
    vi: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Tạo thư mục</span><span class="ch-title">Create Folder</span></div><p class="ch-desc">Nhập tên thư mục vào ô và nhấn <b>Create</b>. Thư mục được tạo sẽ xuất hiện ngay trong danh sách bên dưới và tự động cập nhật vào tất cả dropdown liên quan (Save Scenario, Filter, Move…).</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">✎ Đổi tên</span><span class="ch-title">Rename Folder</span></div><p class="ch-desc">Nhấn ✎ bên cạnh tên thư mục để chỉnh sửa tên. Tất cả scenario trong thư mục vẫn được liên kết đúng sau khi đổi tên (dùng ID nội bộ, không phải tên).</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-red">🗑 Xóa thư mục</span><span class="ch-title">Delete Folder</span></div><p class="ch-desc">Xóa thư mục khỏi danh sách. <b>Các scenario bên trong không bị xóa</b> — chúng được chuyển về <i>"No Folder"</i> tự động. Thao tác có hộp xác nhận trước khi thực hiện.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">💡 Lưu ý</span><span class="ch-title">Về cách tổ chức</span></div><p class="ch-desc">Thư mục chỉ là nhãn phân loại — một scenario chỉ thuộc về 1 thư mục tại một thời điểm. Để chuyển scenario sang thư mục khác, dùng nút <b>⇄</b> trong Manage Scenarios.</p></div>`,
    en: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Create Folder</span><span class="ch-title">Create folder</span></div><p class="ch-desc">Enter a folder name and click <b>Create</b>. The new folder appears immediately in the list below and is auto-synced to all related dropdowns (Save Scenario, Filter, Move…).</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">✎ Rename</span><span class="ch-title">Rename Folder</span></div><p class="ch-desc">Click ✎ next to a folder name to edit it. All scenarios in that folder remain correctly linked after renaming (uses internal IDs, not the name).</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-red">🗑 Delete</span><span class="ch-title">Delete Folder</span></div><p class="ch-desc">Remove the folder. <b>Scenarios inside are not deleted</b> — they are automatically moved to <i>"No Folder"</i>. A confirmation dialog appears before the action.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">💡 Note</span><span class="ch-title">How folders work</span></div><p class="ch-desc">Folders are just labels — a scenario belongs to exactly one folder at a time. To move a scenario to a different folder, use the <b>⇄</b> button in Manage Scenarios.</p></div>`
  },
  importExport: {
    title: { vi: 'Hướng dẫn Import / Export', en: 'Import / Export Guide' },
    vi: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Export Scenario</span><span class="ch-title">Xuất một scenario</span></div><p class="ch-desc">Chọn scenario từ dropdown rồi nhấn <b>Export Scenario</b>. File <code>.json</code> sẽ được tải xuống với tên = tên scenario. File chứa: tên, danh sách actions, thời gian tạo.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Export Folder</span><span class="ch-title">Xuất cả thư mục</span></div><p class="ch-desc">Chọn thư mục rồi nhấn <b>Export Folder</b>. Tất cả scenario trong thư mục đó được đóng gói vào <b>1 file JSON duy nhất</b> (dạng array). Tiện để backup hoặc chuyển sang máy khác. Tên file = tên thư mục + <code>_folder.json</code>.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">Import Scenario</span><span class="ch-title">Nhập scenario</span></div><p class="ch-desc">Chọn file <code>.json</code> đã export từ trước, rồi nhấn <b>Import Scenario</b>. Extension hỗ trợ:<br>
        • <b>File đơn</b>: 1 scenario object <code>{"name":…,"actions":…}</code><br>
        • <b>File nhiều scenario</b>: array <code>[{"name":…},…]</code> (từ Export Folder)<br><br>
        Scenario nhập vào sẽ <b>được cấp ID mới</b> để tránh trùng với scenario hiện có. Nếu tên trùng, sẽ hỏi xác nhận ghi đè.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">💡 Tip</span><span class="ch-title">Dùng để backup</span></div><p class="ch-desc">Export toàn bộ các thư mục định kỳ để backup. Khi cần khôi phục, Import từng file một. Lưu ý: Variables và Settings không được bao gồm trong file export — cần backup riêng nếu cần.</p></div>`,
    en: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Export Scenario</span><span class="ch-title">Export single scenario</span></div><p class="ch-desc">Select a scenario from the dropdown and click <b>Export Scenario</b>. A <code>.json</code> file is downloaded with the scenario name as the filename. The file contains: name, action list, creation time.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Export Folder</span><span class="ch-title">Export entire folder</span></div><p class="ch-desc">Select a folder and click <b>Export Folder</b>. All scenarios in that folder are packed into <b>a single JSON file</b> (as an array). Useful for backup or migration. Filename = folder name + <code>_folder.json</code>.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">Import Scenario</span><span class="ch-title">Import scenario</span></div><p class="ch-desc">Select a previously exported <code>.json</code> file, then click <b>Import Scenario</b>. Supports:<br>
        • <b>Single file</b>: one scenario object <code>{"name":…,"actions":…}</code><br>
        • <b>Multi-scenario file</b>: array <code>[{"name":…},…]</code> (from Export Folder)<br><br>
        Imported scenarios are <b>assigned new IDs</b> to avoid conflicts. If a name already exists, you will be asked to confirm overwrite.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">💡 Tip</span><span class="ch-title">Use for backups</span></div><p class="ch-desc">Periodically export all folders to back up your scenarios. To restore, import the files one by one. Note: Variables and Settings are not included in export files — back these up separately if needed.</p></div>`
  },
  sequence: {
    title: { vi: 'Hướng dẫn Sequence Scenarios', en: 'Sequence Scenarios Guide' },
    vi: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Thêm vào hàng đợi</span><span class="ch-title">Chọn scenario + delay → + Add</span></div><p class="ch-desc">Chọn scenario từ dropdown, chọn delay (thời gian chờ <b>trước khi</b> chạy scenario đó), rồi nhấn <b>+ Add</b>. Cùng một scenario có thể được thêm nhiều lần với delay khác nhau. Delay của item <b>đầu tiên</b> trong danh sách = thời gian chờ trước khi bắt đầu toàn bộ sequence.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">Quản lý danh sách</span><span class="ch-title">Edit / Disable / Remove</span></div><p class="ch-desc">Mỗi item trong danh sách có 4 nút:<br>
        • <b>⊘/✓</b> — tắt/bật item (item bị tắt sẽ bị bỏ qua khi chạy)<br>
        • <b>⧉</b> — nhân đôi item (thêm bản sao ở cuối danh sách)<br>
        • <b>✎</b> — chỉnh sửa delay của item<br>
        • <b>🗑</b> — xóa item khỏi danh sách<br>
        Kéo thả để thay đổi thứ tự chạy.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">▶ Start Sequence</span><span class="ch-title">Chạy toàn bộ chuỗi</span></div><p class="ch-desc">Nhập tên cho chuỗi và nhấn <b>Start Sequence</b>. Extension chạy lần lượt từng scenario, áp dụng delay giữa các scenario. Badge chuyển sang cam <b>SEQ</b>. Nhấn <b>■ Stop</b> để dừng sau scenario hiện tại hoàn thành.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">Save as Scenario</span><span class="ch-title">Lưu thành 1 scenario</span></div><p class="ch-desc">Gộp toàn bộ actions của tất cả scenario trong danh sách (theo thứ tự) thành một scenario mới, có thể dùng lại hoặc export. Delay giữa scenario được chuyển thành action type <b>wait</b>.</p></div>`,
    en: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Add to queue</span><span class="ch-title">Select scenario + delay → + Add</span></div><p class="ch-desc">Select a scenario, choose a delay (wait time <b>before</b> that scenario runs), then click <b>+ Add</b>. The same scenario can be added multiple times with different delays. The delay of the <b>first</b> item = wait before the entire sequence starts.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">Manage list</span><span class="ch-title">Edit / Disable / Remove</span></div><p class="ch-desc">Each item has 4 buttons:<br>
        • <b>⊘/✓</b> — disable/enable the item (disabled items are skipped when running)<br>
        • <b>⧉</b> — duplicate the item (appends a copy to the list)<br>
        • <b>✎</b> — edit the item's delay<br>
        • <b>🗑</b> — remove the item from the list<br>
        Drag & drop to reorder.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">▶ Start Sequence</span><span class="ch-title">Run the full sequence</span></div><p class="ch-desc">Enter a name for the sequence and click <b>Start Sequence</b>. The extension runs each scenario in order, applying delays between them. The badge turns orange <b>SEQ</b>. Click <b>■ Stop</b> to stop after the current scenario finishes.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">Save as Scenario</span><span class="ch-title">Merge into one scenario</span></div><p class="ch-desc">Combines all actions from every scenario in the list (in order) into a new reusable scenario. Delays between scenarios are converted to <b>wait</b> action type.</p></div>`
  },
  schedule: {
    title: { vi: 'Hướng dẫn Scheduled Playback', en: 'Scheduled Playback Guide' },
    vi: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Thiết lập lịch</span><span class="ch-title">Scenario + Giờ + Label + Repeat → + Add</span></div><p class="ch-desc">
        1. Chọn <b>scenario</b> từ dropdown<br>
        2. Đặt <b>giờ chạy</b>: nhập giờ (1–12) và phút (00–59), chọn AM/PM<br>
        3. Nhập <b>label</b> tuỳ chọn để nhận biết lịch<br>
        4. Bật <b>Repeat daily</b> nếu muốn chạy lặp lại mỗi ngày<br>
        5. Nhấn <b>+ Add</b> để lưu</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">Cơ chế hoạt động</span><span class="ch-title">Alarm kiểm tra mỗi phút</span></div><p class="ch-desc">Background service worker dùng <code>chrome.alarms</code> để kiểm tra mỗi <b>1 phút</b>. Khi giờ hiện tại khớp với giờ trong lịch và lịch đang <b>enabled</b>, scenario sẽ được chạy tự động trên tab hiện tại. Mỗi lịch chỉ chạy <b>1 lần</b> trong cùng phút (tránh chạy lặp).</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">✎ Edit</span><span class="ch-title">Chỉnh sửa lịch đã thêm</span></div><p class="ch-desc">Nhấn ✎ trên item để load lại thông tin vào form phía trên. Chỉnh sửa xong, nhấn <b>+ Add</b> (đã đổi thành <b>Update</b>) để lưu. Lịch cũ bị xóa và lịch mới được tạo thay thế.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">⊘ Disable / ✓ Enable</span><span class="ch-title">Tắt / bật lịch</span></div><p class="ch-desc">Tạm tắt một lịch mà không xóa — lịch bị tắt sẽ bị bỏ qua khi kiểm tra. Dùng khi muốn tạm dừng lịch trong thời gian ngắn.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">⧉ Copy</span><span class="ch-title">Sao chép lịch</span></div><p class="ch-desc">Tạo bản sao của lịch với toàn bộ cài đặt (cùng scenario, giờ, repeat, label). Tiện khi muốn tạo lịch tương tự cho giờ khác.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-red">⚠ Điều kiện hoạt động</span><span class="ch-title">Trình duyệt phải mở</span></div><p class="ch-desc">Scheduled Playback <b>không hoạt động</b> nếu trình duyệt bị đóng hoàn toàn. Background service worker của Chrome MV3 có thể bị suspend sau thời gian không hoạt động — nhưng sẽ được đánh thức lại khi alarm kích hoạt, nên thông thường vẫn hoạt động đúng.</p></div>`,
    en: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Set up schedule</span><span class="ch-title">Scenario + Time + Label + Repeat → + Add</span></div><p class="ch-desc">
        1. Select a <b>scenario</b> from the dropdown<br>
        2. Set the <b>run time</b>: enter hour (1–12) and minute (00–59), select AM/PM<br>
        3. Enter an optional <b>label</b> to identify the schedule<br>
        4. Enable <b>Repeat daily</b> if you want it to run every day<br>
        5. Click <b>+ Add</b> to save</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">How it works</span><span class="ch-title">Alarm checks every minute</span></div><p class="ch-desc">The background service worker uses <code>chrome.alarms</code> to check every <b>1 minute</b>. When the current time matches the scheduled time and the schedule is <b>enabled</b>, the scenario runs automatically on the current tab. Each schedule only fires <b>once per minute</b> (duplicate-run protection).</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">✎ Edit</span><span class="ch-title">Edit a saved schedule</span></div><p class="ch-desc">Click ✎ on an item to load its settings back into the form above. Make changes, then click <b>+ Add</b> (changed to <b>Update</b>) to save. The old schedule is removed and replaced with the updated one.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">⊘ Disable / ✓ Enable</span><span class="ch-title">Toggle schedule</span></div><p class="ch-desc">Temporarily disable a schedule without deleting it — disabled schedules are skipped during checks. Use this to pause a schedule briefly.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">⧉ Copy</span><span class="ch-title">Duplicate schedule</span></div><p class="ch-desc">Create a copy of the schedule with all settings (same scenario, time, repeat, label). Convenient when creating a similar schedule at a different time.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-red">⚠ Requirement</span><span class="ch-title">Browser must be open</span></div><p class="ch-desc">Scheduled Playback <b>does not work</b> if the browser is fully closed. The Chrome MV3 background service worker may be suspended after inactivity — but it will be woken up when the alarm fires, so it typically works correctly as long as the browser is running.</p></div>`
  },
  csv: {
    title: { vi: 'Hướng dẫn CSV Data-Driven Run', en: 'CSV Data-Driven Run Guide' },
    vi: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">Luồng hoạt động</span><span class="ch-title">Tổng quan</span></div><p class="ch-desc">Chạy <b>1 scenario</b> nhiều lần, mỗi lần dùng dữ liệu từ <b>1 dòng CSV</b>. Thích hợp để: điền form hàng loạt, test với nhiều bộ dữ liệu, tạo nhiều tài khoản, nhập dữ liệu từ spreadsheet…</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">① Chọn Scenario</span><span class="ch-title">Scenario phải dùng biến</span></div><p class="ch-desc">Chọn scenario đã được thiết kế để dùng <code>\${varName}</code> trong selector/value/URL/code. Ví dụ: action Input với value = <code>\${email}</code>, action Navigate với URL = <code>https://example.com/user/\${userId}</code>.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">② Upload file CSV</span><span class="ch-title">Định dạng CSV</span></div><p class="ch-desc">File <code>.csv</code> hoặc <code>.txt</code> với cấu trúc:<br>
        <code>email,password,name</code><br>
        <code>user1@test.com,pass123,Alice</code><br>
        <code>user2@test.com,pass456,Bob</code><br><br>
        • <b>Dòng 1</b> = tên cột → trở thành tên biến <code>\${email}</code>, <code>\${password}</code>…<br>
        • <b>Dòng 2 trở đi</b> = dữ liệu, mỗi dòng = 1 lần chạy<br>
        • Hỗ trợ dấu phẩy hoặc dấu chấm phẩy làm dấu phân cách<br>
        • Preview hiển thị số dòng sau khi chọn file</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">③ Delay giữa các lần chạy</span><span class="ch-title">Thời gian chờ</span></div><p class="ch-desc">Thời gian chờ giữa mỗi lần chạy (mỗi dòng CSV). Mặc định 1s. Tăng delay nếu website cần thời gian để xử lý mỗi request. Biến từ <b>Variables table</b> được merge với biến CSV — biến CSV có <b>độ ưu tiên cao hơn</b> (override) nếu cùng tên.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">▶ Start CSV Run</span><span class="ch-title">Bắt đầu chạy</span></div><p class="ch-desc">Chạy scenario lần lượt cho từng dòng. Thanh trạng thái hiển thị tiến trình <i>"Row X / Y"</i>. Nhấn <b>■ Stop</b> để dừng sau dòng hiện tại hoàn thành. Nếu gặp lỗi ở một dòng, extension tiếp tục dòng kế tiếp (không dừng toàn bộ).</p></div>`,
    en: `
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">How it works</span><span class="ch-title">Overview</span></div><p class="ch-desc">Run <b>1 scenario</b> multiple times, each time using data from <b>1 CSV row</b>. Ideal for: bulk form filling, multi-dataset testing, creating multiple accounts, importing data from a spreadsheet…</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">① Select Scenario</span><span class="ch-title">Scenario must use variables</span></div><p class="ch-desc">Select a scenario designed to use <code>\${varName}</code> in selector/value/URL/code. E.g. an Input action with value = <code>\${email}</code>, or a Navigate action with URL = <code>https://example.com/user/\${userId}</code>.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">② Upload CSV file</span><span class="ch-title">CSV format</span></div><p class="ch-desc">A <code>.csv</code> or <code>.txt</code> file with this structure:<br>
        <code>email,password,name</code><br>
        <code>user1@test.com,pass123,Alice</code><br>
        <code>user2@test.com,pass456,Bob</code><br><br>
        • <b>Row 1</b> = column headers → become variable names <code>\${email}</code>, <code>\${password}</code>…<br>
        • <b>Row 2+</b> = data, each row = one run<br>
        • Supports comma or semicolon as delimiter<br>
        • A preview shows the row count after selecting a file</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-gray">③ Delay between runs</span><span class="ch-title">Wait time</span></div><p class="ch-desc">Wait time between each run (each CSV row). Default is 1s. Increase if the website needs time to process each request. Variables from the <b>Variables table</b> are merged with CSV variables — CSV variables have <b>higher priority</b> (override) if names conflict.</p></div>
      <div class="ch-item"><div class="ch-name"><span class="ch-badge badge-blue">▶ Start CSV Run</span><span class="ch-title">Start</span></div><p class="ch-desc">Runs the scenario for each row in order. The status bar shows progress <i>"Row X / Y"</i>. Click <b>■ Stop</b> to stop after the current row completes. If a row fails, the extension continues with the next row (does not abort the entire run).</p></div>`
  }
};

let _cardHelpLang = 'vi';
let _cardHelpKey = null;

function _renderCardHelp() {
  const data = CARD_HELP_DATA[_cardHelpKey];
  if (!data) return;
  const isVi = _cardHelpLang === 'vi';
  document.getElementById('cardHelpTitle').textContent = data.title[_cardHelpLang];
  document.getElementById('cardHelpLangToggle').textContent = isVi ? 'EN' : 'VI';
  document.getElementById('cardHelpClose').textContent = isVi ? '✕ Đóng' : '✕ Close';
  document.getElementById('cardHelpBody').innerHTML = data[_cardHelpLang];
}

const CARD_HELP_LABELS = {
  recording: 'Open Recording guide',
  addManual: 'Open Manual Action guide',
  save: 'Open Save Scenario guide',
  manage: 'Open Manage Scenarios guide',
  folders: 'Open Manage Folders guide',
  importExport: 'Open Import / Export guide',
  sequence: 'Open Sequence Scenarios guide',
  schedule: 'Open Scheduled Playback guide',
  csv: 'Open CSV Data-Driven Run guide',
};

let _cardHelpOpener = null;

document.querySelectorAll('.card-help-btn').forEach(btn => {
  const cardKey = btn.dataset.card;
  btn.setAttribute('aria-label', CARD_HELP_LABELS[cardKey] || `Open ${cardKey} help`);
  btn.setAttribute('aria-haspopup', 'dialog');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    _cardHelpOpener = btn;
    openCardHelp(cardKey);
  });
});

function openCardHelp(cardKey) {
  const data = CARD_HELP_DATA[cardKey];
  if (!data) return;
  _cardHelpKey = cardKey;
  chrome.storage.local.get('cardHelpLang', ({ cardHelpLang }) => {
    _cardHelpLang = cardHelpLang || 'vi';
    _renderCardHelp();
  });
  _openModal('cardHelpModal', '#cardHelpClose');
}

_attachModalKeyHandlers('cardHelpModal', () => _closeModal('cardHelpModal', _cardHelpOpener));

document.getElementById('cardHelpLangToggle')?.addEventListener('click', () => {
  _cardHelpLang = _cardHelpLang === 'vi' ? 'en' : 'vi';
  chrome.storage.local.set({ cardHelpLang: _cardHelpLang });
  _renderCardHelp();
});

document.getElementById('cardHelpClose')?.addEventListener('click', () => {
  _closeModal('cardHelpModal', _cardHelpOpener);
});

document.getElementById('cardHelpModal')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) { _closeModal('cardHelpModal', _cardHelpOpener); }
});


const actionsEl = document.getElementById("actions");
// Announce list updates to screen readers
if (actionsEl) {
  actionsEl.setAttribute("aria-live", "polite");
  actionsEl.setAttribute("aria-label", "Recorded action list");
}
const toggleTheme = document.getElementById("toggleTheme");
const activationCard = document.getElementById("activationCard");
const activationStatus = document.getElementById("activationStatus");
const activateTab = document.getElementById("activateTab");
const deactivateTab = document.getElementById("deactivateTab");
const mainContent = document.getElementById("mainContent");
const scenarioSearch = document.getElementById("scenarioSearch");
const scenarioSort = document.getElementById("scenarioSort");
const duplicateScenarioBtn = document.getElementById("duplicateScenario");

const scenarioFolder = document.getElementById("scenarioFolder");
const createFolderBtn = document.getElementById("createFolder");
const filterFolder = document.getElementById("filterFolder");
const moveToFolderSelect = document.getElementById("moveToFolderSelect");
const doMoveToFolder = document.getElementById("doMoveToFolder");
const manageFoldersCard = document.getElementById("manageFoldersCard");
const newFolderInput = document.getElementById("newFolderInput");
const createFolderAction = document.getElementById("createFolderAction");
const foldersList = document.getElementById("foldersList");
const closeFoldersCard = document.getElementById("closeFoldersCard");
const manageFoldersBtn = document.getElementById("manageFoldersBtn");
const scenarioList = document.getElementById("scenarioList");
const sequenceScenarioList = document.getElementById("sequenceScenarioList");
const preview = document.getElementById("preview");
const startRecord = document.getElementById("startRecord");
const stopRecord = document.getElementById("stopRecord");
const manualSelector = document.getElementById("manualSelector");
const selectorType = document.getElementById("selectorType");
const pickedSelectorsInfo = document.getElementById("pickedSelectorsInfo");
const pickedSelectorsWrap = document.getElementById("pickedSelectorsWrap");
// Hide on startup — will be shown later if there are picked selectors
if (pickedSelectorsWrap && !manualSelector?.value?.trim()) {
  pickedSelectorsWrap.style.display = "none";
}
// Clear pick-done badge if set
chrome.action.setBadgeText({ text: "" });
const manualActionType = document.getElementById("manualActionType");
const manualValue = document.getElementById("manualValue");
const manualDelay = document.getElementById("manualDelay");
const addManualAction = document.getElementById("addManualAction");
const cancelEdit = document.getElementById("cancelEdit");
const pickElement = document.getElementById("pickElement");
const newFlow = document.getElementById("newFlow");
const saveFlow = document.getElementById("saveFlow");
const scenarioName = document.getElementById("scenarioName");
const renameScenario = document.getElementById("renameScenario");
const renameInput = document.getElementById("renameInput");
const deleteScenario = document.getElementById("deleteScenario");
const exportScenario = document.getElementById("exportScenario");
const exportScenarioSelect = document.getElementById("exportScenarioSelect");
const exportFolder = document.getElementById("exportFolder");
const exportFolderSelect = document.getElementById("exportFolderSelect");
const importFile = document.getElementById("importFile");
const importScenario = document.getElementById("importScenario");
const playScenario = document.getElementById("playScenario");
const stopPlay = document.getElementById("stopPlay");
const sequenceScenarioListElement = document.getElementById("sequenceScenarioList");
const delayAfterScenario = document.getElementById("delayAfterScenario");
const delayPreset = document.getElementById("delayPreset");
const addToRunList = document.getElementById("addToRunList");
const runListDisplay = document.getElementById("runListDisplay");
const csvDelayBetweenPreset = document.getElementById("csvDelayBetweenPreset");
const sequenceName = document.getElementById("sequenceName");
const startSequence = document.getElementById("startSequence");
const stopSequence = document.getElementById("stopSequence");
const saveSequenceAsScenario = document.getElementById("saveSequenceAsScenario");

// Compact mode elements
const toggleAdvancedMode = document.getElementById("toggleAdvancedMode");
const compactView = document.getElementById("compactView");
const startRecordCompact = document.getElementById("startRecordCompact");
const stopRecordCompact = document.getElementById("stopRecordCompact");
const scenarioListCompact = document.getElementById("scenarioListCompact");
const playScenarioCompact = document.getElementById("playScenarioCompact");
const stopPlayCompact = document.getElementById("stopPlayCompact");
const scenarioNameCompact = document.getElementById("scenarioNameCompact");
const scenarioFolderCompact = document.getElementById("scenarioFolderCompact");
const saveFlowCompact = document.getElementById("saveFlowCompact");
const previewCompact = document.getElementById("previewCompact");
const actionsCompact = document.getElementById("actionsCompact");

// Undo/Redo elements
const undoAction = document.getElementById("undoAction");
const redoAction = document.getElementById("redoAction");

// v2 elements
const recordingBadge = document.getElementById("recordingBadge");
const actionCount = document.getElementById("actionCount");

// Condition elements
const conditionWrapper = document.getElementById("conditionWrapper");
const conditionType = document.getElementById("conditionType");
const conditionExpectedValue = document.getElementById("conditionExpectedValue");
const conditionExpectedValueWrapper = document.getElementById("conditionExpectedValueWrapper");
const conditionSkipCount = document.getElementById("conditionSkipCount");

// Condition types that don't need selector or expected value
const CONDITION_NO_SELECTOR = ["urlContains", "urlEquals"];
const CONDITION_NO_EXPECTED_VALUE = ["elementExists", "elementNotExists", "elementVisible", "elementHidden"];

/* === Default delay (ms) for all new actions === */
const DEFAULT_DELAY_MS = "500";

/* === Types that never need a selector === */
const TYPES_NO_SELECTOR = new Set(["navigate", "wait", "script", "screenshot", "screenshot_full", "switch"]);

/* === Step label renumbering after visibility changes === */
const _STEP_CIRCLES = ['①','②','③','④','⑤','⑥','⑦'];
const _STEP_LABEL_TEXTS = {
  selectorStepLabel:       'Selector',
  readdomStepLabel:        'Read DOM Settings',
  screenshotTovarStepLabel:'Screenshot Settings',
  dragdropStepLabel:       'Drop Target',
  conditionStepLabel:      'Condition',
  switchStepLabel:         'Switch Variable',
  delayStepLabel:          'Delay (optional)',
  labelStepLabel:          'Label (optional)',
};
const _VALUE_LABEL_TEXTS = {
  script:          'Code JS',
  navigate:        'URL',
  screenshot:      'Filename (optional)',
  screenshot_full: 'Filename (optional)',
};
// Ordered list of [stepLabelId, parentWrapperId] in DOM appearance order
const _STEP_ORDER = [
  ['selectorStepLabel',        'selectorSection'],
  ['readdomStepLabel',         'readdomWrapper'],
  ['screenshotTovarStepLabel', 'screenshotTovarWrapper'],
  ['dragdropStepLabel',        'dragdropWrapper'],
  ['conditionStepLabel',       'conditionWrapper'],
  ['switchStepLabel',          'switchWrapper'],
  ['valueStepLabel',           'manualValueWrapper'],
  ['delayStepLabel',           'manualDelayWrapper'],
  ['labelStepLabel',           'manualLabelWrapper'],
];

function _updateStepLabels() {
  const type = manualActionType.value;
  let n = 2; // ① is always Action Type
  for (const [labelId, parentId] of _STEP_ORDER) {
    const parent = document.getElementById(parentId);
    const label  = document.getElementById(labelId);
    if (!parent || !label) continue;
    // Visible = inline style explicitly set to block/flex (not '', not 'none')
    const vis = parent.style.display !== '' && parent.style.display !== 'none';
    if (!vis) continue;
    const text = labelId === 'valueStepLabel'
      ? (_VALUE_LABEL_TEXTS[type] || 'Value')
      : labelId === 'delayStepLabel' && type === 'wait'
        ? 'Duration (ms)'
        : (_STEP_LABEL_TEXTS[labelId] || '');
    label.textContent = `${_STEP_CIRCLES[n - 1]} ${text}`;
    n++;
  }
}

// Update visibility of condition fields based on selected condition type
function updateConditionFieldsVisibility() {
  const ct = conditionType ? conditionType.value : "";
  const selectorSection = document.getElementById("selectorSection");

  // Hide selector section for URL-based conditions
  if (selectorSection && manualActionType.value === "condition") {
    selectorSection.style.display = CONDITION_NO_SELECTOR.includes(ct) ? "none" : "block";
  }
  if (pickedSelectorsInfo && manualActionType.value === "condition" && CONDITION_NO_SELECTOR.includes(ct)) {
    pickedSelectorsWrap.style.display = "none";
  }

  // Hide expected value for existence/visibility conditions
  if (conditionExpectedValueWrapper) {
    conditionExpectedValueWrapper.style.display = CONDITION_NO_EXPECTED_VALUE.includes(ct) ? "none" : "block";
  }

  _updateStepLabels();
}

// Listen for conditionType changes
if (conditionType) {
  conditionType.onchange = updateConditionFieldsVisibility;
}

// Show/hide attrName field based on readdom readFrom selection
document.getElementById("readdomReadFrom")?.addEventListener("change", function() {
  const attrNameEl = document.getElementById("readdomAttrName");
  if (attrNameEl) attrNameEl.style.display = this.value === "attr" ? "block" : "none";
});

// For screenshot_tovar: show selector section only when target = element
document.getElementById("screenshotTovarTarget")?.addEventListener("change", function() {
  const selectorSection = document.getElementById("selectorSection");
  if (selectorSection) selectorSection.style.display = this.value === "element" ? "block" : "none";
  _updateStepLabels();
});

// Status indicator elements
const statusIndicator = document.getElementById("statusIndicator");
const statusText = document.getElementById("statusText");
const connectionStatus = document.getElementById("connectionStatus");

// Connection check state
let connectionRetryCount = 0;
const MAX_CONNECTION_RETRIES = 5;
let connectionCheckInterval = null;

// Check content script connection

/* === Switch Case Builder === */
let _switchCases = []; // [{ value, scenarioId, scenarioName }]

function populateSwitchScenarioSelect() {
  const sel = document.getElementById("switchCaseScenario");
  if (!sel) return;
  sel.innerHTML = "";
  const scenarios = scenariosCache || {};
  const folders = foldersCache || {};
  Object.entries(scenarios).forEach(([id, s]) => {
    const opt = document.createElement("option");
    opt.value = id;
    const folderName = s.folderId && folders[s.folderId] ? `[${folders[s.folderId].name}] ` : "";
    opt.textContent = folderName + (s.name || id);
    sel.appendChild(opt);
  });
}

function renderSwitchCaseList(editingIdx = -1) {
  const list = document.getElementById("switchCaseList");
  if (!list) return;
  list.innerHTML = "";
  _switchCases.forEach((c, idx) => {
    const row = document.createElement("div");

    if (idx === editingIdx) {
      // ── Edit mode ──
      row.className = "sw-case-row-edit";
      const isDefault = c.value === "__default__";

      // Build scenario options
      const scenarios = scenariosCache || {};
      const folders = foldersCache || {};
      const grouped = {};
      Object.entries(scenarios).forEach(([id, s]) => {
        const fid = s.folderId || "";
        if (!grouped[fid]) grouped[fid] = [];
        grouped[fid].push({ id, name: s.name });
      });
      // XSS-NEW-1: escape all user-controlled data inserted into innerHTML
      let optionsHtml = "";
      (grouped[""] || []).sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
        const sel = s.id === c.scenarioId ? " selected" : "";
        optionsHtml += `<option value="${escHtml(s.id)}"${sel}>${escHtml(s.name)}</option>`;
      });
      Object.entries(folders).forEach(([fid, f]) => {
        if (!grouped[fid]?.length) return;
        optionsHtml += `<optgroup label="${escHtml(f.name)}">`;
        grouped[fid].sort((a, b) => a.name.localeCompare(b.name)).forEach(s => {
          const sel = s.id === c.scenarioId ? " selected" : "";
          optionsHtml += `<option value="${escHtml(s.id)}"${sel}>${escHtml(s.name)}</option>`;
        });
        optionsHtml += `</optgroup>`;
      });

      row.innerHTML = `
        <div class="sw-inline-row">
          <input class="sw-edit-val sw-edit-input" placeholder="Case value (empty = default)"
            value="${isDefault ? "" : escHtml(c.value)}"
            ${isDefault ? 'disabled title="Default case — value cannot be changed"' : ""}
            ${isDefault ? 'style="opacity:0.5;"' : ""} />
        </div>
        <div class="sw-inline-row">
          <select class="sw-edit-scen sw-edit-input">${optionsHtml}</select>
        </div>
        <div class="sw-inline-row-end">
          <button class="sw-edit-confirm secondary sw-edit-btn">✓</button>
          <button class="sw-edit-cancel secondary sw-edit-btn-cancel">✕</button>
        </div>
      `;

      list.appendChild(row);

      row.querySelector(".sw-edit-confirm").addEventListener("click", () => {
        const newVal = row.querySelector(".sw-edit-val").value.trim();
        const newScenId = row.querySelector(".sw-edit-scen").value;
        const newScenName = row.querySelector(".sw-edit-scen").selectedOptions[0]?.textContent || newScenId;
        const resolvedVal = (isDefault || newVal === "") ? "__default__" : newVal;
        // Check duplicate (skip self)
        if (_switchCases.some((x, i) => i !== idx && x.value === resolvedVal)) {
          showToast(`Case "${resolvedVal === "__default__" ? "default" : resolvedVal}" already exists`, "error");
          return;
        }
        _switchCases[idx] = { value: resolvedVal, scenarioId: newScenId, scenarioName: newScenName };
        renderSwitchCaseList();
      });

      row.querySelector(".sw-edit-cancel").addEventListener("click", () => {
        renderSwitchCaseList();
      });

    } else {
      // ── View mode ──
      row.className = "sw-case-row-view";
      // XSS-NEW-1: c.value and c.scenarioName are user-authored — escape before inserting into innerHTML
      const label = c.value === "__default__" ? "⬡ default" : `"${escHtml(c.value)}"`;
      row.innerHTML = `
        <span class="sw-case-label">${label}</span>
        <span class="sw-case-target">→ ${escHtml(c.scenarioName || c.scenarioId)}</span>
        <button data-idx="${idx}" class="sw-case-edit secondary sw-case-btn" title="Edit case">✎</button>
        <button data-idx="${idx}" class="sw-case-del secondary sw-case-btn" title="Delete case">🗑</button>
      `;
      list.appendChild(row);
    }
  });

  list.querySelectorAll(".sw-case-edit").forEach(btn => {
    btn.addEventListener("click", () => {
      renderSwitchCaseList(Number(btn.dataset.idx));
    });
  });
  list.querySelectorAll(".sw-case-del").forEach(btn => {
    btn.addEventListener("click", () => {
      _switchCases.splice(Number(btn.dataset.idx), 1);
      renderSwitchCaseList();
    });
  });
}

document.getElementById("switchAddCase")?.addEventListener("click", () => {
  const valEl  = document.getElementById("switchCaseValue");
  const selEl  = document.getElementById("switchCaseScenario");
  if (!selEl?.value) { showToast("Select a scenario for this case", "error"); return; }
  const rawVal = valEl?.value?.trim();
  const caseVal = rawVal === "" ? "__default__" : rawVal;
  if (_switchCases.find(c => c.value === caseVal)) {
    showToast(`Case "${caseVal === "__default__" ? "default" : caseVal}" already exists`, "error"); return;
  }
  _switchCases.push({
    value: caseVal,
    scenarioId: selEl.value,
    scenarioName: selEl.options[selEl.selectedIndex]?.textContent || selEl.value,
  });
  if (valEl) valEl.value = "";
  renderSwitchCaseList();
});
let sequenceClipboard = null; // Copy/paste clipboard for sequence items

/* === COLLAPSIBLE CARDS === */
const COLLAPSIBLE_STATE_KEY = "collapsibleStates";

// Load saved collapsible states
chrome.storage.local.get([COLLAPSIBLE_STATE_KEY], (res) => {
  const states = res?.[COLLAPSIBLE_STATE_KEY] || {};

  // Apply saved states to main cards
  document.querySelectorAll(".card.collapsible").forEach((card) => {
    const cardId = card.id;
    if (cardId && states[cardId] === "open") {
      card.classList.remove("collapsed");

      // Trigger specific logic for opened cards
      if (card.querySelector("#manualActionType")) {
        setTimeout(() => manualActionType?.dispatchEvent(new Event("change")), 50);
      }
    }
  });

  // Apply saved states to sub-cards
  document.querySelectorAll(".sub-card").forEach((subCard) => {
    const subCardId = subCard.querySelector("h4")?.textContent?.trim() || "";
    if (subCardId && states[`sub-${subCardId}`] === "open") {
      subCard.classList.remove("collapsed");
    }
  });
});

// Save collapsible state
function saveCollapsibleState(cardId, isOpen) {
  chrome.storage.local.get([COLLAPSIBLE_STATE_KEY], (res) => {
    const states = res?.[COLLAPSIBLE_STATE_KEY] || {};
    states[cardId] = isOpen ? "open" : "closed";
    chrome.storage.local.set({ [COLLAPSIBLE_STATE_KEY]: states });
  });
}

function _toggleCollapsibleCard(h3) {
  const card = h3.closest(".card.collapsible");
  card.classList.toggle("collapsed");
  const isExpanded = !card.classList.contains("collapsed");
  h3.setAttribute("aria-expanded", String(isExpanded));

  if (card.id) {
    saveCollapsibleState(card.id, isExpanded);
  }

  if (isExpanded && card.querySelector("#manualActionType")) {
    setTimeout(() => { manualActionType.dispatchEvent(new Event("change")); }, 50);
  }
}

document.querySelectorAll(".card.collapsible h3").forEach((h3) => {
  // Ensure all collapsible headers are keyboard-focusable
  if (!h3.hasAttribute("tabindex")) h3.setAttribute("tabindex", "0");
  // Sync aria-expanded with initial CSS state
  const card = h3.closest(".card.collapsible");
  h3.setAttribute("aria-expanded", String(!card.classList.contains("collapsed")));
  h3.setAttribute("role", "button");

  h3.addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
    _toggleCollapsibleCard(h3);
  });

  h3.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      _toggleCollapsibleCard(h3);
    }
  });
});

// Handle nested sub-card collapsible (Variables sub-card)
document.querySelectorAll(".sub-card h4").forEach((h4) => {
  if (!h4.hasAttribute("tabindex")) h4.setAttribute("tabindex", "0");
  h4.setAttribute("role", "button");
  const subCard = h4.closest(".sub-card");
  h4.setAttribute("aria-expanded", String(!subCard.classList.contains("collapsed")));

  function _toggleSubCard() {
    subCard.classList.toggle("collapsed");
    const isExpanded = !subCard.classList.contains("collapsed");
    h4.setAttribute("aria-expanded", String(isExpanded));
    const subCardId = `sub-${h4.textContent?.trim() || ""}`;
    saveCollapsibleState(subCardId, isExpanded);
  }

  h4.addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON" || e.target.tagName === "INPUT") return;
    _toggleSubCard();
  });

  h4.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      _toggleSubCard();
    }
  });
});

/* === Message Listeners === */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "SCREENSHOT_RESULT") return;
  const { result } = msg;
  if (result?.error) {
    showToast('✗ ' + result.error, 'error');
  } else if (result?.success) {
    showToast('✓ Saved: ' + (result.filename || 'screenshot'), 'success');
  }
});

// Fix #6: notify user when an action fails during playback
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "ACTION_FAILED") return;
  const label = msg.action?.type ? `[${msg.action.type}]` : "";
  const reason = msg.reason || "element not found";
  showToast(`✗ Action ${msg.index + 1} failed ${label} — ${reason}`, "error");
});

// Notify user when a Switch action branches to another scenario
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "SWITCH_SCENARIO") return;
  showToast(`🔀 Switch [${msg.caseLabel}] → "${msg.scenarioName}"`, "success");
});

// Fix #10: notify user on storage warnings / errors
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STORAGE_WARNING") {
    const pct = Math.round((msg.bytes / msg.limit) * 100);
    showToast(`⚠ Storage ${pct}% full — consider exporting old scenarios`, "error");
  } else if (msg.type === "STORAGE_ERROR") {
    showToast(`✗ Storage error: ${msg.msg}`, "error");
  }
});

/* === CSV realtime message listeners === */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "CSV_ROW_DONE") return;
  _stopCsvCountdown();
  const csvRow = msg.rowIndex + 1, csvTotal = msg.total;
  _updateCsvBadges(csvRow, csvTotal, msg.failRows ?? 0, false);
  if (!msg.isLast) _startCsvCountdown(msg.delayBetween ?? _csvDelayBetween);
  const stepEl = document.getElementById('nowPlayingStep');
  if (stepEl) stepEl.textContent = `Row Done ${csvRow}/${csvTotal}`;
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "CSV_RUN_DONE") return;
  const failRows = msg.failRows ?? 0;
  _updateCsvBadges(msg.total, msg.total, failRows, true);
  _setCsvState('done');
  const name    = msg.scenarioName || _csvRunScenarioName || "CSV Run";
  const summary = failRows > 0
    ? `✓ ${msg.total - failRows} · ✗ ${failRows} of ${msg.total}`
    : `✓ ${msg.total} rows done`;
  setCsvDoneBar(name, summary);
});

/* === Resumable Playback Banner === */
let _resumeCheckpoint = null;
const resumeBanner = document.getElementById("resumeBanner");

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "OFFER_RESUME") return;
  _resumeCheckpoint = msg.checkpoint;
  const { scenarioId, actionIndex } = msg.checkpoint;
  const name = scenariosCache[scenarioId]?.name || scenarioId;
  document.getElementById("resumeBannerMsg").textContent =
    `Playback interrupted at action #${actionIndex + 1} of "${name}" — resume?`;
  resumeBanner.style.display = "flex";
});

document.getElementById("resumeBtn")?.addEventListener("click", () => {
  if (!_resumeCheckpoint) return;
  chrome.runtime.sendMessage({ type: "RESUME_PLAYBACK", ..._resumeCheckpoint });
  resumeBanner.style.display = "none";
  _resumeCheckpoint = null;
});

document.getElementById("resumeDismissBtn")?.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "DISMISS_RESUME" });
  resumeBanner.style.display = "none";
  _resumeCheckpoint = null;
});


/* === Compact Mode (legacy stubs) === */
function applyAdvancedMode() {
  // Always advanced in tab-based UI
  document.body.classList.remove("compact-mode");
}

if (toggleAdvancedMode) {
  toggleAdvancedMode.addEventListener('click', () => {
    const isAdvanced = document.body.classList.contains("compact-mode");
    applyAdvancedMode(isAdvanced);
    chrome.storage.local.set({ [ADVANCED_MODE_KEY]: isAdvanced });
    document.getElementById('toggleAdvancedMode')?.setAttribute('aria-checked', String(isAdvanced));
  });
  toggleAdvancedMode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.currentTarget.click();
    }
  });
}

// Compact mode button handlers
if (startRecordCompact) {
  startRecordCompact.addEventListener('click', async () => {
    // Query current tab directly to ensure we have the correct tabId
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab) return;

      const tabId = tab.id;

      // Ensure content script is injected first
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ["content.js"]
        });
      } catch (err) {
        console.log("Content script already injected or error:", err);
      }

      // Add to activated tabs if not already
      if (!activatedTabs.has(tabId)) {
        activatedTabs.add(tabId);
        chrome.storage.local.set({ activatedTabs: Array.from(activatedTabs) });
      }

      // Start recording
      chrome.runtime.sendMessage({ type: "START_RECORD", tabId });
      window.close(); // Close popup so recording can proceed
    });
  });
}

if (stopRecordCompact) {
  stopRecordCompact.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: "STOP_RECORD" });
    setTimeout(previewActionsCompact, 150);
  });
}

if (playScenarioCompact) {
  playScenarioCompact.addEventListener('click', () => {
    const scenarioId = scenarioListCompact?.value;
    if (!scenarioId) return;
    chrome.runtime.sendMessage({ type: "START_PLAYBACK_SCENARIO", scenarioId });
    window.close();
  });
}

if (stopPlayCompact) {
  stopPlayCompact.addEventListener('click', () => chrome.runtime.sendMessage({ type: "STOP_PLAYBACK" }));
}


/* === SCREENSHOT BUTTONS === */

/* === Recording, Scenarios, Sequence, Playback === */

// Dragdrop target pick mode
document.getElementById("dragdropTargetPick")?.addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id || !isEligibleTab(tab)) { showToast("Invalid tab for pick mode", "error"); return; }
    // Save current form state so we can restore after pick
    chrome.storage.local.remove(["elemShotPickPending", "elemShotPickCrop"]);
    chrome.storage.local.set({
      dragdropTargetPickPending: true,
      dragdropTargetPickState: {
        scenarioId: scenarioList.value || null,
        editingIndex: editing ? editing.index : null,
        sourceSelector: manualSelector.value?.trim() || "",
        sourceSelectors: currentPickedSelectors || null,
        existingTarget: document.getElementById("dragdropTarget")?.value?.trim() || "",
        targetSelectorType: document.getElementById("dragdropTargetSelectorType")?.value || "css",
        actionType: manualActionType.value,
        delay: manualDelay.value,
        label: document.getElementById("manualLabel")?.value?.trim() || "",
      }
    });
    safeSendTabMessage(tab.id, { type: "START_PICK_MODE" });
    chrome.runtime.sendMessage({ type: "START_PICK_MODE", tabId: tab.id });
    window.close();
  });
});


// Sync compact scenario list with main list
function renderCompactScenarioList() {
  if (!scenarioListCompact) return;

  scenarioListCompact.innerHTML = '<option value="">-- Select scenario --</option>';

  const sortedScenarios = Object.entries(scenariosCache)
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0));

  sortedScenarios.forEach(([id, meta]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = meta.name;
    scenarioListCompact.appendChild(option);
  });
}

// Sync compact folder list with main list
function renderCompactFolderList() {
  if (!scenarioFolderCompact) return;

  scenarioFolderCompact.innerHTML = '<option value="">(No Folder)</option>';

  Object.entries(foldersCache).forEach(([id, folder]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = folder.name;
    scenarioFolderCompact.appendChild(option);
  });
}

function _showFieldError(inputEl, message) {
  inputEl.classList.add("required-error");
  inputEl.setAttribute("aria-invalid", "true");
  let errorEl = inputEl.parentElement.querySelector('[role="alert"].field-error');
  if (!errorEl) {
    errorEl = document.createElement("div");
    errorEl.setAttribute("role", "alert");
    errorEl.className = "field-error";
    errorEl.style.cssText = "color:var(--danger);font-size:11px;margin-top:3px;";
    inputEl.parentElement.insertBefore(errorEl, inputEl.nextSibling);
  }
  errorEl.textContent = message;
  setTimeout(() => {
    inputEl.classList.remove("required-error");
    inputEl.setAttribute("aria-invalid", "false");
    errorEl.textContent = "";
  }, 2500);
}

// Compact mode save handler
if (saveFlowCompact) {
  saveFlowCompact.addEventListener('click', () => {
    const name = (scenarioNameCompact?.value || "").trim();
    if (!name) {
      _showFieldError(scenarioNameCompact, "Scenario name is required");
      return;
    }
    const folderId = scenarioFolderCompact?.value || null;
    chrome.runtime.sendMessage(
      { type: "SAVE_SCENARIO", name, folderId },
      () => {
        scenarioNameCompact.value = "";
        loadScenarios();
      }
    );
  });
}

// Compact mode preview handler (recorded actions buffer)
function previewActionsCompact() {
  if (!actionsCompact) return;

  chrome.runtime.sendMessage({ type: "GET_PREVIEW_ACTIONS" }, (res) => {
    const actions = res?.actions || [];
    actionsCompact.innerHTML = "";

    if (actions.length === 0) {
      actionsCompact.innerHTML = '<li style="color: var(--muted); font-style: italic;">No actions recorded</li>';
      return;
    }

    actions.forEach((action) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="type">${getActionIcon(action.type)}${escHtml(action.type)}</span>
        <span class="value">${escHtml(action.value || action.selector || action.url || action.code || "")}</span>
      `;
      actionsCompact.appendChild(li);
    });
  });
}

if (previewCompact) {
  previewCompact.addEventListener('click', previewActionsCompact);
}

// Compact mode preview handler (selected scenario actions)
const previewScenarioCompact = document.getElementById("previewScenarioCompact");
const actionsScenarioCompact = document.getElementById("actionsScenarioCompact");

function previewScenarioActionsCompact() {
  if (!actionsScenarioCompact || !scenarioListCompact) return;

  const scenarioId = scenarioListCompact.value;
  if (!scenarioId) {
    actionsScenarioCompact.innerHTML = '<li style="color: var(--muted); font-style: italic;">No scenario selected</li>';
    return;
  }

  chrome.runtime.sendMessage({ type: "GET_PREVIEW_ACTIONS", scenarioId }, (res) => {
    const actions = res?.actions || [];
    actionsScenarioCompact.innerHTML = "";

    if (actions.length === 0) {
      actionsScenarioCompact.innerHTML = '<li style="color: var(--muted); font-style: italic;">No actions in scenario</li>';
      return;
    }

    actions.forEach((action) => {
      const li = document.createElement("li");
      li.innerHTML = `
        <span class="type">${getActionIcon(action.type)}${escHtml(action.type)}</span>
        <span class="value">${escHtml(action.value || action.selector || action.url || action.code || "")}</span>
      `;
      actionsScenarioCompact.appendChild(li);
    });
  });
}

if (previewScenarioCompact) {
  previewScenarioCompact.addEventListener('click', previewScenarioActionsCompact);
}

const SELECTOR_LABELS = {
  css: 'CSS', xpath: 'XPath', fullXpath: 'Full XPath',
  id: 'ID', name: 'Name', text: 'Text', testId: 'Test ID', dataId: 'Data ID'
};

function _buildSelectorOptionsHtml(selectors) {
  let html = '<div style="color:var(--muted);margin-bottom:4px;font-weight:500;">📋 Available selectors (click to use):</div>';
  for (const [type, value] of Object.entries(selectors)) {
    if (type === 'textTag' || !value) continue;
    const label = SELECTOR_LABELS[type] || type;
    const displayValue = value.length > 60 ? value.substring(0, 60) + '…' : value;
    html += `<div class="selector-option" data-type="${type}" data-value="${encodeURIComponent(value)}">
      <strong style="color:var(--primary);">${label}:</strong>
      <code style="font-size:9px;word-break:break-all;">${displayValue}</code>
    </div>`;
  }
  return html;
}

function _renderSelectorPanel(selectors, { infoEl, wrapEl, clearBtnId, onSelect, onClear }) {
  if (!selectors || !infoEl || !wrapEl) return;
  infoEl.innerHTML = _buildSelectorOptionsHtml(selectors);
  wrapEl.style.display = 'flex';

  const clearBtn = document.getElementById(clearBtnId);
  if (clearBtn) {
    const newBtn = clearBtn.cloneNode(true); // remove prior listeners
    clearBtn.parentNode.replaceChild(newBtn, clearBtn);
    newBtn.addEventListener('click', (e) => { e.stopPropagation(); onClear(); });
  }

  infoEl.querySelectorAll('.selector-option').forEach(opt => {
    opt.addEventListener('click', () => onSelect(opt.dataset.type, decodeURIComponent(opt.dataset.value)));
    opt.addEventListener('mouseover', () => { opt.style.background = 'var(--secondary-bg)'; });
    opt.addEventListener('mouseout', () => { opt.style.background = 'transparent'; });
  });
}

// Helper to display all available selectors
function displayPickedSelectors(selectors) {
  if (!selectors || !pickedSelectorsInfo || !pickedSelectorsWrap) return;
  currentPickedSelectors = selectors;
  _renderSelectorPanel(selectors, {
    infoEl: pickedSelectorsInfo,
    wrapEl: pickedSelectorsWrap,
    clearBtnId: 'clearPickedSelectorsBtn',
    onSelect: (type, value) => {
      selectorType.value = type;
      manualSelector.value = value;
    },
    onClear: () => {
      currentPickedSelectors = null;
      manualSelector.value = '';
      pickedSelectorsInfo.innerHTML = '';
      pickedSelectorsWrap.style.display = 'none';
      chrome.storage.local.remove(["lastPickedSelector", "lastPickedSelectors"]);
    },
  });
}

// Display picked selectors for drag & drop TARGET
function displayPickedDragdropTargetSelectors(selectors) {
  const info = document.getElementById('pickedDragdropTargetInfo');
  const wrap = document.getElementById('pickedDragdropTargetWrap');
  if (!selectors || !info || !wrap) return;
  currentPickedDragdropTargetSelectors = selectors;
  _renderSelectorPanel(selectors, {
    infoEl: info,
    wrapEl: wrap,
    clearBtnId: 'clearDragdropTargetBtn',
    onSelect: (type, value) => {
      const dtType = document.getElementById('dragdropTargetSelectorType');
      if (dtType) dtType.value = type;
      const t = document.getElementById('dragdropTarget');
      if (t) t.value = value;
    },
    onClear: () => {
      currentPickedDragdropTargetSelectors = null;
      const t = document.getElementById('dragdropTarget');
      if (t) t.value = '';
      info.innerHTML = '';
      wrap.style.display = 'none';
    },
  });
}

/* === LISTEN FOR ELEMENT PICKED (EARLY REGISTER) === */
// Register early so ELEMENT_PICKED is caught even if popup opens later
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "ELEMENT_PICKED") {
    // If pick was triggered by element screenshot, don't populate the form
    chrome.storage.local.get(["elemShotPickPending"], (flags) => {
      if (flags.elemShotPickPending) {
        pickerMode = false;
        pickElement.textContent = "🎯";
        pickElement.classList.remove('picker-active');
        document.getElementById('pickerInstructionBar')?.classList.remove('show');
        return;
      }
      manualSelector.value = msg.selector || "";
      currentPickedSelectors = msg.selectors || { css: msg.selector };
      displayPickedSelectors(currentPickedSelectors);
      selectorType.value = 'css';
      pickerMode = false;
      pickElement.textContent = "🎯";
      pickElement.classList.remove('picker-active');
      document.getElementById('pickerInstructionBar')?.classList.remove('show');
    });
    sendResponse({ success: true });
  }
});

// If popup opens after picking, restore the cached selector from storage
chrome.storage.local.get(["lastPickedSelector", "lastPickedSelectors", "pendingEdit", "dragdropTargetPickPending", "dragdropTargetPickState", "elemShotPickPending", "manualFormDraft"], (res) => {
  // Restore pending edit/add state (saved before pick mode opens)
  if (res?.pendingEdit) {
    const pe = res.pendingEdit;
    // Only restore as edit if it was an existing action (has index)
    if (!pe.isNew && pe.index != null) {
      editing = { scenarioId: pe.scenarioId, index: pe.index };
      addManualAction.textContent = "Save Edit";
      cancelEdit.style.display = "inline-block";
    }
    manualActionType.value = pe.actionType || "";
    manualValue.value = pe.actionValue || "";
    setManualDelayUI(pe.actionDelay || DEFAULT_DELAY_MS);
    if (pe.actionDelayPreset) {
      const presetEl = document.getElementById("manualDelayPreset");
      if (presetEl) presetEl.value = pe.actionDelayPreset;
    }

    // Trigger onchange to restore all field visibility correctly
    manualActionType.onchange?.();

    // Open the collapsible card
    const card = document.getElementById("addManualActionCard");
    if (card && card.classList.contains("collapsed")) {
      card.classList.remove("collapsed");
    }

    chrome.storage.local.remove("pendingEdit");
  }

  // Restore dragdrop target pick
  if (res?.dragdropTargetPickPending && (res?.lastPickedSelector || res?.lastPickedSelectors)) {
    chrome.storage.local.remove(["dragdropTargetPickPending", "dragdropTargetPickState", "lastPickedSelector", "lastPickedSelectors"]);
    const picked = res.lastPickedSelectors?.css || res.lastPickedSelector || "";
    const st = res.dragdropTargetPickState || {};
    // Restore form state
    manualActionType.value = "dragdrop";
    manualSelector.value = st.sourceSelector || "";
    manualActionType.onchange?.();  // trigger show/hide
    // Restore target selector with full selector display
    const ddPickedSelectors = res.lastPickedSelectors || (picked ? { css: picked } : null);
    const dtSelectorType = document.getElementById("dragdropTargetSelectorType");
    if (ddPickedSelectors) {
      displayPickedDragdropTargetSelectors(ddPickedSelectors);
      if (dtSelectorType) dtSelectorType.value = st.targetSelectorType || "css";
      const ddTarget = document.getElementById("dragdropTarget");
      if (ddTarget) ddTarget.value = ddPickedSelectors[st.targetSelectorType || "css"] || picked;
    } else {
      const ddTarget = document.getElementById("dragdropTarget");
      if (ddTarget) ddTarget.value = st.existingTarget || "";
    }
    if (st.sourceSelectors) {
      currentPickedSelectors = st.sourceSelectors;
      displayPickedSelectors(currentPickedSelectors);
    }
    setManualDelayUI(st.delay || DEFAULT_DELAY_MS);
    const lblEl = document.getElementById("manualLabel");
    const lblW  = document.getElementById("manualLabelWrapper");
    if (lblEl) lblEl.value = st.label || "";
    if (st.label && lblW) lblW.style.display = "block";
    if (st.editingIndex != null) {
      editing = { scenarioId: st.scenarioId, index: st.editingIndex };
      addManualAction.textContent = "Save Edit";
      cancelEdit.style.display = "inline-block";
    }
    // Open the action card
    const card = document.getElementById("addManualActionCard");
    if (card?.classList.contains("collapsed")) card.classList.remove("collapsed");
    return;
  }

  // Then restore picked selectors — only if NOT from element screenshot pick
  if (!res?.elemShotPickPending) {
    if (res?.lastPickedSelectors) {
      try {
        currentPickedSelectors = res.lastPickedSelectors;
        displayPickedSelectors(currentPickedSelectors);
        if (res.lastPickedSelector) {
          manualSelector.value = res.lastPickedSelector;
        }
        chrome.storage.local.remove(["lastPickedSelector", "lastPickedSelectors"]);
      } catch (e) { /* ignore */ }
    } else if (res?.lastPickedSelector) {
      try {
        manualSelector.value = res.lastPickedSelector;
        chrome.storage.local.remove("lastPickedSelector");
      } catch (e) { /* ignore */ }
    }

    // Restore draft (only if not coming from any pick mode)
    if (!res?.pendingEdit && !res?.dragdropTargetPickPending && res?.manualFormDraft) {
      restoreDraft(res.manualFormDraft);
    }
  }
});

/* === TAB ACTIVATION === */

let currentTabId = null;
let activatedTabs = new Set();

// Load activated tabs from storage
chrome.storage.local.get(["activatedTabs"], (res) => {
  if (res?.activatedTabs) {
    activatedTabs = new Set(res.activatedTabs);
  }
  checkTabActivation();
});

function showLockOverlay(which, type) {
  const id = which === 'record' ? 'Record' : 'Data';
  const overlay = document.getElementById('lockOverlay' + id);
  const titleEl = document.getElementById('lockOverlay' + id + 'Title');
  const subEl = document.getElementById('lockOverlay' + id + 'Sub');
  const btn = document.getElementById('lockOverlay' + id + 'Btn');
  if (!overlay) return;
  if (type === 'not-eligible') {
    if (titleEl) titleEl.textContent = 'Not Available';
    if (subEl) subEl.textContent = 'Recording and playback are not supported on this page (e.g. Chrome settings, extension pages).';
    if (btn) btn.hidden = true;
  } else {
    if (titleEl) titleEl.textContent = 'Activate on Tab';
    if (subEl) subEl.textContent = 'Click Activate to enable recording and playback on the current tab.';
    if (btn) btn.hidden = false;
  }
  overlay.classList.add('is-visible');
  document.body.style.overflow = 'hidden';
}

function hideLockOverlay() {
  const r = document.getElementById('lockOverlayRecord');
  const d = document.getElementById('lockOverlayData');
  if (r) r.classList.remove('is-visible');
  if (d) d.classList.remove('is-visible');
  document.body.style.overflow = '';
}

function checkTabActivation() {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab) return;

    currentTabId = tab.id;

    const mainContentData = document.getElementById("mainContentData");
    const statusDot = document.getElementById("statusDot");

    if (!isEligibleTab(tab)) {
      activationStatus.textContent = "Not available";
      activationStatus.style.color = "var(--muted)";
      if (statusDot) { statusDot.className = "status-dot"; }
      activateTab.style.display = "none";
      deactivateTab.style.display = "none";
      showLockOverlay('record', 'not-eligible');
      showLockOverlay('data', 'not-eligible');
      if (compactView) compactView.classList.add("hidden");
      document.body.dataset.activation = 'not-eligible';
      return;
    }

    const isActivated = activatedTabs.has(tab.id);

    if (isActivated) {
      activationStatus.textContent = "Active";
      activationStatus.style.color = "var(--success)";
      if (statusDot) { statusDot.className = "status-dot active"; }
      activateTab.style.display = "none";
      deactivateTab.style.display = "block";
      hideLockOverlay();
      if (compactView) compactView.classList.remove("hidden");
      document.body.dataset.activation = 'active';
      // Start connection checking
      connectionRetryCount = 0;
      startConnectionCheck();
    } else {
      activationStatus.textContent = "Inactive";
      activationStatus.style.color = "var(--danger)";
      if (statusDot) { statusDot.className = "status-dot inactive"; }
      activateTab.style.display = "block";
      deactivateTab.style.display = "none";
      showLockOverlay('record', 'inactive');
      showLockOverlay('data', 'inactive');
      if (compactView) compactView.classList.add("hidden");
      document.body.dataset.activation = 'inactive';
      // Stop connection checking
      if (connectionCheckInterval) {
        clearInterval(connectionCheckInterval);
        connectionCheckInterval = null;
      }
      if (connectionStatus) {
        connectionStatus.textContent = "";
      }
    }
  });
}

if (activateTab) {
  activateTab.addEventListener('click', async () => {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab || !isEligibleTab(tab)) return;

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["content.js"]
        });

        activatedTabs.add(tab.id);
        chrome.storage.local.set({ activatedTabs: Array.from(activatedTabs) });

        checkTabActivation();
        connectionRetryCount = 0;

        activationStatus.textContent = "✓ Activated successfully!";
        activationStatus.style.color = "var(--success)";
        setTimeout(() => checkTabActivation(), 1500);
      } catch (err) {
        console.error("Failed to activate:", err);
        activationStatus.textContent = "❌ Activation failed";
        activationStatus.style.color = "var(--danger)";
      }
    });
  });
}

['lockOverlayRecordBtn', 'lockOverlayDataBtn'].forEach(id => {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener('click', () => activateTab && activateTab.click());
});

['lockOverlayRecord', 'lockOverlayData'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('wheel', e => e.preventDefault(), { passive: false });
  el.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
});

if (deactivateTab) {
  deactivateTab.addEventListener('click', () => {
    showConfirm("Remove extension from this tab? You'll need to reactivate to use it again.", () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) return;

      // Remove from activated tabs
      activatedTabs.delete(tab.id);
      chrome.storage.local.set({ activatedTabs: Array.from(activatedTabs) });

      // Stop connection checking
      if (connectionCheckInterval) {
        clearInterval(connectionCheckInterval);
        connectionCheckInterval = null;
      }
      if (connectionStatus) {
        connectionStatus.textContent = "";
      }

      // Reload the tab to remove the content script
      chrome.tabs.reload(tab.id, () => {
        // Update UI after reload starts
        checkTabActivation();
      });
    });
    }, { title: 'Remove Extension' });
  });
}

// Remove tab from activated list when closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activatedTabs.has(tabId)) {
    activatedTabs.delete(tabId);
    chrome.storage.local.set({ activatedTabs: Array.from(activatedTabs) });
  }
});

/* === RECORD === */

startRecord.addEventListener('click', async () => {
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab) return;

    const tabId = tab.id;

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ["content.js"]
      });
    } catch (err) {
      console.log("Content script already injected or error:", err);
    }

    if (!activatedTabs.has(tabId)) {
      activatedTabs.add(tabId);
      chrome.storage.local.set({ activatedTabs: Array.from(activatedTabs) });
    }

    const scenarioId = scenarioList?.value || null;
    chrome.runtime.sendMessage({ type: "START_RECORD", tabId, scenarioId });
    window.close();
  });
});

stopRecord.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: "STOP_RECORD" }, (res) => {
    if (chrome.runtime.lastError) {
      console.error("STOP_RECORD:", chrome.runtime.lastError.message);
      return;
    }
    if (res?.scenarioId && scenarioList) {
      scenarioList.value = res.scenarioId;
    }
    previewActions();
  });
});

/* === UNDO/REDO === */

function updateUndoRedoState() {
  const scenarioId = scenarioList?.value || null;
  chrome.runtime.sendMessage({ type: "GET_UNDO_REDO_STATE", scenarioId }, (res) => {
    if (chrome.runtime.lastError) return; // popup may have lost connection briefly
    if (undoAction) undoAction.disabled = !res?.canUndo;
    if (redoAction) redoAction.disabled = !res?.canRedo;
  });
}

if (undoAction) {
  undoAction.addEventListener('click', () => {
    const scenarioId = scenarioList?.value || null;
    chrome.runtime.sendMessage({ type: "UNDO_ACTION", scenarioId }, (res) => {
      if (res?.success) { previewActions(); updateUndoRedoState(); }
    });
  });
}

if (redoAction) {
  redoAction.addEventListener('click', () => {
    const scenarioId = scenarioList?.value || null;
    chrome.runtime.sendMessage({ type: "REDO_ACTION", scenarioId }, (res) => {
      if (res?.success) { previewActions(); updateUndoRedoState(); }
    });
  });
}

/* === PREVIEW === */

let previewRequestId = 0; // Guard against race conditions

function _getActionDisplayValue(a) {
  let value = a.selector || a.url || a.value || a.code || "";
  if (a.type === "wait") {
    const dur = a.delay || a.value;
    return dur ? `${dur}ms` : "(no duration)";
  }
  if (a.type === "condition") {
    return `${a.conditionType || 'elementExists'}: ${a.selector || a.expectedValue || ''} [skip ${a.skipCount || 1}]`;
  }
  if (a.type === "dragdrop") {
    return `${a.selector || "(no source)"} → ${a.targetSelector || "(no target)"}`;
  }
  if (a.type === "dropdown") {
    return a.selector || "(no selector)";
  }
  if (a.type === "screenshot_element") {
    return a.selector || "(no selector)";
  }
  if (a.type === "screenshot_tovar") {
    const tgt = a.target === "element" ? (a.selector || "?") : a.target === "full" ? "full-page" : "visible";
    return `${tgt} → $\{${a.varName || "?"}}`;
  }
  if (a.type === "switch") {
    const caseLabels = (a.cases || []).map(c =>
      `${c.value === "__default__" ? "default" : c.value}→${c.scenarioName || c.scenarioId || "?"}`
    ).join(" | ");
    return `${a.switchVar || "?"}: ${caseLabels || "(no cases)"}`;
  }
  if (a.type === "readdom") {
    const from = a.readFrom === "attr" ? `attr:${a.attrName || "?"}` : (a.readFrom || "text");
    return `${a.selector || "(no selector)"} → ${from} → $\{${a.varName || "?"}}`;
  }
  return value;
}

function createActionListItem(a, i, scenarioId) {
  const li = document.createElement("li");
  li.classList.add("action", `action-${a.type}`);
  if (a.disabled) li.classList.add("action-disabled");
  li.dataset.index = i;
  li.draggable = true;

  const value = _getActionDisplayValue(a);
  const delayText = (a.delay && a.type !== "wait") ? ` (${a.delay}ms)` : "";
  const labelHtml = a.label
    ? `<span style="display:block;font-size:10px;color:var(--primary);opacity:0.8;font-style:italic;margin-top:1px;">${escHtml(a.label)}</span>`
    : "";

  li.innerHTML = `
    <span class="index">${i + 1}.</span>
    <span class="type">${getActionIcon(a.type)}${escHtml(a.type)}</span>
    <span class="value" title="${escHtml(value)}${escHtml(delayText)}">
      ${escHtml(value)}${escHtml(delayText)}
      ${labelHtml}
    </span>
  `;

  li.addEventListener("dragstart", (e) => {
    dragFromIndex = Number(li.dataset.index);
    li.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
  });
  li.addEventListener("dragend", () => {
    li.classList.remove("dragging");
    document.querySelectorAll(".drag-over").forEach((el) => el.classList.remove("drag-over"));
  });

  const btnRow = document.createElement("div");
  btnRow.className = "btn-row";

  const actionLabel = a.label ? `"${a.label}"` : `${a.type} #${i + 1}`;

  const toggleBtn = document.createElement("button");
  toggleBtn.textContent = a.disabled ? "Enable" : "Disable";
  toggleBtn.className = "secondary";
  toggleBtn.setAttribute("aria-label", `${a.disabled ? "Enable" : "Disable"} action ${i + 1}: ${actionLabel}`);
  toggleBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage(
      { type: "TOGGLE_ACTION_DISABLED", scenarioId, index: i },
      () => { previewActions(); updateUndoRedoState(); }
    );
  });

  const editBtn = document.createElement("button");
  editBtn.textContent = "Edit";
  editBtn.className = "secondary";
  editBtn.setAttribute("aria-label", `Edit action ${i + 1}: ${actionLabel}`);
  editBtn.addEventListener("click", () => startEdit(i, a));

  const delBtn = document.createElement("button");
  delBtn.textContent = "Delete";
  delBtn.className = "danger";
  delBtn.setAttribute("aria-label", `Delete action ${i + 1}: ${actionLabel}`);
  delBtn.addEventListener("click", () => {
    showConfirm("Delete this action?", () => {
      chrome.runtime.sendMessage(
        { type: "REMOVE_ACTION", scenarioId, index: i },
        () => { previewActions(); updateUndoRedoState(); }
      );
    }, { title: 'Delete Action', danger: true });
  });

  const copyBtn = document.createElement("button");
  copyBtn.textContent = "Copy";
  copyBtn.className = "secondary";
  copyBtn.setAttribute("aria-label", `Copy action ${i + 1}: ${actionLabel}`);
  copyBtn.addEventListener("click", () => {
    actionClipboard = JSON.parse(JSON.stringify(a));
    showToast("Action copied to clipboard", "success");
    previewActions();
  });

  btnRow.appendChild(toggleBtn);
  btnRow.appendChild(copyBtn);
  btnRow.appendChild(editBtn);
  btnRow.appendChild(delBtn);
  li.appendChild(btnRow);
  return li;
}

function previewActions() {
  const scenarioId = scenarioList.value || null;
  const savedScroll = actionsEl.scrollTop;
  const currentRequestId = ++previewRequestId;

  actionsEl.innerHTML = '<li class="action-loading">Loading…</li>';

  chrome.runtime.sendMessage(
    { type: "GET_PREVIEW_ACTIONS", scenarioId },
    (res) => {
      if (currentRequestId !== previewRequestId) return;

      actionsEl.innerHTML = "";

      if (!res?.actions?.length) {
        actionsEl.innerHTML = `<li class="empty">No actions recorded</li>`;
        if (actionCount) actionCount.style.display = "none";
        updateUndoRedoState();
        return;
      }

      res.actions.forEach((a, i) => {
        if (a != null) actionsEl.appendChild(createActionListItem(a, i, scenarioId));
      });

      // Paste button — shown when clipboard has data
      if (actionClipboard) {
        const pasteLi = document.createElement("li");
        pasteLi.className = "action-navigate action-paste-li";
        const pasteBtn = document.createElement("button");
        pasteBtn.textContent = `📋 Paste: ${actionClipboard.type}${actionClipboard.label ? ` (${actionClipboard.label})` : ""}`;
        pasteBtn.className = "secondary action-paste-btn";
        pasteBtn.addEventListener("click", () => {
          const newAction = JSON.parse(JSON.stringify(actionClipboard));
          delete newAction.disabled;
          const sid = scenarioList.value || null;
          chrome.runtime.sendMessage({ type: "ADD_MANUAL_ACTION", action: newAction, scenarioId: sid }, () => {
            showToast("Action pasted", "success");
            previewActions();
            updateUndoRedoState();
          });
        });
        const clearClipboardBtn = document.createElement("button");
        clearClipboardBtn.textContent = "✕";
        clearClipboardBtn.className = "secondary action-paste-btn";
        clearClipboardBtn.title = "Clear clipboard";
        clearClipboardBtn.style.opacity = "0.65";
        clearClipboardBtn.addEventListener("click", () => { actionClipboard = null; previewActions(); });
        pasteLi.appendChild(pasteBtn);
        pasteLi.appendChild(clearClipboardBtn);
        actionsEl.appendChild(pasteLi);
      }

      const count = res.actions?.length || 0;
      if (actionCount) {
        actionCount.textContent = count;
        actionCount.style.display = count > 0 ? "inline-block" : "none";
      }

      actionsEl.scrollTop = savedScroll;
      updateUndoRedoState();
    }
  );
}

actionsEl.addEventListener("dragover", (e) => {
  e.preventDefault();

  const dragging = document.querySelector(".dragging");
  if (!dragging) return;

  const afterElement = getDragAfterElement(actionsEl, e.clientY);

  document
    .querySelectorAll(".drag-over")
    .forEach((el) => el.classList.remove("drag-over"));

  if (afterElement == null) {
    actionsEl.appendChild(dragging);
  } else {
    afterElement.classList.add("drag-over");
    actionsEl.insertBefore(dragging, afterElement);
  }
});

actionsEl.addEventListener("drop", () => {
  updateActionOrderFromDOM();
});

// Drag & drop for runListDisplay
runListDisplay.addEventListener("dragover", (e) => {
  e.preventDefault();
  const dragging = runListDisplay.querySelector(".dragging");
  if (!dragging) return;
  const after = getDragAfterElement(runListDisplay, e.clientY);
  runListDisplay.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
  if (after == null) runListDisplay.appendChild(dragging);
  else { after.classList.add("drag-over"); runListDisplay.insertBefore(dragging, after); }
});
runListDisplay.addEventListener("drop", () => {
  runListDisplay.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
  const newOrder = [...runListDisplay.querySelectorAll("li[data-index]")].map(li => Number(li.dataset.index));
  runList = newOrder.map(i => runList[i]);
  updateRunListDisplay();
});

function getDragAfterElement(container, y) {
  const items = [...container.querySelectorAll("li:not(.dragging)")];

  return items.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;

      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY }
  ).element;
}

function updateActionOrderFromDOM() {
  const scenarioId = scenarioList.value || null;

  const newOrder = [...actionsEl.children].map((li) =>
    Number(li.dataset.index)
  );

  chrome.runtime.sendMessage(
    {
      type: "REORDER_ACTIONS",
      scenarioId,
      newOrder,
    },
    () => {
      // Refresh preview to update STT immediately after reorder
      previewActions();
      updateUndoRedoState();
    }
  );
}

preview.addEventListener('click', previewActions);

/* === DELAY PRESET HELPER === */
function setManualDelayUI(ms) {
  const preset = document.getElementById("manualDelayPreset");
  const custom = document.getElementById("manualDelay");
  if (!preset || !custom) return;
  const s = ms != null && ms !== "" ? String(ms) : "";
  const presetMatch = Array.from(preset.options).some(o => o.value === s && o.value !== "custom");
  if (!s) {
    preset.value = ""; custom.style.display = "none"; custom.value = "";
  } else if (presetMatch) {
    preset.value = s; custom.style.display = "none"; custom.value = "";
  } else {
    preset.value = "custom"; custom.style.display = ""; custom.value = s;
  }
}

/* === ADD MANUAL ACTION === */

manualActionType.onchange = () => {
  const type = manualActionType.value;
  const manualValueWrapper = document.getElementById("manualValueWrapper");
  const manualDelayWrapper = document.getElementById("manualDelayWrapper");
  const selectorSection    = document.getElementById("selectorSection");

  // --- Selector section ---
  // screenshot_tovar shows selector only when target = element
  const ssTovarTarget = document.getElementById("screenshotTovarTarget");
  const isConditionUrlType = type === "condition" && CONDITION_NO_SELECTOR.includes(conditionType ? conditionType.value : "");
  const showSelector = !TYPES_NO_SELECTOR.has(type) &&
    type !== "" &&
    !(type === "screenshot_tovar" && ssTovarTarget?.value !== "element") &&
    !isConditionUrlType;
  if (selectorSection) selectorSection.style.display = showSelector ? "block" : "none";
  if (pickedSelectorsInfo && !showSelector) pickedSelectorsWrap.style.display = "none";

  // --- Special wrappers ---
  if (conditionWrapper) {
    conditionWrapper.style.display = type === "condition" ? "block" : "none";
    if (type === "condition") updateConditionFieldsVisibility();
  }

  const readdomWrapper = document.getElementById("readdomWrapper");
  if (readdomWrapper) readdomWrapper.style.display = type === "readdom" ? "block" : "none";

  const dragdropWrapper = document.getElementById("dragdropWrapper");
  if (dragdropWrapper) dragdropWrapper.style.display = type === "dragdrop" ? "block" : "none";

  const ssTovarWrapper = document.getElementById("screenshotTovarWrapper");
  if (ssTovarWrapper) ssTovarWrapper.style.display = type === "screenshot_tovar" ? "block" : "none";

  const switchWrapper = document.getElementById("switchWrapper");
  if (switchWrapper) {
    switchWrapper.style.display = type === "switch" ? "block" : "none";
    if (type === "switch") populateSwitchScenarioSelect();
  }

  const childConditionWrapper = document.getElementById("childConditionWrapper");
  if (childConditionWrapper) {
    childConditionWrapper.style.display = ["click", "input", "hover"].includes(type) ? "block" : "none";
  }

  // --- Value field ---
  const needsValue = ["input", "navigate", "script", "screenshot", "screenshot_full"].includes(type);
  manualValueWrapper.style.display = needsValue ? "block" : "none";
  manualValue.style.display = "";

  if (type === "screenshot" || type === "screenshot_full") {
    manualValue.placeholder = "Filename (optional, e.g., my-screenshot.png)";
    manualValue.style.height = "40px";
  } else if (type === "script") {
    manualValue.placeholder = "JavaScript code to execute";
    manualValue.style.height = "80px";
  } else {
    manualValue.placeholder = "Value (for input/navigate)";
    manualValue.style.height = "80px";
  }

  // --- Delay & Label ---
  manualDelayWrapper.style.display = type ? "block" : "none";
  const manualLabelWrapper = document.getElementById("manualLabelWrapper");
  if (manualLabelWrapper) manualLabelWrapper.style.display = type ? "block" : "none";

  // Renumber step labels
  if (type !== "condition") _updateStepLabels();
  // (condition calls updateConditionFieldsVisibility which calls _updateStepLabels)
};

/* === Child Condition toggle === */
function _hasChildCondData() {
  return !!(
    document.getElementById("condChildValueEquals")?.value?.trim() ||
    document.getElementById("condChildTextContains")?.value?.trim() ||
    document.getElementById("condChildIdContains")?.value?.trim() ||
    document.getElementById("condChildClassContains")?.value?.trim() ||
    document.getElementById("condChildType")?.value
  );
}

function _updateChildCondBadge() {
  const badge = document.getElementById("childConditionBadge");
  if (badge) badge.style.display = _hasChildCondData() ? "" : "none";
}

function _setChildCondExpanded(expanded) {
  const toggle = document.getElementById("childConditionToggle");
  const body   = document.getElementById("childConditionBody");
  if (!toggle || !body) return;
  toggle.setAttribute("aria-expanded", String(expanded));
  body.style.display = expanded ? "block" : "none";
}

document.getElementById("childConditionToggle")?.addEventListener("click", () => {
  const toggle = document.getElementById("childConditionToggle");
  const expanded = toggle?.getAttribute("aria-expanded") === "true";
  _setChildCondExpanded(!expanded);
});

// Update badge when any child condition input changes
const _debouncedUpdateChildCondBadge = debounce(_updateChildCondBadge, 120);
["condChildValueEquals","condChildTextContains","condChildIdContains","condChildClassContains","condChildType"].forEach(id => {
  document.getElementById(id)?.addEventListener("input", _debouncedUpdateChildCondBadge);
  document.getElementById(id)?.addEventListener("change", _updateChildCondBadge);
});

pickElement.addEventListener('click', () => {
  pickerMode = !pickerMode;
  pickElement.textContent = pickerMode ? "✓ Pick Mode" : "🎯";
  pickElement.classList.toggle('picker-active', pickerMode);

  // Save form state before picking so it can be restored when popup reopens
  if (pickerMode) {
    chrome.storage.local.set({
      pendingEdit: {
        ...(editing || {}),
        actionType: manualActionType.value,
        actionValue: manualValue.value,
        actionDelay: manualDelay.value,
        actionDelayPreset: document.getElementById("manualDelayPreset")?.value || "500",
        isNew: !editing,
      }
    });
  }

  // Clear any stale Capture pick flag so R&P pick is not mistaken for a screenshot pick
  if (pickerMode) chrome.storage.local.remove(["elemShotPickPending", "elemShotPickCrop"]);

  // Broadcast pick mode toggle to all tabs
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) return;
    if (!isEligibleTab(tab)) return;

    const type = pickerMode ? "START_PICK_MODE" : "STOP_PICK_MODE";

    // Send to content script
    safeSendTabMessage(tab.id, { type });

    // Notify background to update badge for this tab
    chrome.runtime.sendMessage({ type, tabId: tab.id });

    // Show instruction bar briefly before popup closes
    if (pickerMode) {
      const pickerBar = document.getElementById('pickerInstructionBar');
      if (pickerBar) { pickerBar.textContent = '🎯 Click an element on the page to select it. Reopen popup to cancel.'; pickerBar.classList.add('show'); }
      window.close();
    } else {
      document.getElementById('pickerInstructionBar')?.classList.remove('show');
    }
  });
});

// Selector listener is registered at top already

function extractVarNames(action) {
  const VAR_RE = /\$\{([^}]+)\}/g;
  const names = new Set();
  const scan = (str) => {
    if (typeof str !== 'string') return;
    for (const m of str.matchAll(VAR_RE)) names.add(m[1]);
  };
  scan(action.selector);
  scan(action.value);
  scan(action.url);
  scan(action.code);
  scan(action.expectedValue);
  scan(action.switchVar);
  if (action.conditions && typeof action.conditions === 'object') {
    Object.values(action.conditions).forEach(v => scan(String(v)));
  }
  return names;
}

function autoCreateMissingVariables(action) {
  const needed = extractVarNames(action);
  if (!needed.size) return;
  chrome.runtime.sendMessage({ type: 'GET_VARIABLES' }, (res) => {
    const existing = res?.variables || {};
    const newVars = [...needed].filter(n => !(n in existing));
    if (!newVars.length) return;
    const merged = { ...existing };
    newVars.forEach(n => { merged[n] = ''; });
    chrome.runtime.sendMessage({ type: 'SAVE_VARIABLES', variables: merged }, () => {
      newVars.forEach(n => addVariableRow(n, ''));
      showToast(`Đã tự động tạo variable: ${newVars.join(', ')}`, 'success');
    });
  });
}

// Types that don't require a selector field
const TYPES_NO_SELECTOR_REQUIRED = new Set([
  "script", "navigate", "screenshot", "screenshot_full",
  "readdom", "screenshot_tovar", "wait", "switch"
]);

function validateActionForm(type, selector, delayVal) {
  if (!type) {
    return { valid: false, el: manualActionType, msg: "Action type is required" };
  }
  if (!selector && !TYPES_NO_SELECTOR_REQUIRED.has(type)) {
    return { valid: false, el: manualSelector, msg: "Selector is required for this action type" };
  }
  if (type === "wait") {
    const d = parseInt(delayVal, 10);
    if (!delayVal || isNaN(d) || d <= 0) {
      return {
        valid: false,
        el: document.getElementById("manualDelayPreset"),
        msg: "Wait action requires a duration greater than 0ms",
        toastOnly: true,
      };
    }
  }
  return { valid: true };
}

function buildActionFromForm(type, selector, value, delayVal) {
  const action = { type };

  if (selector) {
    action.selector = selector;
    action.selectors = currentPickedSelectors || { [selectorType?.value || 'css']: selector };
  }

  if (type === "input" && value)                              action.value = value;
  if (type === "navigate" && value)                           action.url   = value;
  if (type === "script" && value)                             action.code  = value;
  if ((type === "screenshot" || type === "screenshot_full") && value) action.value = value;

  if (type === "readdom") {
    const varName = document.getElementById("readdomVarName")?.value?.trim();
    if (!varName) { showToast("Variable name is required for Read DOM action", "error"); return null; }
    action.varName  = varName;
    action.readFrom = document.getElementById("readdomReadFrom")?.value || "text";
    const attrName  = document.getElementById("readdomAttrName")?.value?.trim();
    if (action.readFrom === "attr" && attrName) action.attrName = attrName;
  }

  if (type === "screenshot_tovar") {
    const varName = document.getElementById("screenshotTovarVarName")?.value?.trim();
    if (!varName) { showToast("Variable name is required for Screenshot → Variable", "error"); return null; }
    action.varName = varName;
    action.target  = document.getElementById("screenshotTovarTarget")?.value || "page";
    if (action.target === "element") {
      if (!selector) { showToast("Selector (①) is required for Element target", "error"); return null; }
      action.selector = selector;
    }
  }

  if (["click", "input", "hover"].includes(type)) {
    const ve  = document.getElementById("condChildValueEquals")?.value?.trim();
    const tc  = document.getElementById("condChildTextContains")?.value?.trim();
    const ic  = document.getElementById("condChildIdContains")?.value?.trim();
    const cc  = document.getElementById("condChildClassContains")?.value?.trim();
    const typ = document.getElementById("condChildType")?.value || "";
    if (ve || tc || ic || cc || typ) {
      const mode = document.querySelector('input[name="condChildMatchMode"]:checked')?.value || "any";
      action.conditions = { matchMode: mode };
      if (ve)  action.conditions.valueEquals   = ve;
      if (tc)  action.conditions.textContains  = tc;
      if (ic)  action.conditions.idContains    = ic;
      if (cc)  action.conditions.classContains = cc;
      if (typ) action.conditions.typeEquals    = typ;
    }
  }

  if (type === "dragdrop") {
    const target = document.getElementById("dragdropTarget")?.value?.trim();
    if (!target) { showToast("Drop target selector is required for Drag & Drop action", "error"); return null; }
    action.targetSelector  = target;
    const dtSelectorType   = document.getElementById("dragdropTargetSelectorType")?.value || "css";
    action.targetSelectors = currentPickedDragdropTargetSelectors || { [dtSelectorType]: target };
  }

  if (type === "condition") {
    action.conditionType = conditionType?.value || "elementExists";
    action.expectedValue = conditionExpectedValue?.value?.trim() || "";
    action.skipCount     = parseInt(conditionSkipCount?.value, 10) || 1;
  }

  if (type === "switch") {
    const switchVar = document.getElementById("switchVar")?.value?.trim();
    if (!switchVar)       { showToast("Variable name is required for Switch action", "error"); return null; }
    if (!_switchCases.length) { showToast("Add at least one case to the Switch", "error"); return null; }
    action.switchVar = switchVar;
    action.cases     = _switchCases.map(c => ({ ...c }));
  }

  if (delayVal) {
    const d = parseInt(delayVal, 10);
    if (!isNaN(d) && d > 0) action.delay = d;
  }

  const labelVal = document.getElementById("manualLabel")?.value?.trim();
  if (labelVal) action.label = labelVal;

  return action;
}

addManualAction.addEventListener('click', () => {
  const selector  = manualSelector.value?.trim() || "";
  const type      = manualActionType.value?.trim() || "";
  const value     = manualValue.value?.trim() || "";
  const preset    = document.getElementById("manualDelayPreset");
  const delayVal  = (preset?.value === "custom")
    ? (manualDelay.value?.trim() || "")
    : (preset?.value || "");

  const check = validateActionForm(type, selector, delayVal);
  if (!check.valid) {
    if (check.toastOnly) {
      if (check.el) _showFieldError(check.el, check.msg);
      showToast(check.msg, "error");
    } else {
      _showFieldError(check.el, check.msg);
      check.el?.focus();
    }
    return;
  }

  const action = buildActionFromForm(type, selector, value, delayVal);
  if (!action) return; // buildActionFromForm already showed a toast

  autoCreateMissingVariables(action);

  const onDone = () => {
    clearEditState();
    chrome.storage.local.remove("manualFormDraft");
    previewActions();
    updateUndoRedoState();
  };

  if (editing) {
    chrome.runtime.sendMessage({
      type: "UPDATE_ACTION",
      scenarioId: editing.scenarioId,
      index: editing.index,
      action,
    }, onDone);
  } else {
    chrome.runtime.sendMessage({
      type: "ADD_MANUAL_ACTION",
      action,
      scenarioId: scenarioList.value || null,
    }, onDone);
  }
});

function startEdit(index, action) {
  manualSelector.value = action.selector || "";
  manualActionType.value = action.type || "";

  // Show/hide selector section based on type
  const selectorSection = document.getElementById("selectorSection");
  if (selectorSection) {
    const ssTovarTargetVal = action.target || "page";
    const hideSelector = TYPES_NO_SELECTOR.has(action.type) ||
      (action.type === "screenshot_tovar" && ssTovarTargetVal !== "element");
    selectorSection.style.display = hideSelector ? "none" : "block";
  }

  // Restore selectors if available
  if (action.selectors) {
    currentPickedSelectors = action.selectors;
    displayPickedSelectors(action.selectors);
  } else {
    currentPickedSelectors = null;
    if (pickedSelectorsInfo) {
      pickedSelectorsWrap.style.display = "none";
    }
  }

  // Show/hide value and delay wrappers
  const manualValueWrapper = document.getElementById("manualValueWrapper");
  const manualDelayWrapper = document.getElementById("manualDelayWrapper");

  // Reset inline display that clearEditState sets directly on the textarea
  manualValue.style.display = "";

  if (action.type === "input" || action.type === "navigate") {
    if (manualValueWrapper) manualValueWrapper.style.display = "block";
    if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
    manualValue.value = action.value || action.url || "";
    manualValue.placeholder = action.type === "navigate" ? "URL to navigate" : "Value to input";
  } else if (action.type === "script") {
    if (manualValueWrapper) manualValueWrapper.style.display = "block";
    if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
    manualValue.value = action.code || "";
    manualValue.placeholder = "JavaScript code";
  } else if (action.type === "screenshot" || action.type === "screenshot_full") {
    if (manualValueWrapper) manualValueWrapper.style.display = "block";
    if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
    manualValue.value = action.value || "";
    manualValue.placeholder = "Filename (optional, e.g. screenshot.png)";
    // Hide pickedSelectorsInfo for screenshot
    if (pickedSelectorsInfo) {
      pickedSelectorsWrap.style.display = "none";
    }
  } else if (action.type === "screenshot_tovar") {
    if (manualValueWrapper) manualValueWrapper.style.display = "none";
    if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
    const ssTovarWrap = document.getElementById("screenshotTovarWrapper");
    if (ssTovarWrap) ssTovarWrap.style.display = "block";
    const ssTovarTarget = document.getElementById("screenshotTovarTarget");
    if (ssTovarTarget) {
      ssTovarTarget.value = action.target || "page";
      ssTovarTarget.dispatchEvent(new Event("change"));
    }
    if (action.target === "element" && action.selector) {
      manualSelector.value = action.selector;
    }
    const ssTovarVar = document.getElementById("screenshotTovarVarName");
    if (ssTovarVar) ssTovarVar.value = action.varName || "";
  } else if (action.type === "dragdrop") {
    if (manualValueWrapper) manualValueWrapper.style.display = "none";
    if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
    const dragdropWrapper = document.getElementById("dragdropWrapper");
    const dragdropTarget  = document.getElementById("dragdropTarget");
    if (dragdropWrapper) dragdropWrapper.style.display = "block";
    if (dragdropTarget)  dragdropTarget.value = action.targetSelector || "";
    // Restore target selector type and picked selectors display
    const dtSelectorType = document.getElementById("dragdropTargetSelectorType");
    if (action.targetSelectors) {
      displayPickedDragdropTargetSelectors(action.targetSelectors);
      const savedType = Object.keys(action.targetSelectors)[0] || "css";
      if (dtSelectorType) dtSelectorType.value = savedType;
    } else {
      if (dtSelectorType) dtSelectorType.value = "css";
      const pickedDdWrap = document.getElementById("pickedDragdropTargetWrap");
      if (pickedDdWrap) pickedDdWrap.style.display = "none";
    }
  } else if (action.type === "hover") {
    if (manualValueWrapper) manualValueWrapper.style.display = "none";
    if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
  } else if (action.type === "dropdown") {
    if (manualValueWrapper) manualValueWrapper.style.display = "none";
    if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
  } else if (action.type === "readdom") {
    if (manualValueWrapper) manualValueWrapper.style.display = "none";
    if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
    const readdomWrapper = document.getElementById("readdomWrapper");
    if (readdomWrapper) readdomWrapper.style.display = "block";
    const readdomVarName = document.getElementById("readdomVarName");
    const readdomReadFrom = document.getElementById("readdomReadFrom");
    const readdomAttrName = document.getElementById("readdomAttrName");
    if (readdomVarName) readdomVarName.value = action.varName || "";
    if (readdomReadFrom) readdomReadFrom.value = action.readFrom || "text";
    if (readdomAttrName) {
      readdomAttrName.value = action.attrName || "";
      readdomAttrName.style.display = action.readFrom === "attr" ? "block" : "none";
    }
  } else if (action.type === "condition") {
    if (manualValueWrapper) manualValueWrapper.style.display = "none";
    if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
    if (conditionWrapper) conditionWrapper.style.display = "block";
    if (conditionType) conditionType.value = action.conditionType || "elementExists";
    if (conditionExpectedValue) conditionExpectedValue.value = action.expectedValue || "";
    if (conditionSkipCount) conditionSkipCount.value = action.skipCount || 1;
    updateConditionFieldsVisibility();
  } else if (action.type === "switch") {
    if (manualValueWrapper) manualValueWrapper.style.display = "none";
    if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
    // Hide all other type-specific wrappers
    if (conditionWrapper) conditionWrapper.style.display = "none";
    const readdomWrapperSW = document.getElementById("readdomWrapper");
    if (readdomWrapperSW) readdomWrapperSW.style.display = "none";
    const dragdropWrapperSW = document.getElementById("dragdropWrapper");
    if (dragdropWrapperSW) dragdropWrapperSW.style.display = "none";
    const ssTovarWrapperSW = document.getElementById("screenshotTovarWrapper");
    if (ssTovarWrapperSW) ssTovarWrapperSW.style.display = "none";
    // Show switch wrapper and populate
    const switchWrapEl = document.getElementById("switchWrapper");
    if (switchWrapEl) switchWrapEl.style.display = "block";
    const switchVarEl = document.getElementById("switchVar");
    if (switchVarEl) switchVarEl.value = action.switchVar || "";
    _switchCases = (action.cases || []).map(c => ({ ...c }));
    populateSwitchScenarioSelect();
    renderSwitchCaseList();
    if (selectorSection) selectorSection.style.display = "none";
  } else {
    if (manualValueWrapper) manualValueWrapper.style.display = "none";
    if (manualDelayWrapper) manualDelayWrapper.style.display = "block";
    manualValue.value = "";
  }
  // For wait: support old actions that stored duration in action.value
  const delayForUI = action.type === "wait"
    ? String(action.delay || action.value || DEFAULT_DELAY_MS)
    : (action.delay ? String(action.delay) : DEFAULT_DELAY_MS);
  setManualDelayUI(delayForUI);

  // Restore child condition fields
  const childCondWrap = document.getElementById("childConditionWrapper");
  if (childCondWrap) {
    const supportsChildCondition = ["click", "input", "hover"].includes(action.type);
    childCondWrap.style.display = supportsChildCondition ? "block" : "none";
  }
  const condChildVE   = document.getElementById("condChildValueEquals");
  const condChildTC   = document.getElementById("condChildTextContains");
  const condChildIC   = document.getElementById("condChildIdContains");
  const condChildCC   = document.getElementById("condChildClassContains");
  const condChildType = document.getElementById("condChildType");
  const restoredMode  = action.conditions?.matchMode || "any";
  const radioAny = document.getElementById("condChildMatchAny");
  const radioAll = document.getElementById("condChildMatchAll");
  if (radioAny) radioAny.checked = restoredMode === "any";
  if (radioAll) radioAll.checked = restoredMode === "all";
  if (condChildVE)   condChildVE.value   = action.conditions?.valueEquals  || "";
  if (condChildTC)   condChildTC.value   = action.conditions?.textContains || "";
  if (condChildIC)   condChildIC.value   = action.conditions?.idContains   || "";
  if (condChildCC)   condChildCC.value   = action.conditions?.classContains || "";
  if (condChildType) condChildType.value = action.conditions?.typeEquals   || "";
  // Auto-expand if there is existing condition data
  const hasCondData = !!(action.conditions?.valueEquals || action.conditions?.textContains || action.conditions?.idContains || action.conditions?.classContains || action.conditions?.typeEquals);
  _setChildCondExpanded(hasCondData);
  _updateChildCondBadge();

  const manualLabelEl = document.getElementById("manualLabel");
  const manualLabelWrapper = document.getElementById("manualLabelWrapper");
  if (manualLabelEl) manualLabelEl.value = action.label || "";
  if (manualLabelWrapper) manualLabelWrapper.style.display = "block";

  editing = { scenarioId: scenarioList.value || null, index };
  addManualAction.textContent = "Save Edit";
  cancelEdit.style.display = "inline-block";
  _updateStepLabels();
  saveDraft();
}

function clearEditState() {
  editing = null;
  manualSelector.value = "";
  manualActionType.value = "";
  manualValue.value = "";
  setManualDelayUI(DEFAULT_DELAY_MS);
  manualValue.style.display = "none";
  addManualAction.textContent = "Add Action";
  cancelEdit.style.display = "none";
  currentPickedSelectors = null;
  if (pickedSelectorsWrap) { pickedSelectorsWrap.style.display = "none"; }
  if (pickedSelectorsInfo) { pickedSelectorsInfo.innerHTML = ""; }
  if (selectorType) selectorType.value = "css";

  // Reset selectorSection and value/delay wrappers
  const _selectorSection = document.getElementById("selectorSection");
  if (_selectorSection) _selectorSection.style.display = "none";
  const _valWrap = document.getElementById("manualValueWrapper");
  if (_valWrap) _valWrap.style.display = "none";
  const _delWrap = document.getElementById("manualDelayWrapper");
  if (_delWrap) _delWrap.style.display = "none";
  const _lblWrap = document.getElementById("manualLabelWrapper");
  if (_lblWrap) _lblWrap.style.display = "none";

  // Reset condition fields
  if (conditionWrapper) conditionWrapper.style.display = "none";
  if (conditionType) conditionType.value = "elementExists";
  if (conditionExpectedValue) conditionExpectedValue.value = "";
  if (conditionSkipCount) conditionSkipCount.value = "1";
  if (conditionExpectedValueWrapper) conditionExpectedValueWrapper.style.display = "block";

  // Reset dragdrop fields
  const dragdropWrapperEl = document.getElementById("dragdropWrapper");
  if (dragdropWrapperEl) dragdropWrapperEl.style.display = "none";
  const dragdropTargetEl = document.getElementById("dragdropTarget");
  if (dragdropTargetEl) dragdropTargetEl.value = "";
  const dragdropTargetTypeEl = document.getElementById("dragdropTargetSelectorType");
  if (dragdropTargetTypeEl) dragdropTargetTypeEl.value = "css";
  currentPickedDragdropTargetSelectors = null;
  const pickedDdTargetWrap = document.getElementById("pickedDragdropTargetWrap");
  if (pickedDdTargetWrap) pickedDdTargetWrap.style.display = "none";
  const pickedDdTargetInfo = document.getElementById("pickedDragdropTargetInfo");
  if (pickedDdTargetInfo) pickedDdTargetInfo.innerHTML = "";

  // Reset readdom fields
  const readdomWrapper = document.getElementById("readdomWrapper");
  if (readdomWrapper) readdomWrapper.style.display = "none";
  const readdomVarName = document.getElementById("readdomVarName");
  if (readdomVarName) readdomVarName.value = "";
  const readdomReadFrom = document.getElementById("readdomReadFrom");
  if (readdomReadFrom) readdomReadFrom.value = "text";
  const readdomAttrName = document.getElementById("readdomAttrName");
  if (readdomAttrName) { readdomAttrName.value = ""; readdomAttrName.style.display = "none"; }

  // Reset screenshot_tovar fields
  const ssTovarWrapClear = document.getElementById("screenshotTovarWrapper");
  if (ssTovarWrapClear) ssTovarWrapClear.style.display = "none";
  const ssTovarVarClear = document.getElementById("screenshotTovarVarName");
  if (ssTovarVarClear) ssTovarVarClear.value = "";
  const ssTovarTargetClear = document.getElementById("screenshotTovarTarget");
  if (ssTovarTargetClear) ssTovarTargetClear.value = "page";

  // Reset switch fields
  _switchCases = [];
  const switchWrapperClear = document.getElementById("switchWrapper");
  if (switchWrapperClear) switchWrapperClear.style.display = "none";
  const switchVarClear = document.getElementById("switchVar");
  if (switchVarClear) switchVarClear.value = "";
  const switchCaseListClear = document.getElementById("switchCaseList");
  if (switchCaseListClear) switchCaseListClear.innerHTML = "";

  const manualLabelEl = document.getElementById("manualLabel");
  if (manualLabelEl) manualLabelEl.value = "";

  // Reset child condition fields
  const childCondWrapClear = document.getElementById("childConditionWrapper");
  if (childCondWrapClear) childCondWrapClear.style.display = "none";
  const radioAnyClear = document.getElementById("condChildMatchAny");
  const radioAllClear = document.getElementById("condChildMatchAll");
  if (radioAnyClear) radioAnyClear.checked = true;
  if (radioAllClear) radioAllClear.checked = false;
  const condChildVEClear = document.getElementById("condChildValueEquals");
  if (condChildVEClear) condChildVEClear.value = "";
  const condChildTCClear = document.getElementById("condChildTextContains");
  if (condChildTCClear) condChildTCClear.value = "";
  const condChildICClear = document.getElementById("condChildIdContains");
  if (condChildICClear) condChildICClear.value = "";
  const condChildCCClear = document.getElementById("condChildClassContains");
  if (condChildCCClear) condChildCCClear.value = "";
  const condChildTypeClear = document.getElementById("condChildType");
  if (condChildTypeClear) condChildTypeClear.value = "";
  _setChildCondExpanded(false);
  _updateChildCondBadge();
}

cancelEdit.addEventListener('click', () => {
  clearEditState();
  chrome.storage.local.remove("manualFormDraft");
});

/* === DRAFT: persist Add Manual Action card across popup close/reopen === */

function saveDraft() {
  // Don't overwrite pick-mode saves (those use pendingEdit)
  if (pickerMode) return;

  const card = document.getElementById("addManualActionCard");
  const cardOpen = card && !card.classList.contains("collapsed");
  const type = manualActionType.value;

  // Only save if card is open or we're in edit mode
  if (!cardOpen && !editing) return;
  // Don't save if nothing meaningful is in the form
  if (!type && !editing) return;

  const draft = {
    actionType:  type,
    selector:    manualSelector.value?.trim() || "",
    selectorType: document.getElementById("selectorType")?.value || "css",
    pickedSelectors: currentPickedSelectors || null,
    value:       manualValue.value || "",
    delay:       (() => {
      const preset = document.getElementById("manualDelayPreset");
      return preset?.value === "custom"
        ? (document.getElementById("manualDelay")?.value?.trim() || "")
        : (preset?.value || "");
    })(),
    delayPreset: document.getElementById("manualDelayPreset")?.value || "500",
    label:       document.getElementById("manualLabel")?.value?.trim() || "",
    cardOpen,

    // dragdrop
    dragdropTarget:            document.getElementById("dragdropTarget")?.value?.trim() || "",
    dragdropTargetSelectorType: document.getElementById("dragdropTargetSelectorType")?.value || "css",
    pickedDragdropTargetSelectors: currentPickedDragdropTargetSelectors || null,

    // condition
    conditionType:          document.getElementById("conditionType")?.value || "",
    conditionExpectedValue: document.getElementById("conditionExpectedValue")?.value?.trim() || "",
    conditionSkipCount:     document.getElementById("conditionSkipCount")?.value || "1",
    childCond: {
      matchAny:      document.getElementById("condChildMatchAny")?.checked ?? true,
      valueEquals:   document.getElementById("condChildValueEquals")?.value?.trim() || "",
      textContains:  document.getElementById("condChildTextContains")?.value?.trim() || "",
      idContains:    document.getElementById("condChildIdContains")?.value?.trim() || "",
      classContains: document.getElementById("condChildClassContains")?.value?.trim() || "",
      childType:     document.getElementById("condChildType")?.value?.trim() || "",
    },

    // readdom
    readdomVarName:  document.getElementById("readdomVarName")?.value?.trim() || "",
    readdomReadFrom: document.getElementById("readdomReadFrom")?.value || "text",
    readdomAttrName: document.getElementById("readdomAttrName")?.value?.trim() || "",

    // screenshot_tovar
    screenshotTovarVarName: document.getElementById("screenshotTovarVarName")?.value?.trim() || "",
    screenshotTovarTarget:  document.getElementById("screenshotTovarTarget")?.value || "page",

    // switch
    switchVar:   document.getElementById("switchVar")?.value?.trim() || "",
    switchCases: _switchCases ? [..._switchCases] : [],

    // editing state
    editing: editing ? { scenarioId: editing.scenarioId, index: editing.index } : null,
    scenarioId: document.getElementById("scenarioList")?.value || null,
  };

  chrome.storage.local.set({ manualFormDraft: draft });
}

function restoreDraft(draft) {
  if (!draft) return;

  // Restore editing state
  if (draft.editing) {
    editing = draft.editing;
    addManualAction.textContent = "Save Edit";
    cancelEdit.style.display = "inline-block";
  }

  // Restore scenario
  if (draft.scenarioId) {
    const sl = document.getElementById("scenarioList");
    if (sl) sl.value = draft.scenarioId;
  }

  // Core fields
  manualActionType.value = draft.actionType || "";
  manualSelector.value   = draft.selector || "";
  manualValue.value      = draft.value || "";
  setManualDelayUI(draft.delay || DEFAULT_DELAY_MS);
  if (draft.delayPreset) {
    const presetEl = document.getElementById("manualDelayPreset");
    if (presetEl) presetEl.value = draft.delayPreset;
  }

  // Trigger visibility
  manualActionType.onchange?.();

  // Restore selector type + picked selectors panel
  if (draft.selectorType) {
    const st = document.getElementById("selectorType");
    if (st) st.value = draft.selectorType;
  }
  if (draft.pickedSelectors) {
    currentPickedSelectors = draft.pickedSelectors;
    displayPickedSelectors(currentPickedSelectors);
    const selectorSection = document.getElementById("selectorSection");
    if (selectorSection && draft.selector) selectorSection.style.display = "block";
  }

  // Label
  const lblEl = document.getElementById("manualLabel");
  const lblW  = document.getElementById("manualLabelWrapper");
  if (lblEl) lblEl.value = draft.label || "";
  if (draft.label && lblW) lblW.style.display = "block";

  // Dragdrop
  if (draft.actionType === "dragdrop") {
    const ddTarget   = document.getElementById("dragdropTarget");
    const ddTypeEl   = document.getElementById("dragdropTargetSelectorType");
    if (ddTarget)  ddTarget.value  = draft.dragdropTarget || "";
    if (ddTypeEl)  ddTypeEl.value  = draft.dragdropTargetSelectorType || "css";
    if (draft.pickedDragdropTargetSelectors) {
      currentPickedDragdropTargetSelectors = draft.pickedDragdropTargetSelectors;
      displayPickedDragdropTargetSelectors(currentPickedDragdropTargetSelectors);
    }
  }

  // Condition
  if (draft.actionType === "condition") {
    const ctEl  = document.getElementById("conditionType");
    const cevEl = document.getElementById("conditionExpectedValue");
    const cscEl = document.getElementById("conditionSkipCount");
    if (ctEl)  ctEl.value  = draft.conditionType || "elementExists";
    if (cevEl) cevEl.value = draft.conditionExpectedValue || "";
    if (cscEl) cscEl.value = draft.conditionSkipCount || "1";
    updateConditionFieldsVisibility?.();

    if (draft.childCond) {
      const cc = draft.childCond;
      const radioAny = document.getElementById("condChildMatchAny");
      const radioAll = document.getElementById("condChildMatchAll");
      if (radioAny) radioAny.checked = cc.matchAny !== false;
      if (radioAll) radioAll.checked = cc.matchAny === false;
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
      set("condChildValueEquals", cc.valueEquals);
      set("condChildTextContains", cc.textContains);
      set("condChildIdContains", cc.idContains);
      set("condChildClassContains", cc.classContains);
      set("condChildType", cc.childType);
      _updateChildCondBadge?.();
    }
  }

  // Readdom
  if (draft.actionType === "readdom") {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ""; };
    set("readdomVarName",  draft.readdomVarName);
    set("readdomReadFrom", draft.readdomReadFrom || "text");
    set("readdomAttrName", draft.readdomAttrName);
    const attrEl = document.getElementById("readdomAttrName");
    if (attrEl) attrEl.style.display = (draft.readdomReadFrom === "attr") ? "inline-block" : "none";
  }

  // Screenshot_tovar
  if (draft.actionType === "screenshot_tovar") {
    const vEl = document.getElementById("screenshotTovarVarName");
    const tEl = document.getElementById("screenshotTovarTarget");
    if (vEl) vEl.value = draft.screenshotTovarVarName || "";
    if (tEl) { tEl.value = draft.screenshotTovarTarget || "page"; tEl.onchange?.(); }
  }

  // Switch
  if (draft.actionType === "switch") {
    const svEl = document.getElementById("switchVar");
    if (svEl) svEl.value = draft.switchVar || "";
    _switchCases = draft.switchCases ? [...draft.switchCases] : [];
    renderSwitchCaseList?.();
  }

  _updateStepLabels?.();

  // Open card
  if (draft.cardOpen || draft.editing) {
    const card = document.getElementById("addManualActionCard");
    if (card?.classList.contains("collapsed")) card.classList.remove("collapsed");
  }
}

// Save draft continuously (debounced) so Chrome popup close doesn't lose async writes
const debouncedSaveDraft = debounce(saveDraft, 600);

// Attach to all manual form inputs
[
  "manualActionType", "selectorType", "manualSelector",
  "manualValue", "manualDelayPreset", "manualDelay", "manualLabel",
  "dragdropTarget", "dragdropTargetSelectorType",
  "conditionType", "conditionExpectedValue", "conditionSkipCount",
  "condChildValueEquals", "condChildTextContains", "condChildIdContains",
  "condChildClassContains", "condChildType",
  "readdomVarName", "readdomReadFrom", "readdomAttrName",
  "screenshotTovarVarName", "screenshotTovarTarget",
  "switchVar",
].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener("input", debouncedSaveDraft);
    el.addEventListener("change", debouncedSaveDraft);
  }
});
document.getElementById("condChildMatchAny")?.addEventListener("change", debouncedSaveDraft);
document.getElementById("condChildMatchAll")?.addEventListener("change", debouncedSaveDraft);

/* === SAVE === */

saveFlow.addEventListener('click', () => {
  const name = scenarioName.value.trim();

  if (!name) {
    _showFieldError(scenarioName, "Scenario name is required");
    scenarioName.focus();
    return;
  }

  scenarioName.classList.remove('required-error');

  const folderId = scenarioFolder.value || null;

  const existing = Object.entries(scenariosCache).find(
    ([, s]) => s.name === name && (s.folderId || null) === folderId
  );
  const originalCreatedAt = existing ? existing[1].createdAt : undefined;

  chrome.runtime.sendMessage({ type: "SAVE_SCENARIO", name, folderId, originalCreatedAt }, () => {
    scenarioName.value = "";
    scenarioFolder.value = "";
    loadScenarios();
  });
});

// New scenario: clear current recording/actions buffer so manual adds start a fresh scenario
newFlow.addEventListener('click', () => {
  showConfirm("Create new empty scenario buffer? This will clear current unsaved actions.", () => {
    chrome.runtime.sendMessage({ type: "START_NEW_SCENARIO" }, () => {
    manualSelector.value = "";
    manualActionType.value = "";
    manualValue.value = "";
    manualValue.style.display = "none";
    try {
      scenarioList.value = "";
      toggleScenarioActions(false);
      chrome.storage.local.remove("lastSelectedScenario");
    } catch (e) {
      // ignore
    }
    actionsEl.innerHTML = `<li class="empty">New scenario (no actions)</li>`;
    });
  }, { title: 'New Scenario', okLabel: 'Continue' });
});

/* === LOAD SCENARIOS === */

function renderScenarioOptions() {
  scenarioList.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- Select a scenario --";
  scenarioList.appendChild(placeholder);

  const searchTerm = (scenarioSearch?.value || "").toLowerCase();
  const sort = scenarioSort?.value || "createdDesc";
  const folderFilter = filterFolder?.value || "";

  const list = Object.entries(scenariosCache).map(([id, s]) => ({
    id,
    name: s.name,
    tags: s.tags || [],
    createdAt: s.createdAt || 0,
    folderId: s.folderId || null,
  }));

  const filtered = list.filter((item) => {
    // Filter by search term
    if (searchTerm) {
      const haystack = `${item.name} ${(item.tags || []).join(" ")}`.toLowerCase();
      if (!haystack.includes(searchTerm)) return false;
    }

    // Filter by folder
    if (folderFilter) {
      if (folderFilter === "__none__") {
        if (item.folderId) return false;
      } else {
        if (item.folderId !== folderFilter) return false;
      }
    }

    return true;
  });

  filtered.sort((a, b) => {
    if (sort === "nameAsc") return a.name.localeCompare(b.name);
    if (sort === "nameDesc") return b.name.localeCompare(a.name);
    if (sort === "createdAsc") return (a.createdAt || 0) - (b.createdAt || 0);
    return (b.createdAt || 0) - (a.createdAt || 0); // createdDesc
  });

  // Group by folder
  const grouped = {};
  filtered.forEach((item) => {
    const key = item.folderId || "__none__";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  });

  // Render grouped scenarios for scenarioList
  const folderKeys = Object.keys(grouped).sort((a, b) => {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    const nameA = foldersCache[a]?.name || "";
    const nameB = foldersCache[b]?.name || "";
    return nameA.localeCompare(nameB);
  });

  folderKeys.forEach((folderId) => {
    const items = grouped[folderId];
    const folderName = folderId === "__none__" ? "No Folder" : foldersCache[folderId]?.name || "Unknown";

    // Add folder header (optgroup)
    const optgroup = document.createElement("optgroup");
    optgroup.label = folderName;
    scenarioList.appendChild(optgroup);

    items.forEach((item) => {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = item.name;
      optgroup.appendChild(o);
    });
  });

  // restore selection if still present in filtered list
  chrome.storage.local.get(["lastSelectedScenario"], (storageRes) => {
    const last = storageRes?.lastSelectedScenario;
    const isInFiltered = filtered.some(item => item.id === last);

    if (last && scenariosCache[last] && isInFiltered) {
      scenarioList.value = last;
      toggleScenarioActions(true);
    } else {
      scenarioList.value = "";
      toggleScenarioActions(false);
    }
    previewActions();
  });
}

function renderSequenceScenarioList() {
  sequenceScenarioList.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "-- Select a scenario --";
  sequenceScenarioList.appendChild(placeholder);

  // Apply folder filter from filterFolder
  const folderFilter = filterFolder?.value || "";

  const list = Object.entries(scenariosCache).map(([id, s]) => ({
    id,
    name: s.name,
    createdAt: s.createdAt || 0,
    folderId: s.folderId || null,
  }));

  // Filter by folder (same as scenarioList)
  const filtered = list.filter((item) => {
    if (folderFilter) {
      if (folderFilter === "__none__") {
        return !item.folderId || item.folderId === null;
      }
      return item.folderId === folderFilter;
    }
    return true;
  });

  const grouped = {};
  filtered.forEach((item) => {
    const key = item.folderId || "__none__";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  });

  // Render filtered scenarios with folder grouping
  const folderKeys = Object.keys(grouped).sort((a, b) => {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    const nameA = foldersCache[a]?.name || "";
    const nameB = foldersCache[b]?.name || "";
    return nameA.localeCompare(nameB);
  });

  folderKeys.forEach((folderId) => {
    const items = grouped[folderId];
    const folderName = folderId === "__none__" ? "No Folder" : foldersCache[folderId]?.name || "Unknown";

    const optgroup = document.createElement("optgroup");
    optgroup.label = folderName;
    sequenceScenarioList.appendChild(optgroup);

    items.forEach((item) => {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = item.name;
      optgroup.appendChild(o);
    });
  });
}

function loadScenarios() {
  // Fetch scenarios and folders in parallel, then render everything once
  Promise.all([
    new Promise(r => chrome.runtime.sendMessage({ type: "GET_SCENARIOS" }, r)),
    new Promise(r => chrome.runtime.sendMessage({ type: "GET_FOLDERS" }, r)),
  ]).then(([sRes, fRes]) => {
    scenariosCache = sRes?.scenarios || {};
    foldersCache = fRes?.folders || {};

    // Render all UI once (no double-render)
    renderFolderOptions();
    renderMoveToFolderSelect();
    renderFoldersManagementUI();
    renderCompactFolderList();
    renderScenarioOptions();
    renderSequenceScenarioList();
    renderExportScenarioSelect();
    renderCompactScenarioList();
    renderScheduleScenarioSelect();
    renderCsvScenarioSelect();
    renderExportCodeSelect();

    // Restore scenario selection if stopped recording via hotkey while popup was closed
    chrome.storage.local.get(["pendingRecordScenarioId"], (stored) => {
      const sid = stored?.pendingRecordScenarioId;
      if (sid && scenarioList) {
        scenarioList.value = sid;
        if (scenarioList.value === sid) {
          previewActions();
        }
        chrome.storage.local.remove("pendingRecordScenarioId");
      }
    });
  });
}

loadScenarios();

// Debounce search input to avoid rendering on every keystroke
if (scenarioSearch) scenarioSearch.oninput = debounce(renderScenarioOptions, 250);
if (scenarioSort) scenarioSort.onchange = renderScenarioOptions;
if (filterFolder) filterFolder.onchange = renderScenarioOptions;

// Update Move to Folder select when scenario is changed
if (scenarioList) {
  scenarioList.onchange = () => {
    renderMoveToFolderSelect();
  };
}

/* === FOLDERS === */

function renderFolderOptions() {
  // Render folder options for Save Scenario
  scenarioFolder.innerHTML = '<option value="">No Folder</option>';

  // Render folder options for Filter
  filterFolder.innerHTML = '<option value="">All Folders</option><option value="__none__">No Folder</option>';

  Object.entries(foldersCache)
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .forEach(([id, folder]) => {
      const option1 = document.createElement("option");
      option1.value = id;
      option1.textContent = folder.name;
      scenarioFolder.appendChild(option1);

      const option2 = document.createElement("option");
      option2.value = id;
      option2.textContent = folder.name;
      filterFolder.appendChild(option2);
    });

  // Render options for Export Folder select
  if (exportFolderSelect) {
    exportFolderSelect.innerHTML = '<option value="">-- Select folder --</option>';
    const folderEntries = Object.entries(foldersCache);
    folderEntries
      .sort((a, b) => a[1].name.localeCompare(b[1].name))
      .forEach(([id, folder]) => {
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = folder.name;
        exportFolderSelect.appendChild(opt);
      });

    // Disable export button if no folders exist or none selected
    if (exportFolder) {
      exportFolder.disabled = folderEntries.length === 0 || !exportFolderSelect.value;
    }
  }
}

// Populate Export Scenario select
function renderExportScenarioSelect() {
  if (!exportScenarioSelect) return;
  exportScenarioSelect.innerHTML = '<option value="">-- Select scenario --</option>';

  const list = Object.entries(scenariosCache).map(([id, s]) => ({
    id,
    name: s.name,
    folderId: s.folderId || null,
  }));

  // Group by folder
  const grouped = {};
  list.forEach((item) => {
    const key = item.folderId || "__none__";
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(item);
  });

  const folderKeys = Object.keys(grouped).sort((a, b) => {
    if (a === "__none__") return 1;
    if (b === "__none__") return -1;
    const nameA = foldersCache[a]?.name || "";
    const nameB = foldersCache[b]?.name || "";
    return nameA.localeCompare(nameB);
  });

  folderKeys.forEach((folderId) => {
    const items = grouped[folderId];
    const folderName = folderId === "__none__" ? "No Folder" : foldersCache[folderId]?.name || "Unknown";

    const optgroup = document.createElement("optgroup");
    optgroup.label = folderName;
    exportScenarioSelect.appendChild(optgroup);

    items.forEach((item) => {
      const o = document.createElement("option");
      o.value = item.id;
      o.textContent = item.name;
      optgroup.appendChild(o);
    });
  });

  // Disable export button if no scenarios exist or none selected
  if (exportScenario) {
    exportScenario.disabled = list.length === 0 || !exportScenarioSelect.value;
  }
}

if (createFolderBtn) {
  createFolderBtn.onclick = () => {
    // Open and scroll to Manage Folders section
    if (manageFoldersCard) {
      manageFoldersCard.classList.remove("collapsed");
      manageFoldersCard.scrollIntoView({ behavior: "smooth", block: "start" });

      // Focus on the input field after scrolling
      setTimeout(() => {
        if (newFolderInput) {
          newFolderInput.focus();
        }
      }, 300);
    }
  };
}

// Populate Move to Folder select when needed
function renderMoveToFolderSelect() {
  moveToFolderSelect.innerHTML = '<option value="">No Folder</option>';
  const sortedFolders = Object.entries(foldersCache)
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  sortedFolders.forEach(([folderId, folder]) => {
    const option = document.createElement("option");
    option.value = folderId;
    option.textContent = folder.name;
    moveToFolderSelect.appendChild(option);
  });
}

if (doMoveToFolder) {
  doMoveToFolder.onclick = () => {
    const scenarioId = scenarioList.value;
    if (!scenarioId) return;

    const folderId = moveToFolderSelect.value || null;

    chrome.runtime.sendMessage({ type: "MOVE_TO_FOLDER", scenarioId, folderId }, () => {
      moveToFolderSelect.value = "";
      loadScenarios();
    });
  };
}

function renderFoldersManagementUI() {
  foldersList.innerHTML = "";
  const sortedFolders = Object.entries(foldersCache)
    .sort((a, b) => a[1].name.localeCompare(b[1].name));

  if (sortedFolders.length === 0) {
    foldersList.innerHTML = '<div style="color: var(--muted); padding: 10px 0; text-align: center;">No folders yet</div>';
    return;
  }

  sortedFolders.forEach(([folderId, folder]) => {
    const count = Object.values(scenariosCache).filter(s => s.folderId === folderId).length;
    const folderDiv = document.createElement("div");
    folderDiv.className = "list-item";

    const contentDiv = document.createElement("div");
    contentDiv.className = "list-item-content";
    contentDiv.textContent = `${folder.name} (${count})`;

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "list-item-actions";

    const renameBtn = document.createElement("button");
    renameBtn.textContent = "Rename";
    renameBtn.className = "list-item-btn secondary";
    renameBtn.dataset.folderId = folderId;
    renameBtn.onclick = (e) => {
      e.stopPropagation();
      const btn = e.target;
      const currentFolderId = btn.dataset.folderId;

      if (btn.dataset.editing) {
        // Save mode
        const input = contentDiv.querySelector("input");
        const newName = input.value.trim();
        if (!newName) {
          _showFieldError(input, "Folder name is required");
          return;
        }
        chrome.runtime.sendMessage({ type: "RENAME_FOLDER", folderId: currentFolderId, name: newName }, () => {
          loadScenarios(); // Refresh caches and all folder-dependent UI immediately
        });
      } else {
        // Edit mode
        const input = document.createElement("input");
        input.type = "text";
        input.value = foldersCache[currentFolderId].name;
        input.style.cssText = "flex: 1; padding: 4px 6px; font-size: 11px; border: 2px solid var(--primary); border-radius: 4px; background: var(--card); color: var(--text); margin: 0;";

        contentDiv.innerHTML = "";
        contentDiv.appendChild(input);
        btn.textContent = "Save";
        btn.dataset.editing = "true";
        input.focus();
        input.select();
      }
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.textContent = "Delete";
    deleteBtn.className = "list-item-btn danger";
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      showConfirm(`Delete folder "${folder.name}"? Scenarios will be moved to "No Folder"`, () => {
        chrome.runtime.sendMessage({ type: "DELETE_FOLDER", folderId }, () => {
          loadScenarios(); // Refresh caches after delete so lists update instantly
        });
      }, { title: 'Delete Folder', danger: true });
    };

    actionsDiv.appendChild(renameBtn);
    actionsDiv.appendChild(deleteBtn);
    folderDiv.appendChild(contentDiv);
    folderDiv.appendChild(actionsDiv);
    foldersList.appendChild(folderDiv);
  });
}

if (createFolderAction) {
  createFolderAction.onclick = () => {
    const name = newFolderInput.value.trim();
    if (!name) {
      _showFieldError(newFolderInput, "Folder name is required");
      return;
    }

    chrome.runtime.sendMessage({ type: "CREATE_FOLDER", name }, () => {
      newFolderInput.value = "";
      loadScenarios(); // Reload to reflect new folder everywhere without reopening popup
    });
  };
}

// MANAGE FOLDERS is now always visible, render it when folders load
// (already called in loadScenarios)

// Variables UI is fully managed by popup/variables.js (initVariables called in init.js)

scenarioList.onchange = () => {
  // Enable scenario actions only when a real scenario is selected
  const hasSelection = !!scenarioList.value;
  toggleScenarioActions(hasSelection);
  previewActions();
  // Persist selection so it remains when popup is closed and reopened
  if (hasSelection) {
    chrome.storage.local.set({ lastSelectedScenario: scenarioList.value });
  } else {
    chrome.storage.local.remove("lastSelectedScenario");
  }
};

/* === ENABLE / DISABLE === */

function toggleScenarioActions(enabled) {
  [
    renameScenario,
    deleteScenario,
    playScenario,
    stopPlay,
    duplicateScenarioBtn,
    doMoveToFolder,
    document.getElementById("showMoveSection"),
  ].filter(Boolean).forEach((btn) => (btn.disabled = !enabled));

  // Hide rename/move panels when selection cleared
  if (!enabled) {
    const rs = document.getElementById("renameSection");
    const ms = document.getElementById("moveSection");
    if (rs) rs.style.display = "none";
    if (ms) ms.style.display = "none";
  }
}

/* === RENAME === */

renameScenario.onclick = () => {
  const scenarioId = scenarioList.value;
  if (!scenarioId) return;

  const renameSection = document.getElementById("renameSection");
  const moveSection = document.getElementById("moveSection");

  // Toggle visibility
  const isOpen = renameSection && renameSection.style.display !== "none";
  if (renameSection) renameSection.style.display = isOpen ? "none" : "block";
  if (moveSection) moveSection.style.display = "none";

  // Pre-fill with current name
  if (!isOpen && renameInput) {
    renameInput.value = scenariosCache[scenarioId]?.name || "";
    renameInput.focus();
    renameInput.select();
  }
};

// Confirm rename
document.getElementById("confirmRename")?.addEventListener("click", () => {
  const newName = renameInput?.value.trim();
  const scenarioId = scenarioList?.value;
  if (!newName || !scenarioId) {
    if (renameInput) _showFieldError(renameInput, "Scenario name is required");
    return;
  }
  chrome.runtime.sendMessage({ type: "RENAME_SCENARIO", scenarioId, newName }, () => {
    const rs = document.getElementById("renameSection");
    if (rs) rs.style.display = "none";
    if (renameInput) renameInput.value = "";
    loadScenarios();
  });
});

// Cancel rename
document.getElementById("cancelRename")?.addEventListener("click", () => {
  const rs = document.getElementById("renameSection");
  if (rs) rs.style.display = "none";
  if (renameInput) renameInput.value = "";
});

// Toggle move section
document.getElementById("showMoveSection")?.addEventListener("click", () => {
  const moveSection = document.getElementById("moveSection");
  const renameSection = document.getElementById("renameSection");
  if (!moveSection) return;
  const isOpen = moveSection.style.display !== "none";
  moveSection.style.display = isOpen ? "none" : "block";
  if (!isOpen && renameSection) renameSection.style.display = "none";
});

if (duplicateScenarioBtn) {
  duplicateScenarioBtn.onclick = () => {
    const scenarioId = scenarioList.value;
    if (!scenarioId) return;
    chrome.runtime.sendMessage({ type: "DUPLICATE_SCENARIO", scenarioId }, () => {
      loadScenarios();
    });
  };
}

/* === DELETE === */

deleteScenario.onclick = () => {
  const scenarioId = scenarioList.value;
  if (!scenarioId) return;

  showConfirm("Delete this scenario?", () => {
    chrome.runtime.sendMessage({ type: "DELETE_SCENARIO", scenarioId }, () => {
      actionsEl.innerHTML = "";
      // If the deleted scenario was the last selected scenario, remove persisted selection
      chrome.storage.local.get(["lastSelectedScenario"], (res) => {
        if (res?.lastSelectedScenario === scenarioId) {
          chrome.storage.local.remove("lastSelectedScenario");
        }
        loadScenarios();
      });
    });
  }, { title: 'Delete Scenario', danger: true });
};

/* === EXPORT === */

// Update button state when scenario selection changes
if (exportScenarioSelect) {
  exportScenarioSelect.onchange = () => {
    if (exportScenario) {
      exportScenario.disabled = !exportScenarioSelect.value;
    }
  };
}

// Update button state when folder selection changes
if (exportFolderSelect) {
  exportFolderSelect.onchange = () => {
    if (exportFolder) {
      exportFolder.disabled = !exportFolderSelect.value;
    }
  };
}

exportScenario.onclick = () => {
  const scenarioId = exportScenarioSelect?.value;
  if (!scenarioId) return;

  chrome.runtime.sendMessage({ type: "EXPORT_SCENARIO", scenarioId }, (res) => {
    if (!res?.scenario) return;

    const blob = new Blob([JSON.stringify(res.scenario, null, 2)], {
      type: "application/json",
    });

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${res.scenario.name}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
};

// Export all scenarios within a selected folder
if (exportFolder) {
  exportFolder.onclick = () => {
    const folderId = exportFolderSelect?.value;
    if (!folderId) return;

    chrome.runtime.sendMessage({ type: 'EXPORT_FOLDER', folderId }, (res) => {
      const folderData = res?.folder;
      if (!folderData) return;
      const nameSafe = (folderData.name || 'folder').replace(/\s+/g, '-');
      const blob = new Blob([JSON.stringify(folderData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `folder-${nameSafe}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
  };
}

/* === IMPORT === */

importScenario.onclick = () => {
  const file = importFile.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(reader.result);
      // Support both single scenario {name,actions} and array [{name,actions},…]
      const items = Array.isArray(json) ? json : [json];
      if (!items.length) { showToast("Empty file", "error"); return; }
      let done = 0;
      items.forEach((scenario) => {
        chrome.runtime.sendMessage({ type: "IMPORT_SCENARIO", scenario }, () => {
          done++;
          if (done === items.length) {
            loadScenarios();
            showToast(`✓ Imported ${items.length} scenario${items.length > 1 ? "s" : ""}`, "success");
          }
        });
      });
    } catch (e) {
      showToast("Invalid JSON file", 'error');
    }
  };
  reader.readAsText(file);
};

/* === BACKUP / RESTORE ALL DATA (Fix #12) === */

const backupAllBtn = document.getElementById("backupAll");
const restoreAllBtn = document.getElementById("restoreAll");
const restoreFileInput = document.getElementById("restoreFile");

if (backupAllBtn) {
  backupAllBtn.onclick = () => {
    chrome.runtime.sendMessage({ type: "GET_ALL_DATA" }, (res) => {
      if (chrome.runtime.lastError || !res?.data) {
        showToast("✗ Backup failed", "error");
        return;
      }
      const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `fast-recorder-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("✓ Backup downloaded", "success");
    });
  };
}

function _doRestore(file) {
  if (!file || !file.name.endsWith('.json')) {
    showToast("✗ Please select a .json backup file", "error");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      showConfirm(
        "This will overwrite ALL current data (scenarios, folders, schedules, settings). Continue?",
        () => {
          chrome.runtime.sendMessage({ type: "RESTORE_ALL_DATA", data }, (res) => {
            if (chrome.runtime.lastError) {
              showToast("✗ Restore failed: " + chrome.runtime.lastError.message, "error");
              return;
            }
            if (res?.success) {
              showToast("✓ Data restored — reloading…", "success");
              setTimeout(() => location.reload(), 1200);
            } else {
              showToast("✗ Restore failed: " + (res?.error || "unknown"), "error");
            }
          });
        },
        { title: "Restore All Data", okLabel: "Restore" }
      );
    } catch {
      showToast("✗ Invalid backup file", "error");
    }
  };
  reader.readAsText(file);
}

if (restoreAllBtn && restoreFileInput) {
  restoreAllBtn.onclick = () => {
    const file = restoreFileInput.files[0];
    if (!file) { showToast("Please choose a backup file first", "error"); return; }
    _doRestore(file);
  };
}

/* === PLAYBACK === */

playScenario.onclick = () => {
  const scenarioId = scenarioList.value;
  if (!scenarioId) return;
  const loopCount = Math.max(1, parseInt(document.getElementById("loopCount")?.value || "1", 10));
  const loopDelayPreset = document.getElementById("loopDelayPreset");
  const loopDelayCustom = document.getElementById("loopDelay");
  const loopDelayRaw = loopDelayPreset?.value === "custom"
    ? parseInt(loopDelayCustom?.value || "500", 10)
    : parseInt(loopDelayPreset?.value || "500", 10);
  const loopDelay = Math.max(500, isNaN(loopDelayRaw) ? 500 : loopDelayRaw);
  chrome.runtime.sendMessage({ type: "START_PLAYBACK_SCENARIO", scenarioId, loopCount, loopDelay });
  window.close();
};

stopPlay.onclick = () => chrome.runtime.sendMessage({ type: "STOP_PLAYBACK" });


// Sequence scenario execution (run list)
// - `runList` stores queued scenarios with per-item delay
// - Inline editor allows per-item delay editing


let runList = []; // Array<{ id, name, delay }>

// Initialize sequence buttons state (disabled when runList is empty)
if (startSequence) startSequence.disabled = true;
if (saveSequenceAsScenario) saveSequenceAsScenario.disabled = true;

delayPreset?.addEventListener("change", () => {
  const isCustom = delayPreset.value === "custom";
  delayAfterScenario.style.display = isCustom ? "" : "none";
  if (!isCustom) delayAfterScenario.value = "";
});

document.getElementById("loopDelayPreset")?.addEventListener("change", function () {
  const isCustom = this.value === "custom";
  const customEl = document.getElementById("loopDelay");
  if (customEl) { customEl.style.display = isCustom ? "" : "none"; if (!isCustom) customEl.value = ""; }
});

document.getElementById("manualDelayPreset")?.addEventListener("change", function () {
  const isCustom = this.value === "custom";
  const customEl = document.getElementById("manualDelay");
  if (customEl) { customEl.style.display = isCustom ? "" : "none"; if (!isCustom) customEl.value = ""; }
});


csvDelayBetweenPreset?.addEventListener("change", () => {
  const isCustom = csvDelayBetweenPreset.value === "custom";
  const customEl = document.getElementById("csvDelayBetween");
  if (customEl) { customEl.style.display = isCustom ? "" : "none"; if (!isCustom) customEl.value = ""; }
});

addToRunList.onclick = () => {
  const scenarioId = sequenceScenarioList.value;
  if (!scenarioId) return;

  let finalDelay;
  if (delayPreset?.value === "custom") {
    const v = parseInt(delayAfterScenario.value, 10);
    finalDelay = !isNaN(v) && v >= 500 ? v : 500;
  } else {
    finalDelay = parseInt(delayPreset?.value ?? "500", 10) || 500;
  }

  const scenarioName = scenariosCache[scenarioId]?.name || "Unknown";
  runList.push({ id: scenarioId, name: scenarioName, delay: finalDelay });
  updateRunListDisplay();
  sequenceScenarioList.value = "";
  if (delayPreset) { delayPreset.value = "500"; }
  delayAfterScenario.value = "";
  delayAfterScenario.style.display = "none";
};

function updateRunListDisplay() {
  runListDisplay.innerHTML = "";

  // Toggle sequence buttons based on runList
  const hasItems = runList.length > 0;
  if (startSequence) startSequence.disabled = !hasItems;
  if (saveSequenceAsScenario) saveSequenceAsScenario.disabled = !hasItems;

  if (!runList.length) {
    runListDisplay.innerHTML = `<li class="empty">No scenarios in run list</li>`;
    return;
  }

  runList.forEach((scenarioItem, index) => {
    const li = document.createElement("li");
    li.classList.add("action", "action-navigate");
    if (scenarioItem.disabled) li.classList.add("action-disabled");
    li.dataset.index = index;
    li.draggable = true;

    const delayText = scenarioItem.delay ? `${scenarioItem.delay}ms` : "0ms";
    li.innerHTML = `
      <span class="index">${index + 1}.</span>
      <span class="type" title="${escHtml(scenarioItem.name)}" style="text-transform:none;">${escHtml(scenarioItem.name)}</span>
      <span class="value">${escHtml(delayText)}</span>
    `;

    li.addEventListener("dragstart", (e) => {
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      runListDisplay.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
    });

    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";

    const disableBtn = document.createElement("button");
    disableBtn.textContent = scenarioItem.disabled ? "Enable" : "Disable";
    disableBtn.className = "secondary";
    disableBtn.onclick = () => { scenarioItem.disabled = !scenarioItem.disabled; updateRunListDisplay(); };

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy";
    copyBtn.className = "secondary";
    copyBtn.onclick = () => {
      sequenceClipboard = { id: scenarioItem.id, name: scenarioItem.name, delay: scenarioItem.delay };
      showToast("Item copied", "success");
      updateRunListDisplay();
    };

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.className = "secondary";
    editBtn.onclick = () => {
      const newDelay = prompt("Delay (ms):", String(scenarioItem.delay));
      if (newDelay === null) return;
      const v = parseInt(newDelay, 10);
      if (!isNaN(v) && v >= 0) scenarioItem.delay = v;
      updateRunListDisplay();
    };

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "danger";
    delBtn.onclick = () => { runList.splice(index, 1); updateRunListDisplay(); };

    btnRow.appendChild(disableBtn);
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(editBtn);
    btnRow.appendChild(delBtn);
    li.appendChild(btnRow);
    runListDisplay.appendChild(li);
  });

  // Task 2 — Paste item nếu clipboard có dữ liệu
  if (sequenceClipboard) {
    const pasteLi = document.createElement("li");
    pasteLi.className = "action-navigate action-paste-li";
    const pasteBtn = document.createElement("button");
    pasteBtn.textContent = `Paste: ${sequenceClipboard.name} (${sequenceClipboard.delay}ms)`;
    pasteBtn.className = "secondary action-paste-btn";
    pasteBtn.addEventListener("click", () => {
      runList.push({ ...sequenceClipboard });
      showToast("Item pasted", "success");
      updateRunListDisplay();
    });
    pasteLi.appendChild(pasteBtn);
    runListDisplay.appendChild(pasteLi);
  }
}

startSequence.onclick = () => {
  if (!runList.length) return;

  chrome.runtime.sendMessage({
    type: "START_SEQUENCE_PLAYBACK",
    runList: runList,
  });
};

stopSequence.onclick = () => {
  chrome.runtime.sendMessage({ type: "STOP_SEQUENCE_PLAYBACK" });
};

saveSequenceAsScenario.onclick = () => {
  if (!runList.length) return;

  const name = sequenceName.value?.trim();
  if (!name) {
    _showFieldError(sequenceName, "Sequence name is required");
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: "SAVE_SEQUENCE_AS_SCENARIO",
      name,
      runList: runList,
    },
    () => {
      sequenceName.value = "";
      runList = [];
      updateRunListDisplay();
      loadScenarios();
    }
  );
};

/* === NOTIFICATION SETTING === */


/* === Schedule & CSV === */
/* === SCHEDULED PLAYBACK === */

function renderScheduleScenarioSelect() {
  const sel = document.getElementById("scheduleScenarioSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Select scenario --</option>';
  Object.entries(scenariosCache).forEach(([id, s]) => {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = s.name;
    sel.appendChild(o);
  });
}

let editingScheduleId = null;
let currentSchedules = [];

function _setScheduleTimePicker(timeStr) {
  const stHour = document.getElementById("stHour");
  const stMin  = document.getElementById("stMin");
  const stAmPm = document.getElementById("stAmPm");
  const hidden = document.getElementById("scheduleTime");
  if (!stHour || !stMin || !stAmPm || !hidden) return;
  const [h24, m] = timeStr.split(":").map(Number);
  let h12, ampm;
  if (h24 === 0)       { h12 = 12; ampm = "AM"; }
  else if (h24 < 12)   { h12 = h24; ampm = "AM"; }
  else if (h24 === 12) { h12 = 12;  ampm = "PM"; }
  else                 { h12 = h24 - 12; ampm = "PM"; }
  stHour.value = h12;
  stMin.value  = m;
  stAmPm.textContent = ampm;
  hidden.value = timeStr;
}

function formatTime12h(timeStr) {
  const [h24, m] = timeStr.split(":").map(Number);
  let h12, ampm;
  if (h24 === 0)       { h12 = 12; ampm = "AM"; }
  else if (h24 < 12)   { h12 = h24; ampm = "AM"; }
  else if (h24 === 12) { h12 = 12;  ampm = "PM"; }
  else                 { h12 = h24 - 12; ampm = "PM"; }
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

function renderScheduleList(schedules) {
  currentSchedules = schedules;
  const container = document.getElementById("scheduleList");
  if (!container) return;
  if (!schedules.length) {
    container.innerHTML = '<li class="empty">No schedules yet.</li>';
    return;
  }
  container.innerHTML = "";
  schedules.forEach((s, index) => {
    const li = document.createElement("li");
    li.classList.add("action", "action-navigate");
    if (!s.enabled) li.classList.add("action-disabled");
    li.dataset.index = index;
    li.draggable = true;

    const scenarioName = scenariosCache[s.scenarioId]?.name || s.scenarioId;
    const timeDisplay = formatTime12h(s.time);
    const repeatText = s.repeat ? " 🔁" : "";
    const labelText = s.label ? ` · ${s.label}` : "";

    li.innerHTML = `
      <span class="index">${index + 1}.</span>
      <span class="type" title="${escHtml(scenarioName)}" style="text-transform:none;">${escHtml(scenarioName)}</span>
      <span class="value">${escHtml(timeDisplay)}${repeatText}${escHtml(labelText)}</span>
    `;

    li.addEventListener("dragstart", (e) => {
      li.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragend", () => {
      li.classList.remove("dragging");
      container.querySelectorAll(".drag-over").forEach(el => el.classList.remove("drag-over"));
    });

    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";

    const disableBtn = document.createElement("button");
    disableBtn.textContent = s.enabled ? "Disable" : "Enable";
    disableBtn.className = "secondary";
    disableBtn.onclick = () => {
      s.enabled = !s.enabled;
      chrome.runtime.sendMessage({ type: "SAVE_SCHEDULE", schedule: s }, loadSchedules);
    };

    const copyBtn = document.createElement("button");
    copyBtn.textContent = "Copy";
    copyBtn.className = "secondary";
    copyBtn.onclick = () => {
      const copy = { ...s, id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5) };
      chrome.runtime.sendMessage({ type: "SAVE_SCHEDULE", schedule: copy }, () => {
        loadSchedules();
        showToast("Schedule duplicated", "success");
      });
    };

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.className = "secondary";
    editBtn.onclick = () => {
      editingScheduleId = s.id;
      document.getElementById("scheduleScenarioSelect").value = s.scenarioId;
      _setScheduleTimePicker(s.time);
      document.getElementById("scheduleLabel").value = s.label || "";
      document.getElementById("scheduleRepeat").checked = !!s.repeat;
      document.getElementById("addSchedule").textContent = "✔ Save";
      const card = document.getElementById("scheduledPlaybackCard");
      if (card?.classList.contains("collapsed")) card.classList.remove("collapsed");
    };

    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.className = "danger";
    delBtn.onclick = () => {
      if (editingScheduleId === s.id) {
        editingScheduleId = null;
        document.getElementById("addSchedule").textContent = "+ Add";
        _resetScheduleTimePicker?.();
      }
      chrome.runtime.sendMessage({ type: "DELETE_SCHEDULE", id: s.id }, loadSchedules);
    };

    btnRow.appendChild(disableBtn);
    btnRow.appendChild(copyBtn);
    btnRow.appendChild(editBtn);
    btnRow.appendChild(delBtn);
    li.appendChild(btnRow);
    container.appendChild(li);
  });
}

function loadSchedules() {
  chrome.runtime.sendMessage({ type: "GET_SCHEDULES" }, (res) => {
    renderScheduleList(res?.schedules || []);
  });
}

(function () {
  const el = document.getElementById("scheduleList");
  if (!el) return;
  el.addEventListener("dragover", (e) => {
    e.preventDefault();
    const dragging = el.querySelector(".dragging");
    if (!dragging) return;
    const after = getDragAfterElement(el, e.clientY);
    el.querySelectorAll(".drag-over").forEach(x => x.classList.remove("drag-over"));
    if (after == null) el.appendChild(dragging);
    else { after.classList.add("drag-over"); el.insertBefore(dragging, after); }
  });
  el.addEventListener("drop", () => {
    el.querySelectorAll(".drag-over").forEach(x => x.classList.remove("drag-over"));
    const newOrder = [...el.querySelectorAll("li[data-index]")].map(li => Number(li.dataset.index));
    const reordered = newOrder.map(i => currentSchedules[i]);
    renderScheduleList(reordered);
  });
})();

/* === Custom Schedule Time Picker === */
let _resetScheduleTimePicker = null;
(function () {
  const stHour = document.getElementById("stHour");
  const stMin  = document.getElementById("stMin");
  const stAmPm = document.getElementById("stAmPm");
  const hidden = document.getElementById("scheduleTime");
  if (!stHour || !stMin || !stAmPm || !hidden) return;

  function clamp(val, min, max) {
    const n = parseInt(val, 10);
    if (isNaN(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function syncHidden() {
    const h12 = clamp(stHour.value, 1, 12);
    const m   = clamp(stMin.value, 0, 59);
    const pm  = stAmPm.textContent === "PM";
    const h24 = pm ? (h12 === 12 ? 12 : h12 + 12) : (h12 === 12 ? 0 : h12);
    hidden.value = `${String(h24).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  stHour.addEventListener("input", syncHidden);
  stHour.addEventListener("change", () => { stHour.value = clamp(stHour.value, 1, 12); syncHidden(); });
  stMin.addEventListener("input", syncHidden);
  stMin.addEventListener("change", () => { stMin.value = clamp(stMin.value, 0, 59); syncHidden(); });
  stAmPm.addEventListener("click", () => {
    stAmPm.textContent = stAmPm.textContent === "AM" ? "PM" : "AM";
    syncHidden();
  });

  _resetScheduleTimePicker = () => {
    stHour.value = 12;
    stMin.value  = 0;
    stAmPm.textContent = "AM";
    syncHidden(); // keep hidden populated (12 AM = "00:00")
  };

  syncHidden(); // init hidden value
})();

document.getElementById("addSchedule")?.addEventListener("click", () => {
  const scenarioId = document.getElementById("scheduleScenarioSelect")?.value;
  const time = document.getElementById("scheduleTime")?.value;
  const label = document.getElementById("scheduleLabel")?.value?.trim() || "";
  const repeat = document.getElementById("scheduleRepeat")?.checked || false;

  if (!scenarioId) {
    showToast("Select a scenario first", "error");
    return;
  }
  if (!time) {
    showToast("Select a time first", "error");
    return;
  }

  const schedule = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    scenarioId,
    time,
    label,
    repeat,
    enabled: true,
  };

  const isEditing = !!editingScheduleId;
  const saveAction = () => {
    chrome.runtime.sendMessage({ type: "SAVE_SCHEDULE", schedule }, () => {
      editingScheduleId = null;
      document.getElementById("addSchedule").textContent = "+ Add";
      _resetScheduleTimePicker?.();
      document.getElementById("scheduleLabel").value = "";
      document.getElementById("scheduleRepeat").checked = false;
      loadSchedules();
      showToast(isEditing ? "Schedule updated" : "Schedule added", "success");
    });
  };

  if (isEditing) {
    chrome.runtime.sendMessage({ type: "DELETE_SCHEDULE", id: editingScheduleId }, saveAction);
  } else {
    saveAction();
  }
});

loadSchedules();

/* === CSV DATA-DRIVEN RUN === */

// Extract ${variable} names used as inputs in a scenario's actions (mirrors collectRelevantKeys in bg/playback.js)
function _getInputVarsFromScenario(scenarioId) {
  const scenario = scenariosCache[scenarioId];
  if (!scenario?.actions) return new Set();
  const keys = new Set();
  const VAR_RE = /\$\{([^}]+)\}/g;
  const FIELDS = ["selector", "value", "url", "code", "expectedValue", "switchVar"];
  const COND_FIELDS = ["valueEquals", "textContains"];
  for (const a of scenario.actions) {
    for (const f of FIELDS) {
      if (typeof a[f] === "string") {
        let m; VAR_RE.lastIndex = 0;
        while ((m = VAR_RE.exec(a[f])) !== null) keys.add(m[1]);
      }
    }
    if (a.conditions && typeof a.conditions === "object") {
      for (const f of COND_FIELDS) {
        if (typeof a.conditions[f] === "string") {
          let m; VAR_RE.lastIndex = 0;
          while ((m = VAR_RE.exec(a.conditions[f])) !== null) keys.add(m[1]);
        }
      }
    }
  }
  return keys;
}

function renderCsvScenarioSelect() {
  const sel = document.getElementById("csvScenarioSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">-- Select scenario --</option>';
  Object.entries(scenariosCache).forEach(([id, s]) => {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = s.name;
    sel.appendChild(o);
  });
}

function renderExportCodeSelect() {
  const sel = document.getElementById("exportCodeSelect");
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">-- Select scenario --</option>';
  Object.entries(scenariosCache)
    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
    .forEach(([id, s]) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = s.name;
      sel.appendChild(o);
    });
  if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
}

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;

  // Proper CSV line parser that handles quoted fields with commas and escaped quotes
  function parseLine(line) {
    const fields = [];
    let i = 0, field = '', inQuote = false;
    while (i < line.length) {
      const ch = line[i];
      if (inQuote) {
        if (ch === '"') {
          if (line[i + 1] === '"') { field += '"'; i += 2; }
          else { inQuote = false; i++; }
        } else { field += ch; i++; }
      } else {
        if (ch === '"') { inQuote = true; i++; }
        else if (ch === ',') { fields.push(field.trim()); field = ''; i++; }
        else { field += ch; i++; }
      }
    }
    fields.push(field.trim());
    return fields;
  }

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const vals = parseLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ""; });
    return row;
  });
  return { headers, rows };
}

let csvParsed = null;
let _csvDelayBetween = 500;
let _csvCountdownInterval = null;
let _csvRunScenarioName = "";

function _updateCsvBadges(row, total, failRows, done) {
  const progText  = document.getElementById("pbPanelCsvProgText");
  const badgeOk   = document.getElementById("pbPanelCsvBadgeOk");
  const badgeFail = document.getElementById("pbPanelCsvBadgeFail");
  const barOk     = document.getElementById("pbPanelBarOk");
  const barFail   = document.getElementById("pbPanelBarFail");
  const statusEl  = document.getElementById("csvStatus");

  const success = row - failRows;
  const pct = total > 0 ? (v) => Math.round(v / total * 100) + "%" : () => "0%";

  if (done) {
    if (progText) progText.textContent = `${total - failRows} passed · ${failRows} failed`;
    if (barOk)    barOk.style.width    = pct(total - failRows);
    if (barFail)  barFail.style.width  = pct(failRows);
    if (statusEl) statusEl.textContent = `✓ ${total - failRows} passed · ✗ ${failRows} failed`;
  } else if (!row) {
    if (progText) progText.textContent = total > 0 ? `Row Done 0 / ${total}` : "";
    if (barOk)    barOk.style.width    = "0%";
    if (barFail)  barFail.style.width  = "0%";
  } else {
    if (progText) progText.textContent = `Row Done ${row} / ${total}`;
    if (barOk)    barOk.style.width    = pct(success);
    if (barFail)  barFail.style.width  = pct(failRows);
  }
  if (badgeOk)   badgeOk.textContent   = `✓ ${done ? total - failRows : success}`;
  if (badgeFail) {
    badgeFail.textContent = `✗ ${failRows}`;
    badgeFail.classList.toggle("has-fail", failRows > 0);
  }
}

function _startCsvCountdown(delayMs) {
  if (!delayMs || delayMs <= 0) return;
  const cdWrap = document.getElementById("pbPanelCsvCountdown");
  const cdText = document.getElementById("pbPanelCsvCdText");
  const cdBar  = document.getElementById("pbPanelCsvCdBar");
  if (!cdWrap) return;

  if (_csvCountdownInterval) clearInterval(_csvCountdownInterval);
  cdWrap.style.display = "block";

  let rem = Math.round(delayMs / 1000);
  if (cdText) cdText.textContent = `⏱ next row in ${rem}s`;
  _csvCountdownInterval = setInterval(() => {
    rem--;
    if (rem <= 0) {
      clearInterval(_csvCountdownInterval);
      if (cdText) cdText.textContent = "";
      if (cdWrap) cdWrap.style.display = "none";
    } else {
      if (cdText) cdText.textContent = `⏱ next row in ${rem}s`;
    }
  }, 1000);

  if (cdBar) {
    cdBar.style.transition = "none";
    cdBar.style.width = "100%";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      cdBar.style.transition = `width ${delayMs}ms linear`;
      cdBar.style.width = "0%";
    }));
  }
}

function _stopCsvCountdown() {
  if (_csvCountdownInterval) { clearInterval(_csvCountdownInterval); _csvCountdownInterval = null; }
  const cdWrap = document.getElementById("pbPanelCsvCountdown");
  const cdBar  = document.getElementById("pbPanelCsvCdBar");
  if (cdWrap) cdWrap.style.display = "none";
  if (cdBar)  { cdBar.style.transition = "none"; cdBar.style.width = "100%"; }
}

document.getElementById("csvFile")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  const preview = document.getElementById("csvPreview");
  if (!file) { csvParsed = null; if (preview) preview.textContent = ""; return; }

  const reader = new FileReader();
  reader.onload = () => {
    csvParsed = parseCSV(reader.result);
    if (!csvParsed) {
      if (preview) preview.textContent = "Invalid CSV (need at least 1 header row + 1 data row)";
      chrome.storage.local.remove("csvSessionData");
      return;
    }
    if (preview) {
      preview.textContent = `${csvParsed.rows.length} rows, columns: ${csvParsed.headers.join(", ")}`;
    }
    chrome.storage.local.set({ csvSessionData: { headers: csvParsed.headers, rows: csvParsed.rows } });
  };
  reader.readAsText(file);
});

// Format failures array into a human-readable bug string
function _formatBug(failures) {
  if (!failures || failures.length === 0) return "";
  return failures.map(f => {
    const label = f.label ? ` "${f.label}"` : "";
    return `[${f.index}] ${f.type}${label}`;
  }).join("; ");
}

// Build and download result CSV after a CSV run
function generateResultCsv(originalHeaders, originalRows, results) {
  // Collect any extra columns captured by readdom that weren't in original headers
  const extraCols = [];
  const headerSet = new Set(originalHeaders);
  results.forEach(r => {
    Object.keys(r.vars || {}).forEach(k => {
      if (!headerSet.has(k)) { extraCols.push(k); headerSet.add(k); }
    });
  });
  const allHeaders = [...originalHeaders, ...extraCols, "Action Failed"];

  const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [allHeaders.map(escape).join(",")];

  results.forEach((r) => {
    const origRow = originalRows[r.rowIndex] || {};
    const line = allHeaders.map(h => {
      if (h === "Action Failed") return escape(_formatBug(r.failures));
      return escape(r.vars?.[h] ?? origRow[h] ?? "");
    });
    lines.push(line.join(","));
  });
  return lines.join("\r\n");
}

function downloadCsvText(text, filename) {
  // Prepend UTF-8 BOM (\uFEFF) so Excel/spreadsheet apps detect encoding correctly
  const blob = new Blob(["\uFEFF" + text], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* === Minimal ZIP builder (Store method) for XLSX generation === */
(function() {
  function _makeCRC32() {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  }
  const _CRC32T = _makeCRC32();
  window._zipCrc32 = function(data) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ _CRC32T[(crc ^ data[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  };
  window.ZipWriter = class {
    constructor() { this._files = []; this._parts = []; this._offset = 0; }
    add(name, content) {
      const nb = new TextEncoder().encode(name);
      const db = typeof content === 'string' ? new TextEncoder().encode(content) : content;
      const crc = window._zipCrc32(db);
      const lh = new DataView(new ArrayBuffer(30 + nb.length));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true);
      lh.setUint16(6, 0, true);  lh.setUint16(8, 0, true);
      lh.setUint16(10, 0, true); lh.setUint16(12, 0, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, db.length, true);
      lh.setUint32(22, db.length, true); lh.setUint16(26, nb.length, true);
      lh.setUint16(28, 0, true);
      new Uint8Array(lh.buffer).set(nb, 30);
      this._files.push({ nb, size: db.length, crc, offset: this._offset });
      this._offset += lh.buffer.byteLength + db.length;
      this._parts.push(new Uint8Array(lh.buffer), db);
    }
    build(mimeType) {
      const cdParts = []; let cdSize = 0; const cdOffset = this._offset;
      for (const f of this._files) {
        const cd = new DataView(new ArrayBuffer(46 + f.nb.length));
        cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
        cd.setUint16(8, 0, true);  cd.setUint16(10, 0, true);
        cd.setUint16(12, 0, true); cd.setUint16(14, 0, true);
        cd.setUint32(16, f.crc, true); cd.setUint32(20, f.size, true); cd.setUint32(24, f.size, true);
        cd.setUint16(28, f.nb.length, true); cd.setUint16(30, 0, true); cd.setUint16(32, 0, true);
        cd.setUint16(34, 0, true); cd.setUint16(36, 0, true);
        cd.setUint32(38, 0, true); cd.setUint32(42, f.offset, true);
        new Uint8Array(cd.buffer).set(f.nb, 46);
        cdParts.push(new Uint8Array(cd.buffer)); cdSize += cd.buffer.byteLength;
      }
      const eocd = new DataView(new ArrayBuffer(22));
      eocd.setUint32(0, 0x06054b50, true); eocd.setUint16(4, 0, true); eocd.setUint16(6, 0, true);
      eocd.setUint16(8, this._files.length, true); eocd.setUint16(10, this._files.length, true);
      eocd.setUint32(12, cdSize, true); eocd.setUint32(16, cdOffset, true); eocd.setUint16(20, 0, true);
      return new Blob([...this._parts, ...cdParts, new Uint8Array(eocd.buffer)],
        { type: mimeType || 'application/zip' });
    }
  };
})();

// Build full-header list from results + screenshots keys (always appends "Action Failed" last)
function _buildAllHeaders(originalHeaders, results, screenshots) {
  const headerSet = new Set(originalHeaders);
  const extra = [];
  results.forEach(r => {
    Object.keys(r.vars || {}).forEach(k => { if (!headerSet.has(k)) { extra.push(k); headerSet.add(k); } });
  });
  Object.keys(screenshots || {}).forEach(key => {
    const vn = key.split(':').slice(1).join(':');
    if (!headerSet.has(vn)) { extra.push(vn); headerSet.add(vn); }
  });
  return [...originalHeaders, ...extra, "Action Failed"];
}

// HTML export — images as base64 <img> tags
function generateResultHtml(originalHeaders, originalRows, results, screenshots) {
  const allHeaders = _buildAllHeaders(originalHeaders, results, screenshots);
  const imgCols = new Set();
  Object.keys(screenshots || {}).forEach(key => {
    const vn = key.split(':').slice(1).join(':');
    const ci = allHeaders.indexOf(vn);
    if (ci >= 0) imgCols.add(ci);
  });
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const hRow = allHeaders.map((h, i) => `<th${imgCols.has(i) ? ' style="min-width:200px"' : ''}>${esc(h)}</th>`).join('');
  const rows = results.map(r => {
    const orig = originalRows[r.rowIndex] || {};
    const cells = allHeaders.map((h, ci) => {
      if (imgCols.has(ci)) {
        const b64 = (screenshots || {})[`${r.rowIndex}:${h}`];
        return b64 ? `<td><img src="data:image/png;base64,${b64}" style="max-width:200px;max-height:130px;display:block;border-radius:3px;"/></td>` : '<td></td>';
      }
      if (h === 'Action Failed') {
        const bugVal = _formatBug(r.failures);
        const style = bugVal ? ' style="color:#dc2626;font-weight:600;"' : '';
        return `<td${style}>${esc(bugVal)}</td>`;
      }
      return `<td>${esc(r.vars?.[h] ?? orig[h] ?? '')}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>CSV Result</title>
<style>body{font-family:sans-serif;font-size:13px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px 8px;vertical-align:top}th{background:#f3f4f6;font-weight:bold}tr:nth-child(even){background:#f9fafb}</style>
</head><body><h2>CSV Run Result (${results.length} rows)</h2>
<table><thead><tr>${hRow}</tr></thead><tbody>\n${rows}\n</tbody></table></body></html>`;
}

// XLSX export — images placed in cells via drawing anchors
function generateResultXlsx(originalHeaders, originalRows, results, screenshots) {
  const allHeaders = _buildAllHeaders(originalHeaders, results, screenshots);
  const ss = screenshots || {};

  // Which columns have images
  const imgColIdx = new Set();
  Object.keys(ss).forEach(key => {
    const vn = key.split(':').slice(1).join(':');
    const ci = allHeaders.indexOf(vn);
    if (ci >= 0) imgColIdx.add(ci);
  });

  // Column ref: 0-indexed → A,B,...
  function colRef(n) {
    let r = ''; let c = n + 1;
    while (c > 0) { c--; r = String.fromCharCode(65 + (c % 26)) + r; c = Math.floor(c / 26); }
    return r;
  }
  function xmlEsc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Shared strings
  const strs = []; const strMap = new Map();
  function addStr(s) {
    const key = String(s ?? '');
    if (!strMap.has(key)) { strMap.set(key, strs.length); strs.push(key); }
    return strMap.get(key);
  }

  // Rows XML
  const rowsXml = [];
  // Header row
  const hCells = allHeaders.map((h, ci) => `<c r="${colRef(ci)}1" t="s"><v>${addStr(h)}</v></c>`).join('');
  rowsXml.push(`<row r="1">${hCells}</row>`);

  // Data rows
  results.forEach((r, di) => {
    const rowNum = di + 2;
    const orig = originalRows[r.rowIndex] || {};
    const hasImg = Object.keys(ss).some(k => parseInt(k.split(':')[0],10) === r.rowIndex);
    const cells = allHeaders.map((h, ci) => {
      if (imgColIdx.has(ci)) return ''; // leave empty — image goes in drawing
      const val = h === 'Action Failed' ? _formatBug(r.failures) : String(r.vars?.[h] ?? orig[h] ?? '');
      const si = addStr(val);
      return `<c r="${colRef(ci)}${rowNum}" t="s"><v>${si}</v></c>`;
    }).join('');
    const rowAttr = hasImg ? ` ht="80" customHeight="1"` : '';
    rowsXml.push(`<row r="${rowNum}"${rowAttr}>${cells}</row>`);
  });

  // Columns override for image columns
  let colsXml = '';
  if (imgColIdx.size > 0) {
    const defs = [...imgColIdx].map(ci => `<col min="${ci+1}" max="${ci+1}" width="28" customWidth="1"/>`).join('');
    colsXml = `<cols>${defs}</cols>`;
  }

  // Images
  const imageEntries = [];
  const anchors = [];
  const imgRels = [];
  let picIdx = 1;
  Object.entries(ss).forEach(([key, base64]) => {
    const colon = key.indexOf(':');
    const rowIdx = parseInt(key.slice(0, colon), 10);
    const vn = key.slice(colon + 1);
    const ci = allHeaders.indexOf(vn);
    if (ci < 0) return;
    const dataRowIdx = results.findIndex(r => r.rowIndex === rowIdx);
    if (dataRowIdx < 0) return;
    const col0 = ci;
    const row0 = dataRowIdx + 1; // +1 for header, 0-indexed for drawing
    const cx = 1905000, cy = 952500; // 200×100px in EMU
    anchors.push(`<xdr:oneCellAnchor>
  <xdr:from><xdr:col>${col0}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row0}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
  <xdr:ext cx="${cx}" cy="${cy}"/>
  <xdr:pic>
    <xdr:nvPicPr><xdr:cNvPr id="${picIdx+1}" name="Img${picIdx}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
    <xdr:blipFill><a:blip r:embed="rId${picIdx}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
    <xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
  </xdr:pic>
  <xdr:clientData/>
</xdr:oneCellAnchor>`);
    imgRels.push(`<Relationship Id="rId${picIdx}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${picIdx}.png"/>`);
    imageEntries.push({ base64, idx: picIdx });
    picIdx++;
  });

  const hasImages = imageEntries.length > 0;
  const drawingRef = hasImages ? '<drawing r:id="rId1"/>' : '';

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${colsXml}<sheetData>${rowsXml.join('')}</sheetData>${drawingRef}</worksheet>`;

  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strs.length}" uniqueCount="${strs.length}">
${strs.map(s => `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`).join('')}</sst>`;

  const drawingXml = hasImages ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchors.join('\n')}</xdr:wsDr>` : '';

  const drawingRelsXml = hasImages ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${imgRels.join('\n')}</Relationships>` : '';

  const imgCT   = hasImages ? '\n  <Default Extension="png" ContentType="image/png"/>' : '';
  const drawCT  = hasImages ? '\n  <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '';

  const zip = new ZipWriter();
  zip.add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>${imgCT}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${drawCT}
</Types>`);
  zip.add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.add('xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`);
  zip.add('xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`);
  zip.add('xl/sharedStrings.xml', ssXml);
  zip.add('xl/worksheets/sheet1.xml', sheetXml);

  if (hasImages) {
    zip.add('xl/worksheets/_rels/sheet1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`);
    zip.add('xl/drawings/drawing1.xml', drawingXml);
    zip.add('xl/drawings/_rels/drawing1.xml.rels', drawingRelsXml);
    for (const img of imageEntries) {
      const bin = atob(img.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      zip.add(`xl/media/image${img.idx}.png`, bytes);
    }
  }

  return zip.build('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

function _downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.getElementById("csvDownloadResult")?.addEventListener("click", () => {
  const format = document.getElementById("csvExportFormat")?.value || "csv";
  if (!csvParsed) { showToast("Reload the original CSV file first", "error"); return; }

  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}_${String(now.getHours()).padStart(2,"0")}-${String(now.getMinutes()).padStart(2,"0")}-${String(now.getSeconds()).padStart(2,"0")}`;

  const fetchResults = cb => chrome.runtime.sendMessage({ type: "GET_CSV_RUN_RESULTS" }, cb);
  const fetchSS      = cb => chrome.runtime.sendMessage({ type: "GET_CSV_SCREENSHOTS" }, cb);

  fetchResults(res => {
    const results = res?.results;
    if (!results?.length) { showToast("No results to download yet", "error"); return; }

    if (format === "csv") {
      const text = generateResultCsv(csvParsed.headers, csvParsed.rows, results);
      downloadCsvText(text, `csv_result_${ts}.csv`);
      showToast("Downloaded — results still available for re-download", "success");
    } else {
      fetchSS(ssRes => {
        const ss = ssRes?.screenshots || {};
        if (format === "html") {
          const html = generateResultHtml(csvParsed.headers, csvParsed.rows, results, ss);
          _downloadBlob(new Blob([html], { type: "text/html;charset=utf-8;" }), `csv_result_${ts}.html`);
        } else if (format === "xlsx") {
          const blob = generateResultXlsx(csvParsed.headers, csvParsed.rows, results, ss);
          _downloadBlob(blob, `csv_result_${ts}.xlsx`);
        } else if (format === "zip") {
          const zip = new ZipWriter();
          const csvText = generateResultCsv(csvParsed.headers, csvParsed.rows, results);
          zip.add("results.csv", "﻿" + csvText);
          for (const [key, b64] of Object.entries(ss)) {
            const colonIdx = key.indexOf(":");
            const rowNum = String(Number(key.slice(0, colonIdx)) + 1).padStart(2, "0");
            const varName = key.slice(colonIdx + 1);
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            zip.add(`row_${rowNum}/${varName}.png`, bytes);
          }
          _downloadBlob(zip.build("application/zip"), `csv_screenshots_${ts}.zip`);
        }
        showToast("Downloaded — results still available for re-download", "success");
      });
    }
  });
});

/* === CSV state machine: 'idle' | 'running' | 'done' === */
function _setCsvState(s) {
  const formatSel    = document.getElementById("csvExportFormat");
  const formatLocked = document.getElementById("csvFormatLocked");
  const startBtn     = document.getElementById("startCsvRun");
  const dlBtn        = document.getElementById("csvDownloadResult");
  const statusEl     = document.getElementById("csvStatus");
  const pbCsvSection = document.getElementById("pbPanelCsvSection");
  const pbStopSingle = document.getElementById("pbPanelStop");
  const pbStopSplit  = document.getElementById("pbPanelCsvStopSplit");

  if (s === 'idle') {
    if (formatSel)    { formatSel.disabled = false; formatSel.style.pointerEvents = ""; formatSel.style.cursor = ""; }
    if (formatLocked) formatLocked.style.display = "none";
    if (startBtn)     { startBtn.style.display = ""; startBtn.disabled = false; }
    if (dlBtn)        dlBtn.style.display = "none";
    if (statusEl)     statusEl.textContent = "";
    if (pbCsvSection) pbCsvSection.style.display = "none";
    if (pbStopSingle) pbStopSingle.style.display = "";
    if (pbStopSplit)  pbStopSplit.style.display = "none";
    _stopCsvCountdown();
  } else if (s === 'running') {
    if (formatSel)    { formatSel.disabled = true; formatSel.style.pointerEvents = ""; formatSel.style.cursor = ""; }
    if (formatLocked) formatLocked.style.display = "none";
    if (startBtn)     { startBtn.style.display = ""; startBtn.disabled = true; }
    if (dlBtn)        dlBtn.style.display = "none";
    if (pbCsvSection) pbCsvSection.style.display = "";
    if (pbStopSingle) pbStopSingle.style.display = "none";
    if (pbStopSplit)  pbStopSplit.style.display = "";
    openPbPanel();
  } else if (s === 'done') {
    if (formatSel)    { formatSel.disabled = true; formatSel.style.pointerEvents = "none"; formatSel.style.cursor = "not-allowed"; }
    if (formatLocked) formatLocked.style.display = "none";
    if (startBtn)     { startBtn.style.display = ""; startBtn.disabled = false; }
    if (dlBtn)        dlBtn.style.display = "block";
    if (pbCsvSection) pbCsvSection.style.display = "";
    if (pbStopSingle) pbStopSingle.style.display = "none";
    if (pbStopSplit)  pbStopSplit.style.display = "none";
    _stopCsvCountdown();
  }
}

document.getElementById("startCsvRun")?.addEventListener("click", () => {
  const scenarioId = document.getElementById("csvScenarioSelect")?.value;
  if (!scenarioId) { showToast("Select a scenario first", "error"); return; }
  if (!csvParsed || !csvParsed.rows.length) { showToast("Load a CSV file first", "error"); return; }
  clearCsvDoneBar();
  _csvRunScenarioName = document.getElementById("csvScenarioSelect")?.selectedOptions[0]?.text || "CSV Run";

  const _csvPresetEl = document.getElementById("csvDelayBetweenPreset");
  const delayVal = _csvPresetEl?.value === "custom"
    ? document.getElementById("csvDelayBetween")?.value?.trim()
    : (_csvPresetEl?.value || "500");
  const delayMs = parseInt(delayVal, 10);
  const delayBetween = !isNaN(delayMs) && delayMs >= 500 ? delayMs : 500;
  _csvDelayBetween = delayBetween;

  // Warn if scenario uses ${variables} not present in CSV headers
  const inputVars = _getInputVarsFromScenario(scenarioId);
  const csvHeaderSet = new Set(csvParsed.headers);
  const missingCols = [...inputVars].filter(v => !csvHeaderSet.has(v));
  if (missingCols.length > 0) {
    showToast(`⚠ CSV missing columns used by scenario: ${missingCols.join(", ")}`, "error");
  }

  _updateCsvBadges(0, csvParsed.rows.length, 0, false);
  const status = document.getElementById("csvStatus");
  if (status) status.textContent = "";

  _setCsvState('running');

  // Persist CSV data so popup can restore session after reopen
  chrome.storage.local.set({ csvSessionData: { headers: csvParsed.headers, rows: csvParsed.rows } });

  const exportFormat = document.getElementById("csvExportFormat")?.value || "csv";

  chrome.runtime.sendMessage({
    type: "START_CSV_PLAYBACK",
    scenarioId,
    rows: csvParsed.rows,
    delayBetween,
    exportFormat,
  });
});

function startCsvPoll(statusEl) {
  const poll = setInterval(() => {
    chrome.runtime.sendMessage({ type: "GET_CSV_STATUS" }, (res) => {
      if (!res) { clearInterval(poll); return; }
      if (res.active) {
        chrome.storage.local.get(["csvRunResults"], (stored) => {
          const results = stored.csvRunResults || [];
          const failRows = results.filter(r => r.failures?.length > 0).length;
          _updateCsvBadges(res.currentRow + 1, res.totalRows, failRows, false);
        });
      } else {
        chrome.storage.local.get(["csvRunResults"], (stored) => {
          const results = stored.csvRunResults || [];
          const failRows = results.filter(r => r.failures?.length > 0).length;
          _updateCsvBadges(results.length, results.length, failRows, true);
        });
        _setCsvState('done');
        clearInterval(poll);
      }
    });
  }, 800);
}

function _handleCsvStop(label) {
  chrome.runtime.sendMessage({ type: "STOP_CSV_PLAYBACK" }, () => {
    _stopCsvCountdown();
    showToast(`CSV run ${label}`, "info");
    chrome.storage.local.get(["csvRunResults"], (stored) => {
      const results = stored.csvRunResults || [];
      if (results.length > 0) {
        const failRows = results.filter(r => r.failures?.length > 0).length;
        _updateCsvBadges(results.length, results.length, failRows, true);
        _setCsvState('done');
        const statusEl = document.getElementById("csvStatus");
        const cardSummary = failRows > 0
          ? `Stopped · ✓ ${results.length - failRows} passed · ✗ ${failRows} failed`
          : `Stopped · ✓ ${results.length} passed`;
        if (statusEl) statusEl.textContent = cardSummary;
        const barSummary = failRows > 0
          ? `Stopped · ✓ ${results.length - failRows} · ✗ ${failRows} of ${results.length}`
          : `Stopped · ✓ ${results.length} rows`;
        setCsvDoneBar(_csvRunScenarioName || "CSV Run", barSummary);
      } else {
        _setCsvState('idle');
      }
    });
  });
}

document.getElementById("pbStopCsvNow")?.addEventListener("click",      () => _handleCsvStop("aborted"));
document.getElementById("pbStopCsvAfterRow")?.addEventListener("click",  () => _handleCsvStop("stopped after this row"));

document.getElementById("csvChangeFormat")?.addEventListener("click", () => {
  showConfirm(
    "Changing the export format will clear the current run results. You will need to run again.",
    () => {
      chrome.runtime.sendMessage({ type: "CLEAR_CSV_SCREENSHOTS" }, () => {
        chrome.storage.local.remove("csvRunResults", () => {
          const status = document.getElementById("csvStatus");
          if (status) status.textContent = "";
          _updateCsvBadges(0, 0, 0, false);
          _setCsvState('idle');
          showToast("Format unlocked — results cleared", "info");
        });
      });
    },
    { title: "Change Export Format?", danger: true, okLabel: "Clear & change" }
  );
});

// Persist export format selection across popup reopens
document.getElementById("csvExportFormat")?.addEventListener("change", (e) => {
  chrome.storage.local.set({ csvExportFormat: e.target.value });
});

// Show format-locked warning when user clicks the format area while in done state
// pointer-events:none on the select lets clicks fall through to this parent div
document.getElementById("csvFormatRow")?.addEventListener("click", () => {
  const formatSel = document.getElementById("csvExportFormat");
  const locked    = document.getElementById("csvFormatLocked");
  if (!formatSel?.disabled || !locked) return;
  locked.style.display = "";
});

/* === Restore export format selection on every popup open === */
chrome.storage.local.get(["csvExportFormat"], (stored) => {
  if (stored.csvExportFormat) {
    const sel = document.getElementById("csvExportFormat");
    if (sel) sel.value = stored.csvExportFormat;
  }
});

/* === Restore CSV session when popup reopens during/after a run === */
(function restoreCsvSession() {
  chrome.runtime.sendMessage({ type: "GET_CSV_STATUS" }, (csvStatus) => {
    const isActive = !!csvStatus?.active;
    chrome.storage.local.get(["csvSessionData", "csvRunResults", "csvExportFormat"], (stored) => {
      const session    = stored.csvSessionData;
      const hasResults = (stored.csvRunResults || []).length > 0;
      if (!session) return;
      if (!isActive && !hasResults) return;

      // Restore in-memory CSV data so download works without reloading file
      csvParsed = session;

      if (stored.csvExportFormat) {
        const sel = document.getElementById("csvExportFormat");
        if (sel) sel.value = stored.csvExportFormat;
      }

      const preview  = document.getElementById("csvPreview");
      const status   = document.getElementById("csvStatus");
      const csvCard  = document.getElementById("csvRunCard");

      if (preview) preview.textContent = `${session.rows.length} rows, columns: ${session.headers.join(", ")} ↩ restored`;

      if (csvCard?.classList.contains("collapsed")) {
        csvCard.classList.remove("collapsed");
      }

      if (isActive) {
        if (status) status.textContent = "";
        _updateCsvBadges(csvStatus.currentRow + 1, csvStatus.totalRows, 0, false);
        _setCsvState('running');
        startCsvPoll(status);
      } else if (hasResults) {
        const results = stored.csvRunResults;
        const failRows = results.filter(r => r.failures?.length > 0).length;
        _updateCsvBadges(results.length, results.length, failRows, true);
        if (status) status.textContent = "";
        _setCsvState('done');
      }
    });
  });
})();

} /* end initMain */
