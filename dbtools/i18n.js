/**
 * i18n.js — panel and manager text, English by default.
 *
 * English, like the rest of the extension's interface; Vietnamese is one switch
 * away on the manager page (🌐), and a language someone picks is remembered.
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
  'panel.startTitle': 'Bắt đầu phiên test',
  'panel.defaultName': 'Phiên test',
  'panel.recorded': 'Đã ghi: {op} {table} ({n} dòng)',
  'panel.notUndoable': 'Không tự hoàn tác được: {reason}',
  'panel.capturing': 'Đang chụp dữ liệu trước khi chạy…',
  'panel.captureFailed': 'Không chụp được dữ liệu cũ: {reason}',
  'panel.saveFailed': 'Adminer báo lỗi nên thay đổi không được ghi: {reason}',
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
  'rollback.againTitle': 'Chạy lại SQL hoàn tác',
  'rollback.againNote': 'Phiên này đã rollback rồi — chạy lại sẽ ghi lại đúng các giá trị cũ đó một lần nữa.',
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
  'mgr.sessionName': 'Tên phiên:',
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
  'mgr.wrongConn': 'Tab Adminer đang mở ở {origin} không trỏ tới đúng database của phiên này.',
  'mgr.integrationOff': 'Tích hợp Adminer đang tắt — bật lại ở popup (thẻ DB Test Session) hoặc trong Settings.',
  'mgr.storageUsed': 'Dung lượng đã dùng: {mb} MB',

  'reason.insert-key-unknown': 'INSERT không xác định được khoá của dòng mới',
  'reason.too-many-rows': 'thao tác đụng quá nhiều dòng — không chụp',
  'reason.import-not-captured': 'nhập CSV không được ghi lại',
  'reason.clone': 'nhân bản dòng',

  'panel.snapshot': '📸 Snapshot',
  'panel.backup': '🗄 Backup',
  'panel.snapshots': '{n} snapshot',
  'panel.promptTables': 'Chụp toàn bộ các bảng (cách nhau bằng dấu phẩy):',
  'panel.promptBackup': 'Tạo bảng backup cho bảng:',
  'panel.snapTaken': 'Đã chụp {table}: {n} dòng',
  'panel.snapFailed': 'Không chụp được {table}: {reason}',
  'panel.backupDone': 'Đã tạo bảng backup {name}',
  'panel.backupFailed': 'Không tạo được bảng backup: {reason}',
  'panel.guardStarted': 'Playback "{name}" đang chạy trong phiên này',
  'panel.guardSetAside': 'Tạm đóng phiên "{name}" để Playback chạy trong phiên riêng — sẽ mở lại khi chạy xong.',
  'panel.actionFailed': 'Không thực hiện được: {reason}',
  'panel.storageFull': 'Bộ nhớ của extension đã đầy — xoá bớt phiên cũ ở trang Test sessions & rollback rồi thử lại.',

  'snap.title': 'Khôi phục bảng về snapshot',
  'snap.nothing': 'Các bảng đã chụp không có gì thay đổi.',
  'snap.confirm': 'Chạy {n} câu lệnh',
  'snap.done': 'Đã khôi phục {n} bảng về snapshot.',
  'snap.failed': 'Khôi phục {table} lỗi: {reason}',
  'snap.skippedCols': '{table}: bỏ qua cột {cols} (không so sánh được)',
  'snap.note': 'Bảng được đưa về đúng như lúc chụp — kể cả thay đổi của người khác sau thời điểm đó.',
  'snap.reason.no-key': 'bảng không có khoá',
  'snap.reason.too-large': 'bảng lớn hơn giới hạn snapshot — hãy dùng bảng backup',
  'snap.reason.duplicate-key': 'khoá bị trùng, không so khớp được dòng',
  'snap.reason.key-not-compared': 'cột khoá không đọc được',
  'snap.reason.snapshot-missing': 'dữ liệu snapshot không còn',
  'snap.reason.read-failed': 'không đọc được bảng',

  'backup.createTitle': 'Tạo bảng backup trong database',
  'backup.createNote': 'Bảng backup nằm trong database, còn nguyên kể cả khi gỡ extension. Cần quyền CREATE.',
  'backup.create': 'Tạo',
  'backup.restoreTitle': 'Khôi phục {table} từ {backup}',
  'backup.wholesale': 'Bảng lớn hơn giới hạn so sánh: sẽ xoá hết rồi chép lại toàn bộ từ bảng backup (chạy trigger/cascade xoá).',
  'backup.dropTitle': 'Xoá bảng backup {backup}',
  'backup.restored': 'Đã khôi phục {table} từ {backup}.',
  'backup.dropped': 'Đã xoá bảng backup {backup}.',

  'guard.noTab': 'Chưa mở tab Adminer của {label} — playback không chạy để tránh sửa DB mà không rollback được.',
  'guard.failed': 'Không mở được phiên bảo vệ DB: {reason}',
  'guard.rolledBack': 'Đã rollback DB sau playback: {ok} thay đổi, {snaps} bảng khôi phục, {fail} lỗi.',
  'guard.kept': 'Playback xong — phiên "{name}" được giữ lại để bạn tự rollback.',

  'mgr.snapshots': 'Snapshot bảng',
  'mgr.backups': 'Bảng backup',
  'mgr.restore': 'Khôi phục',
  'mgr.remove': 'Xoá',
  'mgr.drop': 'Xoá bảng backup',
  'mgr.copySql': 'Copy SQL',
  'mgr.restored': 'đã khôi phục',
  'mgr.dropped': 'đã xoá',
  'mgr.rows': '{n} dòng',
  'mgr.snapshotLimit': 'Số dòng tối đa của một snapshot bảng',
  'mgr.keyScanLimit': 'Số dòng tối đa khi dò khoá của dòng mới INSERT',
  'mgr.guard': 'Bảo vệ DB khi chạy Playback',
  'mgr.guardEnabled': 'Bọc mỗi lần Playback trong một phiên test',
  'mgr.guardConn': 'Database (Adminer)',
  'mgr.guardConnNone': '— mở Adminer ít nhất một lần để chọn —',
  'mgr.guardTables': 'Chụp snapshot các bảng (cách nhau bằng dấu phẩy)',
  'mgr.guardAuto': 'Tự rollback khi Playback kết thúc',
};

const EN = {
  'panel.title': 'DB test session',
  'panel.noSession': 'No session running',
  'panel.start': '▶ Start session',
  'panel.stop': '■ End',
  'panel.view': 'View',
  'panel.exportSql': 'Export SQL',
  'panel.rollbackAll': '↺ Roll back all',
  'panel.changes': '{n} change(s)',
  'panel.tables': '{n} table(s)',
  'panel.promptName': 'Session name:',
  'panel.startTitle': 'Start a test session',
  'panel.defaultName': 'Test session',
  'panel.recorded': 'Recorded: {op} {table} ({n} rows)',
  'panel.notUndoable': 'Cannot be undone automatically: {reason}',
  'panel.capturing': 'Snapshotting rows before the statement runs…',
  'panel.captureFailed': 'Could not snapshot the old rows: {reason}',
  'panel.saveFailed': 'Adminer reported an error, so the change was not recorded: {reason}',
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
  'rollback.againTitle': 'Run the undo again',
  'rollback.againNote': 'This session was rolled back already — running it again writes those same old values back once more.',
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
  'mgr.sessionName': 'Session name:',
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
  'mgr.wrongConn': 'The Adminer tab open on {origin} is not pointed at this session\'s database.',
  'mgr.integrationOff': 'The Adminer integration is switched off — turn it back on in the popup (DB Test Session card) or in Settings.',
  'mgr.storageUsed': 'Storage in use: {mb} MB',

  'reason.insert-key-unknown': 'the INSERT\'s new key could not be determined',
  'reason.too-many-rows': 'touches too many rows — not snapshotted',
  'reason.import-not-captured': 'CSV import is not recorded',
  'reason.clone': 'row clone',

  'panel.snapshot': '📸 Snapshot',
  'panel.backup': '🗄 Backup',
  'panel.snapshots': '{n} snapshot(s)',
  'panel.promptTables': 'Snapshot these whole tables (comma-separated):',
  'panel.promptBackup': 'Create a backup table of:',
  'panel.snapTaken': 'Snapshot of {table}: {n} rows',
  'panel.snapFailed': 'Could not snapshot {table}: {reason}',
  'panel.backupDone': 'Backup table {name} created',
  'panel.backupFailed': 'Could not create the backup table: {reason}',
  'panel.guardStarted': 'Playback "{name}" is running in this session',
  'panel.guardSetAside': 'Session "{name}" is set aside so Playback runs in its own — it is reopened when the run ends.',
  'panel.actionFailed': 'That did not go through: {reason}',
  'panel.storageFull': 'The extension\'s storage is full — delete old sessions on the Test sessions & rollback page and try again.',

  'snap.title': 'Restore tables to their snapshot',
  'snap.nothing': 'Nothing changed in the snapshotted tables.',
  'snap.confirm': 'Run {n} statements',
  'snap.done': 'Restored {n} table(s) to their snapshot.',
  'snap.failed': 'Restoring {table} failed: {reason}',
  'snap.skippedCols': '{table}: columns {cols} skipped (cannot be compared)',
  'snap.note': 'The table is put back exactly as it was when snapshotted — including changes others made since.',
  'snap.reason.no-key': 'the table has no key',
  'snap.reason.too-large': 'the table is over the snapshot limit — use a backup table',
  'snap.reason.duplicate-key': 'duplicate keys, rows cannot be matched',
  'snap.reason.key-not-compared': 'a key column cannot be read',
  'snap.reason.snapshot-missing': 'the snapshot data is gone',
  'snap.reason.read-failed': 'the table could not be read',

  'backup.createTitle': 'Create a backup table in the database',
  'backup.createNote': 'The backup lives in the database and survives removing the extension. Needs CREATE privilege.',
  'backup.create': 'Create',
  'backup.restoreTitle': 'Restore {table} from {backup}',
  'backup.wholesale': 'Too large to compare here: the table is emptied and the whole backup copied back (DELETE triggers and cascades fire).',
  'backup.dropTitle': 'Drop backup table {backup}',
  'backup.restored': 'Restored {table} from {backup}.',
  'backup.dropped': 'Dropped backup table {backup}.',

  'guard.noTab': 'No Adminer tab is open for {label} — playback was not started, so the database is not changed without a way back.',
  'guard.failed': 'Could not open the protecting DB session: {reason}',
  'guard.rolledBack': 'Database rolled back after playback: {ok} change(s), {snaps} table(s) restored, {fail} error(s).',
  'guard.kept': 'Playback finished — session "{name}" was kept for you to roll back.',

  'mgr.snapshots': 'Table snapshots',
  'mgr.backups': 'Backup tables',
  'mgr.restore': 'Restore',
  'mgr.remove': 'Remove',
  'mgr.drop': 'Drop backup table',
  'mgr.copySql': 'Copy SQL',
  'mgr.restored': 'restored',
  'mgr.dropped': 'dropped',
  'mgr.rows': '{n} rows',
  'mgr.snapshotLimit': 'Largest table a snapshot copies (rows)',
  'mgr.keyScanLimit': 'Largest table scanned to find an INSERT\'s new keys (rows)',
  'mgr.guard': 'Protect the database during Playback',
  'mgr.guardEnabled': 'Wrap every Playback run in a test session',
  'mgr.guardConn': 'Database (Adminer)',
  'mgr.guardConnNone': '— open Adminer at least once to choose —',
  'mgr.guardTables': 'Snapshot these tables (comma-separated)',
  'mgr.guardAuto': 'Roll back automatically when Playback ends',
};

export const CATALOGS = { vi: VI, en: EN };

let lang = 'en';
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
  const text = CATALOGS[lang][key] ?? CATALOGS.en[key];
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
