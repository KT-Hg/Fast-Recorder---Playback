/**
 * i18n.js — panel and manager text, Vietnamese by default.
 *
 * Same arrangement as sqlcases/: Vietnamese is the default because that is who
 * uses this day to day, English is one switch away, and the choice is remembered.
 * SQL keywords and column names are never translated — they are what the person
 * has to match against the database.
 *
 * A missing key degrades to the key itself rather than throwing, and
 * `missingKeys()` lets the selftest assert that neither catalog has holes.
 */

export const LANGUAGES = ['vi', 'en'];

const VI = {
  'panel.title': 'Phiên test DB',
  'panel.noSession': 'Chưa có phiên nào đang chạy',
  'panel.start': '▶ Bắt đầu phiên',
  'panel.stop': '■ Kết thúc',
  'panel.view': 'Xem',
  'panel.exportSql': 'Xuất SQL',
  'panel.rollbackAll': '↺ Rollback tất cả',
  'panel.changes': '{n} thay đổi',
  'panel.tables': '{n} bảng',
  'panel.promptName': 'Tên phiên test:',
  'panel.defaultName': 'Phiên test',
  'panel.recorded': 'Đã ghi: {op} {table} ({n} dòng)',
  'panel.notUndoable': 'Không tự hoàn tác được: {reason}',
  'panel.capturing': 'Đang chụp dữ liệu trước khi chạy…',
  'panel.captureFailed': 'Không chụp được dữ liệu cũ: {reason}',
  'panel.tooManyRows': 'Câu lệnh đụng quá {n} dòng — không chụp. Hãy dùng backup bảng.',
  'panel.unsaved': 'Còn phiên "{name}" với {n} thay đổi chưa rollback.',
  'panel.engine': 'Engine: {engine}',
  'panel.collapse': 'Thu gọn',
  'panel.expand': 'Mở rộng',
  'panel.dismiss': 'Đóng',

  'rollback.title': 'Xem trước SQL hoàn tác',
  'rollback.nothing': 'Không có gì để hoàn tác.',
  'rollback.confirm': 'Chạy {n} câu lệnh',
  'rollback.copy': 'Copy',
  'rollback.cancel': 'Huỷ',
  'rollback.running': 'Đang chạy {i}/{n}…',
  'rollback.done': 'Xong: {ok} thành công, {fail} lỗi.',
  'rollback.driftTitle': 'Dữ liệu đã bị đổi sau khi bạn sửa',
  'rollback.driftRow': '{table} {where}: cột {col} đang là "{actual}", mong đợi "{expected}"',
  'rollback.driftMissing': '{table} {where}: dòng không còn tồn tại',
  'rollback.driftSkip': 'Huỷ = bỏ qua các dòng đã lệch, phần còn lại vẫn hoàn tác',
  'rollback.driftForce': 'Ghi đè hết',
  'rollback.blocked': '{n} thay đổi không tự hoàn tác được và đã bị bỏ qua.',
  'rollback.copied': 'Đã copy vào clipboard.',

  'reason.no-key': 'bảng không có khoá để định danh dòng',
  'reason.no-before': 'không đọc được giá trị cũ',
  'reason.nothing-to-restore': 'không có cột nào để khôi phục',
  'reason.no-rows': 'không có dòng nào được ghi lại',
  'reason.no-table': 'không xác định được bảng',
  'reason.unsupported-op': 'loại thao tác không hỗ trợ',
  'reason.unreadable-columns': 'có cột không đọc được (BLOB/file)',
  'reason.multi-table': 'câu lệnh ghi nhiều bảng',
  'reason.no-where': 'câu lệnh không có WHERE',
  'reason.insert-not-captured': 'INSERT không ghi lại được khoá mới',
  'reason.parse-error': 'không phân tích được câu lệnh',
  'reason.not-a-write': 'không phải câu lệnh ghi',

  'op.update': 'UPDATE',
  'op.delete': 'DELETE',
  'op.insert': 'INSERT',

  'mgr.title': 'Phiên test & Rollback',
  'mgr.sessions': 'Các phiên',
  'mgr.empty': 'Chưa có phiên test nào.',
  'mgr.open': 'Đang mở',
  'mgr.closed': 'Đã đóng',
  'mgr.changes': 'Thay đổi',
  'mgr.selectAll': 'Chọn tất cả',
  'mgr.rollbackSelected': '↺ Rollback mục đã chọn',
  'mgr.exportSql': 'Xuất .sql',
  'mgr.exportJson': 'Xuất .json',
  'mgr.delete': 'Xoá phiên',
  'mgr.reopen': 'Mở lại',
  'mgr.close': 'Đóng phiên',
  'mgr.rename': 'Đổi tên',
  'mgr.undone': 'đã hoàn tác',
  'mgr.column': 'Cột',
  'mgr.before': 'Trước',
  'mgr.after': 'Sau',
  'mgr.row': 'Dòng',
  'mgr.noPreview': 'Chọn một phiên bên trái.',
  'mgr.settings': 'Cài đặt',
  'mgr.autoExecute': 'Cho phép extension tự chạy SQL hoàn tác',
  'mgr.driftCheck': 'Đọc lại dòng trước khi hoàn tác',
  'mgr.captureSqlPage': 'Chụp dữ liệu trước câu lệnh gõ tay ở trang SQL',
  'mgr.prefetchLimit': 'Giới hạn số dòng chụp cho một câu lệnh',
  'mgr.engineOverride': 'Ép engine (để trống = tự nhận)',
  'mgr.enabled': 'Bật tích hợp Adminer',
  'mgr.warnings': 'Cảnh báo',
  'mgr.unverified': 'chưa xác nhận',
  'mgr.needTab': 'Cần mở sẵn một tab Adminer ở {origin} để chạy SQL hoàn tác.',
  'mgr.autoExecuteOff': 'Tự chạy SQL đang tắt — dùng "Xuất .sql" rồi chạy tay trong Adminer.',
};

const EN = {
  'panel.title': 'DB test session',
  'panel.noSession': 'No session running',
  'panel.start': '▶ Start session',
  'panel.stop': '■ End',
  'panel.view': 'View',
  'panel.exportSql': 'Export SQL',
  'panel.rollbackAll': '↺ Roll back all',
  'panel.changes': '{n} changes',
  'panel.tables': '{n} tables',
  'panel.promptName': 'Session name:',
  'panel.defaultName': 'Test session',
  'panel.recorded': 'Recorded: {op} {table} ({n} rows)',
  'panel.notUndoable': 'Cannot be undone automatically: {reason}',
  'panel.capturing': 'Snapshotting rows before the statement runs…',
  'panel.captureFailed': 'Could not snapshot the old rows: {reason}',
  'panel.tooManyRows': 'The statement touches more than {n} rows — not snapshotted. Use a backup table.',
  'panel.unsaved': 'Session "{name}" still has {n} changes not rolled back.',
  'panel.engine': 'Engine: {engine}',
  'panel.collapse': 'Collapse',
  'panel.expand': 'Expand',
  'panel.dismiss': 'Close',

  'rollback.title': 'Undo SQL preview',
  'rollback.nothing': 'Nothing to roll back.',
  'rollback.confirm': 'Run {n} statements',
  'rollback.copy': 'Copy',
  'rollback.cancel': 'Cancel',
  'rollback.running': 'Running {i}/{n}…',
  'rollback.done': 'Done: {ok} succeeded, {fail} failed.',
  'rollback.driftTitle': 'The data changed after you edited it',
  'rollback.driftRow': '{table} {where}: column {col} is now "{actual}", expected "{expected}"',
  'rollback.driftMissing': '{table} {where}: the row no longer exists',
  'rollback.driftSkip': 'Cancel = skip the drifted rows; the rest is still rolled back',
  'rollback.driftForce': 'Overwrite anyway',
  'rollback.blocked': '{n} changes cannot be undone automatically and were skipped.',
  'rollback.copied': 'Copied to clipboard.',

  'reason.no-key': 'the table has no key to identify a row',
  'reason.no-before': 'the old values could not be read',
  'reason.nothing-to-restore': 'no column to restore',
  'reason.no-rows': 'no rows were recorded',
  'reason.no-table': 'the table could not be determined',
  'reason.unsupported-op': 'unsupported operation',
  'reason.unreadable-columns': 'some columns could not be read (BLOB/file)',
  'reason.multi-table': 'the statement writes more than one table',
  'reason.no-where': 'the statement has no WHERE',
  'reason.insert-not-captured': 'an INSERT does not record its new key',
  'reason.parse-error': 'the statement could not be parsed',
  'reason.not-a-write': 'not a writing statement',

  'op.update': 'UPDATE',
  'op.delete': 'DELETE',
  'op.insert': 'INSERT',

  'mgr.title': 'Test sessions & rollback',
  'mgr.sessions': 'Sessions',
  'mgr.empty': 'No test session yet.',
  'mgr.open': 'Open',
  'mgr.closed': 'Closed',
  'mgr.changes': 'Changes',
  'mgr.selectAll': 'Select all',
  'mgr.rollbackSelected': '↺ Roll back selected',
  'mgr.exportSql': 'Export .sql',
  'mgr.exportJson': 'Export .json',
  'mgr.delete': 'Delete session',
  'mgr.reopen': 'Reopen',
  'mgr.close': 'Close session',
  'mgr.rename': 'Rename',
  'mgr.undone': 'undone',
  'mgr.column': 'Column',
  'mgr.before': 'Before',
  'mgr.after': 'After',
  'mgr.row': 'Row',
  'mgr.noPreview': 'Pick a session on the left.',
  'mgr.settings': 'Settings',
  'mgr.autoExecute': 'Let the extension run undo SQL itself',
  'mgr.driftCheck': 'Read the row back before undoing it',
  'mgr.captureSqlPage': 'Snapshot rows before hand-written statements on the SQL page',
  'mgr.prefetchLimit': 'Row cap for one statement snapshot',
  'mgr.engineOverride': 'Force engine (empty = detect)',
  'mgr.enabled': 'Enable the Adminer integration',
  'mgr.warnings': 'Warnings',
  'mgr.unverified': 'unverified',
  'mgr.needTab': 'An Adminer tab on {origin} has to be open to run the undo SQL.',
  'mgr.autoExecuteOff': 'Running SQL automatically is off — use "Export .sql" and run it in Adminer.',
};

export const CATALOGS = { vi: VI, en: EN };

let lang = 'vi';
const missing = new Set();

export function setLang(next) {
  if (CATALOGS[next]) lang = next;
  return lang;
}

export function getLang() {
  return lang;
}

/** `t('panel.changes', { n: 3 })` → "3 thay đổi". */
export function t(key, vars) {
  const text = CATALOGS[lang][key] ?? CATALOGS.vi[key];
  if (text === undefined) {
    missing.add(`${lang}:${key}`);
    return key;
  }
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (all, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : all);
}

export function missingKeys() {
  return [...missing];
}

export function clearMissingKeys() {
  missing.clear();
}
