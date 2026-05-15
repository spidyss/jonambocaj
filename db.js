/* =============================================
   SQLite layer — handles persistence for the portfolio
   (Using sqlite3 + sqlite wrapper for better compatibility)
   ============================================= */

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'works.db');
const LEGACY_JSON = path.join(DATA_DIR, 'works.json');
const crypto = require('crypto');

let db;

async function initDb() {
  if (db) return db;

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  db = await open({
    filename: DB_FILE,
    driver: sqlite3.Database
  });

  // Initialize Schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS works (
      id          TEXT    PRIMARY KEY,
      title       TEXT    NOT NULL,
      tile_image  TEXT    NOT NULL DEFAULT '',
      content     TEXT    NOT NULL DEFAULT '[]',
      status      TEXT    NOT NULL DEFAULT 'published'
                  CHECK (status IN ('published','draft','unpublished')),
      position    INTEGER NOT NULL,
      created_at  TEXT    NOT NULL,
      updated_at  TEXT    NOT NULL,
      tile_aspect TEXT    NOT NULL DEFAULT '16/10',
      tags        TEXT    NOT NULL DEFAULT '[]',
      bg_color    TEXT    NOT NULL DEFAULT '#ffffff'
    );
    CREATE TABLE IF NOT EXISTS users (
      username    TEXT    PRIMARY KEY,
      password    TEXT    NOT NULL,
      salt        TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_works_status   ON works(status);
    CREATE INDEX IF NOT EXISTS idx_works_position ON works(position);
  `);

  await seedAdmin();
  await migrateFromJson();
  await migrateStatusConstraint();
  await migrateTileAspectAndTags();
  await migrateBgColor();
  await migrateSubtitleAndFeatured();
  return db;
}

async function migrateSubtitleAndFeatured() {
  try {
    const tableInfo = await db.all("PRAGMA table_info(works)");
    const cols = new Set(tableInfo.map(c => c.name));
    if (!cols.has('subtitle')) {
      console.log('[db] Migrating: Adding subtitle column...');
      await db.run("ALTER TABLE works ADD COLUMN subtitle TEXT NOT NULL DEFAULT ''");
    }
    if (!cols.has('featured')) {
      console.log('[db] Migrating: Adding featured column...');
      await db.run("ALTER TABLE works ADD COLUMN featured INTEGER NOT NULL DEFAULT 0");
      await db.run("CREATE INDEX IF NOT EXISTS idx_works_featured ON works(featured)");
    }
    if (!cols.has('text_color')) {
      console.log('[db] Migrating: Adding text_color column...');
      await db.run("ALTER TABLE works ADD COLUMN text_color TEXT NOT NULL DEFAULT ''");
    }
    if (!cols.has('tags_align')) {
      console.log('[db] Migrating: Adding tags_align column...');
      await db.run("ALTER TABLE works ADD COLUMN tags_align TEXT NOT NULL DEFAULT 'center'");
    }
    if (!cols.has('subtitle_align')) {
      console.log('[db] Migrating: Adding subtitle_align column...');
      await db.run("ALTER TABLE works ADD COLUMN subtitle_align TEXT NOT NULL DEFAULT 'center'");
    }
    if (!cols.has('subtitle_size')) {
      console.log('[db] Migrating: Adding subtitle_size column...');
      await db.run("ALTER TABLE works ADD COLUMN subtitle_size TEXT NOT NULL DEFAULT 'm'");
    }
    if (!cols.has('title_divider')) {
      console.log('[db] Migrating: Adding title_divider column...');
      await db.run("ALTER TABLE works ADD COLUMN title_divider INTEGER NOT NULL DEFAULT 0");
    }
    if (!cols.has('title_align')) {
      console.log('[db] Migrating: Adding title_align column...');
      await db.run("ALTER TABLE works ADD COLUMN title_align TEXT NOT NULL DEFAULT 'center'");
    }
    if (!cols.has('subtitle_font')) {
      console.log('[db] Migrating: Adding subtitle_font column...');
      await db.run("ALTER TABLE works ADD COLUMN subtitle_font TEXT NOT NULL DEFAULT ''");
    }
  } catch (e) {
    console.error('[db] subtitle/featured migration error:', e.message);
  }
}

// Migrate old DB that had CHECK (status IN ('published','draft')) — add 'unpublished' support
async function migrateStatusConstraint() {
  try {
    // Check current constraint by reading sqlite_master
    const tableInfo = await db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='works'`);
    if (!tableInfo) return;
    
    // If the constraint already includes unpublished, nothing to do
    if (tableInfo.sql && tableInfo.sql.includes('unpublished')) return;

    console.log('[db] Migrating status constraint to include unpublished...');

    // Use PRAGMA to disable foreign keys temporarily, then do table rebuild step by step
    await db.run('PRAGMA foreign_keys = OFF');

    await db.run('ALTER TABLE works RENAME TO works_old');

    await db.run(`
      CREATE TABLE works (
        id          TEXT    PRIMARY KEY,
        title       TEXT    NOT NULL,
        tile_image  TEXT    NOT NULL DEFAULT '',
        content     TEXT    NOT NULL DEFAULT '[]',
        status      TEXT    NOT NULL DEFAULT 'published'
                    CHECK (status IN ('published','draft','unpublished')),
        position    INTEGER NOT NULL,
        created_at  TEXT    NOT NULL,
        updated_at  TEXT    NOT NULL
      )
    `);

    await db.run(`
      INSERT INTO works (id, title, tile_image, content, status, position, created_at, updated_at)
      SELECT id, title, tile_image, content, status, position, created_at, updated_at FROM works_old
    `);
    await db.run('DROP TABLE works_old');
    await db.run('PRAGMA foreign_keys = ON');

    console.log('[db] Status constraint migration complete.');
  } catch (e) {
    console.error('[db] Status constraint migration error:', e.message);
    // Fallback: if table rebuild failed, just disable CHECK constraints via PRAGMA
    try {
      await db.run('PRAGMA ignore_check_constraints = ON');
      console.log('[db] Fallback: CHECK constraints disabled via PRAGMA.');
    } catch (_) { }
  }
}

async function migrateTileAspectAndTags() {
  try {
    const tableInfo = await db.all("PRAGMA table_info(works)");
    const hasTileAspect = tableInfo.some(c => c.name === 'tile_aspect');
    const hasTags = tableInfo.some(c => c.name === 'tags');
    
    if (!hasTileAspect) {
      console.log('[db] Migrating: Adding tile_aspect column...');
      await db.run("ALTER TABLE works ADD COLUMN tile_aspect TEXT NOT NULL DEFAULT '16/10'");
    }
    if (!hasTags) {
      console.log('[db] Migrating: Adding tags column...');
      await db.run("ALTER TABLE works ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    }
  } catch (e) {
    console.error('[db] Column migration error:', e.message);
  }
}

async function migrateBgColor() {
  try {
    const tableInfo = await db.all("PRAGMA table_info(works)");
    const hasBgColor = tableInfo.some(c => c.name === 'bg_color');
    if (!hasBgColor) {
      console.log('[db] Migrating: Adding bg_color column...');
      await db.run("ALTER TABLE works ADD COLUMN bg_color TEXT NOT NULL DEFAULT '#ffffff'");
    }
  } catch (e) {
    console.error('[db] bg_color migration error:', e.message);
  }
}

// Password Hashing Helper
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

async function seedAdmin() {
  try {
    const row = await db.get('SELECT COUNT(*) AS c FROM users');
    if (row.c > 0) return;

    console.log('[db] Seeding default admin user...');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword('admin123', salt);

    await db.run('INSERT INTO users (username, password, salt) VALUES (?, ?, ?)', ['admin', hash, salt]);
  } catch (e) {
    console.error('[db] Seeding error:', e.message);
  }
}

async function migrateFromJson() {
  try {
    const row = await db.get('SELECT COUNT(*) AS c FROM works');
    if (row.c > 0) return;
    if (!fs.existsSync(LEGACY_JSON)) return;

    console.log('[db] Found works.json, migrating to SQLite...');
    const raw = fs.readFileSync(LEGACY_JSON, 'utf8');
    const data = JSON.parse(raw);
    const works = Array.isArray(data.works) ? data.works : (Array.isArray(data) ? data : []);

    if (works.length === 0) return;

    for (let i = 0; i < works.length; i++) {
      const w = works[i];
      await db.run(`
        INSERT INTO works (id, title, tile_image, content, status, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        w.id || Math.random().toString(36).substr(2, 9),
        w.title || 'Untitled',
        w.tileImage || '',
        JSON.stringify(w.content || []),
        w.status === 'draft' ? 'draft' : (w.status === 'unpublished' ? 'unpublished' : 'published'),
        i,
        w.createdAt || new Date().toISOString(),
        w.updatedAt || w.createdAt || new Date().toISOString()
      ]);
    }

    fs.renameSync(LEGACY_JSON, LEGACY_JSON + '.bak');
    console.log(`[db] Successfully migrated ${works.length} items to SQLite.`);
  } catch (e) {
    console.error('[db] Migration error:', e.message);
  }
}

function rowToWork(row) {
  if (!row) return null;
  let content = [];
  try { content = JSON.parse(row.content); } catch (_) { }
  let tags = [];
  try { tags = JSON.parse(row.tags); } catch (_) { }
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle || '',
    featured: !!row.featured,
    tileImage: row.tile_image,
    tileAspect: row.tile_aspect || '16/10',
    bgColor: row.bg_color || '#ffffff',
    textColor: row.text_color || '',
    tagsAlign: row.tags_align || 'center',
    subtitleAlign: row.subtitle_align || 'center',
    subtitleSize: row.subtitle_size || 'm',
    titleDivider: !!row.title_divider,
    titleAlign: row.title_align || 'center',
    subtitleFont: row.subtitle_font || '',
    tags,
    content,
    status: row.status,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

module.exports = {
  async listWorks() {
    await initDb();
    // Featured works are pinned to the top; everything else falls back to admin-defined position.
    const rows = await db.all('SELECT * FROM works ORDER BY featured DESC, position ASC, created_at DESC');
    return rows.map(rowToWork);
  },
  async getWork(id) {
    await initDb();
    const row = await db.get('SELECT * FROM works WHERE id = ?', id);
    return rowToWork(row);
  },
  async createWork(w) {
    await initDb();
    const row = await db.get('SELECT COALESCE(MAX(position), -1) AS m FROM works');
    const nextPos = row.m + 1;
    await db.run(`
      INSERT INTO works (id, title, tile_image, content, status, position, created_at, updated_at, tile_aspect, tags, bg_color, subtitle, featured, text_color, tags_align, subtitle_align, subtitle_size, title_divider, title_align, subtitle_font)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      w.id,
      w.title || 'Untitled',
      w.tileImage || '',
      JSON.stringify(w.content || []),
      ['published', 'draft', 'unpublished'].includes(w.status) ? w.status : 'published',
      nextPos,
      new Date().toISOString(),
      new Date().toISOString(),
      w.tileAspect || '16/10',
      JSON.stringify(w.tags || []),
      w.bgColor || '#ffffff',
      w.subtitle || '',
      w.featured ? 1 : 0,
      w.textColor || '',
      ['left','center','right'].includes(w.tagsAlign) ? w.tagsAlign : 'center',
      ['left','center','right'].includes(w.subtitleAlign) ? w.subtitleAlign : 'center',
      ['s','m','l'].includes(w.subtitleSize) ? w.subtitleSize : 'm',
      w.titleDivider ? 1 : 0,
      ['left','center','right'].includes(w.titleAlign) ? w.titleAlign : 'center',
      typeof w.subtitleFont === 'string' ? w.subtitleFont : ''
    ]);
    return this.getWork(w.id);
  },
  async updateWork(id, data) {
    await initDb();
    const existing = await this.getWork(id);
    if (!existing) return null;

    const newStatus = data.status !== undefined ? data.status : existing.status;
    // Safety: never write an invalid status
    const safeStatus = ['published', 'draft', 'unpublished'].includes(newStatus) ? newStatus : existing.status;

    try {
      const pickAlign = v => ['left','center','right'].includes(v) ? v : null;
      const pickSize  = v => ['s','m','l'].includes(v) ? v : null;
      await db.run(`
        UPDATE works
           SET title = ?,
               tile_image = ?,
               content = ?,
               status = ?,
               updated_at = ?,
               tile_aspect = ?,
               tags = ?,
               bg_color = ?,
               subtitle = ?,
               featured = ?,
               text_color = ?,
               tags_align = ?,
               subtitle_align = ?,
               subtitle_size = ?,
               title_divider = ?,
               title_align = ?,
               subtitle_font = ?
         WHERE id = ?
      `, [
        data.title !== undefined ? data.title : existing.title,
        data.tileImage !== undefined ? data.tileImage : existing.tileImage,
        JSON.stringify(data.content !== undefined ? data.content : existing.content),
        safeStatus,
        new Date().toISOString(),
        data.tileAspect !== undefined ? data.tileAspect : existing.tileAspect,
        JSON.stringify(data.tags !== undefined ? data.tags : existing.tags),
        data.bgColor !== undefined ? data.bgColor : (existing.bgColor || '#ffffff'),
        data.subtitle !== undefined ? data.subtitle : (existing.subtitle || ''),
        data.featured !== undefined ? (data.featured ? 1 : 0) : (existing.featured ? 1 : 0),
        data.textColor !== undefined ? (data.textColor || '') : (existing.textColor || ''),
        pickAlign(data.tagsAlign) || pickAlign(existing.tagsAlign) || 'center',
        pickAlign(data.subtitleAlign) || pickAlign(existing.subtitleAlign) || 'center',
        pickSize(data.subtitleSize) || pickSize(existing.subtitleSize) || 'm',
        data.titleDivider !== undefined ? (data.titleDivider ? 1 : 0) : (existing.titleDivider ? 1 : 0),
        pickAlign(data.titleAlign) || pickAlign(existing.titleAlign) || 'center',
        data.subtitleFont !== undefined ? (typeof data.subtitleFont === 'string' ? data.subtitleFont : '') : (existing.subtitleFont || ''),
        id
      ]);
    } catch (e) {
      console.error('[db] updateWork failed for id:', id, '| status:', safeStatus, '| error:', e.message);
      throw e;
    }
    return this.getWork(id);
  },
  async deleteWork(id) {
    await initDb();
    const work = await this.getWork(id);
    if (!work) return null;
    await db.run('DELETE FROM works WHERE id = ?', id);
    return work;
  },
  async reorderWorks(ids) {
    await initDb();
    for (let i = 0; i < ids.length; i++) {
      await db.run('UPDATE works SET position = ? WHERE id = ?', [i, ids[i]]);
    }
  },
  async verifyUser(username, password) {
    await initDb();
    const user = await db.get('SELECT * FROM users WHERE username = ?', username);
    if (!user) return false;

    const hash = hashPassword(password, user.salt);
    return hash === user.password;
  }
};