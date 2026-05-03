const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { VocabDB, REVIEW_INTERVALS, KIDS_REVIEW_INTERVALS } = require('./db');
const logger = require('./logger');
const { enrichBatch } = require('./enrich');

const app = express();
const PORT = process.env.PORT || 80;

// 初始化数据库
const db = new VocabDB(path.join(__dirname, 'vocab.db'));
const seedCount = db.seedVocabulary();
logger.info('词库已加载', { count: seedCount });
const kidsSeedCount = db.seedKidsChars();
logger.info('儿童字库已加载', { count: kidsSeedCount });

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
  const { category, is_learned, search, batch_id, sort_by, page, limit } = req.query;
  const result = db.getWords({
    category,
    is_learned: is_learned !== undefined ? is_learned === 'true' : undefined,
    search,
    batch_id,
    sort_by,
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

// 记录学习时长（前端每隔一段时间或卸载时上报累计秒数）
app.post('/api/study-time', (req, res) => {
  const seconds = parseInt(req.body && req.body.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    return res.status(400).json({ error: 'seconds 必须为 1..600 的整数' });
  }
  const result = db.recordStudyTime(seconds);
  res.json({ success: true, ...result });
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

// 一键补全 + 入库：取所有 pending 词 → 已存在跳过 → 否则调 Claude CLI 生成 → 写入 words → 记入批次
app.post('/api/pending/enrich', async (req, res) => {
  const pending = db.getPendingWords();
  if (pending.length === 0) {
    return res.json({ message: '待添加词库为空', batch: null });
  }

  const concurrency = Math.max(1, Math.min(parseInt(req.body && req.body.concurrency) || 3, 5));
  const batchId = db.createEnrichmentBatch();
  logger.info('开始补全批次', { batchId, total: pending.length, concurrency });

  const toEnrich = [];
  for (const p of pending) {
    const existingId = db.wordExists(p.word);
    if (existingId) {
      db.recordBatchItem(batchId, { word: p.word, status: 'skipped', word_id: existingId });
      db.deletePendingByWord(p.word);
    } else {
      toEnrich.push(p.word);
    }
  }

  await enrichBatch(toEnrich, {
    concurrency,
    onItem: (item) => {
      if (item.ok) {
        try {
          const r = db.addEnrichedWord({
            word: item.word,
            phonetic: item.data.phonetic,
            chinese: item.data.chinese,
            category: item.data.category,
            examples: item.data.examples,
            synonyms: item.data.synonyms,
            batch_id: batchId
          });
          if (r.inserted) {
            db.recordBatchItem(batchId, { word: item.word, status: 'added', word_id: r.id });
          } else {
            db.recordBatchItem(batchId, { word: item.word, status: 'skipped', word_id: r.id });
          }
          db.deletePendingByWord(item.word);
        } catch (e) {
          logger.error('入库失败', { word: item.word, error: e.message });
          db.recordBatchItem(batchId, { word: item.word, status: 'failed', error: e.message });
        }
      } else {
        logger.warn('补全失败', { word: item.word, error: item.error });
        db.recordBatchItem(batchId, { word: item.word, status: 'failed', error: item.error });
      }
    }
  });

  db.finalizeBatch(batchId);
  const batch = db.getEnrichmentBatch(batchId);
  logger.info('补全批次完成', {
    batchId,
    added: batch.added_count,
    skipped: batch.skipped_count,
    failed: batch.failed_count
  });
  res.json({ batch });
});

// --- 补全批次历史 ---
app.get('/api/batches', (req, res) => {
  res.json({ batches: db.listEnrichmentBatches() });
});

app.get('/api/batches/:id', (req, res) => {
  const batch = db.getEnrichmentBatch(parseInt(req.params.id));
  if (!batch) return res.status(404).json({ error: '批次不存在' });
  res.json({ batch });
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

// ============ 儿童学习模块 ============

// 儿童学习页面
app.get('/kids', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kids.html'));
});

// 字库列表
app.get('/api/kids/chars', (req, res) => {
  const { category, is_learned, sort_by } = req.query;
  const chars = db.getKidsChars({
    category,
    is_learned: is_learned !== undefined ? is_learned === 'true' : undefined,
    sort_by
  });
  res.json({ chars });
});

// 单字详情
app.get('/api/kids/chars/:id', (req, res) => {
  const char = db.getKidsChar(parseInt(req.params.id));
  if (!char) return res.status(404).json({ error: '未找到该字' });
  res.json(char);
});

// 复习
app.post('/api/kids/chars/:id/review', (req, res) => {
  const { known } = req.body;
  if (typeof known !== 'boolean') {
    return res.status(400).json({ error: 'known 字段必须为布尔值' });
  }
  const result = db.reviewKidsChar(parseInt(req.params.id), known);
  if (!result) return res.status(404).json({ error: '未找到该字' });
  logger.info('儿童复习结果', { id: result.id, char: result.char, known, levelChange: `${result.oldLevel}->${result.newLevel}` });
  res.json(result);
});

// 生成学习批次
app.post('/api/kids/sessions/generate', (req, res) => {
  const force = req.body.force === true;
  const result = db.generateKidsSession({ force });
  if (!result.canStudy) {
    return res.json({ message: result.error, session: null });
  }
  logger.info('儿童学习批次已生成', { sessionId: result.session.id, due: result.session.dueCount, new: result.session.newCount });
  res.json(result);
});

// 今日会话
app.get('/api/kids/sessions/today', (req, res) => {
  const sessions = db.getTodayKidsSessions();
  res.json({ sessions });
});

// 完成会话
app.post('/api/kids/sessions/:id/complete', (req, res) => {
  db.completeKidsSession(parseInt(req.params.id));
  res.json({ success: true });
});

// 统计数据
app.get('/api/kids/stats', (req, res) => {
  const stats = db.getKidsStats();
  res.json(stats);
});

// 分类列表
app.get('/api/kids/categories', (req, res) => {
  const categories = db.getKidsCategories();
  res.json({ categories });
});

// 阶段进度
app.get('/api/kids/stages', (req, res) => {
  const stages = db.getKidsStageStats();
  const currentStage = db.getCurrentKidsStage();
  res.json({ stages, currentStage });
});

// 故事列表
const storiesData = require('./data/kids_stories.json');
app.get('/api/kids/stories', (req, res) => {
  const statsMap = db.getStoryPlayStatsAll();
  const list = (storiesData.stories || []).map(s => {
    const st = statsMap[s.id];
    return {
      id: s.id,
      title: s.title,
      cover: s.cover,
      bg: s.bg,
      summary: s.summary,
      play_count: st ? st.play_count : 0,
      total_seconds: st ? st.total_seconds : 0,
      last_played_at: st ? st.last_played_at : null
    };
  });
  res.json({ stories: list });
});

// 故事详情
app.get('/api/kids/stories/:id', (req, res) => {
  const story = (storiesData.stories || []).find(s => s.id === req.params.id);
  if (!story) return res.status(404).json({ error: '未找到故事' });
  const plays = db.getStoryPlays(req.params.id, 20);
  const total = plays.reduce((sum, p) => sum + (p.duration_seconds || 0), 0);
  res.json({
    ...story,
    play_count: plays.length,
    total_seconds: total,
    plays
  });
});

// 记录儿童学习时长（按子模块），前端定时或卸载时上报累计秒数
app.post('/api/kids/study-time', (req, res) => {
  const { module, seconds } = req.body || {};
  const sec = parseInt(seconds);
  if (!['literacy', 'math', 'english', 'story'].includes(module)) {
    return res.status(400).json({ error: 'module 非法' });
  }
  if (!Number.isFinite(sec) || sec <= 0 || sec > 600) {
    return res.status(400).json({ error: 'seconds 必须为 1..600 的整数' });
  }
  const result = db.recordKidsStudyTime(module, sec);
  res.json({ success: true, ...result });
});

// 学习统计总览：近 7 日 + 全部累计 + 各模块对比 + 每日明细
app.get('/api/kids/study-time/overview', (req, res) => {
  const overview = db.getKidsStudyTimeOverview();
  res.json(overview);
});

// 记录故事播放
app.post('/api/kids/stories/:id/plays', (req, res) => {
  const { duration } = req.body || {};
  const story = (storiesData.stories || []).find(s => s.id === req.params.id);
  if (!story) return res.status(404).json({ error: '未找到故事' });
  const result = db.recordStoryPlay(req.params.id, duration);
  logger.info('故事播放已记录', { storyId: req.params.id, duration: result.duration_seconds });
  res.status(201).json({ success: true, ...result });
});

// 故事语音总结 — 上传录音
const SUMMARIES_DIR = path.join(__dirname, 'public', 'audio', 'summaries');
fs.mkdirSync(SUMMARIES_DIR, { recursive: true });

app.post('/api/kids/stories/:id/summaries', (req, res) => {
  const storyId = req.params.id;
  const story = (storiesData.stories || []).find(s => s.id === storyId);
  if (!story) return res.status(404).json({ error: '未找到故事' });

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (buf.length < 100) return res.status(400).json({ error: '录音内容为空' });
    const ts = Date.now();
    const filename = `${storyId}_${ts}.webm`;
    const filepath = path.join(SUMMARIES_DIR, filename);
    fs.writeFile(filepath, buf, err => {
      if (err) {
        logger.error('保存录音失败', { err: err.message });
        return res.status(500).json({ error: '保存失败' });
      }
      logger.info('故事语音总结已保存', { storyId, filename });
      res.status(201).json({ success: true, filename, url: `/audio/summaries/${filename}`, created_at: ts });
    });
  });
  req.on('error', () => res.status(500).json({ error: '上传失败' }));
});

// 故事语音总结 — 列表
app.get('/api/kids/stories/:id/summaries', (req, res) => {
  const storyId = req.params.id;
  let files;
  try {
    files = fs.readdirSync(SUMMARIES_DIR)
      .filter(f => f.startsWith(storyId + '_') && f.endsWith('.webm'))
      .sort()
      .reverse()
      .map(f => {
        const ts = parseInt(f.replace(`${storyId}_`, '').replace('.webm', '')) || 0;
        return { filename: f, url: `/audio/summaries/${f}`, created_at: ts };
      });
  } catch {
    files = [];
  }
  res.json({ summaries: files });
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
