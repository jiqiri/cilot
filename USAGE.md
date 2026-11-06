# Hướng dẫn sử dụng và cách ly tài khoản

Tài liệu này mô tả cách bot phân chia quyền giữa **admin** và **user thường**, chỗ lưu dữ
liệu, ý nghĩa của `/access` và `/share`, và những giới hạn còn lại.

Mọi ví dụ dùng Telegram id giả (`111111111`, `222222222`). Không dán token, key hay id thật
vào tài liệu, log hay commit.

## 1. Mô hình tin cậy

- **Admin đầu tiên** (id đầu tiên trong `TELEGRAM_ADMIN_USER_IDS`) là người vận hành máy.
  Admin **luôn có toàn quyền**, không lệnh nào trong bot nhốt được admin.
- **Admin thứ hai trở đi** vẫn là admin (dừng/mở server, xem tiến trình, dùng agent đầy đủ),
  nhưng **không** dùng được `/vault`, `/access`, `/share`.
- **User thường** chỉ được dùng bot trong workspace của chính mình. Không shell, không đọc
  file ngoài workspace, không thấy session/project/ảnh của người khác.

Bot chạy cùng một Linux user với OpenCode server. Vì vậy ranh giới thật sự của user thường
là **tầng agent + tầng đường dẫn**, không phải tầng tiến trình. User thường không được cấp
`bash`, nên không thể tự đọc `env`, file key hay thư mục khác.

## 2. Workspace trên đĩa

Mặc định (`OPENCODE_TELEGRAM_USER_ROOT` không đặt):

```text
~/.local/share/opencode-telegram-server/
├── users/
│   ├── 111111111/projects     # workspace riêng của user 111111111
│   └── 222222222/projects     # workspace riêng của user 222222222
├── shared/
│   └── team/                  # chỉ tồn tại khi admin tạo bằng /share
└── opencode-generated-images/ # ảnh sinh ra, có ghi chủ sở hữu
```

Nếu đặt `OPENCODE_TELEGRAM_USER_ROOT=/srv/tg/users` thì workspace là
`/srv/tg/users/<telegram id>/projects`, còn shared folder là `/srv/tg/shared/<tên>`.

Mỗi tài khoản có một project cá nhân tổng hợp:

```text
id:       personal:<telegram id>
worktree: <OPENCODE_TELEGRAM_USER_ROOT>/<telegram id>/projects
```

Project này được tạo khi cần và hiện trong `/projects`, nên user thường dùng được `/new`
ngay cả khi OpenCode chưa từng thấy thư mục đó.

## 3. Bảng quyền

| Khả năng | Admin đầu tiên | Admin khác | User thường |
| --- | --- | --- | --- |
| Dùng bot, tạo session | có | có | có, trong workspace riêng |
| Chọn agent đầy đủ (`build`, ...) | có | có | không |
| `social-media`, `postiz-social` | có | có | có |
| Dừng/mở OpenCode server (`/stop`, `/start`) | có | có | không |
| `/vault` | có | không | không |
| `/access` | có | không | không |
| `/share` | có | không | không |
| Xem project/session của người khác | có | có | không |
| Đọc file ngoài workspace | có | có | không |

`OPENCODE_TELEGRAM_CONFINE_ADMINS=true` là lựa chọn riêng của người vận hành: nó thu admin
về workspace của chính admin ở tầng bot. Mặc định là `false` và **không** liên quan tới
`/access`.

## 4. `/access` — bật/tắt quyền của user thường

Chỉ admin đầu tiên dùng được. Lệnh này **không** đụng tới admin và **không** restart server.

| Lệnh | Kết quả |
| --- | --- |
| `/access status` | Admin: FULL, luôn luôn. User thường: ON/OFF. Số tài khoản. Đường dẫn workspace |
| `/access on` | User thường được dùng bot trở lại, mỗi người trong workspace của mình |
| `/access off` | Chặn toàn bộ user thường ngay tại auth middleware. Admin không đổi |

Điểm quan trọng:

- `/access on` **không** cấp thêm quyền. Nó chỉ khôi phục quyền bình thường vốn đã bị giới
  hạn. User thường không bao giờ lên được quyền admin.
- `/access off` không dừng một turn đang chạy dở; nó chặn các lệnh mới. Muốn dừng ngay thì
  dùng `/abort`.
- Trạng thái được lưu ở `user-access.json` cạnh `settings.json`, mode `600`, đọc lúc khởi
  động trước khi polling bắt đầu. Mặc định là **on**.

Ví dụ:

```text
/access status
/access off
/access on
```

## 5. `/share` — thư mục dùng chung

Chỉ admin đầu tiên dùng được. Đây là cách duy nhất để hai tài khoản thấy cùng một thư mục.

| Lệnh | Kết quả |
| --- | --- |
| `/share list` | Liệt kê tên thư mục và các id được phép |
| `/share add <tên> <id[,id]>` | Tạo thư mục (nếu chưa có) và cấp quyền cho các id |
| `/share remove <tên> <id[,id]>` | Bỏ quyền của các id |
| `/share delete <tên>` | Bỏ thư mục khỏi danh sách cấp quyền, **không xoá file** |

Quy tắc tên: chữ thường, số, dấu chấm, gạch ngang, gạch dưới; tối đa 64 ký tự. Tên có `../`
hoặc chữ hoa bị từ chối.

Ví dụ:

```text
/share add team 111111111,222222222
/share list
/share remove team 222222222
```

Sau khi được cấp quyền, user thấy `shared/team` trong `/projects` và tạo session ở đó. File
trong shared folder là dùng chung thật sự; đừng đặt key hay dữ liệu riêng vào đó.

## 6. Cách ly được thực thi ở đâu

| Lớp | Việc nó bảo đảm |
| --- | --- |
| `policyForUser` | Id lạ → deny; user thường → chỉ workspace riêng; admin → đầy đủ. Không đọc prompt, không phụ thuộc model |
| Auth middleware | Chặn trước khi handler chạy; `/access off` áp dụng ngay |
| Chọn agent | User thường bị ép vào `social-media`/`postiz-social`; agent lưu trong settings cũng bị kiểm tra lại |
| Quyền agent | Hai agent chuẩn **deny** `bash`, `task`, `webfetch`, `websearch`, `external_directory` |
| Kiểm tra đường dẫn | So sánh `realpath`, không so prefix chuỗi; `..` và symlink không thoát được root |
| Project/session | Lọc và kiểm tra lại tại điểm dùng; `/project` của OpenCode trả global nên bot tự lọc |
| Ảnh | Ghi chủ sở hữu khi tạo, kiểm tra lại mỗi lần đọc/gửi |
| Upload Postiz | Chỉ trong `POSTIZ_UPLOAD_ALLOWED_ROOTS`; file trong thư mục chung phải do cùng process MCP ghi |
| Redaction | Giảm khả năng secret lọt vào tin nhắn Telegram hoặc log |
| Shared folder | Chỉ id được grant mới thấy; `delete` không xoá dữ liệu |

Kiểm tra nhanh bằng lệnh của bot:

```text
/projects     # chỉ thấy workspace của mình (và shared được cấp)
/settings     # agent đang dùng phải là social-media hoặc postiz-social
```

## 7. Key LLM và secret

- Key thật nằm trong env của OpenCode server và/hoặc file env mode `600`.
- User thường không có `bash` và không có `external_directory`, nên không đọc được `env`,
  `.env`, hay file key.
- `/vault` chỉ dành cho admin đầu tiên: giá trị bị che, tin nhắn chứa giá trị bị xoá, không
  bao giờ gửi vào model.
- Không đưa key vào prompt, ảnh chụp màn hình, commit, tài liệu hay shared folder.

Nếu sau này cấp cho user thường một agent có `bash`, mô hình này không còn đủ. Khi đó phải
tách Linux user/container và/hoặc dựng LLM proxy để agent chỉ thấy token giới hạn.

## 8. Cấu hình liên quan

| Biến | Ý nghĩa |
| --- | --- |
| `TELEGRAM_ADMIN_USER_IDS` | Danh sách id admin, id đầu tiên là admin chính |
| `TELEGRAM_ALLOWED_USER_ID` / `TELEGRAM_ALLOWED_USER_IDS` | Danh sách user thường |
| `OPENCODE_TELEGRAM_USER_ROOT` | Gốc workspace chia theo id; mặc định `~/.local/share/opencode-telegram-server/users` |
| `OPENCODE_TELEGRAM_CONFINE_ADMINS` | `true` để thu admin về workspace riêng ở tầng bot; mặc định `false` |
| `OPENCODE_IMAGE_DIR` | Nơi ghi ảnh sinh ra |

File trạng thái (đều nên ở mode `600`):

| File | Nội dung |
| --- | --- |
| `settings.json` | Cấu hình và session của từng tài khoản |
| `user-access.json` | Công tắc `/access` |
| `shared-folders.json` | Danh sách shared folder và id được cấp |
| `opencode.env` / `.env` | Key và cấu hình nhạy cảm — không commit |

## 9. Kiểm tra và xử lý sự cố

```bash
systemctl --user status opencode-telegram-bot.service
systemctl --user status opencode-telegram-server-v2.service
journalctl --user -u opencode-telegram-bot.service -n 50 --no-pager
```

- **User thường bị chặn dù đã có trong allowlist**: kiểm tra `/access status`. Nếu OFF, dùng
  `/access on`.
- **Admin không thấy project cũ**: kiểm tra `OPENCODE_TELEGRAM_CONFINE_ADMINS`. Nếu `true`,
  đặt lại `false` rồi restart bot. `/access` không gây ra tình trạng này.
- **User không thấy shared folder**: `/share list` xem id đã được grant chưa, và user phải
  chọn lại `/projects`.
- **User thấy agent `build`**: dừng lại, kiểm tra `STANDARD_AGENTS` và file agent; đây là lỗi
  cấu hình nghiêm trọng, không phải hành vi bình thường.

## 10. Giới hạn đã biết

- Bot và OpenCode dùng chung một Linux user. Cách ly là ở tầng ứng dụng/agent, không phải
  tầng kernel.
- Key LLM vẫn nằm trong env của process server. User thường không đọc được vì không có
  shell, nhưng đây không phải cách ly tuyệt đối.
- Admin thứ hai không quản lý được `/vault`, `/access`, `/share` — cố ý.
- `/access off` không hủy turn đang chạy.
