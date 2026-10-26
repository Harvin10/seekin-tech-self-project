# Seekin Tech Self Project: guidance for Claude

A home for several small personal apps. Each app is self-contained in `apps/<app-name>/` and has its own `CLAUDE.md` with how to manage its data. Read that file before working on an app.

## Layout

- **App folder:** `apps/<app-name>/` (kebab-case) holds:
  - `public/`: what Pages serves, plus `_worker.js` when the app has an API.
  - `wrangler.toml`: Pages project name, bindings, `pages_build_output_dir = "./public"`.
  - `schema.sql`: if the app has a D1 database.
  - `package.json`: name = the folder name, with `dev` and `deploy` scripts.
  - `README.md` and `CLAUDE.md`.
- **Workspaces:** the root `package.json` is an npm workspace over `apps/*`. Add `dev:<short>` and `deploy:<short>` scripts there for each new app.
- **One app, one deploy:** each app is its own Cloudflare Pages project and its own D1 database. Apps never share a database or read each other's files.

## Adding an app

1. Create `apps/<app-name>/` with the files above.
2. For a database, create a D1 named after the app with the Cloudflare connector, apply `schema.sql`, and put its id in the app's `wrangler.toml`.
3. Add the app to the table in the root `README.md`.
4. Add the root `dev:` and `deploy:` scripts.

## Conventions every app follows

- **UI:** follows the Seekin ERP design system: `docs/design-system.md` in `Harvin10/seekin-tech-erp`.
  - Tokens, Plus Jakarta Sans, 48px targets, bottom nav with labels, and native `<dialog>` sheets that close on back.
  - `apps/papan-prioritas/public/app.css` and `boot.js` hold a working copy of the tokens and the brand-colour logic. Start a new app from those.
- **Copy:** casual Indonesian (*kamu*).
- **No build step by default:** plain HTML, CSS and JS in `public/`.
- **Login:** apps with login use the pattern in `apps/papan-prioritas/public/_worker.js`:
  - PBKDF2 passwords and an HttpOnly `__Host-sid` session cookie whose hash is stored in D1.
  - Sign-up is closed once the first account exists.
- **CSP:** strict, without `'unsafe-inline'`. Runtime styles go through `element.style`; never write `style=""` or `<style>` in markup.
- **PWA:** a manifest, icons and `sw.js`. Bump the cache `VERSION` in `sw.js` whenever app files change.

## Commits

Small commits scoped to one app, message prefixed with the app name, e.g. `papan-prioritas: add weekly view`.
