/**
 * User model: accounts, people search, friend requests and the friendship check.
 * Every SQL statement for the "users", "friendships" and (per-user) "sessions" rows lives here.
 * All queries are parameterized (?, @name) so user input is never pasted into SQL.
 *
 * Friend requests: one row in "friendships" per request. Status lifecycle:
 *   pending -> accepted | declined | cancelled
 * Only pending and accepted rows are "active". The unique index uq_friendships_active_pair
 * (database.js) allows ONE active row per pair of people, whoever sent it, so the queries
 * below normalise the pair with MIN()/MAX() exactly like the index does.
 * Every state change names WHO may make it inside the UPDATE itself (receiver_id = ? for
 * accept/decline, sender_id = ? for cancel), so a forged request id can never change
 * someone else's request.
 */
const db = require('../database.js');

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,24}$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX_BYTES = 72; // bcrypt ignores everything after 72 bytes

/*
 * Legacy admin accounts. Bai-ber has one role, so fresh databases have no "role" column.
 * A database created by the older admin version still has it (we never rebuild that table),
 * and any row there with role = 'admin' is a legacy admin account: it cannot sign in and
 * never appears in friend search. Its old messages are kept.
 */
const HAS_LEGACY_ROLE = Boolean(
  db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'role'").get()
);
const NOT_LEGACY_ADMIN = HAS_LEGACY_ROLE ? "AND role <> 'admin'" : '';

function isLegacyAdmin(row) {
  return Boolean(row) && row.role === 'admin';
}

/** The one rule for "may this account use Bai-ber right now?" (login, every request, every socket event). */
function canUseApp(row) {
  return Boolean(row) && row.status === 'active' && !isLegacyAdmin(row);
}

/** SQLite stores CURRENT_TIMESTAMP as "YYYY-MM-DD HH:MM:SS" in UTC. Turn it into ISO-8601. */
function toIso(value) {
  return value ? `${String(value).replace(' ', 'T')}Z` : null;
}

/** Escape LIKE wildcards so searching for "50%" does not match everything. */
function likePattern(text) {
  return `%${String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Shape sent to browsers: never includes the password hash. */
function toPublic(row) {
  if (!row) return null;
  return {
    id: row.user_id,
    username: row.username,
    // A legacy admin account cannot use the app, so other people see it as inactive.
    status: isLegacyAdmin(row) ? 'inactive' : row.status,
    createdAt: toIso(row.created_at),
  };
}

/** The relationship between "me" and another person, from my point of view. */
function relationFrom(meId, row) {
  if (!row) return { state: 'none', requestId: null };
  if (row.status === 'accepted') return { state: 'friends', requestId: row.friendship_id };
  return { state: row.sender_id === meId ? 'outgoing' : 'incoming', requestId: row.friendship_id };
}

/** A Friends-tab row: the other person plus when the relationship last changed. */
function toFriendEntry(row) {
  return {
    requestId: row.friendship_id,
    since: toIso(row.updated_at),
    user: { id: row.user_id, username: row.username, status: row.status },
  };
}

const PAIR = 'MIN(sender_id, receiver_id) = MIN(@a, @b) AND MAX(sender_id, receiver_id) = MAX(@a, @b)';

const stmts = {
  // ---- accounts ----
  findById: db.prepare('SELECT * FROM users WHERE user_id = ?'),
  findByUsername: db.prepare('SELECT * FROM users WHERE username = ?'), // column is NOCASE
  // No role is stored: on a legacy database the old column falls back to its default, 'user'.
  insert: db.prepare(
    "INSERT INTO users (username, password_hash, status) VALUES (@username, @passwordHash, 'active')"
  ),
  updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE user_id = ?'),
  legacyAdminIds: HAS_LEGACY_ROLE ? db.prepare("SELECT user_id FROM users WHERE role = 'admin'") : null,
  search: db.prepare(`
    SELECT * FROM users
    WHERE status = 'active' AND user_id <> @me ${NOT_LEGACY_ADMIN}
      AND (@q = '' OR username LIKE @pattern ESCAPE '\\')
    ORDER BY username COLLATE NOCASE ASC
    LIMIT @limit
  `),
  // Sign a user out of every OTHER login session (used after a password change).
  deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND sid <> ?'),

  // ---- friend requests / friendships ----
  requestById: db.prepare('SELECT * FROM friendships WHERE friendship_id = ?'),
  activeBetween: db.prepare(`
    SELECT * FROM friendships
    WHERE ${PAIR} AND status IN ('pending', 'accepted')
  `),
  activeFor: db.prepare(`
    SELECT * FROM friendships
    WHERE (sender_id = @me OR receiver_id = @me) AND status IN ('pending', 'accepted')
  `),
  insertRequest: db.prepare("INSERT INTO friendships (sender_id, receiver_id, status) VALUES (?, ?, 'pending')"),
  respond: db.prepare(`
    UPDATE friendships SET status = @status, updated_at = CURRENT_TIMESTAMP
    WHERE friendship_id = @id AND receiver_id = @me AND status = 'pending'
  `),
  cancel: db.prepare(`
    UPDATE friendships SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
    WHERE friendship_id = @id AND sender_id = @me AND status = 'pending'
  `),
  friends: db.prepare(`
    SELECT f.friendship_id, f.updated_at, u.user_id, u.username, u.status
    FROM friendships f
    JOIN users u ON u.user_id = CASE WHEN f.sender_id = @me THEN f.receiver_id ELSE f.sender_id END
    WHERE (f.sender_id = @me OR f.receiver_id = @me) AND f.status = 'accepted'
    ORDER BY u.username COLLATE NOCASE ASC
  `),
  incoming: db.prepare(`
    SELECT f.friendship_id, f.updated_at, u.user_id, u.username, u.status
    FROM friendships f JOIN users u ON u.user_id = f.sender_id
    WHERE f.receiver_id = @me AND f.status = 'pending' AND u.status = 'active'
    ORDER BY f.friendship_id DESC
  `),
  outgoing: db.prepare(`
    SELECT f.friendship_id, f.updated_at, u.user_id, u.username, u.status
    FROM friendships f JOIN users u ON u.user_id = f.receiver_id
    WHERE f.sender_id = @me AND f.status = 'pending' AND u.status = 'active'
    ORDER BY f.friendship_id DESC
  `),
};

/**
 * Sends a request. One transaction, so the "is there already something between us?"
 * check and the insert cannot be split by another request.
 */
const sendRequestTx = db.transaction((senderId, receiverId) => {
  const existing = stmts.activeBetween.get({ a: senderId, b: receiverId });
  if (existing) return { ok: false, relation: relationFrom(senderId, existing) };
  const info = stmts.insertRequest.run(senderId, receiverId);
  return { ok: true, request: stmts.requestById.get(info.lastInsertRowid) };
});

module.exports = {
  USERNAME_PATTERN,
  PASSWORD_MIN,
  PASSWORD_MAX_BYTES,
  HAS_LEGACY_ROLE,
  toIso,
  toPublic,
  isLegacyAdmin,
  canUseApp,
  relationFrom,

  /* ---------------------------------------------------------------- accounts */

  /** Returns an error message, or null when the username is acceptable. */
  validateUsername(username) {
    if (typeof username !== 'string' || !username.trim()) return 'Username is required.';
    if (!USERNAME_PATTERN.test(username.trim())) {
      return 'Username must be 3-24 characters: letters, numbers, dots, underscores or hyphens.';
    }
    return null;
  },

  /** Returns an error message, or null when the password is acceptable. */
  validatePassword(password) {
    if (typeof password !== 'string' || !password) return 'Password is required.';
    if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
    if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
      return `Password is too long (maximum ${PASSWORD_MAX_BYTES} bytes).`;
    }
    return null;
  },

  findById(id) {
    return stmts.findById.get(id) || null;
  },

  findByUsername(username) {
    return stmts.findByUsername.get(String(username)) || null;
  },

  /** Creates an active, regular account. Throws SQLITE_CONSTRAINT_UNIQUE if the username exists. */
  create({ username, passwordHash }) {
    const info = stmts.insert.run({ username, passwordHash });
    return stmts.findById.get(info.lastInsertRowid);
  },

  setPassword(id, passwordHash) {
    stmts.updatePassword.run(passwordHash, id);
  },

  /** Removes every login session of this user except the one given. */
  signOutOtherSessions(id, keepSid) {
    stmts.deleteOtherSessions.run(id, keepSid);
  },

  /** Ids of legacy admin accounts (always empty on a fresh install). */
  legacyAdminIds() {
    return new Set(stmts.legacyAdminIds ? stmts.legacyAdminIds.all().map((r) => r.user_id) : []);
  },

  /** Active users whose name contains q (empty q lists everyone). Never includes the searcher or legacy admins. */
  search(meId, q = '', limit = 30) {
    const query = String(q).trim().slice(0, 50);
    return stmts.search
      .all({ me: meId, q: query, pattern: likePattern(query), limit })
      .map(toPublic);
  },

  /* ---------------------------------------------------------------- friendships */

  findRequest(id) {
    return stmts.requestById.get(id) || null;
  },

  /** { state: 'none' | 'friends' | 'outgoing' | 'incoming', requestId } */
  relationBetween(meId, otherId) {
    return relationFrom(meId, stmts.activeBetween.get({ a: meId, b: otherId }));
  },

  /** THE rule every message send is checked against: an ACCEPTED row for this pair. */
  areFriends(a, b) {
    const row = stmts.activeBetween.get({ a, b });
    return Boolean(row && row.status === 'accepted');
  },

  /** Map of otherUserId -> relation, for every active relationship the user has. */
  relationsFor(meId) {
    const map = new Map();
    for (const row of stmts.activeFor.all({ me: meId })) {
      const otherId = row.sender_id === meId ? row.receiver_id : row.sender_id;
      map.set(otherId, relationFrom(meId, row));
    }
    return map;
  },

  /** Everything the Friends tab shows: { friends, incoming, outgoing }. */
  friendsOverview(meId) {
    return {
      friends: stmts.friends.all({ me: meId }).map(toFriendEntry),
      incoming: stmts.incoming.all({ me: meId }).map(toFriendEntry),
      outgoing: stmts.outgoing.all({ me: meId }).map(toFriendEntry),
    };
  },

  /** Returns { ok: true, request } or { ok: false, relation } when the pair already has an active relationship. */
  sendRequest(senderId, receiverId) {
    try {
      return sendRequestTx(senderId, receiverId);
    } catch (err) {
      // Both people clicked Add Friend at the same instant: the unique index decides.
      if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return { ok: false, relation: this.relationBetween(senderId, receiverId) };
      }
      throw err;
    }
  },

  /** Accept or decline a request addressed to meId. Returns the updated row, or null. */
  respondToRequest(meId, requestId, accept) {
    const changed = stmts.respond.run({ id: requestId, me: meId, status: accept ? 'accepted' : 'declined' }).changes;
    return changed ? stmts.requestById.get(requestId) : null;
  },

  /** Cancel a pending request that meId sent. Returns the updated row, or null. */
  cancelRequest(meId, requestId) {
    const changed = stmts.cancel.run({ id: requestId, me: meId }).changes;
    return changed ? stmts.requestById.get(requestId) : null;
  },
};
