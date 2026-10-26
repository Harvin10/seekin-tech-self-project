# Seekin Tech Self Project

Personal apps, each in its own folder under `apps/`. Every app is its own Cloudflare Pages project with its own D1 database, so one app can be deployed, rolled back or deleted without touching the others.

| App | Folder | What it does |
|---|---|---|
| Papan Prioritas | [`apps/papan-prioritas`](apps/papan-prioritas) | Eisenhower matrix, to-do list and calendar (PWA, login, D1) |

## Deploying an app from GitHub

One Pages project per app:

1. In Cloudflare, go to **Workers & Pages → Create → Pages → Connect to Git** and pick this repo.
2. Set **Root directory** to the app's folder, for example `apps/papan-prioritas`.
3. Leave **Build command** empty and set **Build output directory** to `public`.
4. Under **Build watch paths**, include only `apps/papan-prioritas/*`, so a push to another app does not redeploy this one.

Each app's own README has the details, including deploying from your computer with wrangler.

## Local development

```sh
npm install            # installs wrangler for every app (npm workspaces)
npm run dev:papan      # http://localhost:8788
```

## Adding an app

See `CLAUDE.md`.
