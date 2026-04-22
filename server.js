const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { VocabDB, REVIEW_INTERVALS } = require('./db');
const logger = require('./logger');

const app = express();
const PORT = process.env.PORT || 3000;

// 初始化数据库
const db = new VocabDB(path.join(__dirname, 'vocab.db'));
const seedCount = db.seedVocabulary();
logger.info('词库已加载', { count: seedCount });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 请求日志中间件
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level](`${req.method} ${req.path}`, { status: res.statusCode, ms });
  });
  next();
});

// ============ API 路由 ============

// --- 词汇 ---

// 获取词汇列表
app.get('/api/words', (req, res) => {
  const { category, is_learned, search, page, limit } = req.query;
  const result = db.getWords({
    category,
    is_learned: is_learned !== undefined ? is_learned === 'true' : undefined,
    search,
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 50
  });
  res.json(result);
});

// 获取单个词汇详情
app.get('/api/words/:id', (req, res) => {
  const word = db.getWord(parseInt(req.params.id));
  if (!word) return res.status(404).json({ error: '未找到该单词' });
  res.json(word);
});

// 添加新单词
app.post('/api/words', (req, res) => {
  const { word, phonetic, chinese, category, examples, synonyms } = req.body;
  if (!word || !chinese) {
    return res.status(400).json({ error: '单词和中文释义为必填项' });
  }
  const result = db.addWord({ word, phonetic, chinese, category, examples, synonyms });
  if (!result.success) {
    logger.warn('添加单词冲突', { word, error: result.error });
    return res.status(409).json({ error: result.error });
  }
  logger.info('新词已添加', { id: result.id, word });
  res.status(201).json(result);
});

// 删除单词
app.delete('/api/words/:id', (req, res) => {
  db.deleteWord(parseInt(req.params.id));
  res.json({ success: true });
});

// --- 复习（艾宾浩斯） ---

// 复习单词：记住 / 忘记
app.post('/api/words/:id/review', (req, res) => {
  const { remembered } = req.body;
  if (typeof remembered !== 'boolean') {
    return res.status(400).json({ error: 'remembered 字段必须为布尔值' });
  }
  const result = db.reviewWord(parseInt(req.params.id), remembered);
  if (!result) return res.status(404).json({ error: '未找到该单词' });

  const interval = REVIEW_INTERVALS[result.newLevel];
  logger.info('复习结果', {
    id: result.id,
    word: result.word,
    remembered,
    levelChange: `${result.oldLevel}->${result.newLevel}`,
    nextReview: result.nextReview
  });
  res.json({
    ...result,
    message: remembered
      ? `记住了！掌握等级 ${result.oldLevel} → ${result.newLevel}，${interval ? interval + '天后复习' : '已掌握'}`
      : `忘记了，掌握等级 ${result.oldLevel} → ${result.newLevel}，${interval}天后复习`
  });
});

// 标记为已学会
app.post('/api/words/:id/learned', (req, res) => {
  db.markLearned(parseInt(req.params.id));
  res.json({ success: true, message: '已标记为学会' });
});

// 取消已学会
app.post('/api/words/:id/unlearn', (req, res) => {
  db.unmarkLearned(parseInt(req.params.id));
  res.json({ success: true, message: '已重新加入学习' });
});

// 获取待复习单词
app.get('/api/review/due', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const words = db.getDueWords(limit);
  res.json({ words, count: words.length });
});

// --- 学习会话 ---

// 手动生成一个学习批次
app.post('/api/sessions/generate', (req, res) => {
  const size = parseInt(req.body.size) || 10;
  const batch = db.generateSmartBatch(size);

  if (batch.total === 0) {
    logger.info('生成批次：无需学习的单词');
    return res.json({ message: '没有需要学习的单词了！', session: null });
  }

  const wordIds = batch.words.map(w => w.id);
  const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  const sessionId = db.createSession(now, wordIds);
  logger.info('学习批次已生成', { sessionId, due: batch.dueWords.length, newWords: batch.newWords.length });

  res.json({
    session: {
      id: sessionId,
      scheduled_time: now,
      words: batch.words,
      dueCount: batch.dueWords.length,
      newCount: batch.newWords.length
    }
  });
});

// 获取最新会话
app.get('/api/sessions/latest', (req, res) => {
  const session = db.getLatestSession();
  res.json({ session });
});

// 获取今日会话
app.get('/api/sessions/today', (req, res) => {
  const sessions = db.getTodaySessions();
  res.json({ sessions });
});

// 标记会话完成
app.post('/api/sessions/:id/complete', (req, res) => {
  db.completeSession(parseInt(req.params.id));
  res.json({ success: true });
});

// 从会话中移除单词（记住后）
app.delete('/api/sessions/:id/words/:wordId', (req, res) => {
  const ok = db.removeWordFromSession(parseInt(req.params.id), parseInt(req.params.wordId));
  if (!ok) return res.status(404).json({ error: '会话不存在' });
  res.json({ success: true });
});

// --- 统计 ---

app.get('/api/stats', (req, res) => {
  const stats = db.getStats();
  res.json(stats);
});

app.get('/api/history', (req, res) => {
  const { page, limit } = req.query;
  const result = db.getReviewHistory({
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 50
  });
  res.json(result);
});

app.get('/api/categories', (req, res) => {
  const categories = db.getCategories();
  res.json({ categories });
});

// ============ 待添加词库 ============

// 获取列表
app.get('/api/pending', (req, res) => {
  res.json({ words: db.getPendingWords() });
});

// 添加
app.post('/api/pending', (req, res) => {
  const { word, note } = req.body;
  if (!word || !word.trim()) return res.status(400).json({ error: '单词不能为空' });
  const result = db.addPendingWord(word, note || '');
  if (!result.success) return res.status(409).json({ error: result.error });
  logger.info('待添加词已记录', { word });
  res.status(201).json(result);
});

// 更新备注
app.patch('/api/pending/:id', (req, res) => {
  const { note } = req.body;
  db.updatePendingWord(parseInt(req.params.id), note || '');
  res.json({ success: true });
});

// 删除
app.delete('/api/pending/:id', (req, res) => {
  db.deletePendingWord(parseInt(req.params.id));
  res.json({ success: true });
});

// 获取艾宾浩斯间隔配置
app.get('/api/ebbinghaus', (req, res) => {
  res.json({
    intervals: REVIEW_INTERVALS,
    description: [
      'Level 0: 新词',
      'Level 1: 1天后复习',
      'Level 2: 2天后复习',
      'Level 3: 4天后复习',
      'Level 4: 7天后复习',
      'Level 5: 15天后复习',
      'Level 6: 30天后复习',
      'Level 7: 已掌握'
    ]
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ 定时任务 ============
// 每天 8:00, 12:00, 18:00, 20:00 自动生成学习批次
const PUSH_TIMES = ['0 8 * * *', '0 12 * * *', '0 18 * * *', '0 20 * * *'];
const PUSH_LABELS = ['08:00', '12:00', '18:00', '20:00'];

PUSH_TIMES.forEach((cronExpr, i) => {
  cron.schedule(cronExpr, () => {
    const batch = db.generateSmartBatch(10);
    if (batch.total > 0) {
      const wordIds = batch.words.map(w => w.id);
      db.createSession(PUSH_LABELS[i], wordIds);
      logger.info(`[cron ${PUSH_LABELS[i]}] 学习批次已生成`, { due: batch.dueWords.length, newWords: batch.newWords.length });
    } else {
      logger.info(`[cron ${PUSH_LABELS[i]}] 所有单词已学会，跳过生成`);
    }
  }, { timezone: 'Asia/Shanghai' });
});

// ============ 启动服务器 ============
app.listen(PORT, () => {
  logger.info('AI论文词汇学习系统已启动', {
    url: `http://localhost:${PORT}`,
    pushTimes: PUSH_LABELS.join(', '),
    ebbinghausIntervals: REVIEW_INTERVALS.join(', ') + ' 天'
  });
});

// 优雅退出
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
process.on('SIGTERM', () => {
  db.close();
  process.exit(0);
});
