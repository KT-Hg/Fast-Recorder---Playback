# Adminer Test Session & Rollback — Thiết kế

Tài liệu thiết kế cho nhóm chức năng hỗ trợ người dùng khi thao tác dữ liệu qua **Adminer**, tập trung
vào bài toán: *sửa dữ liệu bảng master để test, xong rollback nhanh về nguyên trạng.*

Trạng thái: **bản thiết kế, chưa hiện thực.** Chưa có dòng code nào trong tài liệu này được viết vào extension.

---

## 1. Bối cảnh & mục tiêu

Tình huống thực tế của người dùng:

- Test giá trị trong **bảng master** (generic, cấu hình, danh mục…).
- Một lượt test có thể sửa **nhiều dòng, nhiều bảng**.
- Sau khi test xong cần **trả dữ liệu về đúng như trước**, càng nhanh càng tốt, không phải nhớ thủ công.

Mục tiêu của chức năng:

1. Ghi lại giá trị **trước khi sửa** một cách tự động, không bắt người dùng thao tác thêm.
2. Gom các thay đổi của một lượt test thành **một phiên (test session)** hoàn tác được trọn gói.
3. Cho phép hoàn tác **từng thay đổi** hoặc **toàn bộ phiên**, có xem trước SQL.
4. Không bao giờ tự ý ghi vào DB mà không cho người dùng xác nhận.

Ngoài phạm vi (giai đoạn này): rollback DDL (`ALTER`, `DROP`), rollback theo thời điểm ở mức engine
(binlog / PITR), và các hệ quản trị khác ngoài Adminer.

---

## 2. Các màn hình Adminer liên quan

### 2.1 Trang sửa một dòng (`?edit=`)

Vào từ link **edit** ở đầu mỗi dòng trong *Select data*.

- URL: `?server=<host>&username=<user>&db=<db>&edit=<table>&where%5Bid%5D=5`
  Phần `where[<cột>]=<giá trị>` là **định danh dòng do chính Adminer sinh ra** theo PK/unique key —
  dùng lại được nguyên vẹn cho mệnh đề `WHERE` của câu hoàn tác.
- Form POST về chính URL đó. Mỗi cột một dòng: `<th>` là tên cột, `<td>` chứa
  `<input name="fields[<cột>]">` (hoặc `<textarea>`), kèm `<select name="function[<cột>]">` với các lựa chọn
  rỗng / `NULL` / `now` / `md5` / `+` / `-` …
- Nút: **Save**, **Save and continue edit**, **Delete** (một số bản có thêm nhân bản / insert tiếp).

> **Điểm mấu chốt của toàn bộ thiết kế:** khi trang edit vừa load, **giá trị cũ đã nằm sẵn trong các input**.
> Không cần query thêm gì để biết "before" — chỉ cần đọc DOM lúc load, đọc lại lúc submit.

### 2.2 Sửa trực tiếp trong lưới kết quả

Bản Adminer 4.x cho click/double-click vào ô trong *Select data* để sửa tại chỗ. Cũng là một POST tương tự,
before-value đọc được từ nội dung ô trước khi biến thành input.

### 2.3 Thao tác hàng loạt trong *Select data*

Tick nhiều dòng rồi dùng nút ở cuối bảng (sửa / xoá / export). Ở đây **DOM không chứa đủ giá trị cũ**
(lưới có thể đang ẩn cột hoặc cắt bớt nội dung) → phải **prefetch snapshot** trước khi cho thao tác chạy.

### 2.4 Trang SQL command (`?sql=`)

Người dùng gõ `UPDATE` / `DELETE` tay. Không có before-value nào trong DOM → phải tự chạy một câu
`SELECT *` với đúng mệnh đề `WHERE` trước, lưu kết quả, rồi mới cho chạy câu gốc.

> Mọi chi tiết DOM ở trên **phải được verify lại** trên đúng phiên bản Adminer người dùng chạy;
> adapter phải tự kiểm tra và **tắt êm** nếu không khớp, tuyệt đối không làm vỡ trang.

---

## 3. Vì sao không dùng transaction

Mỗi request của Adminer là một kết nối riêng ở chế độ autocommit. `BEGIN` gõ ở trang SQL **không sống qua
lần load trang kế tiếp**, nên không thể bọc cả một lượt test trong transaction.
(Trong *một* lần submit thì `BEGIN; …; ROLLBACK;` vẫn chạy được, nhưng đó không phải bài toán ở đây.)

=> Rollback phải làm bằng **changeset log phía extension**, không phải bằng transaction của DB.

---

## 4. Kiến trúc: 3 tầng bảo vệ

| Tầng | Cách làm | Bao phủ | Chi phí |
|---|---|---|---|
| **1. Change log** | Đọc before/after từ form edit và inline edit | Chỉ thay đổi thực hiện **qua Adminer** | Rẻ, chính xác tuyệt đối |
| **2. Snapshot bảng** | Trước khi test: `SELECT *` toàn bộ bảng master (thường vài chục–vài trăm dòng), lưu lại; khi rollback thì **diff** snapshot với hiện tại → sinh `UPDATE`/`INSERT`/`DELETE` | Cả thay đổi do **ứng dụng** sinh ra, do người khác, do trigger | Trung bình |
| **3. Bảng backup trong DB** | Sinh sẵn `CREATE TABLE m_generic_bak_20260919 AS SELECT * FROM m_generic;` và câu restore tương ứng | An toàn nhất — sống sót cả khi mất máy hoặc gỡ extension | Cần quyền `CREATE` |

Khuyến nghị mặc định cho bài toán bảng master: **bật tầng 1 + tầng 2**, tầng 3 là một nút bấm tuỳ chọn
trước mỗi phiên test.

---

## 5. Test Session (changeset)

### 5.1 Vòng đời

1. **▶ Bắt đầu phiên** — đặt tên phiên (ví dụ `Test generic MST`). Tuỳ chọn: chụp snapshot các bảng sẽ đụng tới.
2. Người dùng sửa dữ liệu như bình thường. Mọi thay đổi được ghi vào phiên.
3. **■ Kết thúc phiên** hoặc **↺ Rollback tất cả**.

Thanh nổi trong Adminer khi phiên đang chạy:

```
🔴 Phiên: "Test generic MST" · 12 thay đổi · 4 bảng   [Xem] [Xuất SQL] [Rollback tất cả]
```

Phiên chưa đóng mà đóng trình duyệt → lần sau vào lại Adminer hiện nhắc:
*"Còn phiên test 12 thay đổi chưa rollback."*

### 5.2 Ánh xạ thao tác → câu hoàn tác

| Thao tác gốc | Câu rollback | Lấy dữ liệu từ đâu |
|---|---|---|
| `UPDATE` (form edit) | `UPDATE t SET <cột đã đổi = giá trị cũ> WHERE <where[] của Adminer>` | DOM form lúc load |
| `UPDATE` (inline grid) | như trên, chỉ một cột | nội dung ô + link edit của dòng |
| `INSERT` | `DELETE FROM t WHERE <PK vừa sinh>` | đọc lại URL / thông báo sau khi save |
| `DELETE` (từ form edit) | `INSERT INTO t (...) VALUES (...)` | DOM form lúc load |
| `DELETE` (hàng loạt từ lưới) | như trên | **prefetch** trước khi xoá |
| `UPDATE`/`DELETE` gõ tay ở trang SQL | tuỳ loại | **prefetch** `SELECT *` cùng `WHERE` |

Nguyên tắc:

- Rollback **chạy ngược thứ tự thời gian** (LIFO).
- Chỉ ghi lại **những cột thực sự đổi**, không ghi đè cả dòng — tránh đạp lên thay đổi hợp lệ của người khác.
- `undoSql` luôn được **sinh lại tại thời điểm rollback** chứ không tin bản đã lưu (để còn áp dụng drift check);
  bản lưu chỉ dùng cho export.

### 5.3 Các ca biên bắt buộc xử lý

1. **`NULL` vs chuỗi rỗng** — lưu tri-state (`null` / `''` / giá trị), đọc từ `function[col] = NULL`,
   không suy diễn từ input rỗng.
2. **Sửa chính cột PK** — mệnh đề `WHERE` khi rollback phải dùng giá trị **mới**, không phải cũ.
3. **Bảng không có PK** — Adminer dựng `where[]` bằng tất cả các cột; câu rollback có thể trúng nhiều dòng
   → cảnh báo đỏ, bắt xác nhận, thêm `LIMIT 1`.
4. **Drift detection** — trước khi rollback, so giá trị hiện tại với "after" đã ghi. Lệch (ai đó sửa sau bạn)
   → hiện diff, cho chọn *bỏ qua* / *ghi đè*.
5. **Cột tự động** — `now()`, `md5()`, `AUTO_INCREMENT`, `ON UPDATE CURRENT_TIMESTAMP`: không cần after-value,
   nhưng cột timestamp tự động **không khôi phục được** → phải nói rõ trong preview thay vì im lặng.
6. **BLOB / text dài** — không nhét vào `chrome.storage`; đánh dấu "không hoàn tác được", đề xuất dùng tầng 3.
7. **Nhiều tab / nhiều DB cùng lúc** — changeset khoá theo `host + server + db`, không trộn phiên giữa các DB.
8. **Trigger / cascade** — rollback một `DELETE` không phục hồi được các dòng bị cascade xoá theo;
   phát hiện FK có `ON DELETE CASCADE` thì cảnh báo và khuyến nghị tầng 2/3.

### 5.4 Mô hình dữ liệu

```json
{
  "sessionId": "ts_20260919_1",
  "name": "Test generic MST",
  "conn": { "host": "...", "server": "...", "db": "..." },
  "startedAt": "2026-09-19T02:10:00Z",
  "closedAt": null,
  "snapshots": [
    { "table": "m_generic", "takenAt": "...", "rowCount": 128, "rows": "<ref idb>" }
  ],
  "changes": [
    {
      "seq": 7,
      "at": "2026-09-19T02:14:31Z",
      "op": "update",
      "table": "m_generic",
      "where": { "id": "42" },
      "cols": {
        "value": { "before": "A",  "after": "B" },
        "note":  { "before": null, "after": "x" }
      },
      "source": "edit-form",
      "undoSql": "UPDATE `m_generic` SET `value`='A', `note`=NULL WHERE `id`='42'",
      "undone": false,
      "warnings": ["auto-timestamp:updated_at"]
    }
  ]
}
```

Lưu trong `chrome.storage.local` qua `bg/storage.js` (namespace riêng). Snapshot lớn đẩy sang IndexedDB —
repo đã có tiền lệ `bg/idb-screenshots.js` để theo.

---

## 6. Vị trí trong repo

```
dbtools/
  detect.js            # nhận diện Adminer, chọn adapter
  adapters/
    adminer.js         # đọc/ghi DOM theo từng phiên bản, có self-check
  session.js           # vòng đời phiên test, changeset
  undo.js              # sinh SQL hoàn tác + drift check
  snapshot.js          # tầng 2
  sqlquote.js          # quote định danh & literal theo engine (MySQL / PostgreSQL)
  panel.js             # thanh nổi (Shadow DOM)
  selftest.mjs         # regression guard, không framework — theo mẫu sqlcases/
dbtools.html / dbtools.js   # trang quản lý changeset (mở riêng như sqlcases.html)
css/dbtools.css
```

Ràng buộc kỹ thuật cần tôn trọng:

- **Không nhét vào `content.js`** (đã ~112KB). Inject động bằng `chrome.scripting` khi `detect.js` xác nhận
  đúng là Adminer, để trang thường không tốn gì.
- **Shadow DOM** cho mọi UI chèn vào trang — Adminer hay được cài sau CSP chặt và có theme riêng.
- **Không build step**, plain ES module, đúng phong cách repo hiện tại.
- **Mọi thứ chạy local**, không gửi dữ liệu đi đâu — giữ đúng cam kết của SQL Test Case Designer.

---

## 7. Giao diện

- **Thanh nổi** trong Adminer: trạng thái phiên + `[Xem] [Xuất SQL] [Rollback tất cả]`.
- **Trang quản lý changeset**: danh sách thay đổi nhóm theo bảng, diff before/after theo từng cột,
  checkbox chọn rollback một phần, nút *Rollback đã chọn* / *Rollback tất cả*.
- **Preview bắt buộc**: luôn hiện toàn bộ SQL hoàn tác trước khi chạy, kèm nút
  *Copy vào ô SQL của Adminer* cho người muốn tự bấm Execute.
- **Export** changeset ra `.sql` và `.json` để lưu vào hồ sơ test.

---

## 8. Kế hoạch theo giai đoạn

| GĐ | Nội dung | Ghi chú |
|---|---|---|
| **1** | MVP: chỉ trang `?edit=`. Chụp before lúc load → hook submit → ghi changeset → thanh nổi → trang xem → rollback bằng cách **copy SQL vào ô SQL command** (người dùng tự bấm Execute) | Rủi ro thấp nhất, extension chưa tự ghi vào DB |
| **2** | Tự thực thi rollback: POST tuần tự vào trang SQL của Adminer, có drift check, báo cáo từng câu, dừng khi lỗi | |
| **3** | Mở rộng nguồn thay đổi: inline edit, xoá hàng loạt (prefetch), `UPDATE`/`DELETE` gõ tay ở trang SQL | |
| **4** | Tầng 2 (snapshot + restore-diff) và tầng 3 (nút sinh bảng backup) | |
| **5** | Nối với phần có sẵn: bật/tắt phiên test từ popup; chạy kịch bản Record/Playback **trong** phiên test rồi rollback tự động sau khi chạy xong | Khép kín vòng cho QA |

### Kiểm thử

Theo đúng mẫu `sqlcases/selftest.mjs` (Node thuần, không dependency):

- Sinh SQL hoàn tác đúng cho từng kiểu cột và từng ca biên ở §5.3 — đặc biệt `NULL` vs `''`, đổi PK, không PK.
- Quote định danh/literal đúng cho MySQL và PostgreSQL.
- Changeset round-trip: ghi → export JSON → nạp lại → sinh lại đúng câu cũ.
- Drift check: phát hiện đúng khi giá trị hiện tại khác "after".
- Adapter self-check: gặp DOM lạ thì trả về "không hỗ trợ" chứ không throw.

---

## 9. Câu hỏi còn mở

Ba thứ cần chốt trước khi code GĐ 1:

1. **Phiên bản Adminer** đang dùng (4.8.1 / AdminerEvo 5.x / bản có plugin theme?) — quyết định adapter.
2. **Hệ CSDL** (MySQL/MariaDB hay PostgreSQL) — quyết định cách quote và cách đọc `where[]`.
3. Bảng master **có PK rõ ràng** không — quyết định có phải bật đường cảnh báo ở §5.3-3 hay không.

---

## Phụ lục — Backlog hỗ trợ Adminer rộng hơn

Nhóm chức năng đã bàn, ngoài phạm vi rollback; giữ lại ở đây để không thất lạc.

- **An toàn**: chặn `UPDATE`/`DELETE` thiếu `WHERE`; badge môi trường (prod/staging/dev); dry-run đếm số dòng
  sẽ đụng; nhật ký mọi lệnh đã chạy.
- **Soạn thảo**: autocomplete tên bảng/cột từ schema quét được; thư viện snippet dùng `${variable}` sẵn có;
  lịch sử truy vấn bền vững + **so sánh 2 phiên bản câu lệnh ở mức AST** (`sqlcases/diff.js` đã có);
  format SQL bằng `sqlcases/tokenizer.js`; hotkey Ctrl+Enter / Ctrl+/ / Ctrl+S.
- **Nối với SQL Test Case Designer**: nút "Phân tích câu này" trên trang SQL; nạp **schema thật** từ trang
  structure thay cho schema suy đoán; sinh `INSERT` từ fixture rows; chạy "Verify SQL" từng case và ghi
  actual vs expected; sinh câu dọn dữ liệu test.
- **Bảng kết quả**: header dính & ghim cột; xem ô dài / JSON / BLOB; copy dòng thành `INSERT`,
  copy vùng chọn thành CSV/Markdown/JSON; lọc/sắp xếp phía client; phân biệt `NULL` với chuỗi rỗng;
  export XLSX/HTML; diff hai tập kết quả.
- **Điều hướng**: command palette (Ctrl+K); quản lý connection (không lưu mật khẩu mặc định);
  bookmark bảng/query; ghi chú schema bằng module Highlight; gói bằng chứng test (query + ảnh + thời điểm).
