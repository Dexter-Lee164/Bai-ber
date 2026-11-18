/**
 * Message model: all SQL for the "messages" and "conversation_reads" tables.
 * Every function that changes a message also checks WHO is changing it
 * (sender_id = ?), so ownership is enforced inside the query itself.
 */
const db = require('../database.js');
const { toIso } = require('./userModel');

const MAX_LENGTH = 2000;

function toApi(row) {
  if (!row) return null;
  return {
    id: row.message_id,
    senderId: row.sender_id,
    receiverId: row.receiver_id,
    content: row.content,
    sentAt: toIso(row.sent_at),
    editedAt: toIso(row.edited_at),
  };
}

const stmts = {
  insert: db.prepare('INSERT INTO messages (sender_id, receiver_id, content) VALUES (?, ?, ?)'),
  findById: db.prepare('SELECT * FROM messages WHERE message_id = ?'),
  update: db.prepare(
    'UPDATE messages SET content = ?, edited_at = CURRENT_TIMESTAMP WHERE message_id = ? AND sender_id = ?'
  ),
  remove: db.prepare('DELETE FROM messages WHERE message_id = ? AND sender_id = ?'),
  history: db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE ((sender_id = @a AND receiver_id = @b) OR (sender_id = @b AND receiver_id = @a))
        AND (@before IS NULL OR message_id < @before)
      ORDER BY message_id DESC
      LIMIT @limit
    ) ORDER BY message_id ASC
  `),
  conversations: db.prepare(`
    WITH convo AS (
      SELECT CASE WHEN sender_id = @me THEN receiver_id ELSE sender_id END AS peer_id,
             MAX(message_id) AS last_id
      FROM messages
      WHERE sender_id = @me OR receiver_id = @me
      GROUP BY peer_id
    )
    SELECT c.peer_id, u.username, u.status,
           m.message_id, m.sender_id, m.receiver_id, m.content, m.sent_at, m.edited_at,
           (SELECT COUNT(*) FROM messages x
             WHERE x.sender_id = c.peer_id AND x.receiver_id = @me
               AND x.message_id > COALESCE(
                 (SELECT r.last_read_id FROM conversation_reads r
                   WHERE r.user_id = @me AND r.peer_id = c.peer_id), 0)
           ) AS unread
    FROM convo c
    JOIN users    u ON u.user_id = c.peer_id
    JOIN messages m ON m.message_id = c.last_id
    ORDER BY c.last_id DESC
  `),
  markRead: db.prepare(`
    INSERT INTO conversation_reads (user_id, peer_id, last_read_id)
    VALUES (@me, @peer, (SELECT COALESCE(MAX(message_id), 0) FROM messages WHERE sender_id = @peer AND receiver_id = @me))
    ON CONFLICT(user_id, peer_id) DO UPDATE SET last_read_id = excluded.last_read_id
  `),
};

module.exports = {
  MAX_LENGTH,

  /**
   * Normalises and validates message text.
   * Returns { ok: true, content } or { ok: false, error }.
   */
  validateContent(raw) {
    if (typeof raw !== 'string') return { ok: false, error: 'Message must be text.' };
    const content = raw.replace(/\r\n?/g, '\n').trim();
    if (!content) return { ok: false, error: 'Message cannot be empty.' };
    if (content.length > MAX_LENGTH) {
      return { ok: false, error: `Message is too long (maximum ${MAX_LENGTH} characters).` };
    }
    return { ok: true, content };
  },

  create(senderId, receiverId, content) {
    const info = stmts.insert.run(senderId, receiverId, content);
    return toApi(stmts.findById.get(info.lastInsertRowid));
  },

  findById(id) {
    return toApi(stmts.findById.get(id));
  },

  /** Returns the edited message, or null when the message does not exist or is not owned by senderId. */
  update(messageId, senderId, content) {
    const info = stmts.update.run(content, messageId, senderId);
    return info.changes ? toApi(stmts.findById.get(messageId)) : null;
  },

  /** Returns true when a message owned by senderId was deleted. */
  remove(messageId, senderId) {
    return stmts.remove.run(messageId, senderId).changes > 0;
  },

  /**
   * Messages between exactly two users, oldest first.
   * Pass `before` (a message id) to load an earlier page.
   */
  history(userId, peerId, { before = null, limit = 50 } = {}) {
    const rows = stmts.history.all({ a: userId, b: peerId, before, limit: limit + 1 });
    // We asked for one extra row: if it exists there are older messages left to load.
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(1) : rows;
    return { messages: page.map(toApi), hasMore };
  },

  /** One entry per person the user has talked to, newest conversation first. */
  conversationsFor(userId) {
    return stmts.conversations.all({ me: userId }).map((row) => ({
      peer: { id: row.peer_id, username: row.username, status: row.status },
      lastMessage: toApi(row),
      unread: row.unread,
    }));
  },

  /** Marks everything the peer has sent to the user so far as read. */
  markRead(userId, peerId) {
    stmts.markRead.run({ me: userId, peer: peerId });
  },
};
