# Adminer Test Session & Rollback — Thiết kế

Tài liệu thiết kế cho nhóm chức năng hỗ trợ người dùng khi thao tác dữ liệu qua **Adminer**, tập trung
vào bài toán: *sửa dữ liệu bảng master để test, xong rollback nhanh về nguyên trạng.*

Trạng thái: **Giai đoạn 1–5 đã hiện thực** (xem §8). Code nằm ở `dbtools/`, trang quản lý là `dbtools.html`.
Kiểm thử: `node dbtools/selftest.mjs` và `dbtools/e2e/` (chạy trên Adminer thật).

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

### 2.5 Ba điều kiểm chứng trên Adminer 4.8.1 thật (khác hẳn phỏng đoán ban đầu)

Bản thiết kế ban đầu sai ở cả ba chỗ dưới đây; đều được phát hiện khi chạy extension trên Adminer thật
(`dbtools/e2e/`), không phải qua đọc code.

| Phỏng đoán ban đầu | Thực tế |
|---|---|
| Có `<meta name="generator" content="Adminer …">` để nhận diện | **Không có.** Phải nhận diện qua khối tiêu đề trong `#menu` (`a#h1[href*=adminer.org]` + `span.version`) |
| Driver nằm ở tham số `driver=` | Driver là **tên** tham số: `?server=host` (MySQL), `?pgsql=host`, `?sqlite=`. Đọc sai thì mọi request rơi về trang login — mà trang login vẫn parse ra "không có dòng nào" |
| Câu lệnh nằm trong `textarea[name=query]` | Textarea bị **ẩn** và chứa câu lệnh của **lần chạy trước**; câu đang gõ nằm trong `<pre contenteditable>` bên cạnh. Adminer chỉ copy sang textarea trong `onsubmit` của chính nó, nên khi giữ submit rồi bắn lại thì phải tự ghi vào textarea |

Ngoài ra: `<option>NULL` trong `select[name="function[<cột>]"]` không có thuộc tính `value`, nên `select.value`
vẫn ra đúng `'NULL'`; nút Save **không có `name`**, nút xoá là `input[name=delete]`.

Những điều đọc từ mã nguồn Adminer 4.8.1 và 5.x khi làm GĐ 3–5 (đã kiểm trên bản giả lập chạy JS thật của Adminer,
chưa chạy lại trên Adminer thật):

| Chỗ | Thực tế |
|---|---|
| **Save and continue editing** | Gửi bằng **AJAX** (`ajaxForm`) và huỷ submit — không có sự kiện `submit`. Kết quả được ghi vào `#ajaxstatus`: lần đầu là dòng "Saving…", lần sau là thông báo của server |
| Cột khoá `NULL` trong URL | Là **danh sách tên cột** `null[]=col`, không phải `null[col]=` |
| Khoá text dài hơn 64 ký tự | Lưới gửi **hash**: `where[MD5(`col`)]=…` (4.x) hoặc `fun[0]=md5&col[0]=col&val[0]=…` (5.x). Dùng nguyên chuỗi để đọc dòng, lấy giá trị thật từ form để viết câu hoàn tác |
| Định danh dòng trong lưới | Giá trị của `check[]`; 4.x URL-encode (`where%5Bid%5D=2`), 5.x để nguyên ngoặc. Tên ô sửa `val[…][col]` escape khác nhau giữa hai bản, nên dòng được lấy từ `check[]` cùng hàng |
| **Whole result** | Áp dụng cho **mọi dòng khớp bộ lọc**, không chỉ trang đang xem |
| Kết quả trang SQL | **Không rút gọn** chữ dài (khác lưới `?select=`); NULL là `<i>NULL</i>`, nhị phân là `<i>N byte(s)</i>`; bảng rỗng in "No rows." không có tiêu đề cột |
| INSERT qua form | Thông báo *"Item 42 has been inserted."* mang khoá tự tăng |

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
| **1** | ✅ **Xong.** Trang `?edit=`: chụp before lúc load, hook submit, ghi changeset, thanh nổi, trang xem, xuất SQL | Bắt cả nút Delete → hoàn tác bằng `INSERT` |
| **2** | ✅ **Xong.** Tự thực thi rollback: POST tuần tự vào trang SQL của Adminer, drift check từng dòng, dừng ở câu lỗi đầu tiên | Luôn có preview trước khi chạy |
| **3** | ✅ **Xong.** `UPDATE`/`DELETE`/`INSERT` gõ tay ở trang SQL; sửa inline trong lưới (Ctrl+click và `Modify`); xoá hàng loạt (kể cả *Whole result*); Edit và Clone hàng loạt; *Save and continue editing* (AJAX) | Mọi dòng được đọc qua form edit trước khi ghi và đọc lại sau khi ghi |
| **3b** | ✅ **Xong.** `INSERT` hoàn tác được: khoá lấy từ giá trị gõ vào form, từ thông báo *"Item N has been inserted"*, từ literal trong câu lệnh, hoặc so tập khoá trước/sau | Cách so tập khoá có thể tính cả dòng người khác chèn cùng lúc — change được đánh dấu `insert-found-by-difference` |
| **4** | ✅ **Xong** — ⏸ **tạm ẩn** (`TABLE_COPIES = false` trong `dbtools/features.js`). Tầng 2: `dbtools/snapshot.js` — chụp cả bảng, rollback bằng diff (DELETE → UPDATE → INSERT). Tầng 3: nút tạo bảng backup, khôi phục bằng diff hoặc chép lại toàn bộ khi bảng quá lớn, xoá bảng backup | Dữ liệu snapshot lưu trong IndexedDB của extension (`dbtools/snapstore.js`), không chiếm quota 10 MB của `chrome.storage.local` — không cần quyền `unlimitedStorage` |
| **5** | ✅ **Xong** — ⏸ **tạm ẩn** cùng GĐ 4 (guard dựa trên snapshot). `bg/dbguard.js`: mỗi lần Playback (kịch bản, chuỗi, CSV) mở phiên + chụp các bảng đã chọn trước khi chạy, tự rollback khi chạy xong. Không có tab Adminer của database đó thì **từ chối chạy** | Bật ở thẻ DB Test Session trong popup; chọn database/bảng trong Settings của trang quản lý |

### Kiểm thử (đã có)

```bash
node dbtools/selftest.mjs     # 290 check, Node thuần, không dependency
bash dbtools/e2e/setup.sh     # Adminer 4.8.1 thật trên SQLite
node dbtools/e2e/run.mjs      # extension thật, trình duyệt thật, DB thật
```

`selftest.mjs` phủ phần số học: sinh SQL hoàn tác cho từng ca biên ở §5.3 (`NULL` vs `''`, đổi PK, bảng không
khoá, capture không có "after"), quote đúng theo từng engine, bóc mệnh đề `WHERE` nguyên văn kể cả có subquery,
và hai catalog dịch không thiếu key.

`e2e/run.mjs` phủ phần *không* kiểm chứng được bằng unit test — tức là mọi giả định về HTML của Adminer: sửa dòng,
xoá dòng, `UPDATE` hàng loạt gõ tay, rollback khôi phục đúng từng giá trị (kể cả `NULL` và chuỗi rỗng), drift do
người khác sửa, và trang quản lý.

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
