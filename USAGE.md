# Hướng dẫn sử dụng và cách ly tài khoản

Tài liệu này mô tả cách bot phân chia quyền giữa **admin** và **user thường**, chỗ lưu dữ
liệu, ý nghĩa của `/access`, `/user`, `/share`, và những giới hạn còn lại.

Mọi ví dụ dùng Telegram id giả (`111111111`, `222222222`). Không dán token, key hay id thật
vào tài liệu, log hay commit.

## 1. Mô hình tin cậy

- **Admin đầu tiên** (id đầu tiên trong `TELEGRAM_ADMIN_USER_IDS`) là người vận hành máy.
  Khi `/access on`, admin có toàn quyền: shell, đọc cả máy, `/vault`, điều khiển server.
- **Admin thứ hai trở đi** vẫn là admin, nhưng không dùng được `/vault`, `/access`, `/user`,
  `/share`.
- **User thường** chỉ được dùng bot trong workspace của chính mình. Không shell, không đọc
  file ngoài workspace, không thấy session/project/ảnh của người khác.

**Mặc định là trạng thái an toàn (`/access off`)**: mọi người, kể cả admin, bị giới hạn
trong workspace của mình và chỉ dùng các tool đã cấp. Muốn admin đọc được cả máy thì phải
gõ `/access on`. Đây là chủ ý: một lần restart, hoặc một lần gõ nhầm, không làm bot chạm
vào root/server.

Bot chạy cùng một Linux user với OpenCode server. Vì vậy ranh giới thật sự của user thường
là **tầng agent + tầng đường dẫn**, không phải tầng tiến trình. User thường không được cấp
`bash`, nên không thể tự đọc `env`, file key hay thư mục khác.

## 2. Workspace trên đĩa

Mặc định (`OPENCODE_TELEGRAM_USER_ROOT` không đặt):

```text
~/.local/share/tg-workspaces/
├── users/
│   ├── 111111111/projects     # workspace riêng của user 111111111
│   │   └── .../generated      # ảnh sinh ra cho account này
│   └── 222222222/projects     # workspace riêng của user 222222222
└── shared/
    └── team/                  # chỉ tồn tại khi admin tạo bằng /share
```

Ảnh do tool sinh ra mặc định nằm ở `~/.local/share/opencode-generated-images` (hoặc
`OPENCODE_IMAGE_DIR`), có ghi chủ sở hữu theo account.

Tên thư mục mặc định là `tg-workspaces`, không phải `opencode-telegram-server`: chuỗi sau
cũng là tên systemd unit, nên dễ bị đọc nhầm thành service và quá dài. Đây là thư mục dữ
liệu, tách khỏi thư mục cài đặt (nơi có `settings.json`, `.env`).

Nếu đặt `OPENCODE_TELEGRAM_USER_ROOT=/srv/tg/users` thì workspace là
`/srv/tg/users/<telegram id>/projects`, còn shared folder là `/srv/tg/shared/<tên>`.

Mỗi tài khoản có một project cá nhân tổng hợp:

```text
id:       personal:<telegram id>
worktree: <OPENCODE_TELEGRAM_USER_ROOT>/<telegram id>/projects
```

Project này được tạo khi cần và hiện trong `/projects`, nên dùng được `/new` ngay cả khi
OpenCode chưa từng thấy thư mục đó. Khi `/access off`, admin cũng chỉ thấy project này.

## 3. Bảng quyền

| Khả năng | Admin chính, `on` | Admin chính, `off` | Admin khác | User thường |
| --- | --- | --- | --- | --- |
| Dùng bot, tạo session | có | có | có | có, trong workspace riêng |
| Agent đầy đủ (`build`, ...) | có | không | có (`on`) | không |
| `social-media`, `postiz-social` | có | có | có | có |
| Shell, đọc cả filesystem | có | không | có (`on`) | không |
| `/vault`, `/user`, `/share` | có | không | không | không |
| `/access` | có | có | không | không |
| `/stop`, `/start` server | có | không | có (`on`) | không |
| Xem project/session người khác | có | không | có (`on`) | không |
| Shared folder được cấp | có | có | có | có |

`/access off` không chặn user thường. Việc chặn một tài khoản nằm ở `/user`.

`OPENCODE_TELEGRAM_CONFINE_ADMINS=true` là lựa chọn riêng: ngay cả khi `/access on`, admin
chính cũng chỉ ở trong workspace của mình.

## 4. `/access` — mở khoá toàn quyền cho admin

Chỉ admin chính dùng được. Lệnh này **luôn gõ được**, kể cả khi đang off — đó là cửa để mở
lại, không cần vào SSH sửa file.

| Lệnh | Kết quả |
| --- | --- |
| `/access status` | Trạng thái hiện tại, số user thường, đường dẫn workspace |
| `/access on` | Admin chính lên toàn quyền: shell, cả filesystem, `/vault`, server, mọi project |
| `/access off` | Mọi người, kể cả admin, về workspace của mình với tool được cấp |

Điểm quan trọng:

- `/access on` **không** mở quyền cho user thường. Họ vẫn workspace-only như cũ.
- `/access off` không cắt một turn đang chạy; nó áp cho lệnh kế tiếp. Muốn dừng ngay dùng
  `/abort`.
- Trạng thái lưu ở `user-access.json` cạnh `settings.json`, mode `600`, đọc lúc khởi động
  trước khi polling. Mặc định là **off**; file cũ của thiết kế trước (khoá `enabled`) bị bỏ
  qua để không âm thầm giữ trạng thái nguy hiểm.
- Khi hạ về off, bot tự bỏ project/session đang trỏ ra ngoài workspace, kể cả session đang
  ghim, nên nội dung cũ không hiện lại sau restart.

Ví dụ:

```text
/access status
/access on
/access off
```

## 5. `/user` — thêm, chặn, xoá người dùng

Chỉ admin chính dùng được, và chỉ khi `/access on`. Gõ `/user` để mở menu có ba nút:

| Nút | Kết quả |
| --- | --- |
| **Thêm người dùng** | Cho id dùng bot trong workspace của nó; cũng dùng để mở lại một id đã bị chặn |
| **Chặn người dùng** | Từ chối id ngay tại auth middleware, **giữ** workspace, project, cài đặt, ảnh |
| **Xoá người dùng** | Chặn rồi xoá workspace, project, cài đặt, session, ảnh và grant shared folder |

Sau khi bấm nút, gửi Telegram id (chỉ chữ số). Xoá có bước xác nhận riêng và **không thể
hoàn tác**.

Danh sách lưu ở `users.json` trong app home, mode `600`. Record trong file này thắng
allowlist trong `.env` theo cả hai chiều: chặn được một id đã có trong `.env`, và cho phép
một id chưa từng có trong `.env` — không cần restart.

Admin id không chặn/xoá được từ chat; chúng quản lý trong `.env`. Đó là đường phục hồi.

## 6. `/share` — thư mục dùng chung

Chỉ admin chính dùng được (và cần `/access on`). Đây là cách duy nhất để hai tài khoản thấy
cùng một thư mục.

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

## 7. Cách ly được thực thi ở đâu

| Lớp | Việc nó bảo đảm |
| --- | --- |
| `policyForUser` | Id lạ → deny; record bị chặn → deny; user thường → workspace riêng; admin → đầy đủ khi `on` |
| Auth middleware | Chặn trước khi handler chạy; `/user` áp dụng ngay |
| `/access` | Tắt hết quyền chạm máy, kể cả với admin; `/access` tự nó luôn còn |
| Chọn agent | User thường bị ép vào `social-media`/`postiz-social`; agent lưu trong settings cũng bị kiểm tra lại |
| Quyền agent | Hai agent chuẩn **deny** `bash`, `task`, `webfetch`, `websearch`, `external_directory` |
| Kiểm tra đường dẫn | So sánh `realpath`, không so prefix chuỗi; `..` và symlink không thoát được root |
| Project/session | Lọc và kiểm tra lại tại điểm dùng; project cũ bị bỏ khi không còn quyền |
| Ảnh | Ghi chủ sở hữu khi tạo, kiểm tra lại mỗi lần đọc/gửi |
| Upload Postiz | Chỉ trong `POSTIZ_UPLOAD_ALLOWED_ROOTS`; file trong thư mục chung phải do cùng process MCP ghi |
| Redaction | Giảm khả năng secret lọt vào tin nhắn Telegram hoặc log |
| Shared folder | Chỉ id được grant mới thấy; `delete` không xoá dữ liệu |

Kiểm tra nhanh bằng lệnh của bot:

```text
/projects     # chỉ thấy workspace của mình (và shared được cấp)
/settings     # agent đang dùng phải là social-media hoặc postiz-social
/access status
```

## 8. Key LLM và secret

- Key thật nằm trong env của OpenCode server và/hoặc file env mode `600`.
- User thường không có `bash` và không có `external_directory`, nên không đọc được `env`,
  `.env`, hay file key.
- `/vault` chỉ dành cho admin chính và chỉ khi `/access on`: giá trị bị che, tin nhắn chứa
  giá trị bị xoá, không bao giờ gửi vào model.
- Không đưa key vào prompt, ảnh chụp màn hình, commit, tài liệu hay shared folder.

Nếu sau này cấp cho user thường một agent có `bash`, mô hình này không còn đủ. Khi đó phải
tách Linux user/container và/hoặc dựng LLM proxy để agent chỉ thấy token giới hạn.

## 9. Cấu hình và file trạng thái

| Biến | Ý nghĩa |
| --- | --- |
| `TELEGRAM_ADMIN_USER_IDS` | Danh sách id admin, id đầu tiên là admin chính |
| `TELEGRAM_ALLOWED_USER_ID` / `TELEGRAM_ALLOWED_USER_IDS` | Allowlist gốc cho user thường |
| `OPENCODE_TELEGRAM_USER_ROOT` | Gốc workspace chia theo id; mặc định `~/.local/share/tg-workspaces/users` |
| `OPENCODE_TELEGRAM_CONFINE_ADMINS` | `true` để admin chính chỉ ở workspace của mình dù `/access on` |
| `OPENCODE_IMAGE_DIR` | Nơi ghi ảnh sinh ra |

File trạng thái (đều nên ở mode `600`):

| File | Nội dung |
| --- | --- |
| `settings.json` | Cấu hình và session của từng tài khoản |
| `user-access.json` | Công tắc `/access` (`{"elevated": true|false}`) |
| `users.json` | Danh sách id được thêm/chặn từ `/user` |
| `shared-folders.json` | Danh sách shared folder và id được cấp |
| `opencode.env` / `.env` | Key và cấu hình nhạy cảm — không commit |

## 10. Kiểm tra và xử lý sự cố

```bash
systemctl --user status opencode-telegram-bot.service
systemctl --user status opencode-telegram-server-v2.service
journalctl --user -u opencode-telegram-bot.service -n 50 --no-pager
```

- **Admin không thấy project ngoài workspace**: bình thường khi `/access off`. Gõ
  `/access on`, rồi chọn lại project bằng `/projects` nếu lựa chọn cũ đã bị bỏ vì nằm ngoài
  workspace.
- **Không thấy `/vault`, `/user`, `/share`, `/ls` trong menu**: cũng vì `/access off`.
- **User thường bị chặn dù có trong `.env`**: kiểm tra `/user`; một record `blocked` thắng
  `.env`.
- **User không thấy shared folder**: `/share list` xem id đã được grant chưa, và user phải
  chọn lại `/projects`.
- **User thấy agent `build`**: dừng lại, kiểm tra `STANDARD_AGENTS` và file agent; đây là lỗi
  cấu hình nghiêm trọng, không phải hành vi bình thường.

## 11. Giới hạn đã biết

- Bot và OpenCode dùng chung một Linux user. Cách ly là ở tầng ứng dụng/agent, không phải
  tầng kernel.
- Key LLM vẫn nằm trong env của process server. User thường không đọc được vì không có
  shell, nhưng đây không phải cách ly tuyệt đối.
- Admin thứ hai không quản lý được `/vault`, `/access`, `/user`, `/share` — cố ý.
- `/access off` không hủy turn đang chạy.
- Xoá người dùng là không thể hoàn tác; chặn là lựa chọn an toàn khi chưa chắc.
