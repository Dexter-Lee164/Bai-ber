# Bai-ber

A desktop-first, real-time one-to-one messaging web app with a purple, Viber-inspired interface.
Everyone is a regular user: people find each other, send **friend requests**, and can message each other only once a request is accepted.

**Stack:** Node.js, Express, EJS, Bootstrap 5, vanilla JavaScript, Socket.IO, MySQL (`mysql2/promise`), `express-session`, `bcryptjs`, `dotenv`.

> Bai-ber is a standard web messaging app. Messages are stored in the server's database and are **not** end-to-end encrypted.

---

## Setup on Windows

1. Install Node.js 22.13 or later and start MySQL Server 8.0.16 or later.
2. Open MySQL Workbench, connect to your local server, open `schema.sql` from this folder and execute the whole script. It creates the `bai_ber` database and five tables.
3. Edit the included `.env`. Set `DB_HOST`, `DB_PORT`, `DB_USER` and `DB_PASSWORD` to match your MySQL connection. The account running the app needs SELECT, INSERT, UPDATE and DELETE on `bai_ber`. For a fresh checkout copy `.env.example` to `.env` first.
4. Open a terminal in this folder and run `npm install`.
5. To keep the supplied accounts and chats, run `npm run import:sqlite` once before starting the app. For a fresh installation, skip this step.
6. Run `npm start` and open http://localhost:3000. Set `PORT` in `.env` to change the port.

The importer reads the bundled SQLite database (including its WAL), checks the row counts and commits one MySQL transaction. It preserves IDs, password hashes, friendship states, messages and read positions. It refuses to merge into populated application tables. To import another copy, run `npm run import:sqlite -- "path/to/messaging.db"`. Keep any matching WAL and SHM files beside it. Users sign in again after import.

## Message CRUD

| Action | Express endpoint | Database operation |
| --- | --- | --- |
| Send | POST /api/messages | INSERT for an accepted friendship |
| Open conversation | GET /api/messages/:peerId | SELECT the two users' messages |
| Edit | PUT /api/messages/:id | UPDATE the sender's message and edit timestamp |
| Delete | DELETE /api/messages/:id | UPDATE the sender's message to a deleted placeholder |

The browser calls these routes from `public/js/chat.js`. Express routes in `server.js` call `controllers/chatController.js`; the SQL lives in `models/messageModel.js`. After a successful write, Socket.IO pushes the change to the two participants. Unfriend uses a SQL DELETE on the accepted relationship.

## Accounts

Bai-ber has **one role: user**. There is no administrator, admin dashboard, admin route, admin navigation or admin creation command. Every account that signs in lands on the messaging interface (`/chat`), and registration always creates a regular, active user (any `role` or `status` sent in the form is ignored). The old `/admin` URLs return 404.

Databases created by the older version may still contain admin accounts. They are kept but **cannot sign in** (the login page answers "Invalid username or password") and **never appear in friend search**. Their old messages stay visible to the people they talked to, shown as an inactive account.

## Features

Navigation rail (a bottom bar on phones): **Chats**, **Friends** (with a badge counting incoming requests), **Profile / Settings**, **Log out**.

**Accounts**
- Register with a unique 6–24 character username. Rename it in Profile & settings. Existing accounts with shorter names can still sign in.
- Profile dialog with change-password (other devices are signed out).

**Friends**
- Four sections, switched with a segmented control under the search box:
  - **Friends**: accepted friends grouped by online/offline, each with **Message** and **Unfriend**.
  - **Requests**: incoming requests with **Accept** / **Decline**.
  - **Sent**: your pending requests with **Cancel**.
  - **Find**: search every registered user by username. Each result shows the action that fits:

    | Relationship | Action shown |
    | --- | --- |
    | none | Add Friend |
    | you sent a request | Request Sent / Cancel |
    | they sent you a request | Accept / Decline |
    | friends | Friends / Message / Unfriend |
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
- Send, **edit** (shows an "Edited" label) and **delete** your own messages; changes appear instantly on both sides. Deleted messages show “Message deleted”. A Seen label tracks the most recent outgoing message viewed by the recipient.
- **Conversations from before the friends feature** are kept: they stay in the list (with a lock icon) and their history stays readable for both people. They are **not** turned into friendships automatically. The composer is disabled with "You must be friends to send messages." and a contextual **Add Friend**, **Cancel request** or **Accept / Decline** button; once a request is accepted it unlocks and the old history is still there. You can still edit or delete your own earlier messages.
- Enter sends, Shift+Enter inserts a new line. Message limit: 2000 characters.
- Online/offline status, empty states, loading skeletons and toast notifications.
- Conversations, friends and history are re-fetched from the database after a reconnect, so nothing is missed.
- Desktop layout has three sections (navigation rail, list panel, chat). On small screens the list and the chat become separate views with a bottom navigation bar.

