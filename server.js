const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const QRCode = require('qrcode');
const sharp = require('sharp');
const { MongoClient } = require('mongodb');
const { MongoStore } = require('connect-mongo');
const execFileAsync = promisify(execFile);

// ── Require secrets at startup ───────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET;
// Keep the same normalization on both sides of the comparison. Besides
// trimming accidental whitespace, accept Arabic/Persian numerals typed from
// an Arabic mobile keyboard as their Western digit equivalents.
function normalizePassword(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[٠-٩]/g, char => String(char.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, char => String(char.charCodeAt(0) - 0x6f0))
    .replace(/\s/g, '')
    .trim();
}

const LOVE_PASSWORD  = normalizePassword(process.env.LOVE_PASSWORD);

if (!SESSION_SECRET) {
  console.error('ERROR: SESSION_SECRET environment secret is not set. Please configure it.');
  process.exit(1);
}
if (!LOVE_PASSWORD) {
  console.error('ERROR: LOVE_PASSWORD environment secret is not set. Please configure it.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000;
app.set('trust proxy', 1);

const UPLOADS_DIR = 'uploads';
const DATA_FILE   = path.join('data', 'photos.json');
const MESSAGES_FILE = path.join('data', 'messages.json');
const EVENTS_FILE   = path.join('data', 'events.json');
const ATTACHED_MESSAGES_FILE = path.join('attached_assets', 'Pasted---1789748032217_1789748032218.txt');
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB  = process.env.MONGODB_DB || 'hana_youssef';
let mongoClient = null;
let mongoDb = null;

// Ensure directories exist
['uploads', 'data'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Session
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'hana.sid',
  ...(MONGODB_URI ? {
    store: MongoStore.create({
      mongoUrl: MONGODB_URI,
      dbName: MONGODB_DB,
      collectionName: 'sessions',
      ttl: 7 * 24 * 60 * 60
    })
  } : {}),
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve only public static assets (css, js, assets) — no HTML, no uploads.
// Media files below have their own long-lived cache headers; keep UI files
// revalidating so new releases are visible immediately.
app.use(express.static('public'));

// ── Simple in-memory rate limiter for login ──────────────
const loginAttempts = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT = 10;           // max attempts
const RATE_WINDOW = 10 * 60 * 1000; // 10 minutes

function loginRateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
    loginAttempts.set(ip, entry);
  }
  if (entry.count >= RATE_LIMIT) {
    const wait = Math.ceil((entry.resetAt - now) / 60000);
    return res.status(429).json({ success: false, message: `كتير أوي! استني ${wait} دقيقة يا حبيبتي 💔` });
  }
  entry.count++;
  next();
}

// ── Auth Middleware ──────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'غير مصرح' });
}

function requireAuthPage(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.redirect('/');
}

// ── Multer — stores outside public/ ─────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}_${Math.random().toString(36).substr(2, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/\.(jpg|jpeg|png|gif|webp|mp4|mov|avi|mp3|m4a|wav|aac|ogg)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error('نوع الملف مش مدعوم'));
  }
});

// ── Photo Metadata ───────────────────────────────────────
function loadPhotos() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return []; }
}
function savePhotos(photos) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(photos, null, 2));
}
function loadList(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}
function saveList(file, values) {
  fs.writeFileSync(file, JSON.stringify(values, null, 2));
}

function mediaDocument(entry) {
  return {
    ...entry,
    kind: 'media',
    category: String(entry.category || entry.album || '').slice(0, 50)
  };
}

async function initDatabase() {
  if (!MONGODB_URI) {
    console.warn('⚠️ MONGODB_URI is not set; using the local JSON store.');
    return;
  }

  mongoClient = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  });
  await mongoClient.connect();
  mongoDb = mongoClient.db(MONGODB_DB);

  const memories = mongoDb.collection('memories');
  await memories.createIndex({ kind: 1, uploadedAt: -1 });
  await mongoDb.collection('messages').createIndex({ createdAt: -1 });
  await mongoDb.collection('events').createIndex({ date: 1 });

  const mediaCount = await memories.countDocuments({ kind: 'media' });
  if (mediaCount === 0) {
    const legacy = loadPhotos();
    if (legacy.length > 0) {
      await memories.insertMany(legacy.map(mediaDocument), { ordered: false });
      console.log(`✅ Migrated ${legacy.length} media records to MongoDB`);
    }
  }
  console.log(`✅ MongoDB connected — database: ${MONGODB_DB}`);
}

async function listMedia() {
  if (!mongoDb) return loadPhotos();
  return mongoDb.collection('memories')
    .find({ kind: 'media' }, { projection: { _id: 0 } })
    .sort({ uploadedAt: -1 })
    .toArray();
}

async function insertMedia(entries) {
  if (mongoDb) {
    await mongoDb.collection('memories').insertMany(entries.map(mediaDocument), { ordered: true });
    return;
  }
  const photos = loadPhotos();
  savePhotos(photos.concat(entries));
}

async function updateMedia(filename, changes) {
  if (mongoDb) {
    return mongoDb.collection('memories').updateOne(
      { kind: 'media', filename },
      { $set: changes }
    );
  }
  const photos = loadPhotos();
  const photo = photos.find(p => p.filename === filename);
  if (!photo) return { matchedCount: 0 };
  Object.assign(photo, changes);
  savePhotos(photos);
  return { matchedCount: 1 };
}

async function removeMedia(filename) {
  if (mongoDb) {
    return mongoDb.collection('memories').deleteOne({ kind: 'media', filename });
  }
  const photos = loadPhotos();
  const idx = photos.findIndex(p => p.filename === filename);
  if (idx === -1) return { deletedCount: 0 };
  photos.splice(idx, 1);
  savePhotos(photos);
  return { deletedCount: 1 };
}

async function listMessages() {
  if (!mongoDb) return loadList(MESSAGES_FILE)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return mongoDb.collection('messages')
    .find({}, { projection: { _id: 0 } })
    .sort({ createdAt: -1 })
    .toArray();
}

async function createMessage(message) {
  if (!mongoDb) {
    const messages = loadList(MESSAGES_FILE);
    messages.push(message);
    saveList(MESSAGES_FILE, messages);
    return message;
  }
  await mongoDb.collection('messages').insertOne(message);
  return message;
}

async function removeMessage(id) {
  if (!mongoDb) {
    const messages = loadList(MESSAGES_FILE);
    const remaining = messages.filter(message => message.id !== id);
    saveList(MESSAGES_FILE, remaining);
    return { deletedCount: messages.length - remaining.length };
  }
  return mongoDb.collection('messages').deleteOne({ id });
}

async function listEvents() {
  if (!mongoDb) return loadList(EVENTS_FILE)
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || ''))
      || String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return mongoDb.collection('events')
    .find({}, { projection: { _id: 0 } })
    .sort({ date: 1, createdAt: -1 })
    .toArray();
}

async function createEvent(event) {
  if (!mongoDb) {
    const events = loadList(EVENTS_FILE);
    events.push(event);
    saveList(EVENTS_FILE, events);
    return event;
  }
  await mongoDb.collection('events').insertOne(event);
  return event;
}

async function removeEvent(id) {
  if (!mongoDb) {
    const events = loadList(EVENTS_FILE);
    const remaining = events.filter(event => event.id !== id);
    saveList(EVENTS_FILE, remaining);
    return { deletedCount: events.length - remaining.length };
  }
  return mongoDb.collection('events').deleteOne({ id });
}

function splitMessageText(text, maxLength = 3600) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf(' ', maxLength);
    if (cut < Math.floor(maxLength * 0.65)) cut = maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function seedAttachedMessages() {
  const seedKey = 'attached-love-messages';
  let alreadySeeded;
  if (mongoDb) {
    alreadySeeded = await mongoDb.collection('messages').countDocuments({ seedKey });
  } else {
    alreadySeeded = loadList(MESSAGES_FILE).some(message => message.seedKey === seedKey);
  }
  if (alreadySeeded || !fs.existsSync(ATTACHED_MESSAGES_FILE)) return;

  const raw = fs.readFileSync(ATTACHED_MESSAGES_FILE, 'utf8').trim();
  const start = raw.indexOf('عايز اقولك');
  const loveText = start >= 0 ? raw.slice(start) : raw;
  const chunks = splitMessageText(loveText);
  if (!chunks.length) return;

  const seeded = chunks.map((body, index) => ({
    id: `${seedKey}-${index + 1}`,
    seedKey,
    title: `رسالة من قلبي ليكي ${index + 1}`,
    body: body.slice(0, 5000),
    category: 'حبنا',
    memoryDate: '',
    createdAt: new Date().toISOString()
  }));
  if (mongoDb) {
    await mongoDb.collection('messages').insertMany(seeded, { ordered: true });
  } else {
    saveList(MESSAGES_FILE, loadList(MESSAGES_FILE).concat(seeded));
  }
  console.log(`✅ Added ${chunks.length} written memories from the attached messages`);
}

// ── Public Routes ────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/gallery');
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Login (rate-limited)
app.post('/api/login', loginRateLimit, (req, res) => {
  const pw = normalizePassword(req.body.password);
  if (pw !== LOVE_PASSWORD) {
    res.json({ success: false, message: 'كلمة السر غلط يا حبيبتي 💔 جربي تاني' });
    return;
  }

  // Always create a fresh session after a successful login. This avoids
  // stale/invalid cookies preventing the browser from reaching the gallery.
  req.session.regenerate(err => {
    if (err) {
      console.error('Login session could not be created:', err.message);
      return res.status(500).json({ success: false, message: 'تعذر فتح الجلسة. جربي مرة أخرى.' });
    }
    req.session.authenticated = true;
    req.session.save(saveErr => {
      if (saveErr) {
        console.error('Login session could not be saved:', saveErr.message);
        return res.status(500).json({ success: false, message: 'تعذر حفظ الدخول. جربي مرة أخرى.' });
      }
      // Reset rate limit on successful login.
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      loginAttempts.delete(ip);
      res.set('Cache-Control', 'no-store');
      res.json({ success: true });
    });
  });
});

app.get('/api/check-auth', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ── Protected HTML Pages ─────────────────────────────────
app.get('/gallery', requireAuthPage, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'views', 'gallery.html'));
});

app.get('/upload', requireAuthPage, (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.sendFile(path.join(__dirname, 'views', 'upload.html'));
});

// ── Thumbnail generation ─────────────────────────────────
async function makeThumb(filename) {
  const src = path.join(UPLOADS_DIR, filename);
  const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(filename);
  const isVideo = /\.(mp4|mov|avi)$/i.test(filename);
  if (!isImage && !isVideo) return null;

  const thumbName = 'thumb_' + filename.replace(/\.[^.]+$/, '') + (isVideo ? '.jpg' : '.webp');
  const dst = path.join(UPLOADS_DIR, thumbName);
  try {
    if (isImage) {
      await sharp(src).rotate().resize(640, 640, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(dst);
    } else {
      try {
        await execFileAsync('ffmpeg', [
          '-y', '-ss', '00:00:01', '-i', src, '-frames:v', '1',
          '-vf', 'scale=640:-2', '-q:v', '4', dst
        ], { timeout: 30000 });
      } catch {
        // Very short clips may not have a frame at one second.
        await execFileAsync('ffmpeg', [
          '-y', '-ss', '00:00:00', '-i', src, '-frames:v', '1',
          '-vf', 'scale=640:-2', '-q:v', '4', dst
        ], { timeout: 30000 });
      }
    }
    return '/media/' + thumbName;
  } catch (e) {
    console.error('Preview failed for', filename, e.message);
    return null;
  }
}

// ── Protected Media Serving (cached) ─────────────────────
app.get('/media/:filename', requireAuth, (req, res) => {
  const name = path.basename(req.params.filename);
  const fp = [
    path.join(__dirname, 'uploads', name),
    path.join(__dirname, 'attached_assets', name)
  ].find(candidate => fs.existsSync(candidate));
  if (!fp) return res.status(404).send('Not found');
  res.sendFile(fp, { maxAge: '7d', immutable: true });
});

// ── Protected API Routes ─────────────────────────────────
app.post('/api/upload', requireAuth, upload.array('photos', 200), async (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ success: false, message: 'مفيش ملفات اتحملت' });

  let captions = {}, albums = {}, categories = {}, dates = {};
  try {
    if (req.body.captions) captions = JSON.parse(req.body.captions);
    if (typeof captions !== 'object' || Array.isArray(captions)) captions = {};
  } catch { captions = {}; }
  try {
    if (req.body.albums) albums = JSON.parse(req.body.albums);
    if (typeof albums !== 'object' || Array.isArray(albums)) albums = {};
  } catch { albums = {}; }
  try {
    if (req.body.categories) categories = JSON.parse(req.body.categories);
    if (typeof categories !== 'object' || Array.isArray(categories)) categories = {};
  } catch { categories = {}; }
  try {
    if (req.body.dates) dates = JSON.parse(req.body.dates);
    if (typeof dates !== 'object' || Array.isArray(dates)) dates = {};
  } catch { dates = {}; }

  const thumbs = await Promise.all(req.files.map(f => makeThumb(f.filename)));
  const added = req.files.map((f, i) => {
    const isVideo = /\.(mp4|mov|avi)$/i.test(f.filename);
    const isAudio = /\.(mp3|m4a|wav|aac|ogg)$/i.test(f.filename);
    const category = String(categories[i] || albums[i] || (isAudio ? 'songs' : (isVideo ? 'videos' : ''))).slice(0, 50);
    const entry = {
      id: `${Date.now()}_${i}`,
      filename: f.filename,
      path: '/media/' + f.filename,
      type: isAudio ? 'audio' : (isVideo ? 'video' : 'image'),
      thumb: thumbs[i] || undefined,
      caption: String(captions[i] || '').slice(0, 200),
      album: category,
      category,
      memoryDate: String(dates[i] || '').slice(0, 30),
      poster: isVideo ? (thumbs[i] || '/assets/hana-hero.png') : undefined,
      uploadedAt: new Date().toISOString()
    };
    return entry;
  });
  await insertMedia(added);
  res.json({ success: true, files: added });
});

app.patch('/api/photos/:filename', requireAuth, async (req, res) => {
  const name = path.basename(req.params.filename);
  const changes = {};
  if (req.body.album !== undefined) changes.album = String(req.body.album).slice(0, 50);
  if (req.body.category !== undefined) changes.category = String(req.body.category).slice(0, 50);
  if (req.body.caption !== undefined) changes.caption = String(req.body.caption).slice(0, 200);
  if (req.body.memoryDate !== undefined) changes.memoryDate = String(req.body.memoryDate).slice(0, 30);
  const result = await updateMedia(name, changes);
  if (!result.matchedCount) return res.status(404).json({ success: false });
  res.json({ success: true });
});

app.get('/api/photos', requireAuth, async (req, res) => {
  res.json({ photos: await listMedia() });
});

app.delete('/api/photos/:filename', requireAuth, async (req, res) => {
  const name = path.basename(req.params.filename);
  const result = await removeMedia(name);
  if (!result.deletedCount) return res.status(404).json({ success: false });
  const fp = path.join(__dirname, 'uploads', name);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  const tp = path.join(__dirname, 'uploads', 'thumb_' + name.replace(/\.[^.]+$/, '') + '.webp');
  if (fs.existsSync(tp)) fs.unlinkSync(tp);
  res.json({ success: true });
});

// ── Written memories and date events ───────────────────────
app.get('/api/messages', requireAuth, async (req, res) => {
  res.json({ messages: await listMessages() });
});

app.post('/api/messages', requireAuth, async (req, res) => {
  const body = String(req.body.body || '').trim().slice(0, 5000);
  if (!body) return res.status(400).json({ success: false, message: 'اكتبي الرسالة أولًا' });
  const message = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title: String(req.body.title || 'ذكرياتنا الكتابية').trim().slice(0, 120),
    body,
    category: String(req.body.category || 'حبنا').slice(0, 50),
    memoryDate: String(req.body.memoryDate || '').slice(0, 30),
    createdAt: new Date().toISOString()
  };
  await createMessage(message);
  res.json({ success: true, message });
});

app.delete('/api/messages/:id', requireAuth, async (req, res) => {
  const result = await removeMessage(String(req.params.id));
  res.json({ success: !!result.deletedCount });
});

app.get('/api/events', requireAuth, async (req, res) => {
  res.json({ events: await listEvents() });
});

app.post('/api/events', requireAuth, async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const date = String(req.body.date || '').slice(0, 30);
  if (!title || !date) return res.status(400).json({ success: false, message: 'اكتبي اسم وتاريخ المناسبة' });
  const event = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    title,
    date,
    note: String(req.body.note || '').trim().slice(0, 500),
    createdAt: new Date().toISOString()
  };
  await createEvent(event);
  res.json({ success: true, event });
});

app.delete('/api/events/:id', requireAuth, async (req, res) => {
  const result = await removeEvent(String(req.params.id));
  res.json({ success: !!result.deletedCount });
});

app.get('/api/qrcode', requireAuth, async (req, res) => {
  const qr = await QRCode.toDataURL('https://hana-youssef.website', {
    color: { dark: '#ff6b9d', light: '#0d0014' },
    width: 300
  });
  res.json({ qr });
});

// ── Backfill thumbnails and start after the data store is ready ──
async function backfillThumbs() {
  const photos = loadPhotos();
  let changed = false;
  for (const p of photos) {
    if ((p.type === 'image' || p.type === 'video') && !p.thumb) {
      const t = await makeThumb(p.filename);
      if (t) {
        p.thumb = t;
        if (p.type === 'video') p.poster = t;
        changed = true;
      }
    }
  }
  if (changed) { savePhotos(photos); console.log('✅ Thumbnails backfilled'); }
}

async function backfillMongoThumbs() {
  if (!mongoDb) return;
  const photos = await listMedia();
  let count = 0;
  for (const photo of photos) {
    if ((photo.type !== 'image' && photo.type !== 'video') || photo.thumb) continue;
    const thumb = await makeThumb(photo.filename);
    if (thumb) {
      await updateMedia(photo.filename, {
        thumb,
        ...(photo.type === 'video' ? { poster: thumb } : {})
      });
      count++;
    }
  }
  if (count) console.log(`✅ Generated ${count} media previews`);
}

async function start() {
  await backfillThumbs();
  await initDatabase();
  await seedAttachedMessages();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`💕 Love is running on port ${PORT} — for Hana Youssef forever 💕`);
    backfillMongoThumbs().catch(error => console.error('Preview backfill failed:', error.message));
  });
}

start().catch(error => {
  console.error('ERROR: data store could not start:', error.message);
  process.exit(1);
});
