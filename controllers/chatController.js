/**
 * Chat controller: everything that happens on the chat page.
 *
 *   1. HTTP  - the page, conversations, message history          (read only)
 *   2. HTTP  - friends: overview, search, send / accept / decline / cancel requests
 *   3. Socket.IO - send / edit / delete messages, read receipts, presence, live friendship updates
 *
 * Rules enforced HERE and in the SQL (never only in the page):
 *   - the acting user always comes from the session, never from the request
 *   - only the receiver can accept or decline a request, only the sender can cancel it
 *   - a message can only be SENT between accepted friends (checked in message:send below)
 *   - only the owner of a message can edit or delete it
 *   - a message is saved to SQLite BEFORE anyone is told about it
 */
const userModel = require('../models/userModel');
const messageModel = require('../models/messageModel');
const { createLimiter } = require('./authController');

const PAGE_SIZE = 50;
const room = (userId) => `user:${userId}`; // every user has a private Socket.IO room
const fail = (error) => ({ ok: false, error });
const notFound = (res, error) => res.status(404).json({ ok: false, error });

// Friend requests per user: generous for people, a wall for scripts spamming everyone.
const requestLimiter = createLimiter({ windowMs: 10 * 60 * 1000, max: 30 });
// 40 socket events per 10 seconds per user is plenty for humans and stops floods.
const eventLimiter = createLimiter({ windowMs: 10 * 1000, max: 40 });

// userId -> Set of socket ids (a person may have several tabs open)
const online = new Map();

/** Accepts a positive integer (number or digit string); anything else is null. */
function parseId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

const isId = (value) => Number.isSafeInteger(value) && value > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Pushes a friendship change to the two people involved (every open tab of each).
 * Each side is told about the OTHER person from their own point of view:
 *   { friendshipId, user: { id, username, status }, relation: { state, requestId }, byMe }
 * followed by friends:updated so any open Friends list refreshes from the database.
 */
function notifyFriendship(req, event, request, actor, other) {
  const io = req.app.get('io');
  if (!io) return;
  const sides = [
    { to: actor, about: other, byMe: true },
    { to: other, about: actor, byMe: false },
  ];
  for (const { to, about, byMe } of sides) {
    io.to(room(to.user_id)).emit(event, {
      friendshipId: request.friendship_id,
      byMe,
      user: { id: about.user_id, username: about.username, status: about.status },
      relation: userModel.relationBetween(to.user_id, about.user_id),
    });
    io.to(room(to.user_id)).emit('friends:updated', { userId: about.user_id });
  }
}

/** Loads the request named in the URL if the signed-in user is part of it; otherwise answers 404. */
function loadRequest(req, res) {
  const id = parseId(req.params.id);
  const row = id ? userModel.findRequest(id) : null;
  // Same answer for "does not exist" and "is not yours": no information leak.
  if (!row || (row.sender_id !== req.user.id && row.receiver_id !== req.user.id)) {
    notFound(res, 'Friend request not found.');
    return null;
  }
  return row;
}

/** Accept (true) or decline (false). Only the RECEIVER of a pending request gets past the checks. */
function respondToRequest(accept) {
  return (req, res) => {
    const row = loadRequest(req, res);
    if (!row) return undefined;
    if (row.receiver_id !== req.user.id) return notFound(res, 'Friend request not found.');

    const updated = userModel.respondToRequest(req.user.id, row.friendship_id, accept);
    if (!updated) return res.status(409).json({ ok: false, error: 'This friend request is no longer pending.' });

    const me = userModel.findById(req.user.id);
    const sender = userModel.findById(row.sender_id);
    notifyFriendship(req, accept ? 'friend:accepted' : 'friend:declined', updated, me, sender);
    return res.json({
      ok: true,
      user: userModel.toPublic(sender),
      relation: userModel.relationBetween(me.user_id, sender.user_id),
    });
  };
}

/* ======================================================================
   Socket.IO
   ====================================================================== */

/** Browsers always send Origin on WebSocket handshakes; reject other sites. */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients do not send one
  const extra = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (err) {
    return false;
  }
}

/**
 * Registers one socket event with: rate limiting, a FRESH database check of the user
 * (so deactivation takes effect at once), an argument check, and error handling.
 */
function on(socket, name, handle) {
  socket.on(name, (payload, callback) => {
    const reply = typeof callback === 'function' ? callback : () => {};
    try {
      if (!eventLimiter.consume(String(socket.data.userId)).allowed) {
        return reply(fail('You are doing that too quickly. Please slow down.'));
      }
      const me = userModel.findById(socket.data.userId);
      if (!userModel.canUseApp(me)) {
        socket.disconnect(true);
        return reply(fail('Your session is no longer valid. Please sign in again.'));
      }
      if (!isObject(payload)) return reply(fail('Invalid request.'));
      return reply(handle(me, payload));
    } catch (err) {
      console.error(`[socket:${name}]`, err);
      return reply(fail('Something went wrong. Please try again.'));
    }
  });
}

function registerSocketHandlers(io) {
  // Handshake: re-use the normal login session (the cookie), so there is no separate token to steal.
  io.use((socket, next) => {
    const req = socket.request;
    if (!isAllowedOrigin(req)) return next(new Error('forbidden'));
    const userId = req.session && req.session.userId;
    const user = userId ? userModel.findById(userId) : null;
    if (!userModel.canUseApp(user)) return next(new Error('unauthorized'));
    socket.data.userId = user.user_id;
    socket.data.sid = req.sessionID;
    return next();
  });

  io.on('connection', (socket) => {
    const userId = socket.data.userId;
    socket.join(room(userId));

    // --- presence (online / offline) ---
    const sockets = online.get(userId) || new Set();
    const wasOffline = sockets.size === 0;
    sockets.add(socket.id);
    online.set(userId, sockets);
    socket.emit('presence:list', [...online.keys()]);
    if (wasOffline) io.emit('presence:update', { userId, online: true });

    socket.on('disconnect', () => {
      const set = online.get(userId);
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) {
        online.delete(userId);
        io.emit('presence:update', { userId, online: false });
      }
    });

    // --- CREATE a message ---
    on(socket, 'message:send', (me, { recipientId, content }) => {
      if (!isId(recipientId) || recipientId === me.user_id) return fail('Choose someone to message.');
      const check = messageModel.validateContent(content);
      if (!check.ok) return fail(check.error);

      const recipient = userModel.findById(recipientId);
      if (!recipient || userModel.isLegacyAdmin(recipient)) return fail('That person could not be found.');
      if (recipient.status !== 'active') return fail('This account is inactive, so you cannot send messages to it.');

      // THE friendship check: the database must hold an ACCEPTED row for this pair.
      // A pending request, a declined one, or an old pre-friendship conversation is not enough.
      if (!userModel.areFriends(me.user_id, recipient.user_id)) {
        return fail('You must be friends to send messages.');
      }

      const message = messageModel.create(me.user_id, recipient.user_id, check.content); // saved first...
      io.to(room(me.user_id)).to(room(recipient.user_id)).emit('message:new', message); // ...then delivered
      return { ok: true, message };
    });

    // --- UPDATE a message (owner only) ---
    on(socket, 'message:edit', (me, { messageId, content }) => {
      if (!isId(messageId)) return fail('Message not found.');
      const check = messageModel.validateContent(content);
      if (!check.ok) return fail(check.error);

      const existing = messageModel.findById(messageId);
      // Same answer for "does not exist" and "belongs to someone else": no information leak.
      if (!existing || existing.senderId !== me.user_id) return fail('Message not found.');

      const recipient = userModel.findById(existing.receiverId);
      if (!recipient || recipient.status !== 'active') {
        return fail('This account is inactive, so this message can no longer be edited.');
      }
      if (existing.content === check.content) return { ok: true, message: existing };

      // The SQL also contains "AND sender_id = ?", so ownership is enforced a second time.
      const message = messageModel.update(messageId, me.user_id, check.content);
      if (!message) return fail('Message not found.');
      io.to(room(message.senderId)).to(room(message.receiverId)).emit('message:edited', message);
      return { ok: true, message };
    });

    // --- DELETE a message (owner only) ---
    on(socket, 'message:delete', (me, { messageId }) => {
      if (!isId(messageId)) return fail('Message not found.');
      const existing = messageModel.findById(messageId);
      if (!existing || existing.senderId !== me.user_id) return fail('Message not found.');
      if (!messageModel.remove(messageId, me.user_id)) return fail('Message not found.');

      io.to(room(existing.senderId)).to(room(existing.receiverId)).emit('message:deleted', {
        id: existing.id,
        senderId: existing.senderId,
        receiverId: existing.receiverId,
      });
      return { ok: true };
    });

    // --- unread counters ---
    on(socket, 'conversation:read', (me, { peerId }) => {
      if (!isId(peerId) || !userModel.findById(peerId)) return fail('Invalid request.');
      messageModel.markRead(me.user_id, peerId);
      // Tell this person's other tabs so their badges clear too.
      io.to(room(me.user_id)).emit('conversation:read', { peerId });
      return { ok: true };
    });
  });
}

/* ======================================================================
   HTTP handlers
   ====================================================================== */
module.exports = {
  registerSocketHandlers,

  /** GET /chat */
  showChat(req, res) {
    res.render('chat/index', { title: 'Chats', me: req.user, maxLength: messageModel.MAX_LENGTH });
  },

  /** GET /api/me - who am I? The page uses this to notice an expired session. */
  me(req, res) {
    res.json({ ok: true, user: req.user });
  },

  /** GET /api/conversations - newest first, with unread counts and my relationship with each person. */
  conversations(req, res) {
    const relations = userModel.relationsFor(req.user.id);
    const none = userModel.relationFrom(req.user.id, null);
    const legacyAdmins = userModel.legacyAdminIds(); // old chats with them stay visible, as inactive
    const conversations = messageModel.conversationsFor(req.user.id).map((convo) => ({
      ...convo,
      peer: legacyAdmins.has(convo.peer.id) ? { ...convo.peer, status: 'inactive' } : convo.peer,
      relation: relations.get(convo.peer.id) || none,
    }));
    res.json({ ok: true, conversations });
  },

  /**
   * GET /api/messages/:peerId - messages between the signed-in user and ONE other user.
   * History is always readable by its two participants; only SENDING requires friendship.
   */
  history(req, res) {
    const peerId = parseId(req.params.peerId);
    if (!peerId) return res.status(400).json({ ok: false, error: 'Invalid user.' });

    const peer = userModel.findById(peerId);
    if (!peer || peer.user_id === req.user.id) return notFound(res, 'That person could not be found.');

    const before = typeof req.query.before === 'string' ? parseId(req.query.before) : null;
    const { messages, hasMore } = messageModel.history(req.user.id, peerId, { before, limit: PAGE_SIZE });
    return res.json({
      ok: true,
      peer: userModel.toPublic(peer),
      relation: userModel.relationBetween(req.user.id, peerId),
      messages,
      hasMore,
    });
  },

  /** GET /api/friends -> { friends, incoming, outgoing } */
  friends(req, res) {
    res.json({ ok: true, ...userModel.friendsOverview(req.user.id) });
  },

  /** GET /api/friends/search?q= -> active users (never me) with my relationship to each. */
  searchPeople(req, res) {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const relations = userModel.relationsFor(req.user.id);
    const users = userModel.search(req.user.id, q).map((user) => ({
      ...user,
      relation: relations.get(user.id) || userModel.relationFrom(req.user.id, null),
    }));
    res.json({ ok: true, users });
  },

  /** POST /api/friends/requests { userId } -> creates a PENDING request. */
  sendFriendRequest(req, res) {
    const me = userModel.findById(req.user.id);
    const targetId = parseId(req.body && req.body.userId);
    if (!targetId) return res.status(400).json({ ok: false, error: 'Choose someone to add.' });
    if (targetId === me.user_id) {
      return res.status(400).json({ ok: false, error: 'You cannot send a friend request to yourself.' });
    }

    const target = userModel.findById(targetId);
    if (!userModel.canUseApp(target)) return notFound(res, 'That person could not be found.');

    if (!requestLimiter.consume(String(me.user_id)).allowed) {
      return res.status(429).json({ ok: false, error: 'You are sending friend requests too quickly. Please try again later.' });
    }

    const result = userModel.sendRequest(me.user_id, target.user_id);
    if (!result.ok) {
      const messages = {
        friends: `You and ${target.username} are already friends.`,
        outgoing: `You already sent ${target.username} a friend request.`,
        incoming: `${target.username} already sent you a friend request. Accept it instead.`,
      };
      return res.status(409).json({ ok: false, error: messages[result.relation.state], relation: result.relation });
    }

    notifyFriendship(req, 'friend:request', result.request, me, target);
    return res.status(201).json({
      ok: true,
      user: userModel.toPublic(target),
      relation: userModel.relationBetween(me.user_id, target.user_id),
    });
  },

  /** POST /api/friends/requests/:id/accept  -> pending becomes ACCEPTED (receiver only) */
  acceptFriendRequest: respondToRequest(true),

  /** POST /api/friends/requests/:id/decline -> pending becomes declined (receiver only) */
  declineFriendRequest: respondToRequest(false),

  /** DELETE /api/friends/requests/:id -> the SENDER withdraws a pending request */
  cancelFriendRequest(req, res) {
    const row = loadRequest(req, res);
    if (!row) return undefined;
    if (row.sender_id !== req.user.id) return notFound(res, 'Friend request not found.');

    const updated = userModel.cancelRequest(req.user.id, row.friendship_id);
    if (!updated) return res.status(409).json({ ok: false, error: 'This friend request is no longer pending.' });

    const me = userModel.findById(req.user.id);
    const receiver = userModel.findById(row.receiver_id);
    notifyFriendship(req, 'friend:cancelled', updated, me, receiver);
    return res.json({ ok: true, relation: userModel.relationBetween(me.user_id, receiver.user_id) });
  },
};
