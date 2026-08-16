const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

// ── Require secrets at startup ───────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET;
const LOVE_PASSWORD  = process.env.LOVE_PASSWORD;

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

const UPLOADS_DIR = 'uploads';
const DATA_FILE   = path.join('data', 'photos.json');

// Ensure directories exist
['uploads', 'data'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// Session
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve only public static assets (css, js, assets) — no HTML, no uploads
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

// ── Public Routes ────────────────────────────────────────
app.get('/', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/gallery');
  res.sendFile(path.join(__dirname, 'views', 'index.html'));
});

// Login (rate-limited)
app.post('/api/login', loginRateLimit, (req, res) => {
  const pw = String(req.body.password || '').trim().replace(/\s/g, '');
  if (pw === LOVE_PASSWORD) {
    req.session.authenticated = true;
    // Reset rate limit on successful login
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    loginAttempts.delete(ip);
    res.json({ success: true });
  } else {
    res.json({ success: false, message: 'كلمة السر غلط يا حبيبتي 💔 جربي تاني' });
  }
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
  res.sendFile(path.join(__dirname, 'views', 'gallery.html'));
});

app.get('/upload', requireAuthPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'upload.html'));
});

// ── Protected Media Serving ──────────────────────────────
app.get('/media/:filename', requireAuth, (req, res) => {
  const name = path.basename(req.params.filename);
  const fp = path.join(__dirname, 'uploads', name);
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.sendFile(fp);
});

// ── Protected API Routes ─────────────────────────────────
app.post('/api/upload', requireAuth, upload.array('photos', 200), (req, res) => {
  if (!req.files || req.files.length === 0)
    return res.status(400).json({ success: false, message: 'مفيش ملفات اتحملت' });

  let captions = {}, albums = {};
  try {
    if (req.body.captions) captions = JSON.parse(req.body.captions);
    if (typeof captions !== 'object' || Array.isArray(captions)) captions = {};
  } catch { captions = {}; }
  try {
    if (req.body.albums) albums = JSON.parse(req.body.albums);
    if (typeof albums !== 'object' || Array.isArray(albums)) albums = {};
  } catch { albums = {}; }

  const photos = loadPhotos();
  const added = req.files.map((f, i) => {
    const isVideo = /\.(mp4|mov|avi)$/i.test(f.filename);
    const isAudio = /\.(mp3|m4a|wav|aac|ogg)$/i.test(f.filename);
    const entry = {
      id: `${Date.now()}_${i}`,
      filename: f.filename,
      path: '/media/' + f.filename,
      type: isAudio ? 'audio' : (isVideo ? 'video' : 'image'),
      caption: String(captions[i] || '').slice(0, 200),
      album: String(albums[i] || (isAudio ? 'songs' : (isVideo ? 'videos' : ''))).slice(0, 50),
      uploadedAt: new Date().toISOString()
    };
    photos.push(entry);
    return entry;
  });
  savePhotos(photos);
  res.json({ success: true, files: added });
});

app.patch('/api/photos/:filename', requireAuth, (req, res) => {
  const name = path.basename(req.params.filename);
  const photos = loadPhotos();
  const photo  = photos.find(p => p.filename === name);
  if (!photo) return res.status(404).json({ success: false });
  if (req.body.album   !== undefined) photo.album   = String(req.body.album).slice(0, 50);
  if (req.body.caption !== undefined) photo.caption = String(req.body.caption).slice(0, 200);
  savePhotos(photos);
  res.json({ success: true });
});

app.get('/api/photos', requireAuth, (req, res) => {
  res.json({ photos: loadPhotos() });
});

app.delete('/api/photos/:filename', requireAuth, (req, res) => {
  const name = path.basename(req.params.filename);
  const photos = loadPhotos();
  const idx = photos.findIndex(p => p.filename === name);
  if (idx === -1) return res.status(404).json({ success: false });
  photos.splice(idx, 1);
  savePhotos(photos);
  const fp = path.join(__dirname, 'uploads', name);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  res.json({ success: true });
});

app.get('/api/qrcode', requireAuth, async (req, res) => {
  const qr = await QRCode.toDataURL('https://hana-youssef.website', {
    color: { dark: '#ff6b9d', light: '#0d0014' },
    width: 300
  });
  res.json({ qr });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`💕 Love is running on port ${PORT} — for Hana Youssef forever 💕`);
});
