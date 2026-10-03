# Imposter Game

A lightweight, mobile-first party game for a high-school youth group. Over three rounds, normal players give clues about a secret word while randomly selected imposters bluff using only the public category.

The app is deliberately small: Vite, TypeScript, CSS, and a lightweight QR-code package. It has no accounts, analytics, cookies, database, ads, or production SaaS dependencies.

## Local development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Open the URL printed by Vite. Create a room, configure the category and secret word for each of the three rounds, add demo players, and open player views in separate tabs to exercise automatic phase updates and private in-app voting.

## Tests and production build

```bash
npm test
npm run build
npm run preview
```

The Vite base path is `/imposter-game/`, matching the GitHub Pages project URL. Navigation uses URL hashes (`#/host/...`, `#/join/...`, and `#/play/...`), so refreshing or opening a route directly does not require server-side routing.

## GitHub Pages deployment

The workflow in `.github/workflows/deploy-pages.yml` installs dependencies, runs the application and Firebase rules tests, builds the app, deploys Realtime Database rules, and then deploys `dist`. Pages deployment cannot proceed if the rules deployment fails.

### Initial GitHub configuration

1. Open `https://github.com/jldeahr/imposter-game` on GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source → GitHub Actions**.
4. Push to the default branch (`master` for this checkout).
5. Open the **Actions** tab and verify that **Test, build, and deploy to GitHub Pages** succeeds.
6. Once deployed, open `https://jldeahr.github.io/imposter-game/`.

### Firebase deployment authentication

The workflow uses Google Workload Identity Federation so it does not need a long-lived service-account key. Configure these GitHub Actions repository secrets before running a production deployment:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`: the complete provider resource name, such as `projects/123456789/locations/global/workloadIdentityPools/github/providers/imposter-game`.
- `GCP_SERVICE_ACCOUNT`: the service-account email that GitHub Actions may impersonate.

Grant that service account the Firebase Rules Admin role (`roles/firebaserules.admin`) on project `imposter-game-6c060`, and grant the repository's Workload Identity principal permission to impersonate it. The provider should restrict access to this repository. Without those secrets, GitHub cannot deploy `database.rules.json` and the release job will stop before publishing the site.

If deployment does not start, verify that GitHub Pages is enabled for the repository and that the workflow still has its Pages-specific `pages: write` and `id-token: write` permissions. Those permissions are scoped only to the deployment job; broad repository write permissions are not needed.

The deployed URL will be `https://jldeahr.github.io/imposter-game/`.

## Architecture

- `src/config/gameConfig.ts` contains the default round configuration plus timer/runoff settings. Each room receives its own editable copy of the three rounds.
- `src/domain/` contains framework-independent imposter-count selection, random assignments, vote tallying, round progression, scoring, and timer logic.
- `src/services/GameService.ts` is the boundary between the UI and multiplayer state.
- `src/services/LocalGameService.ts` is the current same-browser demo implementation. It owns validated room-specific round setup, configuration locking, the phase state machine, private ballots, monotonic versions, and subscriptions.
- `src/main.ts` contains the hash router and views; `src/style.css` contains the design system and responsive layout.

The UI only calls the `GameService` interface. A future remote service can replace `LocalGameService` without rewriting the screens or game rules.

## Current multiplayer limitation

This version is a **same-browser demo**, not networked multiplayer. One room is stored in `localStorage`; a custom event updates views in the current tab and the browser `storage` event updates other tabs. A monotonic room version rejects stale notifications. This does not synchronize separate phones, and the interface says so explicitly.

The QR code renders the eventual public join URL, but scanning it on another phone cannot find the room until a shared backend exists.

## Backend contract still needed

A small serverless backend and a remote `GameService` implementation should eventually provide:

- create a room with an expiration time;
- join a room without a configured hard capacity;
- list and remove players for the host;
- securely store host-configured rounds, authorize host-only setup access, and lock configuration once play starts;
- start each round and securely create private assignments using the automatic 1/2/3 imposter thresholds;
- return only the requesting player’s private assignment;
- accept private ballots, tally/run off votes, resolve results, record scoring, and advance/reset the game;
- push versioned state changes with WebSockets, Server-Sent Events, or polling; and
- automatically expire old rooms and their temporary names/state.

The backend—not the static GitHub Pages bundle—must be authoritative for secret assignments and shared room state. A modest serverless function plus a short-lived key/value store is enough; no accounts or permanent player history are needed.

## Privacy

The app collects no contact details, location, analytics, fingerprints, or persistent history. The demo stores only the current local room, nicknames, game state, and the joining tab’s player ID. Resetting creates fresh state, and clearing site storage removes it entirely. The future backend should expire rooms automatically.
