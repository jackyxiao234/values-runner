// server.js — Values Runner backend v3.1 (local adaptation of GDD §10)
// New in v3.1: difficulty-tiered questions with scaled multipliers,
// mini-game validation endpoint, fully server-authoritative scoring.
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'kuaishou-hr-local';

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

// Proper Fisher-Yates shuffle — array.sort(() => Math.random()-0.5) is NOT a valid
// shuffle: it abuses sort() with a comparator that isn't a real ordering, and engines
// like V8 use insertion sort for small arrays, which is provably biased (some
// permutations come up far more often than others). This is the correct algorithm.
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const GAME_CONFIG = {
  baseSpeed: 6, maxSpeed: 9, gravity: 0.55, jumpVelocity: -11.5,
  quizTimeSeconds: 15, lives: 3, gateSpacing: 600,
  // difficulty → points multiplier (applies to questions AND mini-games)
  diffMultiplier: { 1: 1, 2: 2, 3: 3 },
  minigameBasePoints: 30,
  // distance thresholds shaping the easy→hard progression (client mirrors this)
  progression: [
    { until: 5000,  weights: [80, 20, 0]  },
    { until: 10000, weights: [25, 55, 20] },
    { until: 1e9,   weights: [10, 30, 60] },
  ],
};
const MULT = GAME_CONFIG.diffMultiplier;
const MAX_MINIGAMES_PER_SESSION = 60;
const MIN_MINIGAME_MS = 2500; // faster than this = implausible, no award

// Server-authoritative per-session state (GDD's Redis role)
const liveSessions = new Map(); // id -> {combo, score, lives, answered:Set, miniCount, userId}
const lastSessionByUser = new Map();

function getOrCreateUser(displayName, department) {
  const employeeId = 'local:' + displayName.trim().toLowerCase();
  let user = db.prepare('SELECT * FROM users WHERE employee_id = ?').get(employeeId);
  if (!user) {
    const id = uuid();
    db.prepare('INSERT INTO users (id, employee_id, display_name, department) VALUES (?, ?, ?, ?)')
      .run(id, employeeId, displayName.trim(), department || 'Unassigned');
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  return user;
}

function requireAdmin(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Admin key required (X-Admin-Key header)' });
  }
  next();
}

// ---------- sign-in ----------
// Sign in with a @kuaishou.com email. Username = the local part before the @.
// Uses the same employee_id scheme as game sessions so the account lines up.
// isNewPlayer is true when the account has no completed runs yet.
app.post('/api/users/signin', (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const m = /^([a-z0-9._%+-]+)@kuaishou\.com$/.exec(email);
  if (!m) return res.status(400).json({ error: '请使用你的 @kuaishou.com 邮箱登录' });
  const username = m[1];
  const employeeId = 'local:' + username;
  let user = db.prepare('SELECT * FROM users WHERE employee_id = ?').get(employeeId);
  if (!user) {
    const id = uuid();
    db.prepare('INSERT INTO users (id, employee_id, display_name, department) VALUES (?, ?, ?, ?)')
      .run(id, employeeId, username, 'Unassigned');
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  }
  const agg = db.prepare('SELECT COUNT(*) AS runs, MAX(score) AS best FROM game_sessions WHERE user_id = ? AND ended_at IS NOT NULL').get(user.id);
  res.json({
    username,
    email,
    displayName: user.display_name,
    isNewPlayer: (agg.runs || 0) === 0,
    totalRuns: agg.runs || 0,
    bestScore: agg.best || 0,
  });
});

// ---------- sessions ----------
const BANK_KEYS = ['overall', 'techops', 'hr', 'pm', 'project', 'design', 'culture', 'ai'];

app.post('/api/sessions', (req, res) => {
  const { displayName, department, difficulty = 'normal', language = 'en', mode = 'overall' } = req.body || {};
  const bank = BANK_KEYS.includes(mode) ? mode : 'overall';
  if (!displayName || !displayName.trim()) {
    return res.status(400).json({ error: 'displayName is required' });
  }
  const user = getOrCreateUser(displayName, department);

  const last = lastSessionByUser.get(user.id) || 0;
  if (Date.now() - last < 30_000) {
    return res.status(429).json({ error: 'Please wait before starting a new run', retryAfterMs: 30_000 - (Date.now() - last) });
  }
  lastSessionByUser.set(user.id, Date.now());

  const sessionId = uuid();
  db.prepare('INSERT INTO game_sessions (id, user_id, started_at, language, difficulty, mode) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, user.id, now(), language, difficulty, bank);
  // shuffles: questionId -> array where shuffles[shuffledPos] = originalPos (fixes a heavy
  // position bias in the source question banks — the correct answer sat in position 1 far
  // more often than chance would predict, ~70-80% of the time in some banks).
  const shuffles = new Map();
  liveSessions.set(sessionId, { combo: 1, score: 0, lives: GAME_CONFIG.lives, answered: new Set(), miniCount: 0, userId: user.id, shuffles });

  // Questions grouped by difficulty, WITHOUT correct_index (GDD §13.1)
  const qRows = db.prepare('SELECT id, value_key, difficulty, scenario_en, scenario_zh, answers_en, answers_zh, points FROM questions WHERE active = 1 AND value_key = ?').all(bank);
  const questions = { 1: [], 2: [], 3: [] };
  for (const r of qRows) {
    const answers = JSON.parse((language === 'zh' && r.answers_zh) ? r.answers_zh : r.answers_en);
    const order = shuffle(answers.map((_, i) => i)); // order[shuffledPos] = originalPos
    shuffles.set(r.id, order);
    (questions[r.difficulty] ||= []).push({
      id: r.id, value: r.value_key, difficulty: r.difficulty,
      scenario: (language === 'zh' && r.scenario_zh) ? r.scenario_zh : r.scenario_en,
      answers: order.map(origIdx => answers[origIdx]),
      points: r.points,
    });
  }
  for (const d of [1, 2, 3]) questions[d] = shuffle(questions[d]);

  // Mix-and-match pair content grouped by difficulty
  const pRows = db.prepare('SELECT id, category, difficulty, term, definition FROM minigame_pairs WHERE active = 1').all();
  const pairs = { 1: [], 2: [], 3: [] };
  for (const p of pRows) (pairs[p.difficulty] ||= []).push({ id: p.id, category: p.category, term: p.term, definition: p.definition });

  res.json({ sessionId, mode: bank, questions, pairs, config: GAME_CONFIG, user: { displayName: user.display_name, department: user.department } });
});

app.get('/api/sessions/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json(s);
});

// POST /api/sessions/:id/answer — server-side validation with difficulty multiplier.
// context: 'gate' | 'pop' (wrong = lose a life) | 'bonus' (coin mini-game reward question: no life loss)
app.post('/api/sessions/:id/answer', (req, res) => {
  const { questionId, answerIndex, timeMs, context = 'gate' } = req.body || {};
  const live = liveSessions.get(req.params.id);
  if (!live) return res.status(404).json({ error: 'Session not active' });
  if (typeof answerIndex !== 'number' || !questionId) {
    return res.status(400).json({ error: 'questionId and answerIndex required' });
  }
  if (live.answered.has(questionId)) {
    return res.status(409).json({ error: 'Question already answered in this session' });
  }
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND active = 1').get(questionId);
  if (!q) return res.status(404).json({ error: 'Question not found' });

  live.answered.add(questionId);
  const order = live.shuffles && live.shuffles.get(questionId); // order[shuffledPos] = originalPos
  const timedOut = answerIndex === -1;
  const originalIndex = (!timedOut && order) ? order[answerIndex] : answerIndex;
  const correct = !timedOut && originalIndex === q.correct_index;
  const shuffledCorrectIndex = order ? order.indexOf(q.correct_index) : q.correct_index;
  const mult = MULT[q.difficulty] || 1;
  let pointsAwarded = 0;

  if (correct) {
    pointsAwarded = q.points * mult * live.combo;
    live.score += pointsAwarded;
    live.combo += 1;
  } else {
    live.combo = 1;
    if (context !== 'bonus') live.lives -= 1; // bonus questions never cost a life
  }

  db.prepare('INSERT INTO quiz_answers (id, session_id, question_id, answer_index, correct, time_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuid(), req.params.id, questionId, originalIndex, correct ? 1 : 0, timeMs || null);

  res.json({
    correct, correctIndex: shuffledCorrectIndex, difficulty: q.difficulty, multiplier: mult,
    explanation: q.explanation || null,
    pointsAwarded, currentCombo: live.combo, currentScore: live.score, livesRemaining: live.lives,
  });
});

// POST /api/sessions/:id/hit — register an obstacle hit (server-authoritative lives).
// Client-side invulnerability lasts ~0.75s, so hits closer together than 500ms
// are treated as duplicates (lag/retry) and not double-counted.
// POST /api/sessions/:id/coin — a "+25" XiaoKuai coin. Flat point award, no combo
// change. Lightly deduped within 300ms to absorb double-fire on the same frame.
app.post('/api/sessions/:id/coin', (req, res) => {
  const live = liveSessions.get(req.params.id);
  if (!live) return res.status(404).json({ error: 'Session not active' });
  const t = Date.now();
  let pointsAwarded = 0;
  if (!live.lastCoinAt || t - live.lastCoinAt >= 300) {
    live.lastCoinAt = t;
    pointsAwarded = 25;
    live.score += pointsAwarded;
  }
  res.json({ currentScore: live.score, pointsAwarded, currentCombo: live.combo, livesRemaining: live.lives });
});

// POST /api/sessions/:id/hit — obstacle hit costs a life (deduped within 500ms).
app.post('/api/sessions/:id/hit', (req, res) => {
  const live = liveSessions.get(req.params.id);
  if (!live) return res.status(404).json({ error: 'Session not active' });
  const t = Date.now();
  if (!live.lastHitAt || t - live.lastHitAt >= 500) {
    live.lastHitAt = t;
    live.combo = 1;
    if (live.lives > 0) live.lives -= 1;
  }
  res.json({ livesRemaining: live.lives, currentCombo: live.combo, currentScore: live.score });
});

// POST /api/sessions/:id/distance — award distance-based points (~35% of total).
// Client sends current distance; server calculates incremental points.
app.post('/api/sessions/:id/distance', (req, res) => {
  const live = liveSessions.get(req.params.id);
  if (!live) return res.status(404).json({ error: 'Session not active' });
  const dist = req.body.distance || 0;
  const distScore = Math.floor(dist / 12); // 1 point per 12 distance units
  const prevDistScore = live._lastDistScore || 0;
  if (distScore > prevDistScore) {
    live.score += (distScore - prevDistScore);
    live._lastDistScore = distScore;
  }
  res.json({ currentScore: live.score });
});

// POST /api/sessions/:id/heart — a heart coin restores one life (max 3). Nothing else:
// no points, no combo change. Deduped within 800ms to absorb lag retries.
app.post('/api/sessions/:id/heart', (req, res) => {
  const live = liveSessions.get(req.params.id);
  if (!live) return res.status(404).json({ error: 'Session not active' });
  const t = Date.now();
  if (!live.lastHeartAt || t - live.lastHeartAt >= 800) {
    live.lastHeartAt = t;
    if (live.lives < GAME_CONFIG.lives) live.lives += 1;
  }
  res.json({ livesRemaining: live.lives, currentScore: live.score, currentCombo: live.combo });
});

// POST /api/sessions/:id/minigame — record a coin mini-game result and award points.
// { type: 'match'|'mines'|'memory', difficulty: 1-3, success: bool, timeMs }
app.post('/api/sessions/:id/minigame', (req, res) => {
  const { type, difficulty, success, timeMs } = req.body || {};
  const live = liveSessions.get(req.params.id);
  if (!live) return res.status(404).json({ error: 'Session not active' });
  if (!['match', 'mines', 'memory'].includes(type) || ![1, 2, 3].includes(difficulty)) {
    return res.status(400).json({ error: 'valid type and difficulty (1-3) required' });
  }
  if (live.miniCount >= MAX_MINIGAMES_PER_SESSION) {
    return res.status(429).json({ error: 'Mini-game limit reached for this session' });
  }
  live.miniCount += 1;

  const plausible = typeof timeMs === 'number' && timeMs >= MIN_MINIGAME_MS;
  const won = !!success && plausible;
  let pointsAwarded = 0;
  if (won) {
    pointsAwarded = GAME_CONFIG.minigameBasePoints * (MULT[difficulty] || 1) * live.combo;
    live.score += pointsAwarded;
    live.combo += 1;
  } else {
    live.combo = 1; // failing a mini-game breaks the combo but never costs a life
  }

  db.prepare('INSERT INTO minigame_results (id, session_id, game_type, difficulty, success, time_ms) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uuid(), req.params.id, type, difficulty, won ? 1 : 0, timeMs || null);

  res.json({ success: won, pointsAwarded, currentCombo: live.combo, currentScore: live.score, livesRemaining: live.lives });
});

// PATCH /api/sessions/:id — end game. Score is now fully server-authoritative:
// every point flowed through /answer or /minigame, so we simply use live.score.
app.patch('/api/sessions/:id', (req, res) => {
  const sid = req.params.id;
  const s = db.prepare('SELECT * FROM game_sessions WHERE id = ?').get(sid);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.ended_at) return res.status(409).json({ error: 'Session already ended' });

  const live = liveSessions.get(sid);
  const b = req.body || {};
  const answers = db.prepare('SELECT correct FROM quiz_answers WHERE session_id = ?').all(sid);
  const quizCorrect = answers.filter(a => a.correct).length;
  const quizTotal = answers.length;
  const finalScore = live ? live.score : 0;
  const rank = finalScore >= 900 ? 'S' : finalScore >= 500 ? 'A' : finalScore >= 200 ? 'B' : 'C';

  db.prepare(`UPDATE game_sessions SET ended_at = ?, score = ?, distance = ?, level_reached = ?,
    coins_collected = ?, quiz_correct = ?, quiz_total = ?, max_combo = ?, lives_remaining = ?,
    rank = ?, duration_seconds = ? WHERE id = ?`)
    .run(now(), finalScore, Math.max(0, parseInt(b.distance) || 0), Math.max(1, parseInt(b.levelReached) || 1),
      Math.max(0, parseInt(b.coinsCollected) || 0), quizCorrect, quizTotal,
      Math.max(1, parseInt(b.maxCombo) || 1), live ? Math.max(0, live.lives) : 0, rank,
      Math.max(0, parseInt(b.durationSeconds) || 0), sid);

  liveSessions.delete(sid);

  const best = db.prepare('SELECT MAX(score) AS best, COUNT(*) AS runs FROM game_sessions WHERE user_id = ? AND ended_at IS NOT NULL').get(s.user_id);
  const personalBest = finalScore >= (best.best || 0);
  const better = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT user_id, MAX(score) AS s FROM game_sessions WHERE ended_at IS NOT NULL GROUP BY user_id
    ) WHERE s > ?`).get(finalScore).n;

  res.json({ rank, score: finalScore, leaderboardPosition: better + 1, personalBest, totalRuns: best.runs, quizCorrect, quizTotal });
});

// ---------- leaderboard ----------
// Start of the current week (Monday 00:00 local) as an ISO string — ended_at is
// stored as ISO, so lexicographic comparison works.
function weekStartISO() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d.toISOString();
}

// GET /api/leaderboard?period=week|all — weekly board ranks by each player's best
// score THIS WEEK (results persist in SQLite, so the ranking survives restarts).
app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(50, parseInt(req.query.limit) || 10);
  const dept = req.query.department;
  const weekly = req.query.period === 'week';
  const conds = ['g.ended_at IS NOT NULL'];
  const params = [];
  if (weekly) { conds.push('g.ended_at >= ?'); params.push(weekStartISO()); }
  if (dept) { conds.push('u.department = ?'); params.push(dept); }
  const rows = db.prepare(`
    SELECT u.display_name AS displayName, u.department, MAX(g.score) AS bestScore,
           COUNT(g.id) AS totalRuns, MAX(g.ended_at) AS lastRunAt
    FROM game_sessions g JOIN users u ON u.id = g.user_id
    WHERE ${conds.join(' AND ')}
    GROUP BY g.user_id ORDER BY bestScore DESC LIMIT ?`)
    .all(...params, limit);
  res.json(rows.map((r, i) => ({ position: i + 1, ...r, rank: r.bestScore >= 900 ? 'S' : r.bestScore >= 500 ? 'A' : r.bestScore >= 200 ? 'B' : 'C' })));
});

app.get('/api/leaderboard/me', (req, res) => {
  const name = (req.query.displayName || '').trim().toLowerCase();
  if (!name) return res.status(400).json({ error: 'displayName query param required' });
  const user = db.prepare('SELECT * FROM users WHERE employee_id = ?').get('local:' + name);
  if (!user) return res.status(404).json({ error: 'No runs yet' });
  const me = db.prepare('SELECT MAX(score) AS best, COUNT(*) AS runs FROM game_sessions WHERE user_id = ? AND ended_at IS NOT NULL').get(user.id);
  const better = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT user_id, MAX(score) AS s FROM game_sessions WHERE ended_at IS NOT NULL GROUP BY user_id
    ) WHERE s > ?`).get(me.best || 0).n;
  res.json({ displayName: user.display_name, bestScore: me.best || 0, totalRuns: me.runs, position: better + 1 });
});

// ---------- question bank (admin/HR) ----------
app.get('/api/questions', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM questions').all().map(q => ({ ...q, answers_en: JSON.parse(q.answers_en), answers_zh: q.answers_zh ? JSON.parse(q.answers_zh) : null })));
});

app.post('/api/questions', requireAdmin, (req, res) => {
  const { id, value, difficulty = 1, scenarioEn, scenarioZh, answersEn, answersZh, correctIndex, points = 50 } = req.body || {};
  if (!value || !scenarioEn || !Array.isArray(answersEn) || answersEn.length !== 4 || typeof correctIndex !== 'number' || ![1,2,3].includes(difficulty)) {
    return res.status(400).json({ error: 'value, difficulty (1-3), scenarioEn, answersEn[4], correctIndex required' });
  }
  const qid = id || 'q' + crypto.randomBytes(4).toString('hex');
  db.prepare('INSERT INTO questions (id, value_key, difficulty, scenario_en, scenario_zh, answers_en, answers_zh, correct_index, points, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)')
    .run(qid, value, difficulty, String(scenarioEn), scenarioZh ? String(scenarioZh) : null, JSON.stringify(answersEn.map(String)), answersZh ? JSON.stringify(answersZh.map(String)) : null, correctIndex, points);
  res.status(201).json({ id: qid });
});

app.put('/api/questions/:id', requireAdmin, (req, res) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  db.prepare(`UPDATE questions SET value_key=?, difficulty=?, scenario_en=?, scenario_zh=?, answers_en=?, answers_zh=?, correct_index=?, points=?, active=? WHERE id=?`)
    .run(b.value ?? q.value_key, b.difficulty ?? q.difficulty, b.scenarioEn ?? q.scenario_en, b.scenarioZh ?? q.scenario_zh,
      b.answersEn ? JSON.stringify(b.answersEn.map(String)) : q.answers_en,
      b.answersZh ? JSON.stringify(b.answersZh.map(String)) : q.answers_zh,
      b.correctIndex ?? q.correct_index, b.points ?? q.points,
      b.active === undefined ? q.active : (b.active ? 1 : 0), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/questions/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM questions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- analytics (admin) ----------
app.get('/api/analytics/overview', requireAdmin, (req, res) => {
  const o = db.prepare(`SELECT COUNT(*) AS totalRuns, COUNT(DISTINCT user_id) AS totalPlayers,
    ROUND(AVG(score),1) AS avgScore, ROUND(AVG(distance),0) AS avgDistance
    FROM game_sessions WHERE ended_at IS NOT NULL`).get();
  const acc = db.prepare('SELECT ROUND(AVG(correct)*100,1) AS avgAccuracyPct FROM quiz_answers').get();
  const mini = db.prepare('SELECT COUNT(*) AS totalMinigames, ROUND(AVG(success)*100,1) AS minigameWinRatePct FROM minigame_results').get();
  res.json({ ...o, ...acc, ...mini });
});

app.get('/api/analytics/values-weakness', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT q.value_key AS value, q.difficulty, COUNT(a.id) AS answered,
           ROUND(AVG(a.correct)*100,1) AS correctRatePct,
           ROUND(AVG(a.time_ms),0) AS avgTimeMs
    FROM quiz_answers a JOIN questions q ON q.id = a.question_id
    GROUP BY q.value_key, q.difficulty ORDER BY correctRatePct ASC`).all();
  res.json(rows);
});

app.get('/api/health', (req, res) => res.json({ ok: true, version: '3.1-local' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏃 Values Runner v3.1 running at http://localhost:${PORT}\n`);
  console.log(`   Admin endpoints require header  X-Admin-Key: ${ADMIN_KEY}`);
});
