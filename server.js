/* =============================================
   Manoj Jacob Portfolio — Express Server
   Lightweight backend for work management
   ============================================= */

const express = require('express');
const multer = require('multer');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Configuration ---
const UPLOAD_DIR = path.join(__dirname, 'public', 'image', 'works');

// Ensure directories exist
[path.join(__dirname, 'data'), UPLOAD_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- Middleware ---
app.set('trust proxy', 1); // Required for Hostinger's proxy setup
app.disable('x-powered-by');
app.use(express.json({ limit: '6mb' }));
app.use(express.urlencoded({ extended: true, limit: '6mb' }));

// --- Security headers (helmet-lite, no extra deps) ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN'); // SAMEORIGIN so our own modal iframe still works
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-XSS-Protection', '0'); // Modern browsers ignore; explicitly off per OWASP guidance
  // No HSTS here — only meaningful over HTTPS; let the proxy/CDN set it in prod.
  next();
});

// --- Cache policy ---
// API responses must never be cached: if admin unpublishes a work, a refresh
// must re-fetch and get 404, not serve a stale copy from the browser.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// HTML shells that depend on session/auth state shouldn't be served from cache either.
app.use((req, res, next) => {
  if (/\.(html?)$/i.test(req.path) || req.path === '/' || req.path === '/admin') {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // Long-cache images/fonts (immutable filenames are timestamp-prefixed)
    if (/\.(png|jpe?g|gif|webp|svg|avif|otf|ttf|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

if (!process.env.SESSION_SECRET) {
  console.warn('[security] SESSION_SECRET is not set — using a built-in fallback. Set SESSION_SECRET in prod.');
}

app.use(session({
  secret: process.env.SESSION_SECRET || 'manoj-jacob-portfolio-2026-secret',
  resave: false,
  saveUninitialized: false,
  name: 'mj_portfolio_sid', // Custom cookie name for professionalism
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // Secure only in prod
    sameSite: 'strict' // Mitigates CSRF — admin endpoints only act on same-origin requests
  }
}));

// --- Multer Setup ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = crypto.randomBytes(8).toString('hex');
    cb(null, `${Date.now()}-${name}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 25 * 1024 * 1024,   // 25MB per image
    files: 50,                     // up to 50 images per request
    fields: 100,                   // text fields
    fieldSize: 5 * 1024 * 1024     // 5MB for the JSON content blob
  },
  fileFilter: (req, file, cb) => {
    if ((file.mimetype || '').startsWith('image/')) return cb(null, true);
    const allowedExt = /\.(jpg|jpeg|png|gif|webp|svg|avif|heic|heif|bmp)$/i;
    if (allowedExt.test(path.extname(file.originalname))) return cb(null, true);
    cb(new Error(`"${file.originalname}" doesn't look like an image (mime=${file.mimetype})`));
  }
});

// --- Auth Middleware ---
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

function isAdmin(req) {
  return !!(req.session && req.session.authenticated);
}

// ID generation helper
function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// Strip HTML tags from a plain-text field. Subtitle, tags, captions, labels, attributions and
// other non-rich-text inputs should never contain HTML; if they do (from old corrupted data
// or pasted markup) it leaks as ugly literal text on the public page.
function stripHTML(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
}

// Build a sanitized content array given uploaded files and the JSON sent by the client.
// Supports block types: text, image, gallery
function processContentBlocks(rawBlocks, files) {
  const fileMap = {};
  (files || []).forEach(f => {
    fileMap[f.fieldname] = '/image/works/' + f.filename;
  });

  const allowedWidth = ['narrow', 'wide', 'full'];
  const allowedAlign = ['left', 'center', 'right'];
  const normWidth = w => allowedWidth.includes(w) ? w : 'wide';
  const normAlign = a => allowedAlign.includes(a) ? a : 'center';

  const inRowFlag = b => b && (b.inRow === true || b.inRow === 'true' || b.inRow === 1 || b.inRow === '1');

  // Server-side enforcement of the 2-block cap. We compute each block's effective inRow up front
  // so the per-block return values below can use it without re-walking the array.
  const MAX_ROW = 2;
  const effectiveInRow = [];
  let runLen = 0;
  (rawBlocks || []).forEach((b, i) => {
    if (i === 0) { effectiveInRow.push(false); runLen = 1; return; }
    if (inRowFlag(b) && runLen < MAX_ROW) { effectiveInRow.push(true); runLen++; }
    else { effectiveInRow.push(false); runLen = 1; }
  });

  return (rawBlocks || []).map((block, idx) => {
    const inRow = effectiveInRow[idx];
    // Defensive: detect block kind even if `type` arrived garbled.
    const looksLikeGallery = block.type === 'gallery' || Array.isArray(block.images);
    const looksLikeImage = block.type === 'image' || (!!block.fieldName) || (!!block.src && !looksLikeGallery);

    if (looksLikeGallery) {
      const items = Array.isArray(block.images) ? block.images : [];
      const images = items.map(img => {
        if (img.fieldName && fileMap[img.fieldName]) {
          return { src: fileMap[img.fieldName], caption: stripHTML(img.caption || '') };
        }
        return { src: img.src || '', caption: stripHTML(img.caption || '') };
      }).filter(i => i.src);
      return {
        type: 'gallery',
        images,
        layout: block.layout || 'grid',
        columns: Number.isFinite(+block.columns) && +block.columns > 0 ? +block.columns : 3,
        width: normWidth(block.width),
        align: normAlign(block.align),
        gap: Number.isFinite(+block.gap) && +block.gap >= 0 ? +block.gap : 14,
        // 'fit' = images cropped to common aspect (no empty space, may crop edges).
        // 'natural' = images keep their own aspect (may leave empty space below short ones).
        fit: ['fit','natural'].includes(block.fit) ? block.fit : 'fit',
        inRow
      };
    }

    if (looksLikeImage) {
      const fieldName = block.fieldName;
      const base = {
        type: 'image',
        caption: stripHTML(block.caption || ''),
        width: normWidth(block.width),
        align: normAlign(block.align),
        inRow
      };
      if (fieldName && fileMap[fieldName]) {
        return { ...base, src: fileMap[fieldName] };
      }
      return { ...base, src: block.src || '' };
    }

    if (block.type === 'video') {
      return {
        type: 'video',
        url: block.url || '',
        caption: stripHTML(block.caption || ''),
        width: normWidth(block.width || 'wide'),
        align: normAlign(block.align || 'center'),
        inRow
      };
    }
    // Per-block font is a free-form string; we cap length and accept any value (browser falls
     // back gracefully if the user typed a font that isn't installed on the visitor's device).
    const normFont = f => typeof f === 'string' ? f.slice(0, 200) : '';
    if (block.type === 'quote') return { type: 'quote', text: stripHTML(block.text || ''), attr: stripHTML(block.attr || ''), inRow, width: normWidth(block.width || 'narrow'), align: normAlign(block.align || 'center'), font: normFont(block.font) };
    if (block.type === 'divider') return { type: 'divider', style: block.style || 'solid', inRow, width: normWidth(block.width || 'wide'), align: normAlign(block.align || 'center') };
    if (block.type === 'label') return { type: 'label', text: stripHTML(block.text || ''), inRow, width: normWidth(block.width || 'narrow'), align: normAlign(block.align || 'center'), font: normFont(block.font) };

    return { type: 'text', value: block.value || '', align: normAlign(block.align || 'center'), width: normWidth(block.width || 'narrow'), inRow };
  });
}

// Collect every image path referenced by a work (tile + content) for cleanup
function collectImagePaths(work) {
  const list = [];
  if (work.tileImage) list.push(work.tileImage);
  (work.content || []).forEach(b => {
    if (b.type === 'image' && b.src) list.push(b.src);
    if (b.type === 'gallery' && Array.isArray(b.images)) {
      b.images.forEach(img => { if (img.src) list.push(img.src); });
    }
  });
  return list;
}

// =============================================
//  AUTH ROUTES
// =============================================

// In-memory rate limit for /api/login: 8 failures per IP per 15 min, then lock 15 min.
// Resets on successful login. Survives process lifetime only (acceptable for a single-admin site).
const loginAttempts = new Map(); // ip -> { count, firstAt, lockedUntil }
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 8;

function checkLoginRate(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { ok: true };
  if (entry.lockedUntil && now < entry.lockedUntil) {
    return { ok: false, retryAfter: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return { ok: true };
  }
  return { ok: true };
}

function recordLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, firstAt: now };
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    entry.count = 0;
    entry.firstAt = now;
  }
  entry.count++;
  if (entry.count >= LOGIN_MAX) entry.lockedUntil = now + LOGIN_WINDOW_MS;
  loginAttempts.set(ip, entry);
}

app.post('/api/login', async (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const gate = checkLoginRate(ip);
  if (!gate.ok) {
    res.setHeader('Retry-After', String(gate.retryAfter));
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil(gate.retryAfter / 60)} min.` });
  }

  const { username, password } = req.body;
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    recordLoginFailure(ip);
    return res.status(400).json({ error: 'Username and password required' });
  }

  const valid = await db.verifyUser(username, password);
  if (valid) {
    // Reset attempts and regenerate session ID to prevent session fixation
    loginAttempts.delete(ip);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: 'Login failed' });
      req.session.authenticated = true;
      req.session.user = username;
      res.json({ success: true });
    });
    return;
  }
  recordLoginFailure(ip);
  res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth-check', (req, res) => {
  res.json({ authenticated: isAdmin(req) });
});

// List every font file in /public/fonts so the admin font picker can offer them
// dynamically — drop a new .otf/.ttf/.woff into that folder and it shows up next reload.
app.get('/api/fonts', (req, res) => {
  try {
    const fontsDir = path.join(__dirname, 'public', 'fonts');
    if (!fs.existsSync(fontsDir)) return res.json([]);
    const files = fs.readdirSync(fontsDir).filter(f => /\.(otf|ttf|woff2?)$/i.test(f));
    const fonts = files.map(file => {
      const base = file.replace(/\.(otf|ttf|woff2?)$/i, '');
      // Italic detection from filename (e.g. Gotham-BookItalic, Gotham-ThinItalic)
      const isItalic = /italic/i.test(base);
      // Friendly display name: replace dashes/underscores with spaces, drop trailing "Italic"
      const family = base.replace(/[-_]+/g, ' ').replace(/\s*Italic\s*$/i, '').trim();
      const ext = file.toLowerCase();
      const format = ext.endsWith('.otf') ? 'opentype'
                    : ext.endsWith('.ttf') ? 'truetype'
                    : ext.endsWith('.woff2') ? 'woff2'
                    : 'woff';
      return {
        file: '/fonts/' + file,
        family,                 // friendly label, e.g. "Gotham Book"
        italic: isItalic,
        format
      };
    });
    res.json(fonts);
  } catch (e) {
    console.error('[fonts] list error:', e.message);
    res.status(500).json({ error: 'Failed to list fonts' });
  }
});

// Serve admin panel
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// =============================================
//  PUBLIC API
// =============================================

// Public list — drafts hidden
app.get('/api/works', async (req, res) => {
  const all = await db.listWorks();

  // Only show all works (including drafts/unpublished) if ?admin=true AND authenticated
  const showAll = req.query.admin === 'true' && isAdmin(req);
  const visible = showAll ? all : all.filter(w => w.status === 'published');

  // Featured-first sort everywhere — admin grid and public grid both surface featured at the top.
  // db.listWorks already sorted by manual `position`, so this stable-sorts featured to the front
  // while preserving each group's internal order.
  const ordered = [...visible].sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));

  const summary = ordered.map(w => ({
    id: w.id,
    title: w.title,
    subtitle: w.subtitle || '',
    tileImage: w.tileImage,
    tileAspect: w.tileAspect || '16/10',
    tags: w.tags || [],
    featured: !!w.featured,
    createdAt: w.createdAt,
    status: w.status
  }));
  res.json(summary);
});

// Single work — drafts 404 unless admin
app.get('/api/works/:id', async (req, res) => {
  const work = await db.getWork(req.params.id);
  if (!work) return res.status(404).json({ error: 'Work not found' });
  if (!isAdmin(req) && work.status !== 'published') {
    return res.status(404).json({ error: 'Work not found' });
  }
  res.json(work);
});

// =============================================
//  ADMIN API (Protected)
// =============================================

// Multer wrapper that captures errors and returns JSON instead of HTML
function uploadAny() {
  const m = upload.any();
  return (req, res, next) => m(req, res, err => {
    if (err) {
      console.error('[multer]', err.code || err.name, '-', err.message);
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'One of the images is over 10MB. Please use smaller files.'
        : err.message || 'Upload failed';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

// If a field somehow arrives as an array (duplicate FormData append, query string with repeats),
// take the last value. This protects against client-side bugs that would otherwise corrupt data
// (e.g. subtitle="hi" submitted twice arrives as ["hi","hi"] and toString() gives "hi,hi").
function lastValue(v) {
  if (Array.isArray(v)) return v[v.length - 1];
  return v;
}

// Normalize req.body once per request to collapse any duplicated multipart fields to scalars.
function dedupeBody(req, _res, next) {
  if (req.body && typeof req.body === 'object') {
    for (const k of Object.keys(req.body)) {
      req.body[k] = lastValue(req.body[k]);
    }
  }
  next();
}

function debugRequest(label, req) {
  const files = (req.files || []).map(f => ({ field: f.fieldname, name: f.originalname, size: f.size }));
  console.log(`\n[${label}] —————————————————————————————————`);
  console.log(`[${label}] body keys:`, Object.keys(req.body || {}));
  console.log(`[${label}] body.title:`, JSON.stringify(req.body.title));
  console.log(`[${label}] body.status:`, JSON.stringify(req.body.status));
  console.log(`[${label}] body.content length:`, (req.body.content || '').length);
  console.log(`[${label}] files:`, files.length, files);
  // Log block type breakdown from the raw content
  try {
    const parsed = JSON.parse(req.body.content || '[]');
    const types = parsed.map(b => b.type);
    console.log(`[${label}] block types:`, types);
    const galleries = parsed.filter(b => b.type === 'gallery');
    if (galleries.length) {
      console.log(`[${label}] gallery details:`, galleries.map(g => ({
        images: (g.images || []).length,
        fieldNames: (g.images || []).map(i => i.fieldName).filter(Boolean)
      })));
    }
  } catch (e) {
    console.log(`[${label}] content parse error:`, e.message);
  }
}

app.post('/api/works', requireAuth, uploadAny(), dedupeBody, async (req, res) => {
  try {
    debugRequest('create', req);

    const { title, tileAspect } = req.body;
    const bgColor = req.body.bgColor || '#ffffff';
    let tags = [];
    try { tags = JSON.parse(req.body.tags || '[]'); } catch (_) { }

    const status = ['draft', 'published', 'unpublished'].includes(req.body.status) ? req.body.status : 'published';

    let rawBlocks = [];
    try { rawBlocks = JSON.parse(req.body.content || '[]'); } catch (_) { }

    const content = processContentBlocks(rawBlocks, req.files);

    const tileFile = (req.files || []).find(f => f.fieldname === 'tileImage');

    const inAlign = v => ['left','center','right'].includes(v) ? v : 'center';
    const inSize  = v => ['s','m','l'].includes(v) ? v : 'm';
    const inHex   = v => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : '';

    // Strip HTML from tags too — they're plain text labels.
    const cleanTags = Array.isArray(tags) ? tags.map(t => stripHTML(String(t))).filter(Boolean) : [];

    const workData = {
      id: generateId(),
      title: title || 'Untitled',
      subtitle: stripHTML((req.body.subtitle || '').toString()).slice(0, 300),
      featured: req.body.featured === 'true' || req.body.featured === '1' || req.body.featured === true,
      titleDivider: req.body.titleDivider === 'true' || req.body.titleDivider === '1' || req.body.titleDivider === true,
      titleAlign: inAlign(req.body.titleAlign),
      subtitleFont: typeof req.body.subtitleFont === 'string' ? req.body.subtitleFont.slice(0, 200) : '',
      tileImage: tileFile ? '/image/works/' + tileFile.filename : '',
      tileAspect: tileAspect || '16/10',
      bgColor,
      textColor: inHex(req.body.textColor),
      tagsAlign: inAlign(req.body.tagsAlign),
      subtitleAlign: inAlign(req.body.subtitleAlign),
      subtitleSize: inSize(req.body.subtitleSize),
      tags: cleanTags,
      content,
      status
    };

    const work = await db.createWork(workData);

    const galleryCount = content.filter(b => b.type === 'gallery').reduce((n, b) => n + (b.images || []).length, 0);
    console.log(`[create] "${work.title}" status=${work.status} blocks=${content.length} galleryImgs=${galleryCount}`);
    res.json(work);
  } catch (err) {
    console.error('Create error:', err);
    res.status(500).json({ error: 'Failed to create work: ' + err.message });
  }
});

app.put('/api/works/:id', requireAuth, uploadAny(), dedupeBody, async (req, res) => {
  try {
    debugRequest('update', req);

    const existing = await db.getWork(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Work not found' });

    const { title, removeTileImage, tileAspect } = req.body;
    const bgColor = req.body.bgColor;
    
    let tags = existing.tags;
    if (req.body.tags !== undefined) {
      try { tags = JSON.parse(req.body.tags); } catch (_) { }
    }

    let rawBlocks = [];
    try { rawBlocks = JSON.parse(req.body.content || '[]'); } catch (_) { }

    const content = processContentBlocks(rawBlocks, req.files);
    const tileFile = (req.files || []).find(f => f.fieldname === 'tileImage');

    let tileImage = existing.tileImage;
    if (removeTileImage === 'true') tileImage = '';
    else if (tileFile) tileImage = '/image/works/' + tileFile.filename;

    const status = (['draft', 'published', 'unpublished'].includes(req.body.status))
      ? req.body.status
      : existing.status;

    const inAlign = v => ['left','center','right'].includes(v) ? v : null;
    const inSize  = v => ['s','m','l'].includes(v) ? v : null;
    const inHex   = v => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : null;

    const cleanTagsUpdate = Array.isArray(tags) ? tags.map(t => stripHTML(String(t))).filter(Boolean) : tags;

    const updated = await db.updateWork(req.params.id, {
      title: title || existing.title,
      subtitle: req.body.subtitle !== undefined ? stripHTML((req.body.subtitle || '').toString()).slice(0, 300) : existing.subtitle,
      featured: req.body.featured !== undefined
        ? (req.body.featured === 'true' || req.body.featured === '1' || req.body.featured === true)
        : existing.featured,
      titleDivider: req.body.titleDivider !== undefined
        ? (req.body.titleDivider === 'true' || req.body.titleDivider === '1' || req.body.titleDivider === true)
        : existing.titleDivider,
      titleAlign: req.body.titleAlign !== undefined ? (inAlign(req.body.titleAlign) || existing.titleAlign) : existing.titleAlign,
      subtitleFont: req.body.subtitleFont !== undefined ? (typeof req.body.subtitleFont === 'string' ? req.body.subtitleFont.slice(0, 200) : '') : existing.subtitleFont,
      tileImage,
      tileAspect: tileAspect !== undefined ? tileAspect : existing.tileAspect,
      bgColor: bgColor !== undefined ? bgColor : existing.bgColor,
      textColor: req.body.textColor !== undefined ? (inHex(req.body.textColor) || '') : existing.textColor,
      tagsAlign: req.body.tagsAlign !== undefined ? (inAlign(req.body.tagsAlign) || existing.tagsAlign) : existing.tagsAlign,
      subtitleAlign: req.body.subtitleAlign !== undefined ? (inAlign(req.body.subtitleAlign) || existing.subtitleAlign) : existing.subtitleAlign,
      subtitleSize: req.body.subtitleSize !== undefined ? (inSize(req.body.subtitleSize) || existing.subtitleSize) : existing.subtitleSize,
      tags: cleanTagsUpdate,
      content,
      status
    });

    const galleryCount = content.filter(b => b.type === 'gallery').reduce((n, b) => n + (b.images || []).length, 0);
    console.log(`[update] "${updated.title}" status=${updated.status} blocks=${content.length} galleryImgs=${galleryCount}`);
    res.json(updated);
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ error: 'Failed to update work: ' + err.message });
  }
});

app.delete('/api/works/:id', requireAuth, async (req, res) => {
  try {
    const work = await db.deleteWork(req.params.id);
    if (!work) return res.status(404).json({ error: 'Work not found' });

    // Clean up associated images
    const imagePaths = collectImagePaths(work);
    imagePaths.forEach(imgPath => {
      const fullPath = path.join(__dirname, imgPath);
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
          console.log(`Deleted image: ${fullPath}`);
        } catch (e) {
          console.error(`Cleanup error for ${fullPath}:`, e.message);
        }
      }
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Failed to delete work' });
  }
});

// Quick status-toggle endpoints
app.post('/api/works/:id/unpublish', requireAuth, async (req, res) => {
  try {
    const work = await db.updateWork(req.params.id, { status: 'unpublished' });
    if (!work) return res.status(404).json({ error: 'Work not found' });
    res.json(work);
  } catch (err) {
    res.status(500).json({ error: 'Failed to unpublish' });
  }
});

app.post('/api/works/:id/duplicate', requireAuth, async (req, res) => {
  try {
    const original = await db.getWork(req.params.id);
    if (!original) return res.status(404).json({ error: 'Work not found' });
    
    // Create an exact copy but change ID, append " Copy" to title, and set to draft
    // Image references remain the same (pointing to same files)
    const workData = {
      id: generateId(),
      title: original.title + ' Copy',
      tileImage: original.tileImage,
      tileAspect: original.tileAspect,
      bgColor: original.bgColor || '#ffffff',
      tags: original.tags,
      content: original.content,
      status: 'draft'
    };
    
    const work = await db.createWork(workData);
    res.json(work);
  } catch (err) {
    console.error('Duplicate error:', err);
    res.status(500).json({ error: 'Failed to duplicate' });
  }
});

app.post('/api/works/:id/feature', requireAuth, async (req, res) => {
  try {
    const existing = await db.getWork(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Work not found' });
    const work = await db.updateWork(req.params.id, { featured: !existing.featured });
    res.json(work);
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle featured' });
  }
});

app.post('/api/works/:id/publish', requireAuth, async (req, res) => {
  try {
    const work = await db.updateWork(req.params.id, { status: 'published' });
    if (!work) return res.status(404).json({ error: 'Work not found' });
    res.json(work);
  } catch (err) {
    res.status(500).json({ error: 'Failed to publish' });
  }
});


app.put('/api/works-order', requireAuth, async (req, res) => {
  try {
    const { order } = req.body;
    if (!Array.isArray(order)) return res.status(400).json({ error: 'Invalid order' });

    await db.reorderWorks(order);
    res.json({ success: true });
  } catch (err) {
    console.error('Reorder error:', err);
    res.status(500).json({ error: 'Failed to reorder' });
  }
});

// --- Start Server ---
db.listWorks().then(() => {
  app.listen(PORT, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║   Manoj Jacob Portfolio Server       ║');
    console.log('  ╠══════════════════════════════════════╣');
    console.log(`  ║   Site:  http://localhost:${PORT}        ║`);
    console.log(`  ║   Admin: http://localhost:${PORT}/admin  ║`);
    console.log('  ╠══════════════════════════════════════╣');
    console.log('  ║   Login: DB (users table)            ║');
    console.log('  ║   Storage: SQLite (data/works.db)    ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
  });
}).catch(err => {
  console.error('Failed to start server:', err);
});