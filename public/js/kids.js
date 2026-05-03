// ============ 儿童识字模块前端逻辑 ============

// ===== 状态管理 =====
let currentModule = null; // null=hub, 'literacy', 'math', 'english'
let currentView = 'hub';
let studySession = null;
let studyIndex = 0;
let studyReviewed = {}; // { [index]: true | false } — choice already submitted to API
let statsData = null;
let chartMode = 'daily'; // daily | weekly | monthly

// ===== 语音引擎 =====
let _speakAudio = null;
let _speakToken = 0;
function speak(text, rate = 0.8) {
  if (!text) return;
  const myToken = ++_speakToken;

  if (_speakAudio) { try { _speakAudio.pause(); _speakAudio.src = ''; } catch (_) {} _speakAudio = null; }
  window.speechSynthesis && window.speechSynthesis.cancel();

  const fallback = () => {
    if (myToken !== _speakToken) return;
    if (!('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN'; u.rate = rate; u.pitch = 1.1; u.volume = 1;
      const voices = window.speechSynthesis.getVoices();
      const zhVoice = voices.find(v => v.lang.startsWith('zh'));
      if (zhVoice) u.voice = zhVoice;
      window.speechSynthesis.speak(u);
    } catch (_) {}
  };

  let fired = false;
  const fireFallback = () => { if (!fired) { fired = true; fallback(); } };

  try {
    const audio = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&le=zh`);
    _speakAudio = audio;
    audio.addEventListener('error', fireFallback);
    const p = audio.play();
    if (p && typeof p.catch === 'function') p.catch(fireFallback);
  } catch (_) {
    fireFallback();
  }
}

// ===== 学习提示 =====
const STUDY_HINTS = [
  '跟着读一读！📢',
  '看看图片，想想这个字！🖼️',
  '你认识这个字吗？🤔',
  '点击大字可以听读音哦！🔊',
  '仔细看看这个字长什么样！👀',
  '真棒，继续加油！💪'
];

function getRandomHint() {
  return STUDY_HINTS[Math.floor(Math.random() * STUDY_HINTS.length)];
}

// ===== 能力评估 =====
// 识字：基于已学会字数（参考小学语文课标识字量）和正确率
function evalLiteracy(stats) {
  const learned = stats.learned || 0;
  const acc = stats.accuracy || 0;
  const reviews = stats.totalReviews || 0;
  let level, grade, color;
  if (learned >= 2500) { level = 5; grade = '小学高年级（5-6年级）'; color = '#8b5cf6'; }
  else if (learned >= 1600) { level = 4; grade = '小学三年级'; color = '#3b82f6'; }
  else if (learned >= 600)  { level = 3; grade = '小学一二年级'; color = '#22c55e'; }
  else if (learned >= 200)  { level = 2; grade = '幼小衔接（学前班）'; color = '#f59e0b'; }
  else if (learned >= 50)   { level = 1; grade = '学前启蒙'; color = '#f97316'; }
  else { level = 0; grade = '识字萌芽期'; color = '#ec4899'; }

  const tips = [];
  if (acc < 70 && reviews >= 20) tips.push(`正确率偏低（${acc}%），慢一点，多复习巩固`);
  if (learned < 50) {
    tips.push('每天学 3-5 个新字，养成每天打卡的好习惯');
    tips.push('多看图、多讲故事，把汉字和画面联系起来');
  } else if (learned < 200) {
    tips.push('保持每天的学习节奏，累积突破 300 字');
    tips.push('开始尝试用学过的字组词');
  } else if (learned < 600) {
    tips.push('可以读简单绘本（带拼音），把字用起来');
    tips.push('注意常见偏旁部首，归类记忆');
  } else if (learned < 1600) {
    tips.push('选分级阅读读物，提升阅读量');
    tips.push('练习写日记或小短文');
  } else if (learned < 2500) {
    tips.push('阅读经典童话与科普读物，积累词汇');
    tips.push('练习写作，让汉字"活"起来');
  } else {
    tips.push('开始阅读完整章节书与诗词');
    tips.push('巩固难字易错字，挑战写作表达');
  }
  return { level, grade, color, learned, acc, tips, statsLine: `已学会 ${learned} 字 · 正确率 ${acc}%` };
}

// 算数：按难度分别评估
function evalMath(stats) {
  const n = stats.numbers || {total:0,correct:0};
  const e = stats.easy || {total:0,correct:0};
  const m = stats.medium || {total:0,correct:0};
  const h = stats.hard || {total:0,correct:0};
  const accOf = (s) => s.total > 0 ? Math.round(s.correct/s.total*100) : 0;
  const an = accOf(n), ae = accOf(e), am = accOf(m), ah = accOf(h);

  let level, grade, color;
  if (h.total >= 30 && ah >= 80) { level = 4; grade = '小学二年级（100以内加减）'; color = '#3b82f6'; }
  else if (m.total >= 30 && am >= 80) { level = 3; grade = '小学一年级（20以内加减）'; color = '#22c55e'; }
  else if (e.total >= 20 && ae >= 80) { level = 2; grade = '学前/幼儿园（10以内加减）'; color = '#f59e0b'; }
  else if (n.total >= 10)             { level = 1; grade = '启蒙阶段（认识数字）'; color = '#f97316'; }
  else                                { level = 0; grade = '准备阶段'; color = '#ec4899'; }

  const tips = [];
  if (n.total < 20) tips.push('先认识 0-9 数字，打好基础');
  else if (an < 80) tips.push(`数字认识正确率 ${an}%，再练习几遍加深印象`);
  else if (e.total < 20) tips.push('从"简单"难度开始，先把 10 以内加减练熟');
  else if (ae < 80) tips.push(`简单题正确率 ${ae}%，再练几轮巩固熟练度`);
  else if (m.total < 20) tips.push('挑战"中等"难度，进入 20 以内加减带进退位');
  else if (am < 80) tips.push(`中等题正确率 ${am}%，重点练进位/退位`);
  else if (h.total < 20) tips.push('开始"挑战"难度，攻克 100 以内加减');
  else if (ah < 80) tips.push(`挑战题正确率 ${ah}%，借助数线/凑十法解题`);
  else {
    tips.push('准备进入乘法表和简单除法');
    tips.push('多用生活中的数字（购物、时间）解决问题');
  }
  const statsLine = `数字 ${n.correct}/${n.total} · 简单 ${e.correct}/${e.total} · 中等 ${m.correct}/${m.total} · 挑战 ${h.correct}/${h.total}`;
  return { level, grade, color, tips, statsLine };
}

// 英语：按学习内容（字母/单词/颜色）分别评估
function evalEnglish(stats) {
  const a = stats.alphabet || {total:0,correct:0};
  const w = stats.words || {total:0,correct:0};
  const c = stats.colors || {total:0,correct:0};
  const accOf = (s) => s.total > 0 ? Math.round(s.correct/s.total*100) : 0;
  const aa = accOf(a), aw = accOf(w), ac = accOf(c);

  let level, grade, color;
  if (w.total >= 30 && aw >= 80 && c.total >= 20 && ac >= 80) { level = 3; grade = '小学三年级英语水平'; color = '#3b82f6'; }
  else if (a.total >= 26 && aa >= 80 && (w.total >= 10 || c.total >= 10)) { level = 2; grade = '幼小衔接英语'; color = '#22c55e'; }
  else if (a.total >= 10) { level = 1; grade = '字母启蒙阶段'; color = '#f59e0b'; }
  else { level = 0; grade = '英语萌芽期'; color = '#ec4899'; }

  const tips = [];
  if (a.total < 26) tips.push('先从字母开始，认识 26 个英文字母');
  else if (aa < 80) tips.push(`字母正确率 ${aa}%，复习字母名与发音`);
  else if (w.total < 20) tips.push('学习日常单词（动物、食物、物品）');
  else if (aw < 80) tips.push(`单词正确率 ${aw}%，看图记忆更牢固`);
  else if (c.total < 10) tips.push('练习颜色单词');
  else {
    tips.push('开始学简单短句和英文儿歌');
    tips.push('每天听 5 分钟英文儿歌，培养语感');
  }
  const statsLine = `字母 ${a.correct}/${a.total} · 单词 ${w.correct}/${w.total} · 颜色 ${c.correct}/${c.total}`;
  return { level, grade, color, tips, statsLine };
}

function starsForLevel(level) {
  const filled = Math.max(0, Math.min(5, level));
  return '⭐'.repeat(filled) + '☆'.repeat(5 - filled);
}

function renderAssessment(elId, evalResult) {
  const el = document.getElementById(elId);
  if (!el || !evalResult) return;
  const { level, grade, color, statsLine, tips } = evalResult;
  el.innerHTML = `
    <div class="kids-assessment-header" style="background:linear-gradient(135deg, ${color}, ${color}cc)">
      <div class="kids-assessment-label">📈 当前水平</div>
      <div class="kids-assessment-grade">${grade}</div>
      <div class="kids-assessment-stars">${starsForLevel(level)}</div>
      <div class="kids-assessment-stats">${statsLine}</div>
    </div>
    <div class="kids-assessment-tips">
      <div class="kids-assessment-tips-title">💡 学习建议</div>
      <ul class="kids-assessment-tips-list">
        ${tips.map(t => `<li>${t}</li>`).join('')}
      </ul>
    </div>
  `;
}

// ===== 阶段化（识字 / 算数 / 英语共用 UI 渲染） =====

function renderLiteracyStages(data) {
  const el = document.getElementById('literacyStageCard');
  if (!el || !data || !data.stages) return;
  const stages = data.stages;
  const cur = data.currentStage;
  const total = stages.length;
  const passedCount = stages.filter(s => s.passed).length;
  const allPassed = passedCount === total;

  const items = stages.map(s => {
    const isCurrent = s.stage === cur && !allPassed;
    const cls = s.passed ? 'passed' : (isCurrent ? 'current' : 'locked');
    const icon = s.passed ? '✅' : (isCurrent ? '📘' : '🔒');
    const learnPct = s.total > 0 ? Math.round(s.learned / s.total * 100) : 0;
    const subline = s.passed
      ? `已通关 · ${s.learned}/${s.total} 字 · 正确率 ${s.accuracy}%`
      : isCurrent
        ? `进行中 · ${s.learned}/${s.total} 字（${s.learnRatio}%） · 正确率 ${s.accuracy}%`
        : `🔒 待解锁 · 共 ${s.total} 字`;
    return `
      <div class="kids-stage-item ${cls}">
        <div class="kids-stage-icon">${icon}</div>
        <div class="kids-stage-body">
          <div class="kids-stage-title">第 ${s.stage} 阶段</div>
          <div class="kids-stage-sub">${subline}</div>
          <div class="kids-stage-bar"><div class="kids-stage-bar-fill" style="width:${learnPct}%"></div></div>
        </div>
      </div>`;
  }).join('');

  const headline = allPassed
    ? '🏆 全部阶段通关！太厉害啦！'
    : `📘 当前在 第 ${cur} 阶段（共 ${total} 阶段）`;
  const tip = allPassed
    ? '继续巩固已学的字吧！'
    : `通关条件：该阶段已学会 ≥ ${stages[0].learnThreshold}% 且 正确率 ≥ ${stages[0].accThreshold}%`;

  el.innerHTML = `
    <div class="kids-stage-head">
      <div class="kids-stage-headline">${headline}</div>
      <div class="kids-stage-tip">${tip}</div>
    </div>
    <div class="kids-stage-list">${items}</div>
  `;
}

// 通用阶段渲染（算数 / 英语）
// stages: [{ key, label, emoji, desc, total, correct, threshold }]
function renderLinearStages(cardId, gridId, stages, onClick) {
  // 计算解锁状态：第 0 个永远解锁；第 N 个需要前序全部通关
  const enriched = stages.map(s => {
    const acc = s.total > 0 ? Math.round(s.correct / s.total * 100) : 0;
    const passed = s.total >= s.threshold && acc >= 80;
    return { ...s, accuracy: acc, passed };
  });
  let unlockedUntil = 0;
  for (let i = 0; i < enriched.length; i++) {
    enriched[i].unlocked = i <= unlockedUntil;
    if (enriched[i].passed && i === unlockedUntil) unlockedUntil = i + 1;
  }
  const currentIdx = enriched.findIndex(s => !s.passed);
  const allPassed = currentIdx === -1;

  // 阶段进度卡
  const card = document.getElementById(cardId);
  if (card) {
    const headline = allPassed
      ? '🏆 全部阶段通关！'
      : `📘 当前在「${enriched[currentIdx].label}」（${currentIdx + 1}/${enriched.length}）`;
    const items = enriched.map((s, i) => {
      const cls = s.passed ? 'passed' : (i === currentIdx ? 'current' : 'locked');
      const icon = s.passed ? '✅' : (i === currentIdx ? '📘' : '🔒');
      const pct = s.total >= s.threshold ? 100 : Math.min(100, Math.round(s.total / s.threshold * 100));
      const subline = s.passed
        ? `已通关 · ${s.correct}/${s.total} 题 · 正确率 ${s.accuracy}%`
        : i === currentIdx
          ? `进行中 · ${s.correct}/${s.total} 题（需 ${s.threshold} 题以上） · 正确率 ${s.accuracy}%`
          : `🔒 待解锁 · 完成上一阶段后开启`;
      return `
        <div class="kids-stage-item ${cls}">
          <div class="kids-stage-icon">${icon}</div>
          <div class="kids-stage-body">
            <div class="kids-stage-title">${s.emoji} ${s.label}</div>
            <div class="kids-stage-sub">${subline}</div>
            <div class="kids-stage-bar"><div class="kids-stage-bar-fill" style="width:${pct}%"></div></div>
          </div>
        </div>`;
    }).join('');
    card.innerHTML = `
      <div class="kids-stage-head">
        <div class="kids-stage-headline">${headline}</div>
        <div class="kids-stage-tip">通关条件：题数 ≥ 阶段阈值 且 正确率 ≥ 80%</div>
      </div>
      <div class="kids-stage-list">${items}</div>
    `;
  }

  // 难度按钮
  const grid = document.getElementById(gridId);
  if (grid) {
    grid.innerHTML = enriched.map((s, i) => {
      const cls = s.unlocked ? '' : ' locked';
      const lockBadge = s.unlocked ? '' : '<span class="kids-difficulty-lock">🔒</span>';
      const subDesc = s.unlocked
        ? s.desc
        : `🔒 通关上一关解锁`;
      return `
        <button class="kids-difficulty-btn${cls}" data-key="${s.key}" data-unlocked="${s.unlocked ? '1' : '0'}" ${s.unlocked ? '' : 'disabled'}>
          ${lockBadge}
          <span class="kids-difficulty-emoji">${s.emoji}</span>
          <span class="kids-difficulty-name">${s.label}</span>
          <span class="kids-difficulty-desc">${subDesc}</span>
        </button>`;
    }).join('');
    grid.querySelectorAll('.kids-difficulty-btn').forEach(btn => {
      const unlocked = btn.getAttribute('data-unlocked') === '1';
      const key = btn.getAttribute('data-key');
      btn.onclick = unlocked ? () => onClick(key) : () => showToast('🔒 先通关上一阶段再来挑战！');
    });
  }
}

// ===== 视图切换 =====
function switchView(view) {
  currentView = view;
  document.querySelectorAll('.kids-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.kids-tab').forEach(t => t.classList.remove('active'));

  const viewEl = document.getElementById(`view-${view}`);
  const tabEl = document.querySelector(`.kids-tab[data-view="${view}"]`);
  if (viewEl) viewEl.classList.add('active');
  if (tabEl) tabEl.classList.add('active');

  if (view === 'hub') loadHub();
  else if (view === 'home') loadHome();
  else if (view === 'library') loadLibrary();
  else if (view === 'stats') loadStats();
  else if (view === 'math-home') loadMathHome();
  else if (view === 'english-home') loadEnglishHome();
  else if (view === 'story-home') loadStoryHome();
  else if (view === 'story-summary') loadStorySummaries('global');
  else if (view === 'stats-overview') loadStatsOverview();
}

function enterModule(mod) {
  currentModule = mod;
  updateTabs(mod);
  if (mod === 'literacy') switchView('home');
  else if (mod === 'math') switchView('math-home');
  else if (mod === 'english') switchView('english-home');
  else if (mod === 'story') { switchView('story-home'); startStoryModuleTimer(); }
  else if (mod === 'stats-overview') switchView('stats-overview');
}

function goHub() {
  // 离开故事模块时停止计时器
  if (currentModule === 'story') {
    clearStoryLimitTimer();
    clearInterval(_storyLockTimer);
    const overlay = document.getElementById('storyLockOverlay');
    if (overlay) overlay.classList.remove('active');
  }
  currentModule = null;
  updateTabs(null);
  switchView('hub');
}

function updateTabs(mod) {
  const nav = document.getElementById('kidsTabs');
  if (!nav) return;
  if (!mod) {
    nav.innerHTML = `<button class="kids-tab active" data-view="hub" onclick="switchView('hub')"><span class="kids-tab-icon">🏠</span><span class="kids-tab-label">首页</span></button>`;
    return;
  }
  const configs = {
    literacy: [
      { view:'home', icon:'🏠', label:'学习' },
      { view:'library', icon:'📚', label:'字库' },
      { view:'stats', icon:'📊', label:'统计' }
    ],
    math: [
      { view:'math-home', icon:'🏠', label:'算数' }
    ],
    english: [
      { view:'english-home', icon:'🏠', label:'英语' }
    ],
    story: [
      { view:'story-home', icon:'📖', label:'故事' },
      { view:'story-summary', icon:'🎤', label:'总结' }
    ],
    'stats-overview': [
      { view:'stats-overview', icon:'📊', label:'学习统计' }
    ]
  };
  const tabs = configs[mod] || [];
  nav.innerHTML = tabs.map((t,i) => `<button class="kids-tab${i===0?' active':''}" data-view="${t.view}" onclick="switchView('${t.view}')"><span class="kids-tab-icon">${t.icon}</span><span class="kids-tab-label">${t.label}</span></button>`).join('');
}

async function loadHub() {
  try {
    const res = await fetch('/api/kids/stats').then(r => r.json());
    const el = document.getElementById('hubStreak');
    if (el) el.textContent = res.streakDays || 0;
  } catch(e) { console.error('loadHub:', e); }
}

// ===== 首页 =====
async function loadHome() {
  try {
    const [statsRes, sessionsRes, stagesRes] = await Promise.all([
      fetch('/api/kids/stats').then(r => r.json()),
      fetch('/api/kids/sessions/today').then(r => r.json()),
      fetch('/api/kids/stages').then(r => r.json())
    ]);

    const stats = statsRes;
    const sessions = sessionsRes.sessions || [];

    // 连续打卡
    const streakEl = document.getElementById('homeStreak');
    if (streakEl) streakEl.textContent = stats.streakDays || 0;

    // 进度数据
    const setNum = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };
    setNum('homeLearned', stats.learned || 0);
    setNum('homeTotal', stats.total || 0);
    setNum('homeAccuracy', stats.accuracy ? stats.accuracy + '%' : '0%');
    setNum('homeTodayReviews', stats.todayReviews || 0);

    renderLiteracyStages(stagesRes);
    renderAssessment('literacyAssessment', evalLiteracy(stats));

    // 开始学习按钮状态
    const btn = document.getElementById('startStudyBtn');
    const manualBtn = document.getElementById('manualStudyBtn');
    const msgEl = document.getElementById('homeMessage');
    if (btn && msgEl) {
      let limitReached = false;
      if (sessions.length >= 2) {
        btn.disabled = true;
        btn.textContent = '今天学习完成啦！🌟';
        msgEl.textContent = '你真棒！明天再来吧！';
        msgEl.style.display = 'block';
        limitReached = true;
      } else if (sessions.length === 1) {
        // 检查间隔
        const last = sessions[0];
        const lastTime = new Date(last.created_at.replace(' ', 'T'));
        const hoursDiff = (Date.now() - lastTime.getTime()) / (1000 * 3600);
        if (hoursDiff < 4) {
          const wait = Math.ceil(4 - hoursDiff);
          btn.disabled = true;
          btn.textContent = `休息一下吧 🎈`;
          msgEl.textContent = `${wait}小时后再来学习！`;
          msgEl.style.display = 'block';
          limitReached = true;
        } else {
          btn.disabled = false;
          btn.textContent = '开始学习 🚀';
          msgEl.textContent = '今天还可以学习1次哦！';
          msgEl.style.display = 'block';
        }
      } else {
        btn.disabled = false;
        btn.textContent = '开始学习 🚀';
        msgEl.style.display = 'none';
      }
      // 达到限制时显示手动按钮
      if (manualBtn) manualBtn.style.display = limitReached ? 'block' : 'none';
    }
  } catch (e) {
    console.error('加载首页失败:', e);
  }
}

// ===== 开始学习 =====
async function startStudy(force = false) {
  try {
    const res = await fetch('/api/kids/sessions/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force })
    });
    const data = await res.json();

    if (!data.canStudy || !data.session) {
      showToast(data.message || '暂时不能学习');
      loadHome();
      return;
    }

    studySession = data.session;
    studyIndex = 0;
    studyReviewed = {};
    showStudyOverlay();
    renderStudyCard();
  } catch (e) {
    console.error('开始学习失败:', e);
    showToast('网络错误，请重试');
  }
}

// ===== 汉字书写动画 =====
let _hanziWriter = null;

function initHanziWriter(char) {
  const target = document.getElementById('hanziWriterTarget');
  if (!target || typeof HanziWriter === 'undefined') return;

  _hanziWriter = HanziWriter.create(target, char, {
    width: 200,
    height: 200,
    padding: 10,
    strokeColor: '#8b5cf6',
    radicalColor: '#ec4899',
    outlineColor: '#e2e8f0',
    drawingColor: '#f97316',
    strokeAnimationSpeed: 0.5,   // 较慢速度
    delayBetweenStrokes: 400,
    showCharacter: false,
    showOutline: true,
    onLoadCharDataSuccess: () => {
      _hanziWriter.animateCharacter();
    },
    onLoadCharDataError: () => {
      if (target) target.style.display = 'none';
      const hint = target?.nextElementSibling;
      if (hint) hint.style.display = 'none';
    }
  });

  target.onclick = () => {
    if (_hanziWriter) _hanziWriter.animateCharacter();
  };
}

// ===== 学习界面 =====
function showStudyOverlay() {
  const overlay = document.getElementById('studyOverlay');
  if (overlay) overlay.classList.add('active');
}

function closeStudyOverlay() {
  const overlay = document.getElementById('studyOverlay');
  if (overlay) overlay.classList.remove('active');
  if (_speakAudio) { _speakAudio.pause(); _speakAudio = null; }
  window.speechSynthesis && window.speechSynthesis.cancel();
  loadHome();
}

function renderStudyCard(opts) {
  if (!studySession) return;
  const chars = studySession.chars;

  // 如果已经全部完成
  if (studyIndex >= chars.length) {
    showCompleteScreen();
    return;
  }

  const char = chars[studyIndex];
  const total = chars.length;
  const skipAutoSpeak = opts && opts.skipAutoSpeak;

  // 更新进度
  const progText = document.getElementById('studyProgressText');
  const progFill = document.getElementById('studyProgressFill');
  if (progText) progText.textContent = `${studyIndex + 1} / ${total}`;
  if (progFill) progFill.style.width = `${((studyIndex + 1) / total) * 100}%`;

  // 渲染卡片内容
  const content = document.getElementById('studyContent');
  if (!content) return;

  const images = char.images || [];
  const components = char.components || [];
  const reviewed = studyReviewed[studyIndex];
  const isFirst = studyIndex === 0;
  const isLast = studyIndex === total - 1;
  const reviewLocked = reviewed !== undefined ? 'disabled' : '';
  const knownSelected = reviewed === true ? ' selected' : '';
  const unknownSelected = reviewed === false ? ' selected' : '';

  content.innerHTML = `
    <div class="kids-study-hint">${getRandomHint()}</div>
    <div class="kids-char-card">
      <div class="kids-char-main" onclick="speak('${char.char}')" title="点击听读音">${char.char}</div>
      <div class="kids-char-pinyin">${char.pinyin}</div>
      ${char.isNew ? '<span class="kids-char-new-badge">✨ 新字</span>' : ''}
      <div class="kids-stroke-wrap">
        <div id="hanziWriterTarget" class="kids-stroke-canvas"></div>
        <div class="kids-stroke-hint">点击重新书写 ✏️</div>
      </div>
    </div>
    <div class="kids-images">
      ${images.map(img => `
        <div class="kids-image-card" onclick="speak('${img.desc}')">
          <div class="kids-image-emoji">${img.emoji}</div>
          <div class="kids-image-desc">${img.desc}</div>
        </div>
      `).join('')}
    </div>
    <div class="kids-words">
      ${components.map(w => `
        <div class="kids-word-chip" onclick="speak('${w.word}，${w.desc}')">
          <div class="kids-word-text">${w.word}</div>
          <div class="kids-word-pinyin">${w.pinyin}</div>
          <div class="kids-word-desc">${w.desc}</div>
        </div>
      `).join('')}
    </div>
    <div class="kids-review-btns">
      <button class="kids-review-btn unknown${unknownSelected}" ${reviewLocked} onclick="reviewChar(false)">
        不认识 ✗
      </button>
      <button class="kids-review-btn known${knownSelected}" ${reviewLocked} onclick="reviewChar(true)">
        认识 ✓
      </button>
    </div>
    <div class="kids-nav-btns">
      <button class="kids-nav-btn" ${isFirst ? 'disabled' : ''} onclick="prevChar()">⬅ 上一个</button>
      <button class="kids-nav-btn next" onclick="nextChar()">${isLast ? '完成 🎉' : '下一个 ➡'}</button>
    </div>
  `;

  // 自动读字（延迟0.5秒）— 复习反馈时跳过，避免打断"太棒了"语音
  if (!skipAutoSpeak) {
    setTimeout(() => speak(char.char), 500);
  }

  // 书写动画
  initHanziWriter(char.char);
}

// ===== 复习操作 =====
async function reviewChar(known) {
  if (!studySession) return;
  if (studyReviewed[studyIndex] !== undefined) return; // 已选择过

  studyReviewed[studyIndex] = known;
  const char = studySession.chars[studyIndex];

  try {
    await fetch(`/api/kids/chars/${char.id}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ known })
    });
  } catch (e) {
    console.error('复习失败:', e);
  }

  if (known) {
    speak('太棒了！', 1.0);
    createStarBurst();
  } else {
    speak('没关系，我们再学一遍！', 0.9);
  }

  // 停在当前卡片，仅刷新按钮选中态；不自动朗读字以免打断反馈语音
  renderStudyCard({ skipAutoSpeak: true });
}

function prevChar() {
  if (studyIndex > 0) {
    studyIndex--;
    renderStudyCard();
  }
}

function nextChar() {
  studyIndex++;
  renderStudyCard();
}

// ===== 完成页面 =====
async function showCompleteScreen() {
  if (!studySession) return;

  // 标记会话完成
  try {
    await fetch(`/api/kids/sessions/${studySession.id}/complete`, { method: 'POST' });
  } catch (e) {
    console.error('完成会话失败:', e);
  }

  const total = studySession.chars.length;
  const content = document.getElementById('studyContent');
  if (!content) return;

  content.innerHTML = `
    <div class="kids-complete">
      <div class="kids-complete-emoji">🎉</div>
      <div class="kids-complete-title">你真棒！</div>
      <div class="kids-complete-stats">今天学了 ${total} 个字！</div>
      <button class="kids-complete-btn" onclick="closeStudyOverlay()">回到首页 🏠</button>
    </div>
  `;

  // 庆祝
  speak(`你真棒！今天学了${total}个字！`, 0.9);
  createStarBurst();
  setTimeout(createStarBurst, 500);
  setTimeout(createStarBurst, 1000);
}

// ===== 星星动画 =====
function createStarBurst() {
  const emojis = ['⭐', '🌟', '✨', '💫', '🎉', '🎊'];
  for (let i = 0; i < 8; i++) {
    const star = document.createElement('div');
    star.className = 'star-particle';
    star.textContent = emojis[Math.floor(Math.random() * emojis.length)];
    star.style.left = `${20 + Math.random() * 60}%`;
    star.style.top = `${30 + Math.random() * 40}%`;
    star.style.fontSize = `${20 + Math.random() * 20}px`;
    document.body.appendChild(star);
    setTimeout(() => star.remove(), 1500);
  }
}

// ===== 字库页 =====
async function loadLibrary() {
  try {
    const categoryFilter = document.getElementById('libCategoryFilter');
    const learnedFilter = document.getElementById('libLearnedFilter');
    const sortFilter = document.getElementById('libSortFilter');

    // 加载分类
    if (categoryFilter && categoryFilter.options.length <= 1) {
      const catRes = await fetch('/api/kids/categories').then(r => r.json());
      (catRes.categories || []).forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat;
        categoryFilter.appendChild(opt);
      });
    }

    const params = new URLSearchParams();
    if (categoryFilter && categoryFilter.value) params.set('category', categoryFilter.value);
    if (learnedFilter && learnedFilter.value) params.set('is_learned', learnedFilter.value);
    if (sortFilter && sortFilter.value) params.set('sort_by', sortFilter.value);

    const res = await fetch(`/api/kids/chars?${params}`).then(r => r.json());
    const chars = res.chars || [];

    const grid = document.getElementById('charGrid');
    if (!grid) return;

    if (chars.length === 0) {
      grid.innerHTML = '<div class="kids-message">暂无数据</div>';
      return;
    }

    grid.innerHTML = chars.map(c => {
      const stars = getStarRating(c.mastery_level);
      const learnedClass = c.is_learned ? ' learned' : '';
      const badge = c.is_learned ? '<span class="kids-tile-badge">✅</span>' : '';
      return `
        <div class="kids-char-tile${learnedClass}" onclick="speak('${c.char}')">
          ${badge}
          <div class="kids-tile-char">${c.char}</div>
          <div class="kids-tile-pinyin">${c.pinyin}</div>
          <div class="kids-tile-stars">${stars}</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.error('加载字库失败:', e);
  }
}

function getStarRating(level) {
  const filled = Math.min(level, 5);
  const empty = 5 - filled;
  return '⭐'.repeat(filled) + '☆'.repeat(empty);
}

// ===== 统计页 =====
async function loadStats() {
  try {
    const res = await fetch('/api/kids/stats').then(r => r.json());
    statsData = res;
    renderStats();
  } catch (e) {
    console.error('加载统计失败:', e);
  }
}

function renderStats() {
  if (!statsData) return;
  const s = statsData;

  // 总览数据
  const setNum = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };

  setNum('statsLearned', s.learned || 0);
  setNum('statsStreak', s.streakDays || 0);
  setNum('statsAccuracy', s.accuracy ? s.accuracy + '%' : '0%');
  setNum('statsTotalReviews', s.totalReviews || 0);

  // 渲染图表
  renderChart();

  // 渲染分类统计
  renderCategoryStats();
}

function switchChartMode(mode) {
  chartMode = mode;
  document.querySelectorAll('.kids-chart-tab').forEach(t => t.classList.remove('active'));
  const activeTab = document.querySelector(`.kids-chart-tab[data-mode="${mode}"]`);
  if (activeTab) activeTab.classList.add('active');
  renderChart();
}

function renderChart() {
  const container = document.getElementById('chartContainer');
  if (!container || !statsData) return;

  let data = [];
  if (chartMode === 'daily') {
    data = statsData.dailyStats || [];
    // 补全最近7天
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const pad = n => String(n).padStart(2, '0');
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
      const found = data.find(x => x.date === dateStr);
      days.push({
        label: `${d.getMonth()+1}/${d.getDate()}`,
        total: found ? found.total : 0,
        correct: found ? found.correct : 0
      });
    }
    data = days;
  } else if (chartMode === 'weekly') {
    data = (statsData.weeklyStats || []).map(w => ({
      label: w.week.split('-W')[1] ? `第${w.week.split('-W')[1]}周` : w.week,
      total: w.total,
      correct: w.correct
    }));
  } else {
    data = (statsData.monthlyStats || []).map(m => ({
      label: m.month.substring(5) + '月',
      total: m.total,
      correct: m.correct
    }));
  }

  if (data.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:20px;">暂无数据</div>';
    return;
  }

  const maxVal = Math.max(...data.map(d => d.total), 1);
  container.innerHTML = `
    <div class="kids-bar-chart">
      ${data.map(d => `
        <div class="kids-bar-item">
          <span class="kids-bar-value">${d.total || ''}</span>
          <div class="kids-bar" style="height: ${Math.max(4, (d.total / maxVal) * 100)}px"></div>
          <span class="kids-bar-label">${d.label}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderCategoryStats() {
  const container = document.getElementById('categoryStatsContainer');
  if (!container || !statsData) return;

  const cats = statsData.categoryStats || [];
  if (cats.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:#94a3b8;">暂无数据</div>';
    return;
  }

  container.innerHTML = `
    <div class="kids-category-list">
      ${cats.map(c => {
        const pct = c.total > 0 ? Math.round(c.learned / c.total * 100) : 0;
        return `
          <div class="kids-category-item">
            <span class="kids-category-name">${c.category}</span>
            <div class="kids-category-bar-wrap">
              <div class="kids-category-bar-fill" style="width: ${pct}%"></div>
            </div>
            <span class="kids-category-text">${c.learned}/${c.total}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ===== Toast =====
function showToast(msg) {
  const container = document.getElementById('kidsToastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'kids-toast';
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// ===== 初始化 =====
document.addEventListener('DOMContentLoaded', () => {
  switchView('hub');
  startKidsStudyTimer();
});

// ============ 学习时长追踪（按子模块） ============
// 仅在「子模块学习中」（识字/算数/英语 overlay 打开 或 故事阅读视图）且页面可见、
// 最近 60s 有用户操作时计时。每 30s 把累计秒数提交一次；隐藏/卸载用 sendBeacon 兜底。
// 故事时长由 reportStoryPlay 写入 kids_story_plays，所以这里跳过 story，避免重复计数。
let kidsActiveTrackers = { literacy: 0, math: 0, english: 0 };
let kidsLastActivityAt = Date.now();
const KIDS_IDLE_MS = 60_000;
const KIDS_FLUSH_INTERVAL_S = 30;

function getCurrentLearningModule() {
  if (document.visibilityState !== 'visible') return null;
  if (Date.now() - kidsLastActivityAt > KIDS_IDLE_MS) return null;
  const literacyOpen = document.getElementById('studyOverlay')?.classList.contains('active');
  const mathOpen = document.getElementById('mathOverlay')?.classList.contains('active');
  const engOpen = document.getElementById('englishOverlay')?.classList.contains('active');
  if (literacyOpen) return 'literacy';
  if (mathOpen) return 'math';
  if (engOpen) return 'english';
  return null;
}

function flushKidsStudyTime({ beacon = false } = {}) {
  for (const mod of Object.keys(kidsActiveTrackers)) {
    const seconds = kidsActiveTrackers[mod];
    if (seconds <= 0) continue;
    kidsActiveTrackers[mod] = 0;
    const payload = JSON.stringify({ module: mod, seconds });
    if (beacon && navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/kids/study-time', blob);
    } else {
      fetch('/api/kids/study-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true
      }).catch(() => {});
    }
  }
}

function startKidsStudyTimer() {
  const bump = () => { kidsLastActivityAt = Date.now(); };
  ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(ev => {
    window.addEventListener(ev, bump, { passive: true });
  });

  setInterval(() => {
    const mod = getCurrentLearningModule();
    if (mod) {
      kidsActiveTrackers[mod] += 1;
      const total = kidsActiveTrackers.literacy + kidsActiveTrackers.math + kidsActiveTrackers.english;
      if (total >= KIDS_FLUSH_INTERVAL_S) flushKidsStudyTime();
    }
  }, 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushKidsStudyTime({ beacon: true });
  });
  window.addEventListener('pagehide', () => flushKidsStudyTime({ beacon: true }));
}

// ============ 学习统计总览 ============
let overviewData = null;
let overviewRange = '7d';

const OVERVIEW_MODULES = [
  { key: 'literacy', name: '识字', emoji: '📖', color: '#8b5cf6' },
  { key: 'math',     name: '算数', emoji: '🔢', color: '#3b82f6' },
  { key: 'english',  name: '英语', emoji: '🔤', color: '#f97316' },
  { key: 'story',    name: '故事', emoji: '📚', color: '#ec4899' }
];

function fmtMin(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  return `${m} 分`;
}

async function loadStatsOverview() {
  try {
    // 并发拉取：时长总览 + 识字 stats（用于水平评估）
    const [overviewRes, literacyStats] = await Promise.all([
      fetch('/api/kids/study-time/overview').then(r => r.json()),
      fetch('/api/kids/stats').then(r => r.json())
    ]);
    overviewData = overviewRes;

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set('overview7dTotal', fmtMin(overviewData.sevenTotal));
    set('overviewAllTotal', fmtMin(overviewData.allTotal));

    renderOverviewDailyChart();
    renderOverviewLegend();
    renderOverviewModuleList();
    renderOverviewAssessments(literacyStats);
  } catch (e) {
    console.error('加载学习统计失败:', e);
  }
}

function renderOverviewDailyChart() {
  const el = document.getElementById('overviewDailyChart');
  if (!el || !overviewData) return;
  const days = overviewData.days || [];
  const maxSec = Math.max(1, ...days.map(d => d.total));

  el.innerHTML = days.map(d => {
    const heightPct = (d.total / maxSec) * 100;
    const segs = OVERVIEW_MODULES.map(m => {
      const sec = d.perModule[m.key] || 0;
      if (sec === 0) return '';
      const ratio = sec / d.total;
      return `<div class="kids-stacked-seg" style="height:${ratio * 100}%; background:${m.color}" title="${m.name}: ${fmtMin(sec)}"></div>`;
    }).join('');
    const dateLabel = d.date.slice(5).replace('-', '/');
    const totalLabel = d.total > 0 ? fmtMin(d.total) : '';
    return `
      <div class="kids-stacked-item">
        <div class="kids-stacked-value">${totalLabel}</div>
        <div class="kids-stacked-bar-wrap">
          <div class="kids-stacked-bar" style="height:${Math.max(heightPct, d.total > 0 ? 4 : 0)}%">${segs}</div>
        </div>
        <div class="kids-stacked-label">${dateLabel}</div>
      </div>`;
  }).join('');
}

function renderOverviewLegend() {
  const el = document.getElementById('overviewLegend');
  if (!el) return;
  el.innerHTML = OVERVIEW_MODULES.map(m =>
    `<span class="kids-overview-legend-item"><span class="kids-overview-legend-dot" style="background:${m.color}"></span>${m.emoji} ${m.name}</span>`
  ).join('');
}

function switchOverviewRange(range) {
  overviewRange = range;
  document.querySelectorAll('.kids-overview-tab').forEach(t => t.classList.remove('active'));
  const active = document.querySelector(`.kids-overview-tab[data-range="${range}"]`);
  if (active) active.classList.add('active');
  renderOverviewModuleList();
}

function renderOverviewModuleList() {
  const el = document.getElementById('overviewModuleList');
  if (!el || !overviewData) return;
  const data = overviewRange === '7d' ? overviewData.sevenByModule : overviewData.allByModule;
  const max = Math.max(1, ...OVERVIEW_MODULES.map(m => data[m.key] || 0));
  const total = OVERVIEW_MODULES.reduce((sum, m) => sum + (data[m.key] || 0), 0);

  el.innerHTML = OVERVIEW_MODULES.map(m => {
    const sec = data[m.key] || 0;
    const pct = total > 0 ? Math.round(sec / total * 100) : 0;
    const widthPct = (sec / max) * 100;
    return `
      <div class="kids-overview-row">
        <div class="kids-overview-row-name">${m.emoji} ${m.name}</div>
        <div class="kids-overview-row-bar-wrap">
          <div class="kids-overview-row-bar" style="width:${widthPct}%; background:${m.color}"></div>
        </div>
        <div class="kids-overview-row-text">${fmtMin(sec)} <span class="kids-overview-row-pct">(${pct}%)</span></div>
      </div>`;
  }).join('');
}

function renderOverviewAssessments(literacyStats) {
  const el = document.getElementById('overviewAssessments');
  if (!el) return;
  const items = [
    { name: '📖 识字', evalResult: evalLiteracy(literacyStats || {}) },
    { name: '🔢 算数', evalResult: evalMath(getMathStats()) },
    { name: '🔤 英语', evalResult: evalEnglish(getEngStats()) }
  ];
  el.innerHTML = items.map(it => {
    const { level, grade, color, statsLine } = it.evalResult;
    return `
      <div class="kids-overview-eval-card" style="background:linear-gradient(135deg, ${color}, ${color}cc)">
        <div class="kids-overview-eval-name">${it.name}</div>
        <div class="kids-overview-eval-grade">${grade}</div>
        <div class="kids-overview-eval-stars">${starsForLevel(level)}</div>
        <div class="kids-overview-eval-stats">${statsLine}</div>
      </div>`;
  }).join('');
}

// ============ 算数模块 ============
let mathState = { questions:[], index:0, correct:0, difficulty:'easy' };

function getMathStats() {
  const raw = JSON.parse(localStorage.getItem('kids_math_stats') || '{}');
  // 兼容旧格式 {total, correct} -> 全部归入 easy
  if (raw.total !== undefined && raw.easy === undefined) {
    return { numbers:{total:0,correct:0}, easy: {total: raw.total||0, correct: raw.correct||0}, medium:{total:0,correct:0}, hard:{total:0,correct:0} };
  }
  return {
    numbers: raw.numbers || {total:0,correct:0},
    easy: raw.easy || {total:0,correct:0},
    medium: raw.medium || {total:0,correct:0},
    hard: raw.hard || {total:0,correct:0}
  };
}
function saveMathStats(diff, correct) {
  const s = getMathStats();
  if (!s[diff]) s[diff] = {total:0, correct:0};
  s[diff].total++;
  if (correct) s[diff].correct++;
  localStorage.setItem('kids_math_stats', JSON.stringify(s));
}
function getMathTotals() {
  const s = getMathStats();
  const total = s.numbers.total + s.easy.total + s.medium.total + s.hard.total;
  const correct = s.numbers.correct + s.easy.correct + s.medium.correct + s.hard.correct;
  return { total, correct };
}

// 算数阶段定义：阶段顺序 + 解锁阈值（题数）。正确率统一 80%。
const MATH_STAGES = [
  { key: 'numbers', label: '认识数字', emoji: '🔢', desc: '认识 0-9 数字', threshold: 20 },
  { key: 'easy',   label: '简单', emoji: '🌟', desc: '10以内加减',  threshold: 20 },
  { key: 'medium', label: '中等', emoji: '⭐', desc: '20以内加减',  threshold: 30 },
  { key: 'hard',   label: '挑战', emoji: '🌠', desc: '100以内加减', threshold: 30 }
];

function loadMathHome() {
  const t = getMathTotals();
  const set = (id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=v; };
  set('mathTotal', t.total);
  set('mathCorrect', t.correct);
  set('mathAccuracy', t.total>0 ? Math.round(t.correct/t.total*100)+'%' : '0%');

  const ms = getMathStats();
  const stages = MATH_STAGES.map(s => ({
    ...s,
    total: (ms[s.key] && ms[s.key].total) || 0,
    correct: (ms[s.key] && ms[s.key].correct) || 0
  }));
  renderLinearStages('mathStageCard', 'mathDifficultyGrid', stages, startMathGame);

  renderAssessment('mathAssessment', evalMath(ms));
}

function generateMathQ(diff) {
  let max = diff==='easy'?10 : diff==='medium'?20 : 100;
  let a = Math.floor(Math.random()*max)+1;
  let b = Math.floor(Math.random()*max)+1;
  let op = Math.random()>0.5 ? '+' : '-';
  if(op==='-' && a<b) [a,b]=[b,a];
  let answer = op==='+' ? a+b : a-b;
  return { text:`${a} ${op} ${b} = ?`, answer };
}

// ===== 认识数字子模块 =====
const NUMBER_DATA = [
  { digit: 0, zh: '零', emoji: '🌕', things: '什么都没有' },
  { digit: 1, zh: '一', emoji: '☝️', things: '一个手指' },
  { digit: 2, zh: '二', emoji: '✌️', things: '两只眼睛' },
  { digit: 3, zh: '三', emoji: '🌟', things: '三角形' },
  { digit: 4, zh: '四', emoji: '🍀', things: '四片叶子' },
  { digit: 5, zh: '五', emoji: '✋', things: '五个手指' },
  { digit: 6, zh: '六', emoji: '🎲', things: '六个面' },
  { digit: 7, zh: '七', emoji: '🌈', things: '七种颜色' },
  { digit: 8, zh: '八', emoji: '🐙', things: '八条腿' },
  { digit: 9, zh: '九', emoji: '🐱', things: '九条命' }
];

// 每个数字/字母可以有多笔，每个元素是一条 SVG path d 字符串，viewBox 0 0 100 100
// 笔画顺序和方向遵循标准书写教学规范
const DIGIT_STROKES = {
  // 0: 从顶部起笔，逆时针画椭圆（左侧向下→底部→右侧向上→回到顶部）
  0: ["M50 15 Q20 15 20 50 Q20 88 50 88 Q80 88 80 50 Q80 15 50 15"],
  // 1: 先写短斜起笔到顶部再竖直向下，再写底部横线
  1: ["M35 25 L50 15 L50 88", "M35 88 L65 88"],
  // 2: 从左上弧顶开始，顺时针画上半圆，斜向左下，最后横线
  2: ["M25 30 Q25 15 50 15 Q75 15 75 32 Q75 50 50 60 Q30 72 20 88 L80 88"],
  // 3: 上半弧（从左上到中间），下半弧（从中间到左下）
  3: ["M25 20 Q50 10 70 25 Q80 38 55 50", "M55 50 Q80 60 72 78 Q62 92 35 88"],
  // 4: 第一笔从上向左下斜再向右画横，第二笔竖直向下
  4: ["M65 15 L15 62 L82 62", "M65 15 L65 88"],
  // 5: 第一笔从横的左端向下画竖再接弧线，第二笔从左向右画横
  5: ["M28 15 L25 48 Q45 40 62 48 Q82 58 75 78 Q68 92 40 88", "M28 15 L72 15"],
  // 6: 从右上起笔，逆时针向左下弧到底部，再画底部小圆圈
  6: ["M65 18 Q50 10 35 25 Q18 45 18 60 Q18 88 50 88 Q80 88 80 65 Q80 45 50 45 Q25 45 20 60"],
  // 7: 从左到右画横，再斜向左下
  7: ["M20 15 L80 15 L45 88"],
  // 8: 一笔完成。从中间起笔，向右上方逆时针画上圈，回到中间后继续向右下方顺时针画下圈
  8: ["M50 50 Q70 38 70 25 Q70 10 50 12 Q30 10 30 25 Q30 38 50 50 Q70 62 70 78 Q70 92 50 90 Q30 92 30 78 Q30 62 50 50"],
  // 9: 第一笔从圆的右侧起笔逆时针画上部圆圈，第二笔从右侧向下写竖
  9: ["M80 38 Q80 15 50 15 Q20 15 20 38 Q20 58 50 58 Q80 58 80 38", "M80 50 L75 88"]
};

// 字母笔画：遵循英文书写教学标准笔顺（从上到下、从左到右）
const LETTER_STROKES = {
  A: ["M10 90 L50 10 L90 90", "M28 58 L72 58"],
  B: ["M20 10 L20 90", "M20 10 L55 10 Q78 10 78 30 Q78 50 55 50 L20 50", "M20 50 L58 50 Q82 50 82 70 Q82 90 58 90 L20 90"],
  C: ["M80 25 Q50 8 25 25 Q10 42 10 55 Q10 72 25 85 Q50 98 80 80"],
  D: ["M20 10 L20 90", "M20 10 L45 10 Q82 10 82 50 Q82 90 45 90 L20 90"],
  E: ["M75 10 L20 10", "M20 10 L20 90", "M20 50 L60 50", "M20 90 L75 90"],
  F: ["M75 10 L20 10", "M20 10 L20 90", "M20 50 L60 50"],
  G: ["M78 25 Q50 8 25 25 Q10 42 10 55 Q10 72 25 85 Q50 98 78 80", "M78 80 L78 55 L55 55"],
  H: ["M20 10 L20 90", "M80 10 L80 90", "M20 50 L80 50"],
  I: ["M30 10 L70 10", "M50 10 L50 90", "M30 90 L70 90"],
  J: ["M30 10 L75 10", "M60 10 L60 72 Q60 90 42 90 Q25 90 22 75"],
  K: ["M20 10 L20 90", "M75 10 L20 55", "M20 55 L75 90"],
  L: ["M20 10 L20 90", "M20 90 L78 90"],
  M: ["M10 90 L10 10", "M10 10 L50 55", "M50 55 L90 10", "M90 10 L90 90"],
  N: ["M20 90 L20 10", "M20 10 L80 90", "M80 90 L80 10"],
  O: ["M50 10 Q82 10 82 50 Q82 90 50 90 Q18 90 18 50 Q18 10 50 10"],
  P: ["M20 90 L20 10", "M20 10 L55 10 Q80 10 80 30 Q80 50 55 50 L20 50"],
  Q: ["M50 10 Q82 10 82 50 Q82 90 50 90 Q18 90 18 50 Q18 10 50 10", "M62 72 L88 95"],
  R: ["M20 90 L20 10", "M20 10 L55 10 Q80 10 80 30 Q80 50 55 50 L20 50", "M50 50 L82 90"],
  S: ["M72 22 Q55 8 38 15 Q18 22 18 38 Q18 50 50 55 Q82 60 82 75 Q82 92 55 92 Q38 92 22 80"],
  T: ["M10 10 L90 10", "M50 10 L50 90"],
  U: ["M20 10 L20 70 Q20 90 50 90 Q80 90 80 70 L80 10"],
  V: ["M10 10 L50 90", "M50 90 L90 10"],
  W: ["M5 10 L28 90", "M28 90 L50 35", "M50 35 L72 90", "M72 90 L95 10"],
  X: ["M15 10 L85 90", "M85 10 L15 90"],
  Y: ["M15 10 L50 50", "M85 10 L50 50", "M50 50 L50 90"],
  Z: ["M15 10 L85 10", "M85 10 L15 90", "M15 90 L85 90"]
};

// 兼容旧代码：DIGIT_PATHS 已废弃，统一使用 DIGIT_STROKES
const DIGIT_PATHS = Object.fromEntries(
  Object.entries(DIGIT_STROKES).map(([k, v]) => [k, v.join(' ')])
);

let _numAnimFrame = null;
let _numAnimStrokeIdx = 0;

// 通用多笔画动画：strokes 是路径字符串数组，svgEl 里每笔对应一个 .stroke-path-N
function animateStrokes(svgEl, strokes, color) {
  if (_numAnimFrame) { cancelAnimationFrame(_numAnimFrame); _numAnimFrame = null; }

  const paths = svgEl.querySelectorAll('.stroke-path');
  // 初始化：全部隐藏（dashoffset = totalLen）
  const lengths = Array.from(paths).map(p => {
    const len = p.getTotalLength();
    p.style.strokeDasharray = len;
    p.style.strokeDashoffset = len;
    return len;
  });

  const strokeDuration = 1800; // 每笔 1800ms（慢速）
  const strokeGap = 200;       // 笔与笔之间间隔
  let strokeIdx = 0;
  let strokeStart = null;

  function step(ts) {
    if (strokeIdx >= paths.length) return;
    if (!strokeStart) strokeStart = ts;
    const elapsed = ts - strokeStart;
    const progress = Math.min(elapsed / strokeDuration, 1);
    paths[strokeIdx].style.strokeDashoffset = lengths[strokeIdx] * (1 - progress);
    if (progress < 1) {
      _numAnimFrame = requestAnimationFrame(step);
    } else {
      strokeIdx++;
      if (strokeIdx < paths.length) {
        strokeStart = null;
        setTimeout(() => { _numAnimFrame = requestAnimationFrame(step); }, strokeGap);
      }
    }
  }
  _numAnimFrame = requestAnimationFrame(step);
}

// 构建数字 SVG（viewBox 0 0 100 100，支持多笔）
function buildDigitSVG(digit) {
  const strokes = DIGIT_STROKES[digit] || [DIGIT_PATHS[digit]];
  const pathEls = strokes.map(d =>
    `<path class="stroke-path" d="${d}" fill="none" stroke="#8b5cf6" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`
  ).join('');
  return `<svg class="digit-anim-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="96" height="96" rx="10" fill="#f8f7ff" stroke="#e2e8f0" stroke-width="2"/>
    ${pathEls}
  </svg>`;
}

// 构建字母 SVG（viewBox 0 0 100 100，支持多笔）
function buildLetterSVG(letter) {
  const strokes = LETTER_STROKES[letter.toUpperCase()] || [];
  const pathEls = strokes.map(d =>
    `<path class="stroke-path" d="${d}" fill="none" stroke="#f97316" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>`
  ).join('');
  return `<svg class="digit-anim-svg letter-anim-svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="96" height="96" rx="10" fill="#fff7ed" stroke="#fed7aa" stroke-width="2"/>
    ${pathEls}
  </svg>`;
}

function animateDigitSVG(svgEl, digit) {
  const strokes = DIGIT_STROKES[digit] || [];
  animateStrokes(svgEl, strokes, '#8b5cf6');
}

function animateLetterSVG(svgEl, letter) {
  const strokes = LETTER_STROKES[letter.toUpperCase()] || [];
  animateStrokes(svgEl, strokes, '#f97316');
}

let numbersState = { questions:[], index:0, correct:0 };

function startNumbersGame() {
  const pool = [...NUMBER_DATA].sort(() => Math.random() - 0.5).slice(0, 10);
  numbersState = { questions: pool, index: 0, correct: 0 };
  document.getElementById('mathOverlay').classList.add('active');
  renderNumbersCard();
}

function renderNumbersCard() {
  const { questions, index } = numbersState;
  if (index >= questions.length) { showNumbersComplete(); return; }

  const q = questions[index];
  document.getElementById('mathProgressText').textContent = `${index + 1} / ${questions.length}`;
  document.getElementById('mathProgressFill').style.width = `${((index + 1) / questions.length) * 100}%`;

  // 4 options: correct digit + 3 random others
  const allDigits = NUMBER_DATA.map(d => d.digit);
  const opts = new Set([q.digit]);
  while (opts.size < 4) opts.add(allDigits[Math.floor(Math.random() * allDigits.length)]);
  const optArr = [...opts].sort(() => Math.random() - 0.5);

  document.getElementById('mathContent').innerHTML = `
    <div class="kids-study-hint">这是数字几？🔢</div>
    <div class="num-card-wrap">
      <div class="num-card-top">
        <div class="num-big-digit">${q.digit}</div>
        <div class="num-stroke-wrap" id="numStrokeWrap" title="点击重新书写">
          ${buildDigitSVG(q.digit)}
          <div class="num-stroke-hint">点击重新书写 ✏️</div>
        </div>
      </div>
      <div class="num-info">
        <div class="num-zh">${q.zh}  ${q.emoji}</div>
        <div class="num-things">${q.things}</div>
      </div>
    </div>
    <div class="math-options">${optArr.map(o => `<button class="math-option-btn" onclick="checkNumberAnswer(this,${o},${q.digit})">${o}</button>`).join('')}</div>`;

  const svgEl = document.getElementById('numStrokeWrap')?.querySelector('.digit-anim-svg');
  if (svgEl) {
    animateDigitSVG(svgEl, q.digit);
    document.getElementById('numStrokeWrap').onclick = () => {
      const s = document.getElementById('numStrokeWrap')?.querySelector('.digit-anim-svg');
      if (s) animateDigitSVG(s, q.digit);
    };
  }

  speak(q.zh, 0.8);
}

function checkNumberAnswer(btn, selected, answer) {
  if (btn.classList.contains('correct') || btn.classList.contains('wrong')) return;
  const correct = selected === answer;
  btn.classList.add(correct ? 'correct' : 'wrong');
  if (correct) {
    numbersState.correct++;
    speak('太棒了！', 1);
    createStarBurst();
  } else {
    speak('再想想！', 0.9);
    document.querySelectorAll('.math-option-btn').forEach(b => {
      if (parseInt(b.textContent) === answer) b.classList.add('correct');
    });
  }
  saveMathStats('numbers', correct);
  document.querySelectorAll('.math-option-btn').forEach(b => b.onclick = null);
  const nb = document.createElement('button');
  nb.className = 'math-next-btn';
  nb.textContent = '下一个 ➡️';
  nb.onclick = () => { numbersState.index++; renderNumbersCard(); };
  document.querySelector('.math-options').after(nb);
}

function showNumbersComplete() {
  const { correct, questions } = numbersState;
  document.getElementById('mathContent').innerHTML = `
    <div class="kids-complete">
      <div class="kids-complete-emoji">🎉</div>
      <div class="kids-complete-title">数字学完啦！</div>
      <div class="kids-complete-stats">答对 ${correct} / ${questions.length} 题</div>
      <button class="kids-complete-btn" onclick="closeMathOverlay()">回到算数 🔢</button>
    </div>`;
  speak(`太棒了！你认识了${correct}个数字！`, 0.9);
  createStarBurst(); setTimeout(createStarBurst, 500);
}

function startMathGame(diff) {
  if (diff === 'numbers') { startNumbersGame(); return; }
  mathState = { questions:[], index:0, correct:0, difficulty:diff };
  for(let i=0;i<10;i++) mathState.questions.push(generateMathQ(diff));
  document.getElementById('mathOverlay').classList.add('active');
  renderMathCard();
}

function closeMathOverlay() {
  document.getElementById('mathOverlay').classList.remove('active');
  loadMathHome();
}

function renderMathCard() {
  const {questions,index} = mathState;
  if(index >= questions.length) { showMathComplete(); return; }
  const q = questions[index];
  document.getElementById('mathProgressText').textContent = `${index+1} / ${questions.length}`;
  document.getElementById('mathProgressFill').style.width = `${((index+1)/questions.length)*100}%`;
  const opts = generateOptions(q.answer, mathState.difficulty==='easy'?10:mathState.difficulty==='medium'?20:100);
  document.getElementById('mathContent').innerHTML = `
    <div class="kids-study-hint">算一算！🤔</div>
    <div class="math-question">${q.text}</div>
    <div class="math-options">${opts.map(o=>`<button class="math-option-btn" onclick="checkMathAnswer(this,${o},${q.answer})">${o}</button>`).join('')}</div>`;
}

function generateOptions(answer, max) {
  const opts = new Set([answer]);
  while(opts.size<4) { let v=answer+Math.floor(Math.random()*7)-3; if(v>=0&&v!==answer) opts.add(v); }
  return [...opts].sort(()=>Math.random()-0.5);
}

function checkMathAnswer(btn, selected, answer) {
  if(btn.classList.contains('correct')||btn.classList.contains('wrong')) return;
  const correct = selected===answer;
  btn.classList.add(correct?'correct':'wrong');
  if(correct) { mathState.correct++; speak('太棒了！',1); createStarBurst(); }
  else { speak('再想想！',0.9); document.querySelectorAll('.math-option-btn').forEach(b=>{ if(parseInt(b.textContent)===answer) b.classList.add('correct'); }); }
  saveMathStats(mathState.difficulty, correct);
  document.querySelectorAll('.math-option-btn').forEach(b=>b.onclick=null);
  const nb = document.createElement('button');
  nb.className = 'math-next-btn';
  nb.textContent = '下一题 ➡️';
  nb.onclick = ()=>{ mathState.index++; renderMathCard(); };
  document.querySelector('.math-options').after(nb);
}

function showMathComplete() {
  const {correct,questions} = mathState;
  document.getElementById('mathContent').innerHTML = `
    <div class="kids-complete">
      <div class="kids-complete-emoji">🎉</div>
      <div class="kids-complete-title">算数完成！</div>
      <div class="kids-complete-stats">答对 ${correct} / ${questions.length} 题</div>
      <button class="kids-complete-btn" onclick="closeMathOverlay()">回到算数 🔢</button>
    </div>`;
  speak(`太棒了！你答对了${correct}道题！`,0.9);
  createStarBurst(); setTimeout(createStarBurst,500);
}

// ============ 英语模块 ============
const ENG_DATA = {
  alphabet: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l=>({letter:l,lower:l.toLowerCase(),word:['Apple','Ball','Cat','Dog','Egg','Fish','Girl','Hat','Ice','Juice','Kite','Lion','Moon','Nest','Orange','Pen','Queen','Rain','Sun','Tree','Umbrella','Van','Water','Box','Yo-yo','Zebra']['ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(l)]})),
  words: [
    {en:'apple',zh:'苹果',emoji:'🍎'},{en:'banana',zh:'香蕉',emoji:'🍌'},{en:'cat',zh:'猫',emoji:'🐱'},{en:'dog',zh:'狗',emoji:'🐶'},
    {en:'egg',zh:'鸡蛋',emoji:'🥚'},{en:'fish',zh:'鱼',emoji:'🐟'},{en:'bird',zh:'鸟',emoji:'🐦'},{en:'book',zh:'书',emoji:'📖'},
    {en:'star',zh:'星星',emoji:'⭐'},{en:'sun',zh:'太阳',emoji:'☀️'},{en:'moon',zh:'月亮',emoji:'🌙'},{en:'tree',zh:'树',emoji:'🌳'},
    {en:'flower',zh:'花',emoji:'🌸'},{en:'water',zh:'水',emoji:'💧'},{en:'milk',zh:'牛奶',emoji:'🥛'},{en:'cake',zh:'蛋糕',emoji:'🎂'}
  ],
  colors: [
    {en:'red',zh:'红色',emoji:'🔴'},{en:'blue',zh:'蓝色',emoji:'🔵'},{en:'green',zh:'绿色',emoji:'🟢'},{en:'yellow',zh:'黄色',emoji:'🟡'},
    {en:'orange',zh:'橙色',emoji:'🟠'},{en:'purple',zh:'紫色',emoji:'🟣'},{en:'pink',zh:'粉色',emoji:'🩷'},{en:'black',zh:'黑色',emoji:'⚫'},
    {en:'white',zh:'白色',emoji:'⚪'},{en:'brown',zh:'棕色',emoji:'🟤'}
  ]
};
let engState = { items:[], index:0, correct:0, mode:'words' };

function getEngStats() {
  const raw = JSON.parse(localStorage.getItem('kids_eng_stats')||'{}');
  if (raw.total !== undefined && raw.alphabet === undefined) {
    return { alphabet:{total:0,correct:0}, words:{total: raw.total||0, correct: raw.correct||0}, colors:{total:0,correct:0} };
  }
  return {
    alphabet: raw.alphabet || {total:0,correct:0},
    words: raw.words || {total:0,correct:0},
    colors: raw.colors || {total:0,correct:0}
  };
}
function saveEngStats(mode, c) {
  const s=getEngStats();
  if (!s[mode]) s[mode] = {total:0,correct:0};
  s[mode].total++;
  if (c) s[mode].correct++;
  localStorage.setItem('kids_eng_stats',JSON.stringify(s));
}
function getEngTotals() {
  const s = getEngStats();
  const total = s.alphabet.total + s.words.total + s.colors.total;
  const correct = s.alphabet.correct + s.words.correct + s.colors.correct;
  return { total, correct };
}

// 英语阶段定义
const ENG_STAGES = [
  { key: 'alphabet', label: '字母', emoji: '🅰️', desc: '26个英文字母',  threshold: 26 },
  { key: 'words',    label: '单词', emoji: '🍎', desc: '日常简单单词',  threshold: 30 },
  { key: 'colors',   label: '颜色', emoji: '🎨', desc: '认识各种颜色',  threshold: 20 }
];

function loadEnglishHome() {
  const t = getEngTotals();
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  set('engTotal', t.total);
  set('engCorrect', t.correct);
  set('engAccuracy', t.total>0?Math.round(t.correct/t.total*100)+'%':'0%');

  const es = getEngStats();
  const stages = ENG_STAGES.map(s => ({
    ...s,
    total: (es[s.key] && es[s.key].total) || 0,
    correct: (es[s.key] && es[s.key].correct) || 0
  }));
  renderLinearStages('englishStageCard', 'englishDifficultyGrid', stages, startEnglishGame);

  renderAssessment('englishAssessment', evalEnglish(es));
}

function startEnglishGame(mode) {
  engState = {items:[],index:0,correct:0,mode};
  let pool;
  if(mode==='alphabet') pool=ENG_DATA.alphabet.map(a=>({question:a.letter,answer:a.word,emoji:'🔤',display:a.letter}));
  else pool=(mode==='colors'?ENG_DATA.colors:ENG_DATA.words).map(w=>({question:w.emoji+' '+w.zh,answer:w.en,emoji:w.emoji,display:w.zh}));
  pool.sort(()=>Math.random()-0.5);
  engState.items = pool.slice(0,10);
  document.getElementById('englishOverlay').classList.add('active');
  renderEnglishCard();
}

function closeEnglishOverlay() { document.getElementById('englishOverlay').classList.remove('active'); loadEnglishHome(); }

function renderEnglishCard() {
  const {items,index,mode} = engState;
  if(index>=items.length) { showEnglishComplete(); return; }
  const q = items[index];
  document.getElementById('englishProgressText').textContent = `${index+1} / ${items.length}`;
  document.getElementById('englishProgressFill').style.width = `${((index+1)/items.length)*100}%`;
  const allAnswers = (mode==='alphabet'?ENG_DATA.alphabet.map(a=>a.word):(mode==='colors'?ENG_DATA.colors:ENG_DATA.words).map(w=>w.en));
  const opts = new Set([q.answer]);
  while(opts.size<4) { const r=allAnswers[Math.floor(Math.random()*allAnswers.length)]; if(r!==q.answer) opts.add(r); }
  const shuffled = [...opts].sort(()=>Math.random()-0.5);
  const speakText = mode==='alphabet' ? q.display : q.answer;
  const wordBtn = mode==='alphabet'
    ? `<button class="english-word-btn" onclick="event.stopPropagation();speakEn('${q.answer}')">🔊 ${q.answer}</button>`
    : '';
  const letterStroke = mode==='alphabet'
    ? `<div class="letter-stroke-wrap" id="letterStrokeWrap" title="点击重新书写">
        ${buildLetterSVG(q.question)}
        <div class="num-stroke-hint">点击重新书写 ✏️</div>
       </div>`
    : '';
  document.getElementById('englishContent').innerHTML = `
    <div class="kids-study-hint">选出正确答案！🤔</div>
    <div class="english-word-card" onclick="speakEn('${speakText}')">
      <div class="english-word-emoji">${q.emoji}</div>
      <div class="english-word-text">${q.question}</div>
      ${letterStroke}
      ${wordBtn}
    </div>
    <div class="english-options">${shuffled.map(o=>`<button class="english-option-btn" onclick="checkEngAnswer(this,'${o}','${q.answer}')">${o}</button>`).join('')}</div>`;
  if (mode === 'alphabet') {
    const svgEl = document.getElementById('letterStrokeWrap')?.querySelector('.digit-anim-svg');
    if (svgEl) {
      animateLetterSVG(svgEl, q.question);
      document.getElementById('letterStrokeWrap').onclick = (e) => {
        e.stopPropagation();
        const s = document.getElementById('letterStrokeWrap')?.querySelector('.digit-anim-svg');
        if (s) animateLetterSVG(s, q.question);
      };
    }
  }
}

function speakEn(text) {
  const audio = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&type=2`);
  audio.play().catch(()=>{
    if(!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(text); u.lang='en-US'; u.rate=0.8;
    window.speechSynthesis.speak(u);
  });
}

function checkEngAnswer(btn,sel,ans) {
  if(btn.classList.contains('correct')||btn.classList.contains('wrong')) return;
  const c = sel===ans;
  btn.classList.add(c?'correct':'wrong');
  if(c) { engState.correct++; speakEn(ans); createStarBurst(); }
  else { document.querySelectorAll('.english-option-btn').forEach(b=>{if(b.textContent===ans)b.classList.add('correct');}); }
  saveEngStats(engState.mode, c);
  document.querySelectorAll('.english-option-btn').forEach(b=>b.onclick=null);
  const nb = document.createElement('button');
  nb.className = 'english-next-btn';
  nb.textContent = '下一题 ➡️';
  nb.onclick = ()=>{ engState.index++; renderEnglishCard(); };
  document.querySelector('.english-options').after(nb);
}

function showEnglishComplete() {
  const {correct,items}=engState;
  document.getElementById('englishContent').innerHTML = `
    <div class="kids-complete">
      <div class="kids-complete-emoji">🎉</div>
      <div class="kids-complete-title">英语完成！</div>
      <div class="kids-complete-stats">答对 ${correct} / ${items.length} 题</div>
      <button class="kids-complete-btn" onclick="closeEnglishOverlay()">回到英语 🔤</button>
    </div>`;
  speakEn('Great job!');
  createStarBurst(); setTimeout(createStarBurst,500);
}

// ============ 故事模块 ============
let storyState = { story:null, paraIndex:0, playing:false, rate:0.85, startedAt:0, reported:false };

// 故事5分钟限时计时器（整个故事模块累计，进入模块时启动）
const STORY_MAX_MS = 5 * 60 * 1000; // 5分钟
let _storyLimitTimer = null;
let _storyLockTimer = null;  // 锁定期5分钟解锁倒计时
let _storyLockRemain = 0;
let _storyModuleEnteredAt = 0; // 进入故事模块的时间

function startStoryModuleTimer() {
  _storyModuleEnteredAt = Date.now();
  clearTimeout(_storyLimitTimer);
  _storyLimitTimer = setTimeout(() => {
    triggerStoryLock();
  }, STORY_MAX_MS);
}

function clearStoryLimitTimer() {
  clearTimeout(_storyLimitTimer);
  _storyLimitTimer = null;
}

function triggerStoryLock() {
  // 停止播放
  if (_speakAudio) { _speakAudio.pause(); _speakAudio = null; }
  window.speechSynthesis && window.speechSynthesis.cancel();
  storyState.playing = false;
  renderStoryReader();

  // 语音提示
  speak('小朋友，你已经听故事超过5分钟了，休息一下眼睛吧！', 0.85);

  // 显示锁定浮层
  const overlay = document.getElementById('storyLockOverlay');
  if (overlay) overlay.classList.add('active');

  // 5分钟解锁倒计时
  _storyLockRemain = 5 * 60;
  updateLockCountdown();
  clearInterval(_storyLockTimer);
  _storyLockTimer = setInterval(() => {
    _storyLockRemain--;
    updateLockCountdown();
    if (_storyLockRemain <= 0) {
      clearInterval(_storyLockTimer);
      unlockStory();
    }
  }, 1000);
}

function updateLockCountdown() {
  const el = document.getElementById('storyLockCountdown');
  if (!el) return;
  const m = Math.floor(_storyLockRemain / 60);
  const s = _storyLockRemain % 60;
  el.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function unlockStory() {
  const overlay = document.getElementById('storyLockOverlay');
  if (overlay) overlay.classList.remove('active');
  speak('好了，可以继续听故事啦！', 0.85);
  startStoryModuleTimer(); // 重新计时
}

function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`;
}

async function loadStoryHome() {
  const grid = document.getElementById('storyGrid');
  if (!grid) return;
  grid.innerHTML = '<div class="kids-message">加载中...</div>';
  try {
    const res = await fetch('/api/kids/stories').then(r => r.json());
    const stories = res.stories || [];
    if (stories.length === 0) {
      grid.innerHTML = '<div class="kids-message">暂无故事</div>';
      return;
    }
    grid.innerHTML = stories.map(s => {
      const count = s.play_count || 0;
      const badge = count > 0
        ? `<span class="kids-story-count">📚 已讲 ${count} 次 · ${formatDuration(s.total_seconds)}</span>`
        : `<span class="kids-story-count kids-story-count-new">还没讲过</span>`;
      return `
        <div class="kids-story-card" style="background:${s.bg}" onclick="openStory('${s.id}')">
          <div class="kids-story-cover">${s.cover}</div>
          <div class="kids-story-info">
            <div class="kids-story-title">${s.title}</div>
            <div class="kids-story-summary">${s.summary}</div>
            ${badge}
          </div>
          <div class="kids-story-play">▶</div>
        </div>
      `;
    }).join('');
  } catch (e) {
    console.error('加载故事失败:', e);
    grid.innerHTML = '<div class="kids-message">加载失败，请重试</div>';
  }
}

async function openStory(id) {
  try {
    const story = await fetch(`/api/kids/stories/${id}`).then(r => r.json());
    if (!story || !story.paragraphs) {
      showToast('故事加载失败');
      return;
    }
    storyState = { story, paraIndex:0, playing:false, rate:0.85, startedAt: Date.now(), reported: false };
    switchView('story-read');
    renderStoryReader();
  } catch (e) {
    console.error('打开故事失败:', e);
    showToast('网络错误');
  }
}

function reportStoryPlay() {
  if (!storyState || !storyState.story || storyState.reported) return;
  if (!storyState.startedAt) return;
  const duration = Math.round((Date.now() - storyState.startedAt) / 1000);
  if (duration < 3) { storyState.reported = true; return; } // 太短不记
  storyState.reported = true;
  const id = storyState.story.id;
  // navigator.sendBeacon 在页面卸载时更可靠
  try {
    const body = JSON.stringify({ duration });
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: 'application/json' });
      navigator.sendBeacon(`/api/kids/stories/${id}/plays`, blob);
    } else {
      fetch(`/api/kids/stories/${id}/plays`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true
      });
    }
  } catch (e) {
    console.error('上报故事时长失败:', e);
  }
}

function renderStoryReader() {
  const reader = document.getElementById('storyReader');
  const { story, paraIndex, playing, rate } = storyState;
  if (!reader || !story) return;

  const total = story.paragraphs.length;
  const pct = Math.round(((paraIndex + 1) / total) * 100);

  reader.innerHTML = `
    <div class="kids-story-header" style="background:${story.bg}">
      <button class="kids-story-back" onclick="exitStory()" aria-label="返回">←</button>
      <div class="kids-story-cover-big">${story.cover}</div>
      <div class="kids-story-title-big">${story.title}</div>
    </div>
    <div class="kids-story-progress">
      <div class="kids-story-progress-text">第 ${paraIndex + 1} / ${total} 页</div>
      <div class="kids-story-progress-bar"><div class="kids-story-progress-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="kids-story-text" onclick="playCurrent()">${story.paragraphs[paraIndex]}</div>
    <div class="kids-story-controls">
      <button class="kids-story-btn" onclick="prevParagraph()" ${paraIndex === 0 ? 'disabled' : ''}>⬅ 上一页</button>
      <button class="kids-story-btn kids-story-btn-main" onclick="togglePlay()">
        ${playing ? '⏸ 暂停' : '▶ 播放'}
      </button>
      <button class="kids-story-btn" onclick="nextParagraph()" ${paraIndex >= total - 1 ? 'disabled' : ''}>下一页 ➡</button>
    </div>
    <div class="kids-story-rate">
      <span class="kids-story-rate-label">语速</span>
      <button class="kids-story-rate-btn ${rate === 0.7 ? 'active' : ''}" onclick="setStoryRate(0.7)">慢</button>
      <button class="kids-story-rate-btn ${rate === 0.85 ? 'active' : ''}" onclick="setStoryRate(0.85)">中</button>
      <button class="kids-story-rate-btn ${rate === 1 ? 'active' : ''}" onclick="setStoryRate(1)">快</button>
    </div>
  `;
}

function playCurrent() {
  const { story, paraIndex, rate } = storyState;
  if (!story) return;
  speak(story.paragraphs[paraIndex], rate);
}

function togglePlay() {
  if (storyState.playing) {
    if (_speakAudio) { _speakAudio.pause(); _speakAudio = null; }
    window.speechSynthesis && window.speechSynthesis.cancel();
    storyState.playing = false;
    renderStoryReader();
  } else {
    startAutoPlay();
  }
}

function startAutoPlay() {
  const { story, rate } = storyState;
  if (!story) return;
  storyState.playing = true;
  renderStoryReader();
  speakParagraph();
}

function speakParagraph() {
  const { story, paraIndex, playing } = storyState;
  if (!story || !playing) return;
  if (_speakAudio) { _speakAudio.pause(); _speakAudio = null; }
  window.speechSynthesis && window.speechSynthesis.cancel();

  const text = story.paragraphs[paraIndex];
  const onDone = () => {
    if (!storyState.playing) return;
    if (storyState.paraIndex < storyState.story.paragraphs.length - 1) {
      storyState.paraIndex++;
      renderStoryReader();
      setTimeout(speakParagraph, 600);
    } else {
      storyState.playing = false;
      reportStoryPlay();
      renderStoryReader();
      createStarBurst();
      showToast('故事讲完啦！🎉');
    }
  };

  const audio = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(text)}&le=zh`);
  _speakAudio = audio;
  audio.onended = onDone;
  audio.play().catch(() => {
    if (!('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN'; u.rate = storyState.rate; u.pitch = 1.1; u.volume = 1;
    const voices = window.speechSynthesis.getVoices();
    const zhVoice = voices.find(v => v.lang.startsWith('zh'));
    if (zhVoice) u.voice = zhVoice;
    u.onend = onDone;
    window.speechSynthesis.speak(u);
  });
}

function prevParagraph() {
  if (storyState.paraIndex > 0) {
    storyState.paraIndex--;
    if (_speakAudio) { _speakAudio.pause(); _speakAudio = null; }
    window.speechSynthesis && window.speechSynthesis.cancel();
    storyState.playing = false;
    renderStoryReader();
    setTimeout(playCurrent, 200);
  }
}

function nextParagraph() {
  if (storyState.story && storyState.paraIndex < storyState.story.paragraphs.length - 1) {
    storyState.paraIndex++;
    if (_speakAudio) { _speakAudio.pause(); _speakAudio = null; }
    window.speechSynthesis && window.speechSynthesis.cancel();
    storyState.playing = false;
    renderStoryReader();
    setTimeout(playCurrent, 200);
  }
}

function setStoryRate(rate) {
  storyState.rate = rate;
  const wasPlaying = storyState.playing;
  if (_speakAudio) { _speakAudio.pause(); _speakAudio = null; }
  window.speechSynthesis && window.speechSynthesis.cancel();
  storyState.playing = false;
  renderStoryReader();
  if (wasPlaying) startAutoPlay();
  else setTimeout(playCurrent, 150);
}

function exitStory() {
  if (_speakAudio) { _speakAudio.pause(); _speakAudio = null; }
  window.speechSynthesis && window.speechSynthesis.cancel();
  reportStoryPlay();
  // 关闭锁定浮层（如有）
  const overlay = document.getElementById('storyLockOverlay');
  if (overlay) overlay.classList.remove('active');
  storyState = { story:null, paraIndex:0, playing:false, rate:0.85, startedAt:0, reported:false };
  switchView('story-home');
}

// 页面关闭/切走时也尝试上报
window.addEventListener('pagehide', () => {
  if (storyState && storyState.story) reportStoryPlay();
});
window.addEventListener('beforeunload', () => {
  if (storyState && storyState.story) reportStoryPlay();
});

// ============ 故事语音总结录音 ============
let _mediaRecorder = null;
let _recordChunks = [];
let _recordMimeType = '';
let _recordTimerInterval = null;
let _recordSec = 0;

async function toggleStoryRecord() {
  if (_mediaRecorder && _mediaRecorder.state === 'recording') {
    _mediaRecorder.stop();
  } else {
    await startStoryRecord();
  }
}

async function startStoryRecord() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _recordChunks = [];
    _recordSec = 0;
    const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    _recordMimeType = mimeType;
    _mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    _mediaRecorder.ondataavailable = e => { if (e.data.size > 0) _recordChunks.push(e.data); };
    _mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(_recordTimerInterval);
      const btn = document.getElementById('storyRecordBtn');
      const timerEl = document.getElementById('storyRecordTimer');
      if (btn) { btn.classList.remove('recording'); document.getElementById('storyRecordLabel').textContent = '开始录音'; }
      if (timerEl) timerEl.style.display = 'none';
      uploadStoryRecording();
    };
    _mediaRecorder.start(200);

    // 更新 UI
    const btn = document.getElementById('storyRecordBtn');
    const timerEl = document.getElementById('storyRecordTimer');
    if (btn) { btn.classList.add('recording'); document.getElementById('storyRecordLabel').textContent = '停止录音'; }
    if (timerEl) timerEl.style.display = 'block';

    _recordTimerInterval = setInterval(() => {
      _recordSec++;
      const secEl = document.getElementById('storyRecordSec');
      if (secEl) secEl.textContent = _recordSec;
      // 最长录音60秒自动停止
      if (_recordSec >= 60 && _mediaRecorder && _mediaRecorder.state === 'recording') {
        _mediaRecorder.stop();
      }
    }, 1000);
  } catch (e) {
    showToast('无法访问麦克风，请检查权限设置');
  }
}

function stopStoryRecord() {
  if (_mediaRecorder && _mediaRecorder.state === 'recording') {
    _mediaRecorder.stop();
  }
  clearInterval(_recordTimerInterval);
}

async function uploadStoryRecording() {
  if (_recordChunks.length === 0) return;
  const ct = _recordMimeType || 'audio/webm';
  const blob = new Blob(_recordChunks, { type: ct });
  _recordChunks = [];

  showToast('正在保存录音...');
  try {
    const res = await fetch('/api/kids/stories/global/summaries', {
      method: 'POST',
      headers: { 'Content-Type': ct },
      body: blob
    });
    if (res.ok) {
      showToast('录音保存成功！');
      loadStorySummaries('global');
    } else {
      showToast('保存失败，请重试');
    }
  } catch (e) {
    showToast('网络错误，保存失败');
  }
}

async function loadStorySummaries(storyId) {
  const list = document.getElementById('storySummariesList');
  if (!list) return;
  try {
    const res = await fetch(`/api/kids/stories/${storyId}/summaries`).then(r => r.json());
    const summaries = res.summaries || [];
    if (summaries.length === 0) {
      list.innerHTML = '<div style="font-size:13px;color:#94a3b8;text-align:center;padding:8px 0;">还没有录音，录一个试试吧！</div>';
      return;
    }
    list.innerHTML = summaries.map((s, i) => {
      const d = new Date(s.created_at);
      const dateStr = `${d.getMonth()+1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;
      return `
        <div class="story-summary-item">
          <div class="story-summary-item-icon">🎤</div>
          <div class="story-summary-item-info">
            <div class="story-summary-item-label">第 ${summaries.length - i} 次总结</div>
            <div class="story-summary-item-date">${dateStr}</div>
          </div>
          <button class="story-summary-play-btn" onclick="playStorySummary('${s.url}', this)" title="播放">▶</button>
        </div>
      `;
    }).join('');
  } catch (e) {
    list.innerHTML = '<div style="font-size:13px;color:#94a3b8;text-align:center;">加载失败</div>';
  }
}

let _summaryAudio = null;
function playStorySummary(url, btn) {
  if (_summaryAudio) { _summaryAudio.pause(); _summaryAudio = null; }
  // 重置所有播放按钮
  document.querySelectorAll('.story-summary-play-btn').forEach(b => b.textContent = '▶');

  _summaryAudio = new Audio(url);
  _summaryAudio.onended = () => { btn.textContent = '▶'; _summaryAudio = null; };
  _summaryAudio.play().then(() => { btn.textContent = '⏹'; }).catch(() => showToast('播放失败'));
}

