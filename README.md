# Manoj Jacob Portfolio

Express + SQLite portfolio site with a custom admin CMS for managing project work
(text, image, gallery, video, quote, divider, label blocks with per-block width,
alignment, fonts, and Behance-style side-by-side rows).

## Quick start

```bash
npm install
node server.js
```

- Public site: http://localhost:3000
- Admin: http://localhost:3000/admin
- Default admin credentials: **`admin` / `admin123`** — change these immediately
  in production (they're seeded by `db.js` on first run if the `users` table is empty).

## Stack

- **Backend:** Express, multer (uploads), express-session, SQLite (via `sqlite` + `sqlite3`)
- **Frontend:** Vanilla HTML/CSS/JS — no framework, no build step. Fonts via local Gotham family + Google Fonts.
- **Storage:** `data/works.db` (SQLite). Uploaded images live in `public/image/works/`.

## Project layout

```
.
├─ server.js                # Express app, routes, middleware
├─ db.js                    # SQLite schema + migrations + queries
├─ data/
│  └─ works.db              # SQLite database (committed in this snapshot)
└─ public/
   ├─ index.html            # Landing
   ├─ work.html             # Work grid + modal
   ├─ work-detail.html      # Project detail page (also rendered inside the work modal)
   ├─ admin.html            # Admin CMS (single page, no build)
   ├─ profile.html, bio.html, awards.html, brands.html, work-experience.html
   ├─ style.css             # Shared public styles + Gotham @font-face
   ├─ fonts/                # Gotham family (Black, Bold, Book, Light, Thin, etc.)
   └─ image/                # Site images + per-project uploads under image/works/
```

## Environment

| Var               | Purpose                                                                                 |
|-------------------|-----------------------------------------------------------------------------------------|
| `PORT`            | Server port (default `3000`)                                                            |
| `NODE_ENV`        | Set to `production` to enable secure session cookies + HSTS                             |
| `SESSION_SECRET`  | **Set this in production** — falls back to a built-in string with a console warning     |

## Security notes (read before deploying)

- The seeded admin creds (`admin`/`admin123`) are intended for first login only — change the password before exposing the site. Easiest way: log in, change via SQL (no UI for it yet), or wipe and re-seed.
- Sessions use `httpOnly`, `sameSite: strict`, and `secure` in production.
- Login route has in-memory rate-limiting (8 failures per IP / 15-min window → 15-min lockout).
- API responses + admin HTML are `Cache-Control: no-store` so unpublishing a work takes effect on refresh (no stale snapshot risk).
- Plain-text fields (subtitle / tags / captions / labels / quote text + attr) are HTML-stripped on save and again on render — defense in depth against past data with leaked `<span>` markup.

## Reset / fresh start

To clear all works and start from scratch:
```bash
rm data/works.db data/works.db-journal data/works.db-wal data/works.db-shm 2>/dev/null
rm -rf public/image/works/*
node server.js   # recreates schema + reseeds admin/admin123
```

## License

Private — all rights reserved.
