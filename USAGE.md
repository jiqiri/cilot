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

Mặc định (`CILOT_USER_ROOT` không đặt):

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

Tên thư mục mặc định là `tg-workspaces`, không phải `cilot-server`: chuỗi sau
cũng là tên systemd unit, nên dễ bị đọc nhầm thành service và quá dài. Đây là thư mục dữ
liệu, tách khỏi thư mục cài đặt (nơi có `settings.json`, `.env`).

Nếu đặt `CILOT_USER_ROOT=/srv/tg/users` thì workspace là
`/srv/tg/users/<telegram id>/projects`, còn shared folder là `/srv/tg/shared/<tên>`.

Mỗi tài khoản có một project cá nhân tổng hợp:

```text
id:       personal:<telegram id>
worktree: <CILOT_USER_ROOT>/<telegram id>/projects
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

`CILOT_CONFINE_ADMINS=true` là lựa chọn riêng: ngay cả khi `/access on`, admin
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
| `CILOT_USER_ROOT` | Gốc workspace chia theo id; mặc định `~/.local/share/tg-workspaces/users` |
| `CILOT_CONFINE_ADMINS` | `true` để admin chính chỉ ở workspace của mình dù `/access on` |
| `OPENCODE_IMAGE_DIR` | Nơi ghi ảnh sinh ra |

File trạng thái (đều nên ở mode `600`):

| File | Nội dung |
| --- | --- |
| `settings.json` | Cấu hình và session của từng tài khoản |
| `user-access.json` | Công tắc `/access` (`{"elevated": true|false}`) |
| `users.json` | Danh sách id được thêm/chặn từ `/user` |
| `shared-folders.json` | Danh sách shared folder và id được cấp |
| `opencode.env` / `.env` | Key và cấu hình nhạy cảm — không commit |

### Đổi bot token sau khi cài

Token nằm ở hai chỗ: `~/.config/cilot/install.env` (lần `./install.sh` sau sẽ đọc) và `.env` của
bot (`cilot-bot.service` nạp). Sửa một chỗ thì lần cài sau sẽ ghi đè, nên dùng script:

```bash
./set-bot-token.sh                 # hỏi token (ẩn), kiểm tra getMe, restart bot
./set-bot-token.sh 123456789:AA... # nhập thẳng
```

Script giữ nguyên comment và mọi dòng khác trong cả hai file, ghi mode `600`, không in token ra.
`--no-verify` bỏ bước gọi Telegram, `--no-restart` chỉ ghi file, `--dry-run` chỉ in đường dẫn sẽ
sửa. Token cũ vẫn hoạt động cho tới khi script ghi token mới.

## 10. Model premium cho Cilot

Cilot dùng **một** OpenCode instance cho mọi tài khoản Telegram (`cilot-server`). Cách ly nằm
ở workspace, session và policy, không phải mỗi user một server. Vì vậy chỉ cần cấu hình
provider **một lần** trong profile của Cilot; mọi tài khoản thấy cùng catalog model.

Đừng login provider trong TUI thường (`~/.config/opencode`) rồi mong Telegram thấy model mới:
đó là profile khác, có DB credential khác.

| Thứ | Đường dẫn |
| --- | --- |
| Config server | `~/.config/cilot/opencode/opencode.jsonc` |
| Credential/auth | `~/.local/share/cilot/opencode/opencode/opencode.db` |
| Env key | `~/.config/cilot/opencode.env`, `~/.config/cilot/secrets.env` |
| Agent | `~/.config/cilot/opencode/agents/*.md` |

### 10.1 Provider có API key: dùng `/vault`, không cần SSH

Cách nhanh nhất cho OpenRouter, Anthropic, OpenAI, Gemini...:

1. `/vault` → **🔑 Xác thực Model** (chỉ admin chính; nếu không thấy menu, bật `/access on`).
2. Chọn provider → **🔑 Nhập key**.
3. Key được ghi vào credential store của server Cilot, **có hiệu lực ngay**, không cần restart.
4. Vào `/model` → **Providers** để chọn model.

OpenRouter đã được cấu hình sẵn bằng `OPENROUTER_API_KEY` trong
`~/.config/cilot/opencode.env`; nếu tài khoản OpenRouter có credit thì dùng được ngay.

### 10.2 OpenCode Go / OpenCode Console (OAuth)

Hai gói này dùng OAuth, không phải API key, nên phải login bằng CLI **trong profile Cilot**:

```bash
~/.local/bin/cilot-auth login opencode
~/.local/bin/cilot-auth list
systemctl --user restart cilot-server cilot-bot
```

Nếu chưa có `cilot-auth`, chạy trực tiếp:

```bash
env HOME="$HOME" \
  XDG_CONFIG_HOME="$HOME/.config/cilot" \
  XDG_DATA_HOME="$HOME/.local/share/cilot/opencode" \
  XDG_STATE_HOME="$HOME/.local/state/cilot/opencode" \
  XDG_CACHE_HOME="$HOME/.cache/cilot/opencode" \
  OPENCODE_CONFIG_DIR="$HOME/.config/cilot/opencode" \
  ~/.local/share/cilot/bin/opencode auth login --standalone opencode
```

- **OpenCode Go** (~$10/tháng) mở provider `opencode-go` cho model open-source và bỏ giới hạn
  tin nhắn free/ngày. Đăng ký tại `https://opencode.ai/go`.
- **OpenCode Console** dùng credit cho Claude/GPT/Gemini premium; model nằm trong provider
  `opencode`.
- Sau khi login, kiểm tra bằng `~/.local/bin/cilot-auth list` và mở TUI của Cilot (mục 10.4).

### 10.3 Provider tự định nghĩa (TokenHarbor, endpoint OpenAI-compatible)

Thêm block vào `~/.config/cilot/opencode/opencode.jsonc`:

```jsonc
"provider": {
  "tokenharbor": {
    "npm": "@ai-sdk/openai-compatible",
    "name": "TokenHarbor",
    "options": {
      "baseURL": "https://tokenharbor.ai/v1",
      "apiKey": "{env:TOKENHARBOR_API_KEY}"
    },
    "models": {
      "deepseek-v4.1-flash:free": { "name": "DeepSeek V4.1 Flash (Free)" }
    }
  }
}
```

Rồi thêm key. Có thể dùng `/vault` → **Biến môi trường** để thêm `TOKENHARBOR_API_KEY`
(không cần SSH), hoặc ghi trực tiếp file mode `600`:

```bash
read -rsp 'TOKENHARBOR_API_KEY: ' key; printf '\n'
printf 'TOKENHARBOR_API_KEY=%s\n' "$key" >> ~/.config/cilot/opencode.env
unset key
chmod 600 ~/.config/cilot/opencode.env
systemctl --user restart cilot-server
```

### 10.4 Mở TUI đúng instance của Cilot

TUI thường của bạn nhìn vào instance `5100` và config `~/.config/opencode`. Để xem/sửa
session của Cilot, mở TUI với đúng profile và server:

```bash
~/.local/bin/cilot-tui
```

Wrapper này nạp `server.env`, `opencode.env`, `secrets.env` và kết nối tới `cilot-server`.
Cổng lấy từ unit; installer mặc định `4096`, máy này `4156`. Nếu chưa có wrapper, thêm
`--server http://127.0.0.1:<port>` vào lệnh `opencode` trong mục 10.2.

### 10.5 Lưu ý

- Catalog model được cache **10 phút**; sau khi đổi provider, restart `cilot-bot` để `/model`
  thấy ngay.
- Server dùng chung: user thường có thể chọn model premium trong `/model` và tiêu credit của
  bạn. Nếu không muốn, cần giới hạn model theo user (hiện chưa có; có thể bổ sung).
- Không dán key vào chat, commit, log hay shared folder.
- Free tier của OpenCode giới hạn số tin nhắn/ngày; Go dành cho trường hợp cần dùng liên tục.

## 11. Kiểm tra và xử lý sự cố

```bash
systemctl --user status cilot-bot.service
systemctl --user status cilot-server.service
journalctl --user -u cilot-bot.service -n 50 --no-pager
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

## 12. Giới hạn đã biết

- Bot và OpenCode dùng chung một Linux user. Cách ly là ở tầng ứng dụng/agent, không phải
  tầng kernel.
- Key LLM vẫn nằm trong env của process server. User thường không đọc được vì không có
  shell, nhưng đây không phải cách ly tuyệt đối.
- Admin thứ hai không quản lý được `/vault`, `/access`, `/user`, `/share` — cố ý.
- `/access off` không hủy turn đang chạy.
- Xoá người dùng là không thể hoàn tác; chặn là lựa chọn an toàn khi chưa chắc.
