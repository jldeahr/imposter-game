# Imposter Game

A lightweight, mobile-first party game for a high-school youth group. Over three rounds, normal players give clues about a secret word while randomly selected imposters bluff using only the public category.

The app is deliberately small: Vite, TypeScript, CSS, and a lightweight QR-code package. It has no accounts, analytics, cookies, database, ads, or production SaaS dependencies.

## Local development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open the URL printed by Vite. Create a room, add demo players from the host dashboard, and use each player’s role link to simulate passing a phone around.

## Tests and production build

```bash
npm test
npm run build
npm run preview
```

The Vite base path is `/imposter-game/`, matching the GitHub Pages project URL. Navigation uses URL hashes (`#/host/...`, `#/join/...`, and `#/play/...`), so refreshing or opening a route directly does not require server-side routing.

## GitHub Pages deployment

The workflow in `.github/workflows/deploy-pages.yml` installs dependencies, runs tests, builds the app, uploads `dist`, and deploys it.

### Initial GitHub configuration

1. Open `https://github.com/jldeahr/imposter-game` on GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source → GitHub Actions**.
4. Push to the default branch (`master` for this checkout).
5. Open the **Actions** tab and verify that **Test, build, and deploy to GitHub Pages** succeeds.
6. Once deployed, open `https://jldeahr.github.io/imposter-game/`.

If deployment does not start, verify that GitHub Pages is enabled for the repository and that the workflow still has its Pages-specific `pages: write` and `id-token: write` permissions. Those permissions are scoped only to the deployment job; broad repository write permissions are not needed.

The deployed URL will be `https://jldeahr.github.io/imposter-game/`.

## Architecture

- `src/config/gameConfig.ts` contains all three categories and secret words plus player/timer limits.
- `src/domain/` contains framework-independent imposter selection, room limits, round progression, scoring, and timer logic.
- `src/services/GameService.ts` is the boundary between the UI and multiplayer state.
- `src/services/LocalGameService.ts` is the current same-browser demo implementation.
- `src/main.ts` contains the hash router and views; `src/style.css` contains the design system and responsive layout.

The UI only calls the `GameService` interface. A future remote service can replace `LocalGameService` without rewriting the screens or game rules.

## Current multiplayer limitation

This version is a **same-device demo**, not networked multiplayer. One room is stored in `localStorage` so host and player views can be tested in the same browser. A player ID is also stored in `sessionStorage` after joining. Neither storage mechanism synchronizes between phones, and the interface says so explicitly.

The QR code renders the eventual public join URL, but scanning it on another phone cannot find the room until a shared backend exists.

## Backend contract still needed

A small serverless backend and a remote `GameService` implementation should eventually provide:

- create a room with an expiration time;
- join a room, capped at 25 players;
- list and remove players for the host;
- start each round and securely create private assignments;
- return only the requesting player’s private assignment;
- reveal a round, record scores, and advance/reset the game;
- let clients receive or poll for state changes; and
- automatically expire old rooms and their temporary names/state.

The backend—not the static GitHub Pages bundle—must be authoritative for secret assignments and shared room state. A modest serverless function plus a short-lived key/value store is enough; no accounts or permanent player history are needed.

## Privacy

The app collects no contact details, location, analytics, fingerprints, or persistent history. The demo stores only the current local room, nicknames, game state, and the joining tab’s player ID. Resetting creates fresh state, and clearing site storage removes it entirely. The future backend should expire rooms automatically.
