require('dotenv').config();

const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const express = require('express');
const mongoose = require('mongoose');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false }
});

const PORT = Number(process.env.PORT || 3000);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mono_chat';
const JWT_SECRET = process.env.JWT_SECRET || 'development-secret-change-me';
const isProduction = process.env.NODE_ENV === 'production';

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const userSchema = new mongoose.Schema({
  name: { type: String, trim: true, minlength: 2, maxlength: 60, required: true },
  username: { type: String, trim: true, lowercase: true, unique: true, index: true, minlength: 3, maxlength: 24, required: true },
  email: { type: String, trim: true, lowercase: true, unique: true, index: true, minlength: 5, maxlength: 120, required: true },
  passwordHash: { type: String, required: true },
  lastSeen: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now }
});

const messageSchema = new mongoose.Schema({
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  text: { type: String, trim: true, minlength: 1, maxlength: 4000, required: true },
  clientId: { type: String, trim: true, maxlength: 80 },
  readAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
});
messageSchema.index({ sender: 1, recipient: 1, createdAt: -1 });
messageSchema.index({ recipient: 1, sender: 1, createdAt: -1 });

const User = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    username: user.username,
    lastSeen: user.lastSeen
  };
}

function signToken(user) {
  return jwt.sign({ sub: String(user._id) }, JWT_SECRET, { expiresIn: '7d' });
}

function setAuthCookie(res, token) {
  res.cookie('auth', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function getUserIdFromRequest(req) {
  const token = req.cookies?.auth;
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return payload.sub;
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  const userId = getUserIdFromRequest(req);
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  try {
    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ error: 'Account not found.' });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function validateRegistration({ name, username, email, password }) {
  if (!name || name.trim().length < 2 || name.trim().length > 60) return 'Name must be 2–60 characters.';
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username || '')) return 'Username must be 3–24 characters: letters, numbers and underscores only.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) return 'Enter a valid email address.';
  if (!password || password.length < 8 || password.length > 128) return 'Password must be 8–128 characters.';
  return null;
}

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    const username = normalizeUsername(req.body.username);
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');

    const validationError = validateRegistration({ name, username, email, password });
    if (validationError) return res.status(400).json({ error: validationError });

    const exists = await User.findOne({ $or: [{ username }, { email }] }).lean();
    if (exists) {
      return res.status(409).json({ error: exists.username === username ? 'That username is already in use.' : 'That email is already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({ name, username, email, passwordHash, lastSeen: new Date() });
    setAuthCookie(res, signToken(user));
    res.status(201).json({ user: publicUser(user) });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: 'Username or email is already in use.' });
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const identifier = String(req.body.identifier || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!identifier || !password) return res.status(400).json({ error: 'Enter your username/email and password.' });

    const user = await User.findOne({ $or: [{ email: identifier }, { username: identifier }] });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid login details.' });
    }
    user.lastSeen = new Date();
    await user.save();
    setAuthCookie(res, signToken(user));
    res.json({ user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const userId = getUserIdFromRequest(req);
    if (userId) {
      await User.findByIdAndUpdate(userId, { lastSeen: new Date() });
    }
    res.clearCookie('auth', { httpOnly: true, sameSite: 'lax', secure: isProduction, path: '/' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.get('/api/users', requireAuth, async (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    const filter = { _id: { $ne: req.user._id } };
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [{ name: regex }, { username: regex }];
    }
    const users = await User.find(filter).sort({ name: 1 }).limit(100).lean();
    res.json({ users: users.map(publicUser) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/conversations', requireAuth, async (req, res, next) => {
  try {
    const messages = await Message.find({ $or: [{ sender: req.user._id }, { recipient: req.user._id }] })
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
    const map = new Map();
    for (const msg of messages) {
      const partnerId = String(msg.sender) === String(req.user._id) ? String(msg.recipient) : String(msg.sender);
      if (!map.has(partnerId)) {
        map.set(partnerId, {
          partnerId,
          lastMessage: {
            id: String(msg._id),
            text: msg.text,
            createdAt: msg.createdAt,
            senderId: String(msg.sender),
            readAt: msg.readAt
          }
        });
      }
    }
    const partnerIds = [...map.keys()].map(id => new mongoose.Types.ObjectId(id));
    const users = partnerIds.length ? await User.find({ _id: { $in: partnerIds } }).lean() : [];
    const byId = new Map(users.map(u => [String(u._id), publicUser(u)]));
    const conversations = [...map.values()]
      .filter(c => byId.has(c.partnerId))
      .map(c => ({ ...c, partner: byId.get(c.partnerId) }));
    res.json({ conversations });
  } catch (error) {
    next(error);
  }
});

app.get('/api/chats/:partnerId/messages', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.partnerId)) return res.status(400).json({ error: 'Invalid user id.' });
    const partnerId = new mongoose.Types.ObjectId(req.params.partnerId);
    const before = req.query.before ? new Date(req.query.before) : null;
    const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 120);
    const query = {
      $or: [
        { sender: req.user._id, recipient: partnerId },
        { sender: partnerId, recipient: req.user._id }
      ]
    };
    if (before && !Number.isNaN(before.getTime())) query.createdAt = { $lt: before };
    const messages = await Message.find(query).sort({ createdAt: -1 }).limit(limit).lean();
    const ordered = messages.reverse().map(msg => ({
      id: String(msg._id),
      senderId: String(msg.sender),
      recipientId: String(msg.recipient),
      text: msg.text,
      createdAt: msg.createdAt,
      readAt: msg.readAt,
      clientId: msg.clientId || null
    }));
    res.json({ messages: ordered, hasMore: messages.length === limit });
  } catch (error) {
    next(error);
  }
});

app.post('/api/chats/:partnerId/read', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.partnerId)) return res.status(400).json({ error: 'Invalid user id.' });
    const partnerId = new mongoose.Types.ObjectId(req.params.partnerId);
    const now = new Date();
    const result = await Message.updateMany(
      { sender: partnerId, recipient: req.user._id, readAt: null },
      { $set: { readAt: now } }
    );
    const room = `user:${String(partnerId)}`;
    io.to(room).emit('message:read', {
      byUserId: String(req.user._id),
      partnerId: String(partnerId),
      readAt: now.toISOString()
    });
    res.json({ updated: result.modifiedCount });
  } catch (error) {
    next(error);
  }
});

app.get(/^(?!\/api\/).*/, (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const onlineCounts = new Map();

function broadcastPresence(userId, online) {
  io.emit('user:status', { userId: String(userId), online });
}

function verifySocketToken(socket) {
  const raw = socket.handshake.headers.cookie || '';
  const tokenPair = raw.split(';').map(part => part.trim()).find(part => part.startsWith('auth='));
  if (!tokenPair) return null;
  const token = decodeURIComponent(tokenPair.slice(5));
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

io.use((socket, next) => {
  const payload = verifySocketToken(socket);
  if (!payload?.sub) return next(new Error('Unauthorized'));
  socket.userId = String(payload.sub);
  next();
});

io.on('connection', async socket => {
  const userId = socket.userId;
  const room = `user:${userId}`;
  socket.join(room);
  const count = (onlineCounts.get(userId) || 0) + 1;
  onlineCounts.set(userId, count);
  if (count === 1) broadcastPresence(userId, true);
  socket.emit('presence:state', { userIds: [...onlineCounts.keys()].map(String) });
  await User.findByIdAndUpdate(userId, { lastSeen: new Date() }).catch(() => {});

  socket.on('presence:request', () => {
    socket.emit('presence:state', { userIds: [...onlineCounts.keys()].map(String) });
  });

  socket.on('message:send', async (payload, callback) => {
    try {
      const recipientId = String(payload?.recipientId || '');
      const text = String(payload?.text || '').trim();
      const clientId = String(payload?.clientId || '').slice(0, 80);
      if (!mongoose.isValidObjectId(recipientId) || recipientId === userId) throw new Error('Invalid recipient.');
      if (!text || text.length > 4000) throw new Error('Message must be 1–4000 characters.');
      const recipient = await User.findById(recipientId).select('_id').lean();
      if (!recipient) throw new Error('Recipient not found.');

      const duplicate = clientId ? await Message.findOne({ sender: userId, clientId }).lean() : null;
      if (duplicate) {
        const existing = {
          id: String(duplicate._id), senderId: userId, recipientId: String(duplicate.recipient),
          text: duplicate.text, createdAt: duplicate.createdAt, readAt: duplicate.readAt,
          clientId: duplicate.clientId || null
        };
        callback?.({ ok: true, message: existing });
        return;
      }

      const msg = await Message.create({ sender: userId, recipient: recipientId, text, clientId: clientId || undefined });
      const result = {
        id: String(msg._id),
        senderId: userId,
        recipientId,
        text: msg.text,
        createdAt: msg.createdAt,
        readAt: msg.readAt,
        clientId: msg.clientId || null
      };
      io.to(`user:${userId}`).to(`user:${recipientId}`).emit('message:new', result);
      callback?.({ ok: true, message: result });
    } catch (error) {
      callback?.({ ok: false, error: error.message || 'Unable to send message.' });
    }
  });

  socket.on('typing:start', payload => {
    const recipientId = String(payload?.recipientId || '');
    if (mongoose.isValidObjectId(recipientId)) {
      io.to(`user:${recipientId}`).emit('typing:start', { fromUserId: userId });
    }
  });

  socket.on('typing:stop', payload => {
    const recipientId = String(payload?.recipientId || '');
    if (mongoose.isValidObjectId(recipientId)) {
      io.to(`user:${recipientId}`).emit('typing:stop', { fromUserId: userId });
    }
  });

  socket.on('message:markRead', async payload => {
    const partnerId = String(payload?.partnerId || '');
    if (!mongoose.isValidObjectId(partnerId)) return;
    const now = new Date();
    await Message.updateMany({ sender: partnerId, recipient: userId, readAt: null }, { $set: { readAt: now } }).catch(() => {});
    io.to(`user:${partnerId}`).emit('message:read', { byUserId: userId, partnerId, readAt: now.toISOString() });
  });

  socket.on('disconnect', async () => {
    const remaining = (onlineCounts.get(userId) || 1) - 1;
    if (remaining <= 0) {
      onlineCounts.delete(userId);
      await User.findByIdAndUpdate(userId, { lastSeen: new Date() }).catch(() => {});
      broadcastPresence(userId, false);
    } else {
      onlineCounts.set(userId, remaining);
    }
  });
});

async function start() {
  await mongoose.connect(MONGODB_URI);
  console.log(`MongoDB connected: ${MONGODB_URI}`);
  server.listen(PORT, () => console.log(`Mono Chat running on http://localhost:${PORT}`));
}

start().catch(error => {
  console.error('Startup failed:', error);
  process.exit(1);
});
