const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

function localNow() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}
function localDate() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
}

// 艾宾浩斯记忆曲线复习间隔（天数）
// Level 0: 新词，立即学习
// Level 1: 1天后复习
// Level 2: 2天后复习
// Level 3: 4天后复习
// Level 4: 7天后复习
// Level 5: 15天后复习
// Level 6: 30天后复习
// Level 7: 已掌握
const REVIEW_INTERVALS = [0, 1, 2, 4, 7, 15, 30];

// 儿童艾宾浩斯间隔（比成人更密集）
// Level 0: 新字
// Level 1: 4小时后（当天巩固）
// Level 2: 1天
// Level 3: 3天
// Level 4: 7天
// Level 5: 14天
// Level 6: 30天
// Level 7: 已掌握
const KIDS_REVIEW_INTERVALS = [0, 0.17, 1, 3, 7, 14, 30];

class VocabDB {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    logger.info('数据库已连接', { path: dbPath });
    this.init();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        word TEXT NOT NULL UNIQUE COLLATE NOCASE,
        phonetic TEXT,
        chinese TEXT NOT NULL,
        category TEXT DEFAULT '未分类',
        examples TEXT DEFAULT '[]',
        synonyms TEXT DEFAULT '[]',
        mastery_level INTEGER DEFAULT 0,
        review_count INTEGER DEFAULT 0,
        first_seen_at TEXT,
        last_reviewed_at TEXT,
        next_review_at TEXT,
        is_learned INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS review_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        word_id INTEGER NOT NULL,
        reviewed_at TEXT DEFAULT (datetime('now', 'localtime')),
        result TEXT NOT NULL CHECK(result IN ('remembered', 'forgotten')),
        mastery_before INTEGER,
        mastery_after INTEGER,
        FOREIGN KEY (word_id) REFERENCES words(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS study_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scheduled_time TEXT NOT NULL,
        word_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        completed INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS pending_words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        word TEXT NOT NULL UNIQUE COLLATE NOCASE,
        note TEXT DEFAULT '',
        added_at TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE TABLE IF NOT EXISTS enrichment_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        added_count INTEGER DEFAULT 0,
        skipped_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS enrichment_batch_words (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        batch_id INTEGER NOT NULL,
        word TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('added','skipped','failed')),
        word_id INTEGER,
        error TEXT,
        FOREIGN KEY (batch_id) REFERENCES enrichment_batches(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS study_time_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        seconds INTEGER NOT NULL,
        recorded_at TEXT DEFAULT (datetime('now', 'localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_study_time_date ON study_time_log(recorded_at);
      CREATE INDEX IF NOT EXISTS idx_words_next_review ON words(next_review_at);
      CREATE INDEX IF NOT EXISTS idx_words_is_learned ON words(is_learned);
      CREATE INDEX IF NOT EXISTS idx_words_mastery ON words(mastery_level);
      CREATE INDEX IF NOT EXISTS idx_review_history_word ON review_history(word_id);
      CREATE INDEX IF NOT EXISTS idx_review_history_date ON review_history(reviewed_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_time ON study_sessions(scheduled_time);
      CREATE INDEX IF NOT EXISTS idx_batch_words_batch ON enrichment_batch_words(batch_id);
    `);

    // 安全添加 words.batch_id 列（旧数据 batch_id 为 NULL，不影响历史学习记录）
    const wordsCols = this.db.prepare(`PRAGMA table_info(words)`).all();
    if (!wordsCols.some(c => c.name === 'batch_id')) {
      this.db.exec(`ALTER TABLE words ADD COLUMN batch_id INTEGER`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_words_batch ON words(batch_id);`);

    this.initKids();
  }

  // ============ 词汇数据导入 ============
  seedVocabulary() {
    const vocabPath = path.join(__dirname, 'data', 'vocabulary.json');
    const vocab = JSON.parse(fs.readFileSync(vocabPath, 'utf-8'));

    const insert = this.db.prepare(`
      INSERT INTO words (word, phonetic, chinese, category, examples, synonyms)
      VALUES (@word, @phonetic, @chinese, @category, @examples, @synonyms)
      ON CONFLICT(word) DO UPDATE SET
        phonetic = excluded.phonetic,
        chinese = excluded.chinese,
        category = excluded.category,
        examples = excluded.examples,
        synonyms = excluded.synonyms
    `);

    const insertMany = this.db.transaction((words) => {
      for (const w of words) {
        insert.run({
          word: w.word,
          phonetic: w.phonetic || '',
          chinese: w.chinese,
          category: w.category || '未分类',
          examples: JSON.stringify(w.examples || []),
          synonyms: JSON.stringify(w.synonyms || [])
        });
      }
    });

    insertMany(vocab);
    return vocab.length;
  }

  // ============ 词汇查询 ============
  getWords({ category, is_learned, search, batch_id, sort_by, page = 1, limit = 50 } = {}) {
    let where = ['1=1'];
    const params = {};

    if (category) {
      where.push('category = @category');
      params.category = category;
    }
    if (is_learned !== undefined) {
      where.push('is_learned = @is_learned');
      params.is_learned = is_learned ? 1 : 0;
    }
    if (search) {
      where.push('(word LIKE @search OR chinese LIKE @search)');
      params.search = `%${search}%`;
    }
    if (batch_id !== undefined && batch_id !== null && batch_id !== '') {
      where.push('batch_id = @batch_id');
      params.batch_id = parseInt(batch_id);
    }

    const offset = (page - 1) * limit;
    params.limit = limit;
    params.offset = offset;

    const countStmt = this.db.prepare(
      `SELECT COUNT(*) as total FROM words WHERE ${where.join(' AND ')}`
    );
    const { total } = countStmt.get(params);

    const orderMap = {
      last_reviewed_desc: 'COALESCE(last_reviewed_at, first_seen_at) DESC',
      last_reviewed_asc: 'COALESCE(last_reviewed_at, first_seen_at) ASC',
      mastery_desc: 'mastery_level DESC, word ASC',
      mastery_asc: 'mastery_level ASC, word ASC',
      review_count_desc: 'review_count DESC, word ASC',
      review_count_asc: 'review_count ASC, word ASC',
      remembered_desc: '(SELECT COUNT(*) FROM review_history WHERE word_id = words.id AND result = \'remembered\') DESC, word ASC',
      remembered_asc: '(SELECT COUNT(*) FROM review_history WHERE word_id = words.id AND result = \'remembered\') ASC, word ASC',
      forgotten_desc: '(SELECT COUNT(*) FROM review_history WHERE word_id = words.id AND result = \'forgotten\') DESC, word ASC',
      forgotten_asc: '(SELECT COUNT(*) FROM review_history WHERE word_id = words.id AND result = \'forgotten\') ASC, word ASC',
      category_asc: 'category ASC, word ASC',
      word_asc: 'word ASC',
    };
    const orderClause = orderMap[sort_by] || 'CASE WHEN is_learned = 1 THEN 1 ELSE 0 END, mastery_level ASC, word ASC';

    const stmt = this.db.prepare(`
      SELECT * FROM words
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderClause}
      LIMIT @limit OFFSET @offset
    `);

    const words = stmt.all(params).map(w => ({
      ...w,
      examples: JSON.parse(w.examples || '[]'),
      synonyms: JSON.parse(w.synonyms || '[]'),
      is_learned: !!w.is_learned
    }));

    return { words, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  getWord(id) {
    const word = this.db.prepare('SELECT * FROM words WHERE id = ?').get(id);
    if (!word) return null;
    word.examples = JSON.parse(word.examples || '[]');
    word.synonyms = JSON.parse(word.synonyms || '[]');
    word.is_learned = !!word.is_learned;

    // 获取复习历史
    const history = this.db.prepare(
      'SELECT * FROM review_history WHERE word_id = ? ORDER BY reviewed_at DESC LIMIT 20'
    ).all(id);

    return { ...word, history };
  }

  addWord({ word, phonetic, chinese, category, examples, synonyms }) {
    const stmt = this.db.prepare(`
      INSERT INTO words (word, phonetic, chinese, category, examples, synonyms)
      VALUES (@word, @phonetic, @chinese, @category, @examples, @synonyms)
    `);

    try {
      const result = stmt.run({
        word,
        phonetic: phonetic || '',
        chinese,
        category: category || '未分类',
        examples: JSON.stringify(examples || []),
        synonyms: JSON.stringify(synonyms || [])
      });
      logger.debug('单词已写入 DB', { id: result.lastInsertRowid, word });
      return { id: result.lastInsertRowid, success: true };
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        return { success: false, error: '该单词已存在' };
      }
      logger.error('addWord 失败', { word, error: e.message });
      throw e;
    }
  }

  deleteWord(id) {
    this.db.prepare('DELETE FROM words WHERE id = ?').run(id);
  }

  // ============ 艾宾浩斯记忆曲线 ============

  // 获取需要复习的单词（next_review_at <= 当前时间）
  getDueWords(limit = 10) {
    const now = localNow();
    return this.db.prepare(`
      SELECT * FROM words
      WHERE is_learned = 0
        AND next_review_at IS NOT NULL
        AND next_review_at <= @now
        AND mastery_level < 7
      ORDER BY
        mastery_level ASC,
        next_review_at ASC
      LIMIT @limit
    `).all({ now, limit }).map(w => ({
      ...w,
      examples: JSON.parse(w.examples || '[]'),
      synonyms: JSON.parse(w.synonyms || '[]'),
      is_learned: false
    }));
  }

  // 获取新词（从未学习过的）
  getNewWords(limit = 10) {
    return this.db.prepare(`
      SELECT * FROM words
      WHERE is_learned = 0
        AND first_seen_at IS NULL
      ORDER BY RANDOM()
      LIMIT @limit
    `).all({ limit }).map(w => ({
      ...w,
      examples: JSON.parse(w.examples || '[]'),
      synonyms: JSON.parse(w.synonyms || '[]'),
      is_learned: false
    }));
  }

  // 生成学习批次：优先复习到期单词，不足则补充新词
  generateStudyBatch(size = 10) {
    return this.generateSmartBatch(size);
  }

  // ===== 智能调度：基于艾宾浩斯曲线 + SM-2 启发的 urgency 评分 =====

  // 每个 mastery_level 对应的"记忆稳定度"（小时）
  // 对齐 REVIEW_INTERVALS 但给未评级的新词一个较短的稳定度
  static STABILITY_HOURS = [12, 24, 48, 96, 168, 360, 720];

  // 给一个单词算 urgency 分（越大越该复习）
  _computeUrgency(row, now) {
    const level = Math.min(Math.max(row.mastery_level || 0, 0), 6);
    const S = VocabDB.STABILITY_HOURS[level];

    // 遗忘率用 Laplace 平滑，避免首次/少量复习时极端化
    const n = row.review_count || 0;
    const f = row.forgotten_count || 0;
    const forgetRate = (f + 1) / (n + 2);

    // 稳定度打折：经常忘的词提前召回，但不跌破 30%
    const Sadj = S * Math.max(0.3, 1 - 0.5 * forgetRate);

    // 距上次复习（或首次出现）的小时数
    const anchor = row.last_reviewed_at || row.first_seen_at;
    const anchorMs = anchor ? new Date(anchor.replace(' ', 'T')).getTime() : now.getTime() - S * 3_600_000;
    const deltaH = Math.max(0, (now.getTime() - anchorMs) / 3_600_000);

    // 艾宾浩斯保留率
    const R = Math.exp(-deltaH / Sadj);
    let urgency = 1 - R;

    // 过期越久越紧急（封顶 +0.3）
    if (row.next_review_at) {
      const overdueH = (now.getTime() - new Date(row.next_review_at.replace(' ', 'T')).getTime()) / 3_600_000;
      if (overdueH > 0) urgency += Math.min(0.3, (overdueH / Sadj) * 0.1);
    }

    // 低等级词轻度优先，鼓励早期巩固
    urgency += (6 - level) * 0.01;

    return { urgency, R, forgetRate, Sadj, deltaH };
  }

  // 选出最值得复习的词（含"即将遗忘"但尚未过期的）
  getSmartReviewCandidates(limit = 20) {
    const rows = this.db.prepare(`
      SELECT w.*,
        COALESCE((
          SELECT COUNT(*) FROM review_history
          WHERE word_id = w.id AND result = 'forgotten'
        ), 0) AS forgotten_count
      FROM words w
      WHERE w.is_learned = 0
        AND w.first_seen_at IS NOT NULL
        AND w.mastery_level < 7
    `).all();

    const now = new Date();
    const threshold = 0.3; // R <= 0.7 才认为"快忘了"
    const scored = rows.map(r => ({ ...r, ...this._computeUrgency(r, now) }));

    return scored
      .filter(r => {
        if (r.urgency >= threshold) return true;
        if (r.next_review_at && new Date(r.next_review_at.replace(' ', 'T')) <= now) return true;
        return false;
      })
      .sort((a, b) => b.urgency - a.urgency)
      .slice(0, limit)
      .map(w => ({
        ...w,
        examples: JSON.parse(w.examples || '[]'),
        synonyms: JSON.parse(w.synonyms || '[]'),
        is_learned: false,
        _urgency: Number(w.urgency.toFixed(3)),
        _retention: Number(w.R.toFixed(3))
      }));
  }

  // 智能批次：先用当日艾宾浩斯复习列表（next_review_at <= now）填满，
  // 复习列表为空或不足才补新词。
  generateSmartBatch(size = 10) {
    const dueSelected = this.getDueWords(size);

    const newSlots = size - dueSelected.length;
    const newSelected = newSlots > 0 ? this.getNewWords(newSlots) : [];

    // 按比例"拉链式"交错：避免连续一大串新词或旧词
    const total = dueSelected.length + newSelected.length;
    const dueShare = total > 0 ? dueSelected.length / total : 0;
    const words = [];
    let di = 0, ni = 0;
    for (let i = 0; i < total; i++) {
      const targetDueByNow = Math.round(dueShare * (i + 1));
      if (di < targetDueByNow && di < dueSelected.length) words.push(dueSelected[di++]);
      else if (ni < newSelected.length) words.push(newSelected[ni++]);
      else if (di < dueSelected.length) words.push(dueSelected[di++]);
    }

    return { dueWords: dueSelected, newWords: newSelected, words, total };
  }

  // 复习单词 - 核心艾宾浩斯逻辑
  reviewWord(id, remembered) {
    const word = this.db.prepare('SELECT * FROM words WHERE id = ?').get(id);
    if (!word) return null;

    const now = new Date();
    const nowStr = localNow();
    const oldLevel = word.mastery_level;
    let newLevel;

    if (remembered) {
      // 记住了：提升掌握等级
      newLevel = Math.min(oldLevel + 1, 7);
    } else {
      // 忘记了：回退掌握等级（不低于1，因为已见过）
      newLevel = Math.max(1, oldLevel - 2);
    }

    // 计算下次复习时间
    let nextReview = null;
    if (newLevel < 7) {
      const intervalDays = REVIEW_INTERVALS[newLevel] || 30;
      const next = new Date(now);
      next.setDate(next.getDate() + intervalDays);
      // 设置为当天早上8点
      next.setHours(8, 0, 0, 0);
      const pad = n => String(n).padStart(2, '0');
      nextReview = `${next.getFullYear()}-${pad(next.getMonth()+1)}-${pad(next.getDate())} 08:00:00`;
    }

    // 更新单词状态
    this.db.prepare(`
      UPDATE words SET
        mastery_level = @newLevel,
        review_count = review_count + 1,
        first_seen_at = COALESCE(first_seen_at, @now),
        last_reviewed_at = @now,
        next_review_at = @nextReview
      WHERE id = @id
    `).run({ id, newLevel, now: nowStr, nextReview });

    // 记录复习历史
    this.db.prepare(`
      INSERT INTO review_history (word_id, reviewed_at, result, mastery_before, mastery_after)
      VALUES (@word_id, @reviewed_at, @result, @mastery_before, @mastery_after)
    `).run({
      word_id: id,
      reviewed_at: nowStr,
      result: remembered ? 'remembered' : 'forgotten',
      mastery_before: oldLevel,
      mastery_after: newLevel
    });

    return {
      id,
      word: word.word,
      oldLevel,
      newLevel,
      nextReview,
      reviewCount: word.review_count + 1
    };
  }

  // 标记为已学会
  markLearned(id) {
    this.db.prepare(`
      UPDATE words SET
        is_learned = 1,
        mastery_level = 7,
        next_review_at = NULL
      WHERE id = ?
    `).run(id);
  }

  // 取消已学会标记（重新加入学习）
  unmarkLearned(id) {
    const now = localNow();
    this.db.prepare(`
      UPDATE words SET
        is_learned = 0,
        mastery_level = 0,
        next_review_at = @now
      WHERE id = @id
    `).run({ id, now });
  }

  // ============ 学习会话 ============

  createSession(scheduledTime, wordIds) {
    const result = this.db.prepare(`
      INSERT INTO study_sessions (scheduled_time, word_ids)
      VALUES (@time, @ids)
    `).run({
      time: scheduledTime,
      ids: JSON.stringify(wordIds)
    });

    // 标记新词的 first_seen_at
    const now = localNow();
    const markSeen = this.db.prepare(`
      UPDATE words SET
        first_seen_at = COALESCE(first_seen_at, @now),
        next_review_at = COALESCE(next_review_at, @now)
      WHERE id = @id AND first_seen_at IS NULL
    `);
    for (const id of wordIds) {
      markSeen.run({ id, now });
    }

    return result.lastInsertRowid;
  }

  getTodaySessions() {
    const today = localDate();
    const sessions = this.db.prepare(`
      SELECT * FROM study_sessions
      WHERE date(created_at) = @today
      ORDER BY created_at DESC
    `).all({ today });

    return sessions.map(s => ({
      ...s,
      word_ids: JSON.parse(s.word_ids || '[]')
    }));
  }

  getLatestSession() {
    const session = this.db.prepare(`
      SELECT * FROM study_sessions
      ORDER BY created_at DESC
      LIMIT 1
    `).get();

    if (!session) return null;

    const wordIds = JSON.parse(session.word_ids || '[]');
    const words = wordIds.map(id => {
      const w = this.db.prepare('SELECT * FROM words WHERE id = ?').get(id);
      if (w) {
        w.examples = JSON.parse(w.examples || '[]');
        w.synonyms = JSON.parse(w.synonyms || '[]');
        w.is_learned = !!w.is_learned;
      }
      return w;
    }).filter(Boolean);

    return { ...session, words };
  }

  completeSession(id) {
    this.db.prepare('UPDATE study_sessions SET completed = 1 WHERE id = ?').run(id);
  }

  removeWordFromSession(sessionId, wordId) {
    const session = this.db.prepare('SELECT word_ids FROM study_sessions WHERE id = ?').get(sessionId);
    if (!session) return false;
    const wordIds = JSON.parse(session.word_ids || '[]');
    const newWordIds = wordIds.filter(id => id !== wordId);
    this.db.prepare('UPDATE study_sessions SET word_ids = ? WHERE id = ?').run(
      JSON.stringify(newWordIds), sessionId
    );
    return true;
  }

  // ============ 统计数据 ============

  getStats() {
    const total = this.db.prepare('SELECT COUNT(*) as count FROM words').get().count;
    const learned = this.db.prepare('SELECT COUNT(*) as count FROM words WHERE is_learned = 1').get().count;
    const inProgress = this.db.prepare(
      'SELECT COUNT(*) as count FROM words WHERE is_learned = 0 AND first_seen_at IS NOT NULL'
    ).get().count;
    const notStarted = this.db.prepare(
      'SELECT COUNT(*) as count FROM words WHERE first_seen_at IS NULL'
    ).get().count;
    const dueForReview = this.db.prepare(`
      SELECT COUNT(*) as count FROM words
      WHERE is_learned = 0 AND next_review_at IS NOT NULL
        AND next_review_at <= datetime('now', 'localtime')
        AND mastery_level < 7
    `).get().count;

    // 各掌握等级的单词数量
    const masteryDistribution = this.db.prepare(`
      SELECT mastery_level, COUNT(*) as count
      FROM words WHERE is_learned = 0 AND first_seen_at IS NOT NULL
      GROUP BY mastery_level
      ORDER BY mastery_level
    `).all();

    // 各分类的单词数量
    const categoryDistribution = this.db.prepare(`
      SELECT category, COUNT(*) as total,
        SUM(CASE WHEN is_learned = 1 THEN 1 ELSE 0 END) as learned
      FROM words GROUP BY category ORDER BY total DESC
    `).all();

    // 最近7天的复习量
    const recentActivity = this.db.prepare(`
      SELECT date(reviewed_at) as date,
        COUNT(*) as total,
        SUM(CASE WHEN result = 'remembered' THEN 1 ELSE 0 END) as remembered,
        SUM(CASE WHEN result = 'forgotten' THEN 1 ELSE 0 END) as forgotten
      FROM review_history
      WHERE reviewed_at >= datetime('now', '-7 days', 'localtime')
      GROUP BY date(reviewed_at)
      ORDER BY date ASC
    `).all();

    // 今日复习量
    const today = localDate();
    const todayReviews = this.db.prepare(`
      SELECT COUNT(*) as count FROM review_history
      WHERE date(reviewed_at) = @today
    `).get({ today }).count;

    // 连续学习天数
    const streakDays = this._calculateStreak();

    // 学习时长统计
    const todayStudySeconds = this.db.prepare(`
      SELECT COALESCE(SUM(seconds), 0) AS s FROM study_time_log
      WHERE date(recorded_at) = @today
    `).get({ today }).s;

    const totalStudySeconds = this.db.prepare(
      'SELECT COALESCE(SUM(seconds), 0) AS s FROM study_time_log'
    ).get().s;

    const dailyStudyRows = this.db.prepare(`
      SELECT date(recorded_at) AS date, COALESCE(SUM(seconds), 0) AS seconds
      FROM study_time_log
      WHERE recorded_at >= datetime('now', '-7 days', 'localtime')
      GROUP BY date(recorded_at)
      ORDER BY date ASC
    `).all();
    // 对齐成 7 天序列，缺失的日期补 0
    const dailyStudyTime = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const pad = n => String(n).padStart(2, '0');
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      const row = dailyStudyRows.find(r => r.date === dateStr);
      dailyStudyTime.push({ date: dateStr, seconds: row ? row.seconds : 0 });
    }

    return {
      total,
      learned,
      inProgress,
      notStarted,
      dueForReview,
      masteryDistribution,
      categoryDistribution,
      recentActivity,
      todayReviews,
      streakDays,
      todayStudySeconds,
      totalStudySeconds,
      dailyStudyTime
    };
  }

  recordStudyTime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (s === 0) return { id: null, seconds: 0 };
    const info = this.db.prepare(
      'INSERT INTO study_time_log (seconds) VALUES (?)'
    ).run(s);
    return { id: info.lastInsertRowid, seconds: s };
  }

  _calculateStreak() {
    const days = this.db.prepare(`
      SELECT DISTINCT date(reviewed_at) as date
      FROM review_history
      ORDER BY date DESC
      LIMIT 60
    `).all().map(r => r.date);

    if (days.length === 0) return 0;

    let streak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < days.length; i++) {
      const expected = new Date(today);
      expected.setDate(expected.getDate() - i);
      const pad = n => String(n).padStart(2, '0');
      const expectedStr = `${expected.getFullYear()}-${pad(expected.getMonth()+1)}-${pad(expected.getDate())}`;
      if (days[i] === expectedStr) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }

  // 获取复习历史
  getReviewHistory({ page = 1, limit = 50 } = {}) {
    const offset = (page - 1) * limit;
    const total = this.db.prepare('SELECT COUNT(*) as count FROM review_history').get().count;

    const history = this.db.prepare(`
      SELECT rh.*, w.word, w.chinese
      FROM review_history rh
      JOIN words w ON rh.word_id = w.id
      ORDER BY rh.reviewed_at DESC
      LIMIT @limit OFFSET @offset
    `).all({ limit, offset });

    return { history, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  // 获取所有分类
  getCategories() {
    return this.db.prepare(
      'SELECT DISTINCT category FROM words ORDER BY category'
    ).all().map(r => r.category);
  }

  // ============ 待添加词库 ============
  getPendingWords() {
    return this.db.prepare(
      'SELECT * FROM pending_words ORDER BY added_at DESC'
    ).all();
  }

  addPendingWord(word, note = '') {
    try {
      const info = this.db.prepare(
        'INSERT INTO pending_words (word, note) VALUES (?, ?)'
      ).run(word.trim(), note.trim());
      return { success: true, id: info.lastInsertRowid };
    } catch (e) {
      if (e.message.includes('UNIQUE')) return { success: false, error: '该词已在待添加列表中' };
      throw e;
    }
  }

  updatePendingWord(id, note) {
    this.db.prepare('UPDATE pending_words SET note = ? WHERE id = ?').run(note, id);
  }

  deletePendingWord(id) {
    this.db.prepare('DELETE FROM pending_words WHERE id = ?').run(id);
  }

  deletePendingByWord(word) {
    this.db.prepare('DELETE FROM pending_words WHERE word = ? COLLATE NOCASE').run(word);
  }

  // ============ 单词补全批次 ============
  wordExists(word) {
    const row = this.db.prepare('SELECT id FROM words WHERE word = ? COLLATE NOCASE').get(word);
    return row ? row.id : null;
  }

  createEnrichmentBatch() {
    const info = this.db.prepare(
      'INSERT INTO enrichment_batches (added_count, skipped_count, failed_count) VALUES (0, 0, 0)'
    ).run();
    return info.lastInsertRowid;
  }

  // 写入 enriched 词条；该词若已存在则不写入，仅返回已存在的 id（保护历史数据）
  addEnrichedWord({ word, phonetic, chinese, category, examples, synonyms, batch_id }) {
    const existingId = this.wordExists(word);
    if (existingId) return { id: existingId, inserted: false };
    const info = this.db.prepare(`
      INSERT INTO words (word, phonetic, chinese, category, examples, synonyms, batch_id)
      VALUES (@word, @phonetic, @chinese, @category, @examples, @synonyms, @batch_id)
    `).run({
      word: word.trim(),
      phonetic: phonetic || '',
      chinese,
      category: category || '未分类',
      examples: JSON.stringify(examples || []),
      synonyms: JSON.stringify(synonyms || []),
      batch_id
    });
    return { id: info.lastInsertRowid, inserted: true };
  }

  recordBatchItem(batchId, { word, status, word_id = null, error = null }) {
    this.db.prepare(`
      INSERT INTO enrichment_batch_words (batch_id, word, status, word_id, error)
      VALUES (?, ?, ?, ?, ?)
    `).run(batchId, word, status, word_id, error);
  }

  finalizeBatch(batchId) {
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status='added'   THEN 1 ELSE 0 END) AS added_count,
        SUM(CASE WHEN status='skipped' THEN 1 ELSE 0 END) AS skipped_count,
        SUM(CASE WHEN status='failed'  THEN 1 ELSE 0 END) AS failed_count
      FROM enrichment_batch_words WHERE batch_id = ?
    `).get(batchId);
    this.db.prepare(`
      UPDATE enrichment_batches
      SET added_count = ?, skipped_count = ?, failed_count = ?
      WHERE id = ?
    `).run(counts.added_count || 0, counts.skipped_count || 0, counts.failed_count || 0, batchId);
  }

  // 删除空批次（无任何记录的批次，比如 pending 列表为空时）
  deleteBatchIfEmpty(batchId) {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM enrichment_batch_words WHERE batch_id = ?'
    ).get(batchId);
    if (!row || row.n === 0) {
      this.db.prepare('DELETE FROM enrichment_batches WHERE id = ?').run(batchId);
      return true;
    }
    return false;
  }

  listEnrichmentBatches() {
    return this.db.prepare(`
      SELECT id, created_at, added_count, skipped_count, failed_count
      FROM enrichment_batches
      ORDER BY created_at DESC, id DESC
    `).all();
  }

  getEnrichmentBatch(id) {
    const batch = this.db.prepare(
      'SELECT * FROM enrichment_batches WHERE id = ?'
    ).get(id);
    if (!batch) return null;
    const items = this.db.prepare(`
      SELECT word, status, word_id, error
      FROM enrichment_batch_words
      WHERE batch_id = ?
      ORDER BY id ASC
    `).all(id);
    return { ...batch, items };
  }

  // ============ 儿童识字模块 ============

  initKids() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kids_chars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        char TEXT NOT NULL UNIQUE,
        pinyin TEXT NOT NULL,
        category TEXT DEFAULT '基础',
        difficulty INTEGER DEFAULT 1,
        frequency INTEGER DEFAULT 5,
        components TEXT DEFAULT '[]',
        images TEXT DEFAULT '[]',
        mastery_level INTEGER DEFAULT 0,
        review_count INTEGER DEFAULT 0,
        correct_count INTEGER DEFAULT 0,
        first_seen_at TEXT,
        last_reviewed_at TEXT,
        next_review_at TEXT,
        is_learned INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS kids_char_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        char_id INTEGER NOT NULL,
        reviewed_at TEXT DEFAULT (datetime('now','localtime')),
        result TEXT NOT NULL CHECK(result IN ('known','unknown')),
        mastery_before INTEGER,
        mastery_after INTEGER,
        FOREIGN KEY (char_id) REFERENCES kids_chars(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS kids_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        char_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now','localtime')),
        completed INTEGER DEFAULT 0,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS kids_story_plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        story_id TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        played_at TEXT DEFAULT (datetime('now','localtime'))
      );

      CREATE TABLE IF NOT EXISTS kids_study_time_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module TEXT NOT NULL CHECK(module IN ('literacy','math','english','story')),
        seconds INTEGER NOT NULL,
        recorded_at TEXT DEFAULT (datetime('now','localtime'))
      );

      CREATE INDEX IF NOT EXISTS idx_kids_chars_next_review ON kids_chars(next_review_at);
      CREATE INDEX IF NOT EXISTS idx_kids_chars_learned ON kids_chars(is_learned);
      CREATE INDEX IF NOT EXISTS idx_kids_reviews_char ON kids_char_reviews(char_id);
      CREATE INDEX IF NOT EXISTS idx_kids_reviews_date ON kids_char_reviews(reviewed_at);
      CREATE INDEX IF NOT EXISTS idx_kids_story_plays_story ON kids_story_plays(story_id);
      CREATE INDEX IF NOT EXISTS idx_kids_story_plays_date ON kids_story_plays(played_at);
      CREATE INDEX IF NOT EXISTS idx_kids_study_time_module ON kids_study_time_log(module);
      CREATE INDEX IF NOT EXISTS idx_kids_study_time_date ON kids_study_time_log(recorded_at);
    `);
  }

  seedKidsChars() {
    const charPath = path.join(__dirname, 'data', 'kids_chars.json');
    if (!fs.existsSync(charPath)) return 0;
    const chars = JSON.parse(fs.readFileSync(charPath, 'utf-8'));

    const insert = this.db.prepare(`
      INSERT INTO kids_chars (char, pinyin, category, difficulty, frequency, components, images)
      VALUES (@char, @pinyin, @category, @difficulty, @frequency, @components, @images)
      ON CONFLICT(char) DO UPDATE SET
        pinyin = excluded.pinyin,
        category = excluded.category,
        difficulty = excluded.difficulty,
        frequency = excluded.frequency,
        components = excluded.components,
        images = excluded.images
    `);

    const insertMany = this.db.transaction((items) => {
      for (const c of items) {
        insert.run({
          char: c.char,
          pinyin: c.pinyin,
          category: c.category || '基础',
          difficulty: c.difficulty || 1,
          frequency: c.frequency || 5,
          components: JSON.stringify(c.components || []),
          images: JSON.stringify(c.images || [])
        });
      }
    });

    insertMany(chars);
    return chars.length;
  }

  getKidsChars({ category, is_learned, sort_by } = {}) {
    let where = ['1=1'];
    const params = {};

    if (category) {
      where.push('k.category = @category');
      params.category = category;
    }
    if (is_learned !== undefined) {
      where.push('k.is_learned = @is_learned');
      params.is_learned = is_learned ? 1 : 0;
    }

    const orderMap = {
      last_reviewed_desc: 'COALESCE(k.last_reviewed_at, k.created_at) DESC',
      review_count_desc: 'k.review_count DESC',
      correct_desc: 'k.correct_count DESC',
      error_desc: '(k.review_count - k.correct_count) DESC',
      mastery_asc: 'k.mastery_level ASC',
      mastery_desc: 'k.mastery_level DESC',
      difficulty_asc: 'k.difficulty ASC',
      category_asc: 'k.category ASC, k.char ASC',
    };
    const orderClause = orderMap[sort_by] || 'k.category ASC, k.difficulty ASC, k.id ASC';

    const stmt = this.db.prepare(`
      SELECT k.* FROM kids_chars k
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderClause}
    `);

    return stmt.all(params).map(c => ({
      ...c,
      components: JSON.parse(c.components || '[]'),
      images: JSON.parse(c.images || '[]'),
      is_learned: !!c.is_learned
    }));
  }

  getKidsChar(id) {
    const c = this.db.prepare('SELECT * FROM kids_chars WHERE id = ?').get(id);
    if (!c) return null;
    c.components = JSON.parse(c.components || '[]');
    c.images = JSON.parse(c.images || '[]');
    c.is_learned = !!c.is_learned;

    const history = this.db.prepare(
      'SELECT * FROM kids_char_reviews WHERE char_id = ? ORDER BY reviewed_at DESC LIMIT 20'
    ).all(id);

    return { ...c, history };
  }

  reviewKidsChar(id, known) {
    const c = this.db.prepare('SELECT * FROM kids_chars WHERE id = ?').get(id);
    if (!c) return null;

    const now = new Date();
    const nowStr = localNow();
    const oldLevel = c.mastery_level;
    let newLevel;

    if (known) {
      newLevel = Math.min(oldLevel + 1, 7);
    } else {
      newLevel = Math.max(0, oldLevel - 1);
    }

    // 计算下次复习时间（使用儿童间隔）
    let nextReview = null;
    if (newLevel < 7) {
      const intervalDays = KIDS_REVIEW_INTERVALS[newLevel] || 30;
      const next = new Date(now.getTime() + intervalDays * 24 * 3600 * 1000);
      next.setHours(8, 0, 0, 0);
      const pad = n => String(n).padStart(2, '0');
      nextReview = `${next.getFullYear()}-${pad(next.getMonth()+1)}-${pad(next.getDate())} 08:00:00`;
    }

    const isLearned = newLevel >= 7 ? 1 : 0;

    this.db.prepare(`
      UPDATE kids_chars SET
        mastery_level = @newLevel,
        review_count = review_count + 1,
        correct_count = correct_count + @correct,
        first_seen_at = COALESCE(first_seen_at, @now),
        last_reviewed_at = @now,
        next_review_at = @nextReview,
        is_learned = @isLearned
      WHERE id = @id
    `).run({ id, newLevel, correct: known ? 1 : 0, now: nowStr, nextReview, isLearned });

    this.db.prepare(`
      INSERT INTO kids_char_reviews (char_id, reviewed_at, result, mastery_before, mastery_after)
      VALUES (@char_id, @reviewed_at, @result, @mastery_before, @mastery_after)
    `).run({
      char_id: id,
      reviewed_at: nowStr,
      result: known ? 'known' : 'unknown',
      mastery_before: oldLevel,
      mastery_after: newLevel
    });

    return { id, char: c.char, oldLevel, newLevel, nextReview, isLearned: !!isLearned };
  }

  getTodayKidsSessions() {
    const today = localDate();
    return this.db.prepare(`
      SELECT * FROM kids_sessions
      WHERE date(created_at) = @today
      ORDER BY created_at DESC
    `).all({ today }).map(s => ({
      ...s,
      char_ids: JSON.parse(s.char_ids || '[]')
    }));
  }

  generateKidsSession({ force = false } = {}) {
    // 检查今日会话数（手动模式跳过限制）
    const todaySessions = this.getTodayKidsSessions();
    if (!force && todaySessions.length >= 2) {
      return { error: '今天学习完成啦！明天再来！🌟', canStudy: false };
    }

    // 检查间隔（至少4小时，手动模式跳过）
    if (!force && todaySessions.length > 0) {
      const lastSession = todaySessions[0];
      const lastTime = new Date(lastSession.created_at.replace(' ', 'T'));
      const now = new Date();
      const hoursDiff = (now - lastTime) / (1000 * 3600);
      if (hoursDiff < 4) {
        const waitHours = Math.ceil(4 - hoursDiff);
        return { error: `休息一下吧！${waitHours}小时后再来学习！🎈`, canStudy: false };
      }
    }

    // 选择复习字（到期的，最多3个）
    const now = localNow();
    const dueChars = this.db.prepare(`
      SELECT * FROM kids_chars
      WHERE is_learned = 0
        AND next_review_at IS NOT NULL
        AND next_review_at <= @now
        AND mastery_level < 7
      ORDER BY mastery_level ASC, next_review_at ASC
      LIMIT 3
    `).all({ now }).map(c => ({
      ...c,
      components: JSON.parse(c.components || '[]'),
      images: JSON.parse(c.images || '[]'),
      is_learned: false,
      isNew: false
    }));

    // 选择新字（最多2个，总数不超过5）— 仅从"当前阶段"抽
    const currentStage = this.getCurrentKidsStage();
    const newSlots = Math.min(2, 5 - dueChars.length);
    const newChars = newSlots > 0 ? this.db.prepare(`
      SELECT * FROM kids_chars
      WHERE is_learned = 0
        AND first_seen_at IS NULL
        AND difficulty = @stage
      ORDER BY frequency DESC, id ASC
      LIMIT @limit
    `).all({ limit: newSlots, stage: currentStage }).map(c => ({
      ...c,
      components: JSON.parse(c.components || '[]'),
      images: JSON.parse(c.images || '[]'),
      is_learned: false,
      isNew: true
    })) : [];

    const chars = [...dueChars, ...newChars];
    if (chars.length === 0) {
      return { error: '太棒了！所有字都学会啦！🎉', canStudy: false };
    }

    // 创建会话
    const charIds = chars.map(c => c.id);
    const result = this.db.prepare(`
      INSERT INTO kids_sessions (char_ids) VALUES (@ids)
    `).run({ ids: JSON.stringify(charIds) });

    // 标记新字的 first_seen_at
    const nowStr = localNow();
    const markSeen = this.db.prepare(`
      UPDATE kids_chars SET
        first_seen_at = COALESCE(first_seen_at, @now),
        next_review_at = COALESCE(next_review_at, @now)
      WHERE id = @id AND first_seen_at IS NULL
    `);
    for (const id of charIds) {
      markSeen.run({ id, now: nowStr });
    }

    return {
      canStudy: true,
      session: {
        id: result.lastInsertRowid,
        chars,
        dueCount: dueChars.length,
        newCount: newChars.length,
        totalToday: todaySessions.length + 1
      }
    };
  }

  completeKidsSession(id) {
    const nowStr = localNow();
    this.db.prepare(
      'UPDATE kids_sessions SET completed = 1, completed_at = @now WHERE id = @id'
    ).run({ id, now: nowStr });
  }

  getKidsStats() {
    const total = this.db.prepare('SELECT COUNT(*) as c FROM kids_chars').get().c;
    const learned = this.db.prepare('SELECT COUNT(*) as c FROM kids_chars WHERE is_learned = 1').get().c;
    const inProgress = this.db.prepare(
      'SELECT COUNT(*) as c FROM kids_chars WHERE is_learned = 0 AND first_seen_at IS NOT NULL'
    ).get().c;
    const notStarted = this.db.prepare(
      'SELECT COUNT(*) as c FROM kids_chars WHERE first_seen_at IS NULL'
    ).get().c;

    // 总复习次数和正确率
    const reviewStats = this.db.prepare(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN result = 'known' THEN 1 ELSE 0 END) as correct
      FROM kids_char_reviews
    `).get();
    const accuracy = reviewStats.total > 0 ? Math.round(reviewStats.correct / reviewStats.total * 100) : 0;

    // 连续打卡天数
    const streakDays = this._calculateKidsStreak();

    // 今日学习
    const today = localDate();
    const todayReviews = this.db.prepare(
      'SELECT COUNT(*) as c FROM kids_char_reviews WHERE date(reviewed_at) = @today'
    ).get({ today }).c;
    const todaySessions = this.getTodayKidsSessions();

    // 分类统计
    const categoryStats = this.db.prepare(`
      SELECT category,
        COUNT(*) as total,
        SUM(CASE WHEN is_learned = 1 THEN 1 ELSE 0 END) as learned,
        SUM(review_count) as reviews,
        SUM(correct_count) as correct
      FROM kids_chars
      GROUP BY category
      ORDER BY category
    `).all();

    // 最近7天活动
    const dailyStats = this.db.prepare(`
      SELECT date(reviewed_at) as date,
        COUNT(*) as total,
        SUM(CASE WHEN result = 'known' THEN 1 ELSE 0 END) as correct,
        SUM(CASE WHEN result = 'unknown' THEN 1 ELSE 0 END) as wrong
      FROM kids_char_reviews
      WHERE reviewed_at >= datetime('now', '-7 days', 'localtime')
      GROUP BY date(reviewed_at)
      ORDER BY date ASC
    `).all();

    // 最近4周周统计
    const weeklyStats = this.db.prepare(`
      SELECT strftime('%Y-W%W', reviewed_at) as week,
        COUNT(*) as total,
        SUM(CASE WHEN result = 'known' THEN 1 ELSE 0 END) as correct
      FROM kids_char_reviews
      WHERE reviewed_at >= datetime('now', '-28 days', 'localtime')
      GROUP BY week
      ORDER BY week ASC
    `).all();

    // 最近6个月月统计
    const monthlyStats = this.db.prepare(`
      SELECT strftime('%Y-%m', reviewed_at) as month,
        COUNT(*) as total,
        SUM(CASE WHEN result = 'known' THEN 1 ELSE 0 END) as correct
      FROM kids_char_reviews
      WHERE reviewed_at >= datetime('now', '-180 days', 'localtime')
      GROUP BY month
      ORDER BY month ASC
    `).all();

    // 每个字的统计
    const charStats = this.db.prepare(`
      SELECT id, char, pinyin, category, mastery_level, review_count,
        correct_count, is_learned, first_seen_at, last_reviewed_at
      FROM kids_chars
      WHERE first_seen_at IS NOT NULL
      ORDER BY last_reviewed_at DESC
    `).all().map(c => ({
      ...c,
      is_learned: !!c.is_learned,
      error_count: c.review_count - c.correct_count,
      accuracy: c.review_count > 0 ? Math.round(c.correct_count / c.review_count * 100) : 0
    }));

    return {
      total, learned, inProgress, notStarted,
      totalReviews: reviewStats.total,
      totalCorrect: reviewStats.correct,
      accuracy,
      streakDays,
      todayReviews,
      todaySessions: todaySessions.length,
      categoryStats,
      dailyStats,
      weeklyStats,
      monthlyStats,
      charStats
    };
  }

  _calculateKidsStreak() {
    const days = this.db.prepare(`
      SELECT DISTINCT date(reviewed_at) as date
      FROM kids_char_reviews
      ORDER BY date DESC
      LIMIT 60
    `).all().map(r => r.date);

    if (days.length === 0) return 0;

    let streak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < days.length; i++) {
      const expected = new Date(today);
      expected.setDate(expected.getDate() - i);
      const pad = n => String(n).padStart(2, '0');
      const expectedStr = `${expected.getFullYear()}-${pad(expected.getMonth()+1)}-${pad(expected.getDate())}`;
      if (days[i] === expectedStr) {
        streak++;
      } else {
        break;
      }
    }
    return streak;
  }

  getKidsCategories() {
    return this.db.prepare(
      'SELECT DISTINCT category FROM kids_chars ORDER BY category'
    ).all().map(r => r.category);
  }

  // ============ 阶段化（按 difficulty 分阶段） ============
  // 阶段通关条件：该阶段已学会比例 ≥ 80% 且 该阶段历史正确率 ≥ 80%

  getKidsStageStats() {
    const rows = this.db.prepare(`
      SELECT
        k.difficulty AS stage,
        COUNT(*) AS total,
        SUM(CASE WHEN k.is_learned = 1 THEN 1 ELSE 0 END) AS learned,
        SUM(CASE WHEN k.first_seen_at IS NOT NULL THEN 1 ELSE 0 END) AS seen,
        COALESCE(SUM(k.review_count), 0) AS reviews,
        COALESCE(SUM(k.correct_count), 0) AS correct
      FROM kids_chars k
      GROUP BY k.difficulty
      ORDER BY k.difficulty ASC
    `).all();

    const LEARN_RATIO = 0.8;
    const ACC_RATIO = 0.8;

    return rows.map(r => {
      const learnRatio = r.total > 0 ? r.learned / r.total : 0;
      const accuracy = r.reviews > 0 ? r.correct / r.reviews : 0;
      const passed = learnRatio >= LEARN_RATIO && accuracy >= ACC_RATIO;
      return {
        stage: r.stage,
        total: r.total,
        learned: r.learned,
        seen: r.seen,
        reviews: r.reviews,
        correct: r.correct,
        learnRatio: Math.round(learnRatio * 100),
        accuracy: r.reviews > 0 ? Math.round(accuracy * 100) : 0,
        passed,
        learnThreshold: Math.round(LEARN_RATIO * 100),
        accThreshold: Math.round(ACC_RATIO * 100)
      };
    });
  }

  // 当前应解锁/学习的阶段：第一个未通关阶段；全部通关返回最高阶段
  getCurrentKidsStage() {
    const stages = this.getKidsStageStats();
    if (stages.length === 0) return 1;
    const next = stages.find(s => !s.passed);
    return next ? next.stage : stages[stages.length - 1].stage;
  }

  // ============ 故事播放记录 ============
  recordStoryPlay(storyId, durationSeconds) {
    // 上限 1800 秒：单次故事播放再长也不会超过 30 分钟，防止页面挂机导致脏数据。
    const raw = Math.max(0, Math.floor(Number(durationSeconds) || 0));
    const dur = Math.min(raw, 1800);
    const info = this.db.prepare(
      'INSERT INTO kids_story_plays (story_id, duration_seconds) VALUES (?, ?)'
    ).run(storyId, dur);
    return { id: info.lastInsertRowid, duration_seconds: dur };
  }

  getStoryPlayStatsAll() {
    const rows = this.db.prepare(`
      SELECT story_id,
        COUNT(*) AS play_count,
        COALESCE(SUM(duration_seconds), 0) AS total_seconds,
        MAX(played_at) AS last_played_at
      FROM kids_story_plays
      GROUP BY story_id
    `).all();
    const map = {};
    for (const r of rows) map[r.story_id] = r;
    return map;
  }

  getStoryPlays(storyId, limit = 20) {
    return this.db.prepare(`
      SELECT * FROM kids_story_plays
      WHERE story_id = ?
      ORDER BY played_at DESC
      LIMIT ?
    `).all(storyId, limit);
  }

  // ============ 儿童学习时长记录 ============
  // 模块：literacy / math / english / story
  // 注意：story 时长本身已记录到 kids_story_plays，仅当不通过故事 reader 上报时才会写到这张表。
  recordKidsStudyTime(module, seconds) {
    const allowed = ['literacy', 'math', 'english', 'story'];
    if (!allowed.includes(module)) return { id: null, seconds: 0 };
    const s = Math.max(0, Math.floor(Number(seconds) || 0));
    if (s === 0) return { id: null, seconds: 0 };
    const info = this.db.prepare(
      'INSERT INTO kids_study_time_log (module, seconds) VALUES (?, ?)'
    ).run(module, s);
    return { id: info.lastInsertRowid, module, seconds: s };
  }

  // 学习统计总览：合并 kids_study_time_log（literacy/math/english）+ kids_story_plays（story）。
  getKidsStudyTimeOverview() {
    const MODULES = ['literacy', 'math', 'english', 'story'];

    // 各模块整体累计时长
    const allTotalsRows = this.db.prepare(`
      SELECT module, COALESCE(SUM(seconds), 0) AS seconds
      FROM kids_study_time_log
      GROUP BY module
    `).all();
    const storyAll = this.db.prepare(
      'SELECT COALESCE(SUM(duration_seconds), 0) AS seconds FROM kids_story_plays'
    ).get().seconds;

    const allByModule = {};
    for (const m of MODULES) allByModule[m] = 0;
    for (const r of allTotalsRows) {
      if (allByModule[r.module] !== undefined) allByModule[r.module] += r.seconds;
    }
    allByModule.story += storyAll;

    // 近 7 日：按 (date, module) 分组
    const sevenDaysAgo = this.db.prepare(`
      SELECT module, date(recorded_at) AS date, COALESCE(SUM(seconds), 0) AS seconds
      FROM kids_study_time_log
      WHERE recorded_at >= datetime('now', '-7 days', 'localtime')
      GROUP BY module, date(recorded_at)
    `).all();

    const sevenStoryRows = this.db.prepare(`
      SELECT date(played_at) AS date, COALESCE(SUM(duration_seconds), 0) AS seconds
      FROM kids_story_plays
      WHERE played_at >= datetime('now', '-7 days', 'localtime')
      GROUP BY date(played_at)
    `).all();

    // 构造近 7 天序列（含今天）
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const pad = n => String(n).padStart(2, '0');
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const perModule = { literacy: 0, math: 0, english: 0, story: 0 };
      for (const r of sevenDaysAgo) {
        if (r.date === dateStr && perModule[r.module] !== undefined) perModule[r.module] += r.seconds;
      }
      for (const r of sevenStoryRows) {
        if (r.date === dateStr) perModule.story += r.seconds;
      }
      days.push({ date: dateStr, perModule, total: perModule.literacy + perModule.math + perModule.english + perModule.story });
    }

    const sevenByModule = { literacy: 0, math: 0, english: 0, story: 0 };
    for (const d of days) {
      for (const m of MODULES) sevenByModule[m] += d.perModule[m];
    }
    const sevenTotal = sevenByModule.literacy + sevenByModule.math + sevenByModule.english + sevenByModule.story;
    const allTotal = allByModule.literacy + allByModule.math + allByModule.english + allByModule.story;

    return {
      sevenTotal,
      allTotal,
      sevenByModule,
      allByModule,
      days
    };
  }

  close() {
    logger.info('数据库连接已关闭');
    this.db.close();
  }
}

module.exports = { VocabDB, REVIEW_INTERVALS, KIDS_REVIEW_INTERVALS };
