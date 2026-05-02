// ============ State ============
let currentTab = 'study';
let libraryPage = 1;
let searchTimer = null;

// ============ TTS (English) — 有道词典真人发音 ============
const _ttsAudio = new Audio();
_ttsAudio.volume = 1;

function speakWord(word, type = 1) {
  // type: 1 = 美式发音, 2 = 英式发音
  if (!word) return;
  _ttsAudio.pause();
  _ttsAudio.currentTime = 0;
  const src = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type}`;
  _ttsAudio.src = src;
  _ttsAudio.play().catch(() => {
    // 有道不可用时回退到 Web Speech API
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word);
      u.lang = 'en-US';
      u.rate = 0.8;
      window.speechSynthesis.speak(u);
    }
  });
}

// ============ Init ============
document.addEventListener('DOMContentLoaded', () => {
  loadHeaderStats();
  loadStudyTab();
  loadDueBadge();
  requestNotificationPermission();
  // 每分钟检查一次是否需要推送
  setInterval(checkScheduledPush, 60000);
  startStudyTimer();
});

// ============ Study Time Tracker ============
// 仅在「今日学习 / 艾宾浩斯复习 / 卡片学习」场景下，且页面可见、最近 60s 有用户操作时计时。
// 每 30s 把累计秒数提交一次；页面隐藏/卸载时通过 sendBeacon 兜底提交。
let studyTrackedSeconds = 0;
let studyLastActivityAt = Date.now();
const STUDY_IDLE_MS = 60_000;
const STUDY_FLUSH_INTERVAL_S = 30;

function isInLearningContext() {
  if (document.visibilityState !== 'visible') return false;
  if (Date.now() - studyLastActivityAt > STUDY_IDLE_MS) return false;
  const overlay = document.getElementById('flashcardOverlay');
  if (overlay && overlay.classList.contains('active')) return true;
  return currentTab === 'study' || currentTab === 'review';
}

function flushStudyTime({ beacon = false } = {}) {
  if (studyTrackedSeconds <= 0) return;
  const seconds = studyTrackedSeconds;
  studyTrackedSeconds = 0;
  const payload = JSON.stringify({ seconds });
  if (beacon && navigator.sendBeacon) {
    const blob = new Blob([payload], { type: 'application/json' });
    navigator.sendBeacon('/api/study-time', blob);
    return;
  }
  fetch('/api/study-time', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    keepalive: true
  }).catch(() => {
    // 失败不重试，避免循环上报；丢失少量时长可接受
  });
}

function startStudyTimer() {
  const bumpActivity = () => { studyLastActivityAt = Date.now(); };
  ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(ev => {
    window.addEventListener(ev, bumpActivity, { passive: true });
  });

  setInterval(() => {
    if (isInLearningContext()) {
      studyTrackedSeconds += 1;
      if (studyTrackedSeconds >= STUDY_FLUSH_INTERVAL_S) flushStudyTime();
    }
  }, 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushStudyTime({ beacon: true });
  });
  window.addEventListener('pagehide', () => flushStudyTime({ beacon: true }));
}

// ============ Tabs ============
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');

  switch (tab) {
    case 'study': loadStudyTab(); break;
    case 'review': loadReviewTab(); break;
    case 'library': loadLibrary(); loadCategories(); loadBatchOptions(); break;
    case 'stats': loadStats(); break;
    case 'add': renderPendingWords(); renderBatchHistory(); break;
  }
}

// ============ Header Stats ============
async function loadHeaderStats() {
  try {
    const stats = await api('/api/stats');
    document.getElementById('headerStats').innerHTML = `
      <div class="header-stat">
        <span class="num">${stats.learned}</span>
        <span>已学会</span>
      </div>
      <div class="header-stat">
        <span class="num">${stats.inProgress}</span>
        <span>学习中</span>
      </div>
      <div class="header-stat">
        <span class="num">${stats.dueForReview}</span>
        <span>待复习</span>
      </div>
      <div class="header-stat">
        <span class="num">${stats.streakDays}</span>
        <span>天连续</span>
      </div>
    `;
  } catch (e) { console.error(e); }
}

// ============ Due Badge ============
async function loadDueBadge() {
  try {
    const data = await api('/api/review/due?limit=100');
    const badge = document.getElementById('dueBadge');
    if (data.count > 0) {
      badge.textContent = data.count;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
  } catch (e) { console.error(e); }
}

// ============ Study Tab ============
async function loadStudyTab() {
  try {
    const data = await api('/api/sessions/latest');
    const container = document.getElementById('studyCards');
    const info = document.getElementById('sessionInfo');

    if (!data.session || !data.session.words || data.session.words.length === 0) {
      info.innerHTML = '';
      container.innerHTML = `
        <div class="empty-state">
          <div class="icon">📚</div>
          <h3>还没有学习批次</h3>
          <p>点击"生成新批次"开始学习，系统会根据艾宾浩斯记忆曲线为你安排复习</p>
        </div>
      `;
      return;
    }

    const s = data.session;
    const dueCount = s.words.filter(w => w.first_seen_at && w.mastery_level < 7).length;
    const newCount = s.words.filter(w => !w.first_seen_at).length;

    info.innerHTML = `
      <div class="meta">
        批次时间: <strong>${s.scheduled_time}</strong> &nbsp;
        共 <strong>${s.words.length}</strong> 个单词
        ${dueCount > 0 ? `<span class="session-tag review">复习 ${dueCount}</span>` : ''}
        ${newCount > 0 ? `<span class="session-tag new">新词 ${newCount}</span>` : ''}
      </div>
    `;

    const shuffledWords = [...s.words].sort(() => Math.random() - 0.5);
    container.innerHTML = shuffledWords.map(w => renderWordCard(w)).join('');
  } catch (e) {
    console.error(e);
    document.getElementById('studyCards').innerHTML = '<div class="empty-state"><p>加载失败，请刷新重试</p></div>';
  }
}

async function generateSession() {
  try {
    const data = await api('/api/sessions/generate', { method: 'POST', body: { size: 15 } });
    if (!data.session) {
      showToast(data.message || '没有更多单词了', 'info');
      return;
    }
    showToast(`生成 ${data.session.words.length} 个单词（${data.session.dueCount} 复习 + ${data.session.newCount} 新词）`, 'success');
    loadStudyTab();
    loadHeaderStats();
    loadDueBadge();
  } catch (e) {
    showToast('生成失败', 'error');
  }
}

// ============ Flashcard Mode ============
let flashcardState = {
  words: [],
  index: 0,
  flipped: false,
  detailsCache: {},
  sessionId: null
};

async function startFlashcards() {
  try {
    const data = await api('/api/sessions/latest');
    const words = data.session && data.session.words ? data.session.words : [];
    if (words.length === 0) {
      showToast('当前批次没有单词，请先生成新批次', 'info');
      return;
    }
    const shuffled = [...words].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, Math.min(8, shuffled.length));
    flashcardState = { words: selected, index: 0, flipped: false, detailsCache: {}, sessionId: data.session.id };
    document.getElementById('flashcardOverlay').classList.add('active');
    document.body.style.overflow = 'hidden';
    renderFlashcard();
  } catch (e) {
    showToast('进入卡片学习失败', 'error');
  }
}

function closeFlashcards() {
  document.getElementById('flashcardOverlay').classList.remove('active');
  document.body.style.overflow = '';
}

async function renderFlashcard() {
  const { words, index, flipped, detailsCache } = flashcardState;
  const total = words.length;
  const w = words[index];

  document.getElementById('fcProgress').textContent = `${index + 1} / ${total}`;
  document.getElementById('fcProgressFill').style.width = `${((index + 1) / total) * 100}%`;
  document.getElementById('fcPrevBtn').disabled = index === 0;
  document.getElementById('fcNextBtn').disabled = index === total - 1;

  let details = detailsCache[w.id];
  if (flipped && !details) {
    try {
      details = await api(`/api/words/${w.id}`);
      detailsCache[w.id] = details;
    } catch (e) {
      details = w;
    }
  }

  const stage = document.getElementById('fcStage');
  const frontHtml = `
    <div class="fc-face fc-front">
      <div class="fc-category"><span class="category-tag">${escapeHtml(w.category || '')}</span></div>
      <div class="fc-word" onclick="event.stopPropagation(); speakWord('${escapeAttr(w.word)}')" title="🔊 点击听发音" style="cursor:pointer">${escapeHtml(w.word)}</div>
      ${w.phonetic ? `<div class="fc-phonetic">${escapeHtml(w.phonetic)}</div>` : ''}
      <div class="fc-mastery">${renderMasteryDots(w.mastery_level)}</div>
      <div class="fc-tap-hint">点击单词听发音 · 点击卡片查看释义</div>
    </div>
  `;

  const d = details || w;
  const backHtml = `
    <div class="fc-face fc-back">
      <div class="fc-word-small" onclick="event.stopPropagation(); speakWord('${escapeAttr(d.word)}')" title="🔊 点击听发音" style="cursor:pointer">${escapeHtml(d.word)} 🔊${d.phonetic ? ` <span class="fc-phonetic-inline">${escapeHtml(d.phonetic)}</span>` : ''}</div>
      <div class="fc-chinese">${escapeHtml(d.chinese || '')}</div>
      ${d.examples && d.examples.length > 0 ? `
        <div class="fc-section-label">例句 <span class="example-hint">点击或按 A / S / D 查看中文</span></div>
        <div class="fc-examples">
          ${d.examples.slice(0, 3).map((ex, i) => `
            <div class="fc-example${ex.zh ? ' has-zh' : ''}" onclick="event.stopPropagation(); this.classList.toggle('revealed')">
              <div class="fc-example-en" title="点击复制英文" onclick="copyExample(event, this, false)" data-copy="${escapeAttr(ex.en)}"><span class="example-num">${i+1}.</span> ${escapeHtml(ex.en)}</div>
              ${ex.zh ? `<div class="fc-example-zh">${escapeHtml(ex.zh)}</div>` : ''}
            </div>
          `).join('')}
        </div>` : ''}
      ${d.synonyms && d.synonyms.length > 0 ? `
        <div class="fc-section-label">近义词</div>
        <div class="synonym-tags">
          ${d.synonyms.map(s => `<span class="synonym-tag">${escapeHtml(s)}</span>`).join('')}
        </div>` : ''}
    </div>
  `;

  stage.innerHTML = `
    <div class="fc-card ${flipped ? 'flipped' : ''}" onclick="flashcardFlip()">
      ${flipped ? backHtml : frontHtml}
    </div>
  `;

  const btns = document.getElementById('fcReviewBtns');
  if (flipped && !w.is_learned) {
    btns.innerHTML = `
      <button class="btn btn-danger btn-sm" onclick="flashcardReview(false)" title="快捷键 ↓">↓ 忘记了</button>
      <button class="btn btn-success btn-sm" onclick="flashcardReview(true)" title="快捷键 ↑">↑ 记住了</button>
    `;
  } else if (w.is_learned) {
    btns.innerHTML = `<span class="fc-learned-tag">已学会</span>`;
  } else {
    btns.innerHTML = `<span class="fc-dim">翻面后评价</span>`;
  }
}

function flashcardFlip() {
  flashcardState.flipped = !flashcardState.flipped;
  renderFlashcard();
}

function flashcardNext() {
  if (flashcardState.index < flashcardState.words.length - 1) {
    flashcardState.index++;
    flashcardState.flipped = false;
    resetFcSpelling();
    renderFlashcard();
  }
}

function flashcardPrev() {
  if (flashcardState.index > 0) {
    flashcardState.index--;
    flashcardState.flipped = false;
    resetFcSpelling();
    renderFlashcard();
  }
}

async function flashcardReview(remembered) {
  const w = flashcardState.words[flashcardState.index];
  try {
    const result = await api(`/api/words/${w.id}/review`, {
      method: 'POST',
      body: { remembered }
    });
    showToast(result.message, remembered ? 'success' : 'info');
    delete flashcardState.detailsCache[w.id];

    if (remembered && flashcardState.sessionId) {
      // 从批次中移除已记住的单词
      try {
        await api(`/api/sessions/${flashcardState.sessionId}/words/${w.id}`, { method: 'DELETE' });
      } catch (_) {}
      flashcardState.words.splice(flashcardState.index, 1);
      if (flashcardState.words.length === 0) {
        showToast('批次全部完成！', 'success');
        closeFlashcards();
        loadStudyTab();
        loadHeaderStats();
        loadDueBadge();
        return;
      }
      // 保持 index 在范围内
      if (flashcardState.index >= flashcardState.words.length) {
        flashcardState.index = flashcardState.words.length - 1;
      }
      flashcardState.flipped = false;
      renderFlashcard();
    } else {
      const isLast = flashcardState.index === flashcardState.words.length - 1;
      if (!isLast) {
        flashcardState.index++;
        flashcardState.flipped = false;
        renderFlashcard();
      } else {
        renderFlashcard();
      }
    }
    loadHeaderStats();
    loadDueBadge();
  } catch (e) {
    showToast('操作失败', 'error');
  }
}

document.addEventListener('keydown', (e) => {
  const overlay = document.getElementById('flashcardOverlay');
  if (!overlay || !overlay.classList.contains('active')) return;

  // Don't intercept when spelling input is focused (let Enter/stopPropagation handle it there)
  if (document.activeElement && document.activeElement.id === 'fcSpellingInput') return;

  // a / s / d —— 切换对应例句的中文显隐（翻面后才渲染例句，无需额外判断）
  const exKeyIdx = { a: 0, s: 1, d: 2 }[e.key.toLowerCase()];
  if (exKeyIdx !== undefined && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const target = document.querySelectorAll('#fcStage .fc-example')[exKeyIdx];
    if (target) {
      e.preventDefault();
      target.classList.toggle('revealed');
    }
    return;
  }

  if (e.key === 'ArrowRight') { e.preventDefault(); flashcardNext(); return; }
  if (e.key === 'ArrowLeft') { e.preventDefault(); flashcardPrev(); return; }
  if (e.key === ' ') { e.preventDefault(); flashcardFlip(); return; }
  if (e.key === 'Escape') { closeFlashcards(); return; }

  if (flashcardState.flipped) {
    const w = flashcardState.words[flashcardState.index];
    if (w && !w.is_learned) {
      if (e.key === 'ArrowUp') { e.preventDefault(); flashcardReview(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); flashcardReview(false); }
    }
  }
});

// ============ Review Tab (Ebbinghaus) ============
async function loadReviewTab() {
  try {
    const data = await api('/api/review/due?limit=50');
    const container = document.getElementById('reviewContent');

    if (data.count === 0) {
      container.innerHTML = `
        <div class="review-empty">
          <div class="icon">🎉</div>
          <h3>没有需要复习的单词</h3>
          <p>所有单词都已按计划复习完毕，继续保持！</p>
        </div>
      `;
      return;
    }

    // 按掌握等级分组
    const groups = {};
    data.words.forEach(w => {
      const level = w.mastery_level;
      if (!groups[level]) groups[level] = [];
      groups[level].push(w);
    });

    const levelLabels = ['新词', '1天复习', '2天复习', '4天复习', '7天复习', '15天复习', '30天复习'];
    let html = '';

    for (const [level, words] of Object.entries(groups).sort((a, b) => a[0] - b[0])) {
      html += `
        <div class="review-section">
          <h3>${levelLabels[level] || `Level ${level}`} (${words.length})</h3>
          <div class="word-cards">
            ${words.map(w => renderWordCard(w, true)).join('')}
          </div>
        </div>
      `;
    }

    container.innerHTML = html;
  } catch (e) {
    console.error(e);
  }
}

// ============ Library Tab ============
async function loadLibrary() {
  try {
    const search = document.getElementById('searchInput').value;
    const category = document.getElementById('categoryFilter').value;
    const is_learned = document.getElementById('learnedFilter').value;
    const batch_id = document.getElementById('batchFilter').value;
    const sort_by = document.getElementById('sortFilter').value;

    const params = new URLSearchParams({ page: libraryPage, limit: 30 });
    if (search) params.set('search', search);
    if (category) params.set('category', category);
    if (is_learned) params.set('is_learned', is_learned);
    if (batch_id) params.set('batch_id', batch_id);
    if (sort_by) params.set('sort_by', sort_by);

    const data = await api(`/api/words?${params}`);
    const container = document.getElementById('libraryList');

    if (data.words.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>未找到匹配的单词</p></div>';
      document.getElementById('libraryPagination').innerHTML = '';
      return;
    }

    container.innerHTML = data.words.map(w => `
      <div class="word-list-item ${w.is_learned ? 'is-learned' : ''}" onclick="openWordModal(${w.id})">
        <div class="wl-word">${escapeHtml(w.word)}</div>
        <div class="wl-chinese">${escapeHtml(w.chinese)}</div>
        <div class="wl-category"><span class="category-tag">${escapeHtml(w.category)}</span></div>
        <div class="wl-actions">
          ${renderMasteryDots(w.mastery_level)}
        </div>
      </div>
    `).join('');

    renderPagination(data, 'libraryPagination', 'libPageChange');
  } catch (e) { console.error(e); }
}

async function loadCategories() {
  try {
    const data = await api('/api/categories');
    const select = document.getElementById('categoryFilter');
    const currentVal = select.value;
    select.innerHTML = '<option value="">全部分类</option>' +
      data.categories.map(c => `<option value="${c}" ${c === currentVal ? 'selected' : ''}>${c}</option>`).join('');
  } catch (e) { console.error(e); }
}

async function loadBatchOptions() {
  try {
    const data = await api('/api/batches');
    const select = document.getElementById('batchFilter');
    const currentVal = select.value;
    const opts = data.batches.map(b => {
      const label = `${b.created_at.slice(0, 16)} (+${b.added_count})`;
      return `<option value="${b.id}" ${String(b.id) === currentVal ? 'selected' : ''}>${label}</option>`;
    }).join('');
    select.innerHTML = '<option value="">全部批次</option>' + opts;
  } catch (e) { console.error(e); }
}

function debounceSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    libraryPage = 1;
    loadLibrary();
  }, 300);
}

// ============ Stats Tab ============
async function loadStats() {
  try {
    const stats = await api('/api/stats');
    const container = document.getElementById('statsContent');

    const progress = stats.total > 0 ? Math.round((stats.learned / stats.total) * 100) : 0;

    let html = `
      <div class="stats-grid">
        <div class="stat-card highlight">
          <div class="stat-value">${progress}%</div>
          <div class="stat-label">总体进度</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.total}</div>
          <div class="stat-label">总词量</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.learned}</div>
          <div class="stat-label">已掌握</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.inProgress}</div>
          <div class="stat-label">学习中</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.notStarted}</div>
          <div class="stat-label">未开始</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.dueForReview}</div>
          <div class="stat-label">待复习</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.todayReviews}</div>
          <div class="stat-label">今日复习</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${stats.streakDays}</div>
          <div class="stat-label">连续学习天数</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${formatDuration(stats.todayStudySeconds || 0)}</div>
          <div class="stat-label">今日学习时长</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${formatDuration(stats.totalStudySeconds || 0)}</div>
          <div class="stat-label">累计学习时长</div>
        </div>
      </div>
    `;

    // 最近7天学习时长柱状图
    if (Array.isArray(stats.dailyStudyTime) && stats.dailyStudyTime.length > 0) {
      const maxSec = Math.max(...stats.dailyStudyTime.map(d => d.seconds), 1);
      html += `
        <div class="chart-section">
          <h3>最近7天学习时长</h3>
          <div class="bar-chart">
            ${stats.dailyStudyTime.map(d => {
              const h = Math.round((d.seconds / maxSec) * 90);
              const label = d.seconds > 0 ? formatDuration(d.seconds) : '0';
              return `
                <div class="bar-group">
                  <div class="bar-value">${label}</div>
                  <div class="bar-wrapper">
                    <div class="bar remembered" style="height:${h}px" title="${formatDuration(d.seconds)}"></div>
                  </div>
                  <div class="bar-label">${d.date.slice(5)}</div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }

    // 最近7天复习量柱状图
    if (stats.recentActivity.length > 0) {
      const maxTotal = Math.max(...stats.recentActivity.map(d => d.total), 1);
      html += `
        <div class="chart-section">
          <h3>最近7天学习情况</h3>
          <div class="bar-chart">
            ${stats.recentActivity.map(d => {
              const rh = Math.round((d.remembered / maxTotal) * 90);
              const fh = Math.round((d.forgotten / maxTotal) * 90);
              return `
                <div class="bar-group">
                  <div class="bar-value">${d.total}</div>
                  <div class="bar-wrapper">
                    <div class="bar forgotten" style="height:${fh}px" title="忘记 ${d.forgotten}"></div>
                    <div class="bar remembered" style="height:${rh}px" title="记住 ${d.remembered}"></div>
                  </div>
                  <div class="bar-label">${d.date.slice(5)}</div>
                </div>
              `;
            }).join('')}
          </div>
          <div style="display:flex;gap:16px;justify-content:center;margin-top:10px;font-size:0.75rem;color:var(--text-muted)">
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--success);border-radius:2px;margin-right:4px"></span>记住</span>
            <span><span style="display:inline-block;width:10px;height:10px;background:var(--danger);opacity:0.7;border-radius:2px;margin-right:4px"></span>忘记</span>
          </div>
        </div>
      `;
    }

    // 掌握等级分布
    if (stats.masteryDistribution.length > 0) {
      const levelLabels = ['新词', '1天', '2天', '4天', '7天', '15天', '30天'];
      const levelColors = ['#94a3b8', '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', '#14b8a6'];
      const maxCount = Math.max(...stats.masteryDistribution.map(d => d.count), 1);

      html += `
        <div class="chart-section">
          <h3>艾宾浩斯掌握等级分布</h3>
          <div class="mastery-bars">
            ${stats.masteryDistribution.map(d => `
              <div class="mastery-bar-row">
                <div class="mastery-bar-label">${levelLabels[d.mastery_level] || `Level ${d.mastery_level}`}</div>
                <div class="mastery-bar-track">
                  <div class="mastery-bar-fill" style="width:${Math.max(Math.round((d.count/maxCount)*100), 8)}%;background:${levelColors[d.mastery_level] || '#6366f1'}">
                    ${d.count}
                  </div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // 分类进度表
    if (stats.categoryDistribution.length > 0) {
      html += `
        <div class="chart-section">
          <h3>分类学习进度</h3>
          <table class="category-table">
            <thead><tr><th>分类</th><th>总数</th><th>已掌握</th><th>进度</th></tr></thead>
            <tbody>
              ${stats.categoryDistribution.map(c => {
                const pct = c.total > 0 ? Math.round((c.learned / c.total) * 100) : 0;
                return `
                  <tr>
                    <td><span class="category-tag">${escapeHtml(c.category)}</span></td>
                    <td>${c.total}</td>
                    <td>${c.learned}</td>
                    <td>
                      <div class="progress-mini"><div class="progress-mini-fill" style="width:${pct}%"></div></div>
                      <span style="font-size:0.75rem;color:var(--text-muted)">${pct}%</span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    container.innerHTML = html;
  } catch (e) { console.error(e); }
}

// ============ Add Word ============
async function addWordToPending(e) {
  e.preventDefault();
  const input = document.getElementById('pendingWordInput');
  const word = (input.value || '').trim();
  if (!word) return;
  await addToPending(word);
  input.value = '';
  input.focus();
}

// ============ Word Modal ============
async function openWordModal(id) {
  try {
    const w = await api(`/api/words/${id}`);
    const levelLabels = ['新词', '1天后复习', '2天后复习', '4天后复习', '7天后复习', '15天后复习', '30天后复习', '已掌握'];
    const intervals = [0, 1, 2, 4, 7, 15, 30];

    let html = `
      <div class="modal-header">
        <div class="word-title" onclick="speakWord('${escapeAttr(w.word)}')" title="🔊 点击听发音" style="cursor:pointer">${escapeHtml(w.word)} <span style="font-size:0.5em;opacity:0.6">🔊</span></div>
        <div class="word-phonetic">${escapeHtml(w.phonetic || '')}</div>
      </div>
      <div class="modal-body">
        <div class="modal-section">
          <div class="modal-section-title">中文释义</div>
          <div class="modal-section-content chinese">${escapeHtml(w.chinese)}</div>
        </div>

        ${w.examples && w.examples.length > 0 ? `
        <div class="modal-section">
          <div class="modal-section-title">AI论文例句 <span class="example-hint">点击英文查看中文翻译</span></div>
          <div class="examples-list">
            ${w.examples.map((ex, i) => `
              <div class="example-item" onclick="this.classList.toggle('revealed')">
                <div class="example-en" title="点击复制英文" onclick="copyExample(event, this, false)" data-copy="${escapeAttr(ex.en)}"><span class="example-num">${i+1}.</span> ${escapeHtml(ex.en)}</div>
                <div class="example-zh">${escapeHtml(ex.zh)}</div>
              </div>
            `).join('')}
          </div>
        </div>` : ''}

        ${w.synonyms && w.synonyms.length > 0 ? `
        <div class="modal-section">
          <div class="modal-section-title">近义词</div>
          <div class="synonym-tags">
            ${w.synonyms.map(s => `<span class="synonym-tag">${escapeHtml(s)}</span>`).join('')}
          </div>
        </div>` : ''}

        <div class="modal-section">
          <div class="modal-section-title">掌握状态</div>
          <div class="modal-mastery">
            <div class="modal-mastery-level">Lv.${w.mastery_level}</div>
            <div class="modal-mastery-info">
              <div>${levelLabels[w.mastery_level] || '进行中'}</div>
              <div>复习次数: ${w.review_count} 次</div>
              ${w.next_review_at ? `<div>下次复习: ${w.next_review_at}</div>` : ''}
              ${w.first_seen_at ? `<div>首次学习: ${w.first_seen_at}</div>` : '<div>尚未学习</div>'}
            </div>
            <div>
              ${renderMasteryDots(w.mastery_level)}
            </div>
          </div>
        </div>

        <div class="modal-section">
          <div class="modal-section-title">分类</div>
          <span class="category-tag">${escapeHtml(w.category)}</span>
        </div>

        ${w.history && w.history.length > 0 ? `
        <div class="modal-section">
          <div class="modal-section-title">复习历史</div>
          <div class="review-timeline">
            ${w.history.slice(0, 10).map(h => `
              <div class="review-timeline-item">
                <div class="review-dot ${h.result}"></div>
                <span>${h.reviewed_at}</span>
                <span>${h.result === 'remembered' ? '记住了' : '忘记了'}</span>
                <span>Lv.${h.mastery_before} → ${h.mastery_after}</span>
              </div>
            `).join('')}
          </div>
        </div>` : ''}

        <div class="modal-actions">
          ${!w.is_learned ? `
            <button class="btn btn-success" onclick="reviewWordAction(${w.id}, true)">记住了</button>
            <button class="btn btn-danger" onclick="reviewWordAction(${w.id}, false)">忘记了</button>
            <button class="btn btn-outline" onclick="markLearnedAction(${w.id})">已学会</button>
          ` : `
            <button class="btn btn-outline" onclick="unlearnAction(${w.id})">重新学习</button>
          `}
        </div>

        <div class="modal-section">
          <div class="modal-section-title" style="display:flex;align-items:center;justify-content:space-between">
            <span>拼写练习</span>
            <button class="btn btn-outline btn-sm" id="spellingToggleBtn" onclick="toggleSpellingPractice()">开始练习</button>
          </div>
          <div id="spellingPractice" style="display:none;margin-top:10px">
            <div style="display:flex;gap:8px">
              <input type="text" id="spellingInput" class="spelling-input" placeholder="输入单词…"
                autocomplete="off" autocapitalize="none" spellcheck="false"
                onkeydown="if(event.key==='Enter')checkSpelling('${escapeAttr(w.word)}')">
              <button class="btn btn-primary btn-sm" onclick="checkSpelling('${escapeAttr(w.word)}')">确认</button>
            </div>
            <div id="spellingResult" style="margin-top:8px;font-size:0.9rem;min-height:1.4em"></div>
          </div>
        </div>
      </div>
    `;

    document.getElementById('modalContent').innerHTML = html;
    document.getElementById('modalOverlay').classList.add('active');
    document.body.style.overflow = 'hidden';
  } catch (e) {
    showToast('加载单词详情失败', 'error');
  }
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('active');
  document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ============ Review Actions ============
async function removeFromCurrentBatch(id) {
  if (!flashcardState.sessionId) return;
  const idx = flashcardState.words.findIndex(w => w.id === id);
  if (idx === -1) return;
  try {
    await api(`/api/sessions/${flashcardState.sessionId}/words/${id}`, { method: 'DELETE' });
  } catch (_) {}
  flashcardState.words.splice(idx, 1);
  if (flashcardState.index >= flashcardState.words.length) {
    flashcardState.index = Math.max(0, flashcardState.words.length - 1);
  }
  const overlay = document.getElementById('flashcardOverlay');
  if (overlay && overlay.classList.contains('active')) {
    if (flashcardState.words.length === 0) {
      showToast('批次全部完成！', 'success');
      closeFlashcards();
      loadStudyTab();
    } else {
      flashcardState.flipped = false;
      renderFlashcard();
    }
  }
}

async function reviewWordAction(id, remembered) {
  try {
    const result = await api(`/api/words/${id}/review`, {
      method: 'POST',
      body: { remembered }
    });
    showToast(result.message, remembered ? 'success' : 'info');
    if (remembered) await removeFromCurrentBatch(id);
    closeModal();
    refreshCurrentTab();
    loadHeaderStats();
    loadDueBadge();
  } catch (e) {
    showToast('操作失败', 'error');
  }
}

async function markLearnedAction(id) {
  try {
    await api(`/api/words/${id}/learned`, { method: 'POST' });
    showToast('已标记为学会', 'success');
    await removeFromCurrentBatch(id);
    closeModal();
    refreshCurrentTab();
    loadHeaderStats();
    loadDueBadge();
  } catch (e) {
    showToast('操作失败', 'error');
  }
}

async function unlearnAction(id) {
  try {
    await api(`/api/words/${id}/unlearn`, { method: 'POST' });
    showToast('已重新加入学习', 'info');
    closeModal();
    refreshCurrentTab();
    loadHeaderStats();
    loadDueBadge();
  } catch (e) {
    showToast('操作失败', 'error');
  }
}

// ============ Render Helpers ============
function renderWordCard(w, showReviewBtns = false) {
  const levelClass = w.is_learned ? 'learned' : `mastery-${w.mastery_level}`;
  return `
    <div class="word-card ${levelClass}" onclick="openWordModal(${w.id})">
      <div class="word-speak-btn" onclick="event.stopPropagation(); speakWord('${escapeAttr(w.word)}')" title="🔊 听发音">🔊</div>
      <div class="word-title">${escapeHtml(w.word)}</div>
      <div class="word-meta">
        ${renderMasteryDots(w.mastery_level)}
      </div>
      ${showReviewBtns ? `
        <div class="card-review-btns" onclick="event.stopPropagation()">
          <button class="btn btn-success btn-sm" style="flex:1" onclick="reviewWordAction(${w.id}, true)">记住了</button>
          <button class="btn btn-danger btn-sm" style="flex:1" onclick="reviewWordAction(${w.id}, false)">忘记了</button>
        </div>
      ` : ''}
    </div>
  `;
}

function renderMasteryDots(level) {
  let dots = '';
  for (let i = 0; i < 7; i++) {
    const filled = i < level;
    let colorClass = '';
    if (filled) {
      if (i < 2) colorClass = 'low';
      else if (i < 4) colorClass = 'mid';
      else colorClass = 'high';
    }
    dots += `<div class="mastery-dot ${filled ? 'filled' : ''} ${colorClass}"></div>`;
  }
  return `<div class="mastery-indicator">${dots}</div>`;
}

function renderPagination(data, containerId, callbackName) {
  const container = document.getElementById(containerId);
  if (data.totalPages <= 1) { container.innerHTML = ''; return; }

  let html = '';
  html += `<button ${data.page <= 1 ? 'disabled' : ''} onclick="${callbackName}(${data.page - 1})">上一页</button>`;

  const start = Math.max(1, data.page - 2);
  const end = Math.min(data.totalPages, data.page + 2);

  if (start > 1) {
    html += `<button onclick="${callbackName}(1)">1</button>`;
    if (start > 2) html += '<button disabled>...</button>';
  }
  for (let i = start; i <= end; i++) {
    html += `<button class="${i === data.page ? 'active' : ''}" onclick="${callbackName}(${i})">${i}</button>`;
  }
  if (end < data.totalPages) {
    if (end < data.totalPages - 1) html += '<button disabled>...</button>';
    html += `<button onclick="${callbackName}(${data.totalPages})">${data.totalPages}</button>`;
  }

  html += `<button ${data.page >= data.totalPages ? 'disabled' : ''} onclick="${callbackName}(${data.page + 1})">下一页</button>`;

  container.innerHTML = html;
}

function refreshCurrentTab() {
  switch (currentTab) {
    case 'study': loadStudyTab(); break;
    case 'review': loadReviewTab(); break;
    case 'library': loadLibrary(); break;
    case 'stats': loadStats(); break;
  }
}

// ============ Notifications ============
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function showNotification(title, body) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title, { body, icon: '📖' });
  }
}

let lastCheckHour = -1;
function checkScheduledPush() {
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const pushHours = [8, 12, 18, 20];

  if (pushHours.includes(hour) && minute === 0 && lastCheckHour !== hour) {
    lastCheckHour = hour;
    showNotification('AI Vocab 学习时间', '新一批学习单词已准备好，快来学习吧！');
    if (currentTab === 'study') loadStudyTab();
    loadDueBadge();
    loadHeaderStats();
  }
}

// ============ API Helper ============
async function api(url, options = {}) {
  const config = {
    headers: { 'Content-Type': 'application/json' },
    ...options
  };
  if (config.body && typeof config.body === 'object') {
    config.body = JSON.stringify(config.body);
  }
  const res = await fetch(url, config);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

// ============ Toast ============
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(20px)';
    toast.style.transition = 'all 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============ Copy ============
async function copyExample(ev, el, stopBubble) {
  if (stopBubble) ev.stopPropagation();
  const text = el.getAttribute('data-copy') || el.innerText.replace(/^\s*\d+\.\s*/, '');
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    el.classList.add('copied');
    setTimeout(() => el.classList.remove('copied'), 600);
    showToast('已复制英文例句', 'success');
  } catch (e) {
    showToast('复制失败', 'error');
  }
}

// ============ Long Press & Context Menu ============
let lpTimer = null;
let lpStartX = 0, lpStartY = 0;
let contextMenuWord = '';

document.addEventListener('mousedown', lpStart);
document.addEventListener('touchstart', lpStart, { passive: true });
document.addEventListener('mouseup', lpCancel);
document.addEventListener('touchend', lpCancel);
document.addEventListener('mousemove', (e) => {
  if (Math.abs(e.clientX - lpStartX) > 8 || Math.abs(e.clientY - lpStartY) > 8) lpCancel();
});
document.addEventListener('touchmove', lpCancel, { passive: true });
document.addEventListener('click', (e) => {
  if (!e.target.closest('#wordContextMenu')) hideContextMenu();
});

function lpStart(e) {
  const pt = e.touches ? e.touches[0] : e;
  lpStartX = pt.clientX;
  lpStartY = pt.clientY;
  clearTimeout(lpTimer);
  lpTimer = setTimeout(() => {
    const word = getWordAtPoint(lpStartX, lpStartY);
    if (word) {
      contextMenuWord = word;
      showContextMenu(lpStartX, lpStartY, word);
    }
  }, 500);
}

function lpCancel() { clearTimeout(lpTimer); }

function getWordAtPoint(x, y) {
  let range;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos) return null;
    range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
  }
  if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return null;

  const text = range.startContainer.textContent;
  const offset = range.startOffset;
  let start = offset, end = offset;
  while (start > 0 && /[a-zA-Z\-]/.test(text[start - 1])) start--;
  while (end < text.length && /[a-zA-Z\-]/.test(text[end])) end++;
  const word = text.slice(start, end);
  return word.length >= 2 ? word : null;
}

function showContextMenu(x, y, word) {
  const menu = document.getElementById('wordContextMenu');
  document.getElementById('wcmWord').textContent = word;
  menu.style.left = '0px';
  menu.style.top = '0px';
  menu.classList.add('active');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = x + 12, top = y + 12;
  if (left + mw > vw - 8) left = x - mw - 12;
  if (top + mh > vh - 8) top = y - mh - 12;
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
}

function hideContextMenu() {
  document.getElementById('wordContextMenu').classList.remove('active');
}

function contextMenuSearch(engine) {
  hideContextMenu();
  const q = encodeURIComponent(contextMenuWord);
  const url = engine === 'google'
    ? `https://www.google.com/search?q=${q}`
    : `https://www.baidu.com/s?wd=${q}`;
  window.open(url, '_blank', 'noopener');
}

function contextMenuAddPending() {
  hideContextMenu();
  addToPending(contextMenuWord);
}

// ============ Pending Words ============
async function addToPending(word) {
  try {
    await api('/api/pending', { method: 'POST', body: { word } });
    showToast(`"${word}" 已加入待添加词库`, 'success');
    if (currentTab === 'add') renderPendingWords();
  } catch (e) {
    showToast(e.message || '加入失败', 'error');
  }
}

async function removeFromPending(id) {
  try {
    await api(`/api/pending/${id}`, { method: 'DELETE' });
    renderPendingWords();
  } catch (e) {
    showToast('删除失败', 'error');
  }
}

async function savePendingNote(id, note) {
  try {
    await api(`/api/pending/${id}`, { method: 'PATCH', body: { note } });
  } catch (e) {
    showToast('保存备注失败', 'error');
  }
}

async function fillAddFormFromPending(word, id) {
  const input = document.getElementById('pendingWordInput');
  if (input) {
    input.value = word;
    input.focus();
  }
  await removeFromPending(id);
}

async function renderPendingWords() {
  const badge = document.getElementById('pendingBadge');
  const list = document.getElementById('pendingList');
  if (!badge || !list) return;
  try {
    const data = await api('/api/pending');
    const words = data.words;
    if (words.length > 0) {
      badge.textContent = words.length;
      badge.style.display = 'inline-flex';
    } else {
      badge.style.display = 'none';
    }
    list.innerHTML = words.length === 0
      ? '<p class="pending-empty">输入单词或长按例句中的词可加入此列表</p>'
      : words.map(w => `
        <div class="pending-word-item" data-id="${w.id}">
          <div class="pending-word-main">
            <span class="pending-word-text">${escapeHtml(w.word)}</span>
            <span class="pending-word-date">${w.added_at.slice(0, 16)}</span>
          </div>
          <input class="pending-note-input" type="text" placeholder="备注（可选）" value="${escapeAttr(w.note || '')}"
            onblur="savePendingNote(${w.id}, this.value)"
            onkeydown="if(event.key==='Enter'){this.blur()}">
          <div class="pending-word-actions">
            <button class="btn btn-primary btn-sm" onclick="fillAddFormFromPending('${escapeAttr(w.word)}', ${w.id})">填入输入框</button>
            <button class="btn btn-outline btn-sm" onclick="removeFromPending(${w.id})">移除</button>
          </div>
        </div>`).join('');
  } catch (e) {
    list.innerHTML = '<p class="pending-empty">加载失败，请刷新重试</p>';
  }
}

// ============ 一键补全并入库 ============
async function enrichPending() {
  const btn = document.getElementById('enrichBtn');
  const status = document.getElementById('enrichStatus');
  if (!btn || btn.disabled) return;

  // 先确认 pending 非空
  try {
    const p = await api('/api/pending');
    if (!p.words || p.words.length === 0) {
      showToast('待添加词库为空', 'info');
      return;
    }
    if (!confirm(`将对 ${p.words.length} 个待添加单词进行 AI 补全并入库（已存在的词会跳过），确定继续？`)) return;
  } catch (e) { return; }

  btn.disabled = true;
  status.textContent = '正在补全… 这可能需要一会儿';
  try {
    const result = await api('/api/pending/enrich', { method: 'POST', body: { concurrency: 3 } });
    if (!result.batch) {
      status.textContent = result.message || '已完成';
    } else {
      const b = result.batch;
      status.textContent = `批次 #${b.id}：新增 ${b.added_count}，跳过 ${b.skipped_count}，失败 ${b.failed_count}`;
      showToast(`补全完成：新增 ${b.added_count}，跳过 ${b.skipped_count}，失败 ${b.failed_count}`, 'success');
    }
    await renderPendingWords();
    await renderBatchHistory();
  } catch (e) {
    status.textContent = '补全失败：' + (e.message || e);
    showToast('补全失败', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function renderBatchHistory() {
  const container = document.getElementById('batchList');
  if (!container) return;
  try {
    const data = await api('/api/batches');
    if (!data.batches || data.batches.length === 0) {
      container.innerHTML = '<p class="pending-empty">还没有补全批次</p>';
      return;
    }
    container.innerHTML = data.batches.map(b => `
      <div class="batch-item" data-id="${b.id}">
        <div class="batch-summary" onclick="toggleBatchDetail(${b.id})" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;padding:10px 12px;border:1px solid #eee;border-radius:6px;margin-bottom:8px">
          <div>
            <strong>批次 #${b.id}</strong>
            <span style="color:#888;margin-left:8px;font-size:13px">${b.created_at}</span>
          </div>
          <div style="font-size:13px;color:#555">
            新增 <strong>${b.added_count}</strong> · 跳过 ${b.skipped_count} · 失败 ${b.failed_count}
          </div>
        </div>
        <div class="batch-detail" id="batchDetail-${b.id}" style="display:none;padding:8px 12px 12px;border:1px solid #eee;border-top:none;border-radius:0 0 6px 6px;margin-top:-8px;margin-bottom:8px"></div>
      </div>
    `).join('');
  } catch (e) {
    container.innerHTML = '<p class="pending-empty">加载失败</p>';
  }
}

async function toggleBatchDetail(id) {
  const el = document.getElementById(`batchDetail-${id}`);
  if (!el) return;
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  el.style.display = 'block';
  el.innerHTML = '加载中…';
  try {
    const data = await api(`/api/batches/${id}`);
    const items = data.batch.items || [];
    if (items.length === 0) {
      el.innerHTML = '<span style="color:#888">无明细</span>';
      return;
    }
    el.innerHTML = items.map(it => {
      const color = it.status === 'added' ? '#1f9d55' : it.status === 'skipped' ? '#888' : '#d93025';
      const label = it.status === 'added' ? '新增' : it.status === 'skipped' ? '跳过' : '失败';
      const errorText = it.error ? ` <span style="color:#d93025">— ${escapeHtml(it.error)}</span>` : '';
      const link = it.word_id
        ? ` <a href="javascript:openWordModal(${it.word_id})" style="font-size:12px">查看</a>`
        : '';
      return `<div style="padding:4px 0;border-bottom:1px dashed #f0f0f0;font-size:13px">
        <span style="color:${color};font-weight:600;display:inline-block;width:40px">${label}</span>
        <span>${escapeHtml(it.word)}</span>${link}${errorText}
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = '<span style="color:#d93025">加载失败</span>';
  }
}

// ============ Spelling Practice ============
function toggleSpellingPractice() {
  const section = document.getElementById('spellingPractice');
  const btn = document.getElementById('spellingToggleBtn');
  const show = section.style.display === 'none';
  section.style.display = show ? 'block' : 'none';
  btn.textContent = show ? '收起' : '开始练习';
  if (show) {
    const input = document.getElementById('spellingInput');
    input.value = '';
    input.style.borderColor = '';
    document.getElementById('spellingResult').innerHTML = '';
    input.focus();
  }
}

function checkSpelling(word) {
  const input = document.getElementById('spellingInput');
  const result = document.getElementById('spellingResult');
  const typed = input.value.trim().toLowerCase();
  if (!typed) return;
  if (typed === word.toLowerCase()) {
    result.innerHTML = '<span style="color:var(--success)">✓ 正确！</span>';
    input.style.borderColor = 'var(--success)';
  } else {
    result.innerHTML = `<span style="color:var(--danger)">✗ 不对，正确答案：<strong>${escapeHtml(word)}</strong></span>`;
    input.style.borderColor = 'var(--danger)';
  }
  input.select();
}

// Flashcard spelling practice
function toggleFcSpelling() {
  const section = document.getElementById('fcSpellingSection');
  const btn = document.getElementById('fcSpellingToggleBtn');
  const show = section.style.display === 'none';
  section.style.display = show ? 'flex' : 'none';
  btn.classList.toggle('active', show);
  if (show) {
    resetFcSpelling();
    document.getElementById('fcSpellingInput').focus();
  }
}

function resetFcSpelling() {
  const input = document.getElementById('fcSpellingInput');
  if (!input) return;
  input.value = '';
  input.style.borderColor = '';
  document.getElementById('fcSpellingResult').innerHTML = '';
}

function checkFcSpelling() {
  const w = flashcardState.words[flashcardState.index];
  if (!w) return;
  const input = document.getElementById('fcSpellingInput');
  const result = document.getElementById('fcSpellingResult');
  const typed = input.value.trim().toLowerCase();
  if (!typed) return;
  if (typed === w.word.toLowerCase()) {
    result.innerHTML = '<span style="color:var(--success)">✓ 正确！</span>';
    input.style.borderColor = 'var(--success)';
  } else {
    result.innerHTML = `<span style="color:var(--danger)">✗ 不对，正确答案：<strong>${escapeHtml(w.word)}</strong></span>`;
    input.style.borderColor = 'var(--danger)';
  }
  input.select();
}

// ============ Utils ============
function formatDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60 ? (s % 60) + '秒' : ''}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}时${rm}分` : `${h}时`;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Pagination callback needs to be global
window.libPageChange = function(page) {
  libraryPage = page;
  loadLibrary();
};
