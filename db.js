const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

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

      CREATE INDEX IF NOT EXISTS idx_words_next_review ON words(next_review_at);
      CREATE INDEX IF NOT EXISTS idx_words_is_learned ON words(is_learned);
      CREATE INDEX IF NOT EXISTS idx_words_mastery ON words(mastery_level);
      CREATE INDEX IF NOT EXISTS idx_review_history_word ON review_history(word_id);
      CREATE INDEX IF NOT EXISTS idx_review_history_date ON review_history(reviewed_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_time ON study_sessions(scheduled_time);
    `);
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
  getWords({ category, is_learned, search, page = 1, limit = 50 } = {}) {
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

    const offset = (page - 1) * limit;
    params.limit = limit;
    params.offset = offset;

    const countStmt = this.db.prepare(
      `SELECT COUNT(*) as total FROM words WHERE ${where.join(' AND ')}`
    );
    const { total } = countStmt.get(params);

    const stmt = this.db.prepare(`
      SELECT * FROM words
      WHERE ${where.join(' AND ')}
      ORDER BY
        CASE WHEN is_learned = 1 THEN 1 ELSE 0 END,
        mastery_level ASC,
        word ASC
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
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
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

  // 智能批次：按 dueRatio 比例 + 交错排版
  generateSmartBatch(size = 10, { dueRatio = 0.7 } = {}) {
    const dueTarget = Math.ceil(size * dueRatio);
    const dueCandidates = this.getSmartReviewCandidates(size);
    const dueSelected = dueCandidates.slice(0, Math.min(dueTarget, size));

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
    const nowStr = now.toISOString().slice(0, 19).replace('T', ' ');
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
      nextReview = next.toISOString().slice(0, 19).replace('T', ' ');
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
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
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
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
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
    const today = new Date().toISOString().slice(0, 10);
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
    const today = new Date().toISOString().slice(0, 10);
    const todayReviews = this.db.prepare(`
      SELECT COUNT(*) as count FROM review_history
      WHERE date(reviewed_at) = @today
    `).get({ today }).count;

    // 连续学习天数
    const streakDays = this._calculateStreak();

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
      streakDays
    };
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
      const expectedStr = expected.toISOString().slice(0, 10);
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

  close() {
    logger.info('数据库连接已关闭');
    this.db.close();
  }
}

module.exports = { VocabDB, REVIEW_INTERVALS };
