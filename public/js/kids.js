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
}

function enterModule(mod) {
  currentModule = mod;
  updateTabs(mod);
  if (mod === 'literacy') switchView('home');
  else if (mod === 'math') switchView('math-home');
  else if (mod === 'english') switchView('english-home');
  else if (mod === 'story') switchView('story-home');
}

function goHub() {
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
      { view:'story-home', icon:'📖', label:'故事' }
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
    const [statsRes, sessionsRes] = await Promise.all([
      fetch('/api/kids/stats').then(r => r.json()),
      fetch('/api/kids/sessions/today').then(r => r.json())
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
});

// ============ 算数模块 ============
let mathState = { questions:[], index:0, correct:0, difficulty:'easy' };

function getMathStats() {
  return JSON.parse(localStorage.getItem('kids_math_stats') || '{"total":0,"correct":0}');
}
function saveMathStats(correct) {
  const s = getMathStats();
  s.total++; if(correct) s.correct++;
  localStorage.setItem('kids_math_stats', JSON.stringify(s));
}

function loadMathHome() {
  const s = getMathStats();
  const set = (id,v)=>{ const e=document.getElementById(id); if(e) e.textContent=v; };
  set('mathTotal', s.total);
  set('mathCorrect', s.correct);
  set('mathAccuracy', s.total>0 ? Math.round(s.correct/s.total*100)+'%' : '0%');
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

function startMathGame(diff) {
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
  saveMathStats(correct);
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

function getEngStats() { return JSON.parse(localStorage.getItem('kids_eng_stats')||'{"total":0,"correct":0}'); }
function saveEngStats(c) { const s=getEngStats(); s.total++; if(c) s.correct++; localStorage.setItem('kids_eng_stats',JSON.stringify(s)); }

function loadEnglishHome() {
  const s=getEngStats();
  const set=(id,v)=>{const e=document.getElementById(id);if(e)e.textContent=v;};
  set('engTotal',s.total); set('engCorrect',s.correct);
  set('engAccuracy',s.total>0?Math.round(s.correct/s.total*100)+'%':'0%');
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
  const speakEn = mode==='alphabet' ? q.display : q.answer;
  document.getElementById('englishContent').innerHTML = `
    <div class="kids-study-hint">选出正确答案！🤔</div>
    <div class="english-word-card" onclick="speakEn('${speakEn}')">
      <div class="english-word-emoji">${q.emoji}</div>
      <div class="english-word-text">${q.question}</div>
    </div>
    <div class="english-options">${shuffled.map(o=>`<button class="english-option-btn" onclick="checkEngAnswer(this,'${o}','${q.answer}')">${o}</button>`).join('')}</div>`;
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
  saveEngStats(c);
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
let storyState = { story:null, paraIndex:0, playing:false, rate:0.85 };

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
    grid.innerHTML = stories.map(s => `
      <div class="kids-story-card" style="background:${s.bg}" onclick="openStory('${s.id}')">
        <div class="kids-story-cover">${s.cover}</div>
        <div class="kids-story-info">
          <div class="kids-story-title">${s.title}</div>
          <div class="kids-story-summary">${s.summary}</div>
        </div>
        <div class="kids-story-play">▶</div>
      </div>
    `).join('');
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
    storyState = { story, paraIndex:0, playing:false, rate:0.85 };
    switchView('story-read');
    renderStoryReader();
  } catch (e) {
    console.error('打开故事失败:', e);
    showToast('网络错误');
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
  storyState = { story:null, paraIndex:0, playing:false, rate:0.85 };
  switchView('story-home');
}
