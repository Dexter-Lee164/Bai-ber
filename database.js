/**
 * Opens the SQLite database and creates any missing tables and indexes.
 *
 * Works for a fresh install AND for a database from the older admin version:
 * CREATE ... IF NOT EXISTS only adds what is missing and never rebuilds or resets
 * an existing table, so old accounts, statuses and messages stay exactly as they were.
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'database', 'messaging.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// Foreign keys are OFF by default in SQLite. This must be set on every connection.
db.pragma('foreign_keys = ON');
// WAL gives better behaviour when several browser tabs read and write at once.
db.pragma('journal_mode = WAL');

db.exec(`
  -- ---------------------------------------------------------------
  -- users
  -- username is UNIQUE and case-insensitive, so "Maria" and "maria"
  -- cannot both exist (prevents look-alike accounts).
  -- Bai-ber has ONE kind of account, so a fresh install has no "role"
  -- column. A database from the older admin version keeps its "role"
  -- column untouched (CREATE TABLE IF NOT EXISTS never rebuilds an
  -- existing table); models/userModel.js detects it and hides the
  -- legacy 'admin' rows from login and friend search.
  -- ---------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS users (
    user_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- ---------------------------------------------------------------
  -- messages
  -- ON DELETE CASCADE: when a user account is deleted, every message
  -- they sent or received is deleted too. A one-to-one conversation
  -- cannot exist without both people, so nothing is left orphaned.
  -- ---------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS messages (
    message_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id   INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    receiver_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    content     TEXT    NOT NULL CHECK (length(trim(content)) > 0),
    sent_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    edited_at   DATETIME NULL,
    CHECK (sender_id <> receiver_id)
  );

  -- Conversation lookups filter on (sender, receiver) in both directions,
  -- so one index per direction keeps history queries fast.
  CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver
    ON messages (sender_id, receiver_id, message_id);
  CREATE INDEX IF NOT EXISTS idx_messages_receiver_sender
    ON messages (receiver_id, sender_id, message_id);

  -- ---------------------------------------------------------------
  -- conversation_reads (supporting table for unread counters)
  -- Remembers the last message each user has read in each conversation.
  -- ---------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS conversation_reads (
    user_id      INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    peer_id      INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    last_read_id INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, peer_id)
  );

  -- ---------------------------------------------------------------
  -- sessions (server-side session store, see server.js)
  -- ---------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT    PRIMARY KEY,
    sess    TEXT    NOT NULL,
    expires INTEGER NOT NULL,
    user_id INTEGER NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires);
  CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions (user_id);

  -- ---------------------------------------------------------------
  -- friendships (friend requests AND accepted friendships)
  -- One row per request. Its status moves
  --   pending -> accepted | declined | cancelled
  -- Finished rows are kept as history, so a new request after a decline
  -- or a cancellation is simply a new row. An accepted row is mutual:
  -- it does not matter which of the two people sent it.
  -- Old conversations are NEVER turned into friendships automatically.
  -- ---------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS friendships (
    friendship_id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id     INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    receiver_id   INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    status        TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    CHECK (sender_id <> receiver_id)
  );

  -- At most ONE active (pending or accepted) relationship per pair of people,
  -- whoever sent it: the pair is normalised to (smaller id, larger id).
  -- Finished rows (declined / cancelled) are not covered by the index,
  -- so either person can send a new request later. If both people click
  -- "Add Friend" at the same moment, the second INSERT fails on this index.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_friendships_active_pair
    ON friendships (MIN(sender_id, receiver_id), MAX(sender_id, receiver_id))
    WHERE status IN ('pending', 'accepted');
  CREATE INDEX IF NOT EXISTS idx_friendships_sender   ON friendships (sender_id, status);
  CREATE INDEX IF NOT EXISTS idx_friendships_receiver ON friendships (receiver_id, status);
`);

module.exports = db;
