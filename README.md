# Bai-ber

A desktop-first, real-time one-to-one messaging web app with a purple, Viber-inspired interface.
Everyone is a regular user: people find each other, send **friend requests**, and can message each other only once a request is accepted.

**Stack:** Node.js, Express, EJS, Bootstrap 5, vanilla JavaScript, Socket.IO, SQLite (`better-sqlite3`), `express-session`, `bcryptjs`, `dotenv`.

> Bai-ber is a standard web messaging app. Messages are stored in the server's database and are **not** end-to-end encrypted.

---

## 1. Requirements

- **Node.js 22 or newer** (`node -v` to check). `better-sqlite3` needs a recent Node; if you see a build or "module version" error, upgrade Node and run `npm install` again.
- npm (comes with Node).
- No external database server: SQLite is just a file.

## 2. Installation

```bash
cd bai-ber
npm install
```

The Bootstrap, Bootstrap Icons and Inter font files are served from `node_modules`, so the app works offline and loads no third-party CDN.

`better-sqlite3` ships ready-made binaries for Windows, macOS and Linux, so no compiler is needed. The included `.npmrc` (`ignore-scripts=true`) makes sure npm never tries to build it from source.

**Troubleshooting**
- *"Unsupported engine" or a native-module error:* upgrade to Node 22+, delete the `node_modules` folder, and run `npm install` again.
- *"Port already in use":* change `PORT` in `.env`.
- *Everyone was logged out after a restart:* `SESSION_SECRET` is missing from `.env` (a temporary one was generated). Set it as described below.

## 3. Environment configuration

Configuration lives in a `.env` file in the project root. It is ignored by Git. A ready-to-use `.env` is included for local development; for a fresh checkout, copy the template:

```bash
cp .env.example .env
```

Then set a real secret (this signs the session cookie):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Paste the output as `SESSION_SECRET` in `.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | none | **Required in production.** Long random string for signing cookies. In development, a temporary one is generated with a warning (everyone is logged out on each restart). |
| `PORT` | `3000` | Port to listen on. |
| `NODE_ENV` | `development` | Use `production` when deploying: enables HTTPS-only cookies and refuses to start without a real secret. |
| `DB_PATH` | `./database/messaging.db` | Location of the SQLite file. |
| `SESSION_DAYS` | `7` | How long a login lasts. |
| `BCRYPT_ROUNDS` | `10` | Password-hashing cost (allowed 4-15). |
| `REGISTER_LIMIT_PER_HOUR` | `30` | Sign-ups allowed per network address per hour. |
| `TRUST_PROXY` | off | Number of reverse proxies to trust (e.g. `1` behind nginx). |
| `COOKIE_SECURE` | on in production | Force the cookie `secure` flag on or off. |
| `ALLOWED_ORIGINS` | none | Extra browser origins allowed to open the Socket.IO connection (comma separated). |

The database file and all its tables are **created automatically** the first time the app runs. An existing database from the older version keeps working as it is (see [10. Upgrading an existing database](#10-upgrading-an-existing-database)). Nothing to import.

## 4. Running

```bash
npm start          # http://localhost:3000
npm run dev        # same, but restarts when files change
npm test           # 22 end-to-end tests (real HTTP + real WebSocket clients)
```

Typical first run:

1. `npm install`
2. `npm start`
3. Open <http://localhost:3000> and register two accounts in two different browsers (or one normal and one private window).
4. In the first browser open **Friends → Find**, search for the other username and click **Add Friend**.
5. In the second browser the request appears instantly under **Friends → Requests** (with a red badge on Friends); click **Accept**.
6. Both of you can now press **Message** and chat. (Before the request is accepted, neither of you can send a message.)

## 5. Roles

Bai-ber has **one role: user**. There is no administrator, admin dashboard, admin route, admin navigation or admin creation command. Every account that signs in lands on the messaging interface (`/chat`), and registration always creates a regular, active user (any `role` or `status` sent in the form is ignored). The old `/admin` URLs return 404.

Databases created by the older version may still contain admin accounts. They are kept but **cannot sign in** (the login page answers "Invalid username or password") and **never appear in friend search**. Their old messages stay visible to the people they talked to, shown as an inactive account.

## 6. Features

Navigation rail (a bottom bar on phones): **Chats**, **Friends** (with a badge counting incoming requests), **Profile / Settings**, **Log out**.

**Accounts**
- Register (username, password, confirmation) and sign in/out.
- Profile dialog with change-password (other devices are signed out).

**Friends**
- Four sections, switched with a segmented control under the search box:
  - **Friends**: accepted friends grouped by online/offline, each with **Message**.
  - **Requests**: incoming requests with **Accept** / **Decline**.
  - **Sent**: your pending requests with **Cancel**.
  - **Find**: search every registered user by username. Each result shows the action that fits:

    | Relationship | Action shown |
    | --- | --- |
    | none | Add Friend |
    | you sent a request | Request Sent / Cancel |
    | they sent you a request | Accept / Decline |
    | friends | Friends / Message |
- You never appear in your own search results, you cannot befriend yourself, and duplicate requests or friendships are refused (in either direction).
- Cancelling a request asks for confirmation in a styled dialog (no browser `confirm()`).
- After a request is declined or cancelled, **either** person can send a new one.
- Everything updates live in both people's open tabs over the existing Socket.IO connection: request received / accepted / declined / cancelled and badge counts. If a request is accepted while the other person has that chat open, their composer unlocks without a refresh.
- Empty states for no friends, no incoming requests, no sent requests and no search results.

**Messaging (real time over Socket.IO)**
- **Only accepted friends can send each other messages.** The server checks this on every send; it is not only hidden in the page.
- One-to-one conversations, newest first, with last message, time and unread badges. Chat search matches conversations, message text and friends you have not written to yet.
- **All / Unread** filter above the chat list (All by default). Unread shows only conversations with unread incoming messages (it reuses the existing unread counts) and says "You're all caught up" when there are none. It stays in sync with new messages and read events: opening an unread chat clears its badge and removes it from the Unread list while the chat stays open (also with the phone list-to-chat navigation).
- "New conversation" opens your friends list: only friends can be picked.
- Send, **edit** (shows an "Edited" label) and **delete** your own messages; changes appear instantly on both sides.
- **Conversations from before the friends feature** are kept: they stay in the list (with a lock icon) and their history stays readable for both people. They are **not** turned into friendships automatically. The composer is disabled with "You must be friends to send messages." and a contextual **Add Friend**, **Cancel request** or **Accept / Decline** button; once a request is accepted it unlocks and the old history is still there. You can still edit or delete your own earlier messages.
- Enter sends, Shift+Enter inserts a new line. Message limit: 2000 characters.
- Online/offline status, empty states, loading skeletons and toast notifications.
- Conversations, friends and history are re-fetched from the database after a reconnect, so nothing is missed.
- Desktop layout has three sections (navigation rail, list panel, chat). On small screens the list and the chat become separate views with a bottom navigation bar.

## 7. Security notes

- Passwords are hashed with bcrypt; they are never stored or logged in plain text.
- Server-side sessions stored in SQLite; the session id is regenerated on login (prevents session fixation). Cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production.
- CSRF protection on every state-changing HTTP route (hidden `_csrf` field or `X-CSRF-Token` header), including all friendship actions.
- Socket.IO connections reuse the login session, check the browser `Origin`, join only their own private room, verify message ownership in the database for edit/delete, verify an **accepted friendship** in the database for every send, and save to SQLite before acknowledging a send. Extra fields in a payload (such as a forged `senderId`) are ignored: the sender is always the session user.
- Friendship endpoints take the acting user only from the session. Only the receiver can accept or decline, and only the sender can cancel. That rule is part of each `UPDATE` statement, and "not yours" answers exactly like "not found". Friend requests are rate limited (30 per 10 minutes per user).
- Friendship events are emitted only to the private rooms of the two people involved.
- All SQL is parameterized. Message text is rendered with `textContent`, never as HTML, and a strict Content-Security-Policy blocks inline scripts.
- Failed-login, sign-up, password-change, friend-request and socket-event rate limiting (kept in memory, per process).
- Error pages never show stack traces. `.env` and the database are excluded by `.gitignore`.
- For deployment: set `NODE_ENV=production`, a real `SESSION_SECRET`, serve over HTTPS, and set `TRUST_PROXY` if behind a proxy. Run a single process (rate limits and online status are in memory).

## 8. Project structure

The backend is six source files (MVC):

```
bai-ber/
├── server.js                  Express setup: SQLite session store, security headers, CSRF,
│                              "who is signed in" + route guards, ALL route declarations,
│                              error pages, HTTP server + Socket.IO
├── database.js                Opens SQLite; creates missing tables + indexes (fresh or existing install)
├── models/
│   ├── userModel.js           Accounts, people search, friend requests, the friendship check
│   └── messageModel.js        Message CRUD, conversation history, read tracking, unread counts
├── controllers/
│   ├── authController.js      Register, login, logout, password change (+ the small rate limiter)
│   └── chatController.js      Chat page, history, friends endpoints, and its Socket.IO handlers
├── views/                     EJS templates (auth, chat, partials)
├── public/                    css/, js/ (chat.js, common.js), images/logo.svg
├── database/                  SQLite file lives here (ignored by Git)
└── tests/app.test.js          End-to-end test suite
```

**Friends HTTP API** (JSON, signed-in only; mutations need the CSRF header)

| Method & path | Purpose |
| --- | --- |
| `GET /api/friends` | `{ friends, incoming, outgoing }` for the signed-in user |
| `GET /api/friends/search?q=` | Users matching the username, each with `relation` (`none` / `outgoing` / `incoming` / `friends`) |
| `POST /api/friends/requests` `{ userId }` | Send a friend request |
| `POST /api/friends/requests/:id/accept` | Accept a request addressed to you |
| `POST /api/friends/requests/:id/decline` | Decline a request addressed to you |
| `DELETE /api/friends/requests/:id` | Cancel a request you sent |

Socket events pushed to the two people involved: `friend:request`, `friend:accepted`, `friend:declined`, `friend:cancelled`, then `friends:updated`. `GET /api/conversations` and `GET /api/messages/:peerId` also return the `relation` with each person.

## 9. Database

`users` (`user_id`, `username` unique and case-insensitive, `password_hash`, `status` active/inactive, `created_at`) and `messages` (`message_id`, `sender_id`, `receiver_id`, `content`, `sent_at`, `edited_at`) have foreign keys enabled and indexes on both conversation directions. Helper tables: `conversation_reads` (unread counts) and `sessions` (login sessions). Databases from the older version also have a `users.role` column (see section 10).

**`friendships`** holds both requests and friendships, one row per request:

| Column | Type | Notes |
| --- | --- | --- |
| `friendship_id` | INTEGER PRIMARY KEY | |
| `sender_id` | INTEGER NOT NULL | references `users.user_id` (ON DELETE CASCADE) |
| `receiver_id` | INTEGER NOT NULL | references `users.user_id` (ON DELETE CASCADE) |
| `status` | TEXT NOT NULL | `pending`, `accepted`, `declined`, `cancelled` |
| `created_at` / `updated_at` | DATETIME | request time / last status change |

- `CHECK (sender_id <> receiver_id)` blocks self-friendship.
- A **partial unique index on the normalised pair**, `(MIN(sender_id, receiver_id), MAX(sender_id, receiver_id)) WHERE status IN ('pending', 'accepted')`, allows at most one active relationship per pair, whoever sent it. If both people click Add Friend at the same moment, the second insert hits this index and gets "already sent you a request". Finished rows are not covered, so the pair can start over later and the old rows stay as history.
- Accepted rows are mutual; there is never a second "reverse" row.
- Status changes are single conditional `UPDATE`s (for example `... WHERE friendship_id = ? AND receiver_id = ? AND status = 'pending'`), and sending a request runs its duplicate check and insert in one transaction, so concurrent clicks cannot create duplicates or double-accept.
- Extra indexes on `(sender_id, status)` and `(receiver_id, status)` keep the friends and request lists fast.
- Friendship rows are never deleted, and **no friendship action ever deletes messages**.

## 10. Upgrading an existing database

Point `DB_PATH` at the old file (or leave it at `./database/messaging.db`) and start the app. There is no reset and no data migration:

- `CREATE TABLE IF NOT EXISTS` adds only what is missing (`friendships`, `conversation_reads`, `sessions` and their indexes). Existing tables are never rebuilt, so accounts, password hashes, messages and account statuses (`active` / `inactive`) stay exactly as they were.
- The old `users.role` column is **left in place**. Dropping it would mean rebuilding the `users` table that every other table references, just to remove one column. `models/userModel.js` checks once at start-up whether the column exists (`HAS_LEGACY_ROLE`). If it does, rows with `role = 'admin'` are hidden from login and friend search. New accounts never set it, so on an old database they get the column default, `'user'`. A fresh install has no `role` column at all.
- Old conversations are **not** turned into friendships. Their history and unread counts are kept, and sending is locked until one of the two people sends a friend request and the other accepts it.

Back up `database/messaging.db` (and its `-wal` / `-shm` files) before upgrading a production install, as with any change.

## 11. Design decisions worth knowing

- Messages are created, edited and deleted **only through the socket**, which keeps the sender, the recipient and the database consistent. History, search and friendship changes use normal HTTP endpoints (with CSRF protection); friendship changes are then pushed over the socket.
- Friendship only gates **sending**. Reading the history and managing your own past messages (edit/delete) stay available in a conversation that is locked.
- Accounts whose `status` is `inactive` (possible in databases from the earlier admin version) still cannot sign in or receive messages. With no admin panel, re-activate one directly in SQLite if needed: `UPDATE users SET status = 'active' WHERE username = '...';`
- The Unread filter is purely a view over the conversation list: it uses the same `unread` count that `GET /api/conversations` already returns, and the existing `conversation:read` socket event keeps it in sync.
- Usernames are unique ignoring case (`Alice` and `alice` are the same name).
- Out of scope by design: group chats, calls, media/file sharing, reactions, push notifications, end-to-end encryption.
