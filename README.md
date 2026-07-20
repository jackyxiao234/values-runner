# 🏃 Values Runner — Kuaishou Culture Training Game (Local Build)

Side-scrolling runner + timed quiz game themed around Kuaishou's six company values (快手派), per the Game Design Document v3.0. This build runs fully locally with a real backend: server-validated quiz answers, persistent leaderboard, question bank management, and HR analytics.

## Quick Start

Requires **Node.js 22+** (uses the built-in `node:sqlite` module — no database install needed).

```bash
npm install       # installs express + uuid only
npm start         # → http://localhost:3000
```

Open **http://localhost:3000**, enter your name, pick a department, and hit START RUN.

- **Desktop:** Space / ↑ = jump, ↓ = duck (hold), ↓ mid-air = fast-fall
- **Mobile:** on-screen ⬆ / ⬇ buttons appear at ≤768px width

Scores persist in `values-runner.db` (SQLite file, auto-created). Delete it to reset the leaderboard.

## What the backend does (GDD §10 & §13)

| GDD spec | Local adaptation |
|---|---|
| PostgreSQL (users, sessions, answers) | SQLite via Node's built-in `node:sqlite` — same schema |
| Redis leaderboard / session state | SQL aggregate queries + in-memory session map |
| Kuaishou SSO auth | Name + department entry (creates a local user identity) |
| Docker / K8s deployment | `npm start` |

**Security behaviors implemented per GDD §13:**
- `correctIndex` is **never sent to the client** — answers are validated by `POST /api/sessions/:id/answer`
- Final scores are **cross-checked server-side**: quiz points are recomputed from validated answers, coin points are sanity-capped, and the server value is authoritative on the result screen
- Each question can only be answered **once per session**
- **Rate limit:** 1 new session per player per 30 seconds

## API

```
POST   /api/sessions                    start run → { sessionId, questions (no answers), config }
GET    /api/sessions/:id                session details
POST   /api/sessions/:id/answer         { questionId, answerIndex, timeMs } → validated result
PATCH  /api/sessions/:id                end run, submit stats → { rank, leaderboardPosition, personalBest }
GET    /api/leaderboard?limit&department
GET    /api/leaderboard/me?displayName
GET    /api/health
```

**Admin/HR endpoints** (question bank CRUD + analytics) require header `X-Admin-Key: kuaishou-hr-local` (override with the `ADMIN_KEY` env var):

```
GET/POST        /api/questions
PUT/DELETE      /api/questions/:id
GET             /api/analytics/overview
GET             /api/analytics/values-weakness     ← which values employees struggle with
```

Example — add a question:

```bash
curl -X POST http://localhost:3000/api/questions \
  -H "Content-Type: application/json" -H "X-Admin-Key: kuaishou-hr-local" \
  -d '{"value":"customer","scenarioEn":"...","answersEn":["A","B","C","D"],"correctIndex":2}'
```

## Project layout

```
values-runner/
├── server/
│   ├── server.js      Express API (sessions, answers, leaderboard, admin, analytics)
│   └── db.js          SQLite schema + 12-question seed bank (GDD §4.2)
├── public/
│   └── index.html     Game client (canvas runner + quiz overlay), now server-driven
├── package.json       npm start / npm run dev (--watch)
└── values-runner.db   created on first run
```


## v3.1 — Difficulty progression, mini-games & pop quizzes

**Question database (36 questions, tiered):** 12 easy / 12 medium / 12 hard, spanning the six Kuaishou values, company-policy themes (infosec, data handling, confidentiality, gifts & hospitality), and AI education (LLMs, RLHF, RAG, hallucination). Difficulty lives in the DB (`questions.difficulty`), manageable via the admin API.

> ⚠️ Policy/AI questions are HR-training **placeholders** written from public value definitions and generic corporate-policy themes. HR should review and replace with official internal policy text before any real rollout (`POST /api/questions` with `difficulty: 1|2|3`).

**Easy → hard progression:** question difficulty is sampled from distance-based weights — <5000px: 80/20/0, 5000–10000px: 25/55/20, beyond: 10/30/60 — so early-run gates ask definitions and late-run gates ask nuanced tradeoffs. Points scale ×1/×2/×3 by difficulty, multiplied by combo.

**Random pop quizzes:** while running, a quiz can trigger at random moments (≈6% roll per second, min 1800px spacing). Same stakes as gates.

**Coin mini-games:** coins are now rare (≈10% of spawn slots, wider spacing) and each is a ★-rated token at a rolled difficulty. Collecting one opens a random mini-game — 🧩 Mix & Match (terms↔definitions from values/policy/AI content), 💣 Value Sweeper (minesweeper-lite; mines are anti-values), or 🃏 Memory Flip (value-icon pairs). Winning awards 30 × diff × combo AND unlocks a bonus question at that difficulty (bonus questions never cost a life; failing a mini-game only breaks your combo). Mini-game sizes/time limits scale with difficulty.

**Scoring is now fully server-authoritative:** every point flows through `/answer` or the new `POST /api/sessions/:id/minigame` (which rejects implausibly fast wins and rate-limits per session). The client-reported score is ignored entirely at session end. Rank thresholds moved to S≥900 / A≥500 / B≥200 to fit the multiplier economy.

**Analytics upgrade:** `/api/analytics/values-weakness` now breaks accuracy down per value × difficulty, and `/api/analytics/overview` includes mini-game participation and win rates.

## Path to production (per GDD)

The API shape matches the GDD, so productionizing is a swap-out, not a rewrite: replace `db.js` with a Postgres client, move the in-memory `liveSessions` map + leaderboard queries to Redis sorted sets, put SSO middleware in front of `getOrCreateUser`, restrict CORS to internal domains, and containerize. Chinese question text (`scenario_zh` / `answers_zh` columns) is already supported by the schema and the `language: "zh"` session parameter — it just needs HR-reviewed translations loaded into the bank.
