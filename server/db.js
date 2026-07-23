// db.js — SQLite persistence layer (local adaptation of the GDD's PostgreSQL schema)
// v3.1: difficulty-tiered question bank (1=easy, 2=medium, 3=hard) spanning
// Kuaishou's six values, company-policy themes, and AI education,
// plus content for the coin mini-games.
//
// NOTE: policy/AI questions are HR-training placeholders written from public
// value definitions and common corporate policy themes — HR should review and
// replace with official internal policy text via the admin API before rollout.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// DB location: set DB_PATH to an absolute path (e.g. /data/values-runner.db on a
// Render persistent disk) so scores survive restarts; defaults to the repo file.
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, '..', 'values-runner.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT UNIQUE NOT NULL,
  display_name  TEXT,
  department    TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES users(id),
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  score           INTEGER DEFAULT 0,
  distance        INTEGER DEFAULT 0,
  level_reached   INTEGER DEFAULT 1,
  coins_collected INTEGER DEFAULT 0,
  quiz_correct    INTEGER DEFAULT 0,
  quiz_total      INTEGER DEFAULT 0,
  max_combo       INTEGER DEFAULT 1,
  lives_remaining INTEGER DEFAULT 0,
  rank            TEXT,
  duration_seconds INTEGER,
  language        TEXT DEFAULT 'en',
  difficulty      TEXT DEFAULT 'normal'
);

CREATE TABLE IF NOT EXISTS quiz_answers (
  id           TEXT PRIMARY KEY,
  session_id   TEXT REFERENCES game_sessions(id),
  question_id  TEXT NOT NULL,
  answer_index INTEGER NOT NULL,
  correct      INTEGER NOT NULL,
  time_ms      INTEGER,
  created_at   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  value_key     TEXT NOT NULL,      -- customer|innovation|standard|dare|candid|equality|policy|ai
  difficulty    INTEGER DEFAULT 1,  -- 1=easy 2=medium 3=hard
  scenario_en   TEXT NOT NULL,
  scenario_zh   TEXT,
  answers_en    TEXT NOT NULL,      -- JSON array of 4
  answers_zh    TEXT,
  correct_index INTEGER NOT NULL,
  points        INTEGER DEFAULT 50,
  active        INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS minigame_pairs (
  id         TEXT PRIMARY KEY,
  category   TEXT NOT NULL,     -- values|policy|ai
  difficulty INTEGER DEFAULT 1,
  term       TEXT NOT NULL,
  definition TEXT NOT NULL,
  active     INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS minigame_results (
  id         TEXT PRIMARY KEY,
  session_id TEXT REFERENCES game_sessions(id),
  game_type  TEXT NOT NULL,
  difficulty INTEGER NOT NULL,
  success    INTEGER NOT NULL,
  time_ms    INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Migration: older DBs lack the difficulty column
try { db.exec('ALTER TABLE questions ADD COLUMN difficulty INTEGER DEFAULT 1'); } catch (_) {}
try { db.exec('ALTER TABLE questions ADD COLUMN explanation TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE minigame_pairs ADD COLUMN term_en TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE minigame_pairs ADD COLUMN definition_en TEXT'); } catch (_) {}
try { db.exec("ALTER TABLE game_sessions ADD COLUMN mode TEXT DEFAULT 'overall'"); } catch (_) {}

// ============ QUESTION BANK ============
// v3.2: questions are loaded from the HR-maintained JSON banks in server/data/:
//   company-culture-quiz.json  (快手企业文化/价值观/制度/福利, value_key 'culture')
//   ai-knowledge-quiz.json     (AI 专业知识, value_key 'ai')
// Each file provides { questions: { easy:[], medium:[], hard:[] } } with
// { id, question, options[4], answer, explanation }. To update content, edit
// the JSON files and restart — the bank reseeds automatically when the count changes.
const fs = require('fs');
const TIER = { easy: 1, medium: 2, hard: 3 };

// Load a bank's CN + EN sides side-by-side (paired by question id) so each
// question carries both language versions and the client picks by language.
function loadBank(file, prefix, valueKey) {
  const cnRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', file), 'utf8'));
  let enRaw = null;
  try { enRaw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'en', file), 'utf8')); }
  catch (_) { /* EN side optional — falls back to CN text */ }
  // index EN by id for pairing
  const enById = {};
  if (enRaw) for (const items of Object.values(enRaw.questions || {})) for (const q of items) enById[q.id] = q;
  const rows = [];
  for (const [tier, items] of Object.entries(cnRaw.questions || {})) {
    for (const q of items) {
      const ci = (q.options || []).indexOf(q.answer);
      if (ci < 0 || q.options.length !== 4) {
        console.warn(`[db] skipping malformed question ${prefix}${q.id} in ${file}`);
        continue;
      }
      const en = enById[q.id];
      const enQ = en ? en.question : q.question;
      const enOpts = en ? en.options : q.options;
      rows.push([prefix + q.id, valueKey, TIER[tier] || 1, q.question, enQ, q.options, enOpts, ci, q.explanation || null]);
    }
  }
  return rows;
}

// bank key -> [file, id prefix]. The key doubles as the game mode selected on the start screen.
const BANK_FILES = {
  overall:  ['overall-quiz.json', 'ov-'],
  techops:  ['technical-operations-quiz.json', 'to-'],
  hr:       ['hr-quiz.json', 'hr-'],
  pm:       ['product-management-quiz.json', 'pm-'],
  project:  ['project-management-quiz.json', 'pj-'],
  design:   ['design-quiz.json', 'de-'],
  culture:  ['company-culture-quiz.json', 'cu-'],
  ai:       ['ai-knowledge-quiz.json', 'ai-'],
  kdd:      ['kdd-quiz.json', 'kdd-'],
};

const Q = Object.entries(BANK_FILES).flatMap(([key, [file, prefix]]) => loadBank(file, prefix, key));

// ============ MINI-GAME PAIR CONTENT (mix-and-match) ============
// [id, category, difficulty, term_zh, definition_zh, term_en, definition_en]
const PAIRS = [
  // 简单 — 六大价值观
  ['p1','values',1,'痴迷客户','从用户真实需求出发','Customer Obsession','Start from real user needs'],
  ['p2','values',1,'创新务实','用新想法创造真实价值','Practical Innovation','Turn new ideas into real value'],
  ['p3','values',1,'最高标准','以卓越作为质量基准','Highest Standards','Set excellence as the baseline'],
  ['p4','values',1,'担当敢为','主动补位并对结果负责','Ownership','Step up and own the outcome'],
  ['p5','values',1,'坦诚清晰','直接、诚实、透明的沟通','Candor & Clarity','Direct, honest, transparent communication'],
  ['p6','values',1,'平等普惠','让产品服务尽可能多的人','Equity & Access','Serve as many people as possible'],
  // 中等 — 公司制度词汇
  ['p7','policy',2,'数据分级','按敏感程度给信息分类','Data Classification','Categorize information by sensitivity'],
  ['p8','policy',2,'最小权限','只访问岗位所需的数据','Least Privilege','Access only what the role requires'],
  ['p9','policy',2,'桌面清理','离开工位时妥善保管资料','Clean Desk','Secure materials when leaving your desk'],
  ['p10','policy',2,'网络钓鱼','骗取账号密码的欺诈信息','Phishing','Fraud that harvests credentials'],
  ['p11','policy',2,'保密协议','保护机密信息的法律约定','NDA','A legal pact protecting confidential information'],
  ['p12','policy',2,'事件上报','及时上报发现的安全事件','Incident Reporting','Promptly report security incidents you spot'],
  // 困难 — AI 素养
  ['p13','ai',3,'大语言模型','基于文本预测下一个词','Large Language Model','Predicts the next token from text'],
  ['p14','ai',3,'幻觉','自信但捏造的模型输出','Hallucination','Confident but fabricated model output'],
  ['p15','ai',3,'RLHF','用人类反馈对齐模型行为','RLHF','Align model behavior with human feedback'],
  ['p16','ai',3,'RAG','用检索到的资料增强生成','RAG','Augment generation with retrieved documents'],
  ['p17','ai',3,'微调','让预训练模型适配特定任务','Fine-tuning','Adapt a pretrained model to a specific task'],
  ['p18','ai',3,'多模态','同时理解文本图像与音频','Multimodal','Understand text, images and audio together'],
  // KDD — data mining basics for booth play (works in any KDD language pick)
  ['p19','kdd',1,'KDD','知识发现与数据挖掘','KDD','Knowledge Discovery and Data Mining'],
  ['p20','kdd',1,'SIGKDD','ACM 数据挖掘专业组','SIGKDD','ACM group for data mining'],
  ['p21','kdd',1,'KDD Cup','数据挖掘竞赛','KDD Cup','The data mining competition'],
  ['p22','kdd',2,'分类','预测样本所属类别','Classification','Predict a category for each example'],
  ['p23','kdd',2,'聚类','把相似样本分到同一组','Clustering','Group similar examples together'],
  ['p24','kdd',2,'A/B 测试','对照实验衡量改动效果','A/B Test','Controlled experiment to measure impact'],
  ['p25','kdd',3,'AUC','ROC 曲线下面积','AUC','Area Under the ROC Curve'],
  ['p26','kdd',3,'GNN','处理图结构数据的神经网络','GNN','Neural network for graph-structured data'],
];

// Reseed whenever the bank shape changes (old 12-question seeds get replaced)
const qCount = db.prepare('SELECT COUNT(*) AS n FROM questions').get().n;
if (qCount !== Q.length) {
  db.exec('DELETE FROM questions');
  const ins = db.prepare('INSERT INTO questions (id, value_key, difficulty, scenario_en, scenario_zh, answers_en, answers_zh, correct_index, explanation, points, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 50, 1)');
  for (const [id, v, d, sZh, sEn, aZh, aEn, c, ex] of Q) ins.run(id, v, d, sEn, sZh, JSON.stringify(aEn), JSON.stringify(aZh), c, ex);
  console.log(`Seeded ${Q.length} questions from JSON banks (CN + EN).`);
}

const pCount = db.prepare('SELECT COUNT(*) AS n FROM minigame_pairs').get().n;
const pFirst = db.prepare('SELECT term FROM minigame_pairs WHERE id = ?').get(PAIRS[0][0]);
if (pCount !== PAIRS.length || !pFirst || pFirst.term !== PAIRS[0][3]) {
  db.exec('DELETE FROM minigame_pairs');
  const ins = db.prepare('INSERT INTO minigame_pairs (id, category, difficulty, term, definition, term_en, definition_en, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)');
  for (const [id, c, d, tZh, defZh, tEn, defEn] of PAIRS) ins.run(id, c, d, tZh, defZh, tEn, defEn);
  console.log(`Seeded ${PAIRS.length} mini-game pairs (CN + EN).`);
}

module.exports = db;
