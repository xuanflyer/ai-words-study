# 儿童识字模块实现计划

## Context
在现有英语词汇学习 App 基础上，新增一个独立的儿童学习子模块。本期只做"识字"板块，面向4岁儿童，核心设计原则：趣味性优先、语音驱动、图文并茂、艾宾浩斯记忆曲线。

---

## 架构决策

- **独立页面**：`/kids` 路由 → `public/kids.html`，与成人词汇模块完全隔离，UI 风格截然不同（大字体、高饱和色、动画）
- **共用数据库**：在 `vocab.db` 中新增 kids 专属表，通过扩展现有 `VocabDB` 类实现（避免多连接问题）
- **语音**：使用浏览器内置 Web Speech API（`SpeechSynthesis`），`lang: 'zh-CN'`，无需外部依赖
- **图片**：使用 Emoji，无需图床

---

## 文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `data/kids_chars.json` | 新建 | 50个汉字数据（拼音、分类、组词、配图） |
| `db.js` | 修改 | VocabDB 新增 kids 表初始化 + 所有 kids 方法 |
| `server.js` | 修改 | 新增 `/api/kids/*` 路由 + `/kids` 页面路由 |
| `public/kids.html` | 新建 | 儿童模块 SPA 主页面 |
| `public/css/kids.css` | 新建 | 儿童专属样式 |
| `public/js/kids.js` | 新建 | 儿童模块前端逻辑 |
| `public/index.html` | 修改 | 顶部导航加入"儿童学习"入口按钮 |

---

## 数据库扩展（db.js）

### 新增表

```sql
-- 汉字库
CREATE TABLE kids_chars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  char TEXT NOT NULL UNIQUE,
  pinyin TEXT NOT NULL,
  category TEXT DEFAULT '基础',
  difficulty INTEGER DEFAULT 1,
  frequency INTEGER DEFAULT 5,
  components TEXT DEFAULT '[]',   -- [{word,pinyin,desc}] × 3
  images TEXT DEFAULT '[]',       -- [{emoji,desc}] × 2
  mastery_level INTEGER DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  first_seen_at TEXT,
  last_reviewed_at TEXT,
  next_review_at TEXT,
  is_learned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- 复习历史
CREATE TABLE kids_char_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  char_id INTEGER NOT NULL,
  reviewed_at TEXT DEFAULT (datetime('now','localtime')),
  result TEXT NOT NULL CHECK(result IN ('known','unknown')),
  mastery_before INTEGER,
  mastery_after INTEGER,
  FOREIGN KEY (char_id) REFERENCES kids_chars(id) ON DELETE CASCADE
);

-- 学习会话
CREATE TABLE kids_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  char_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  completed INTEGER DEFAULT 0,
  completed_at TEXT
);
```

### 儿童艾宾浩斯间隔（比成人更密集）
```js
KIDS_REVIEW_INTERVALS = [0, 0.17, 1, 3, 7, 14, 30]
// Level 0: 新字
// Level 1: 4小时后（当天巩固）
// Level 2: 1天
// Level 3: 3天
// Level 4: 7天
// Level 5: 14天
// Level 6: 30天
// Level 7: 已掌握
```

### VocabDB 新增方法
- `initKids()` — 建表，从 `init()` 调用
- `seedKidsChars()` — 导入 kids_chars.json
- `getKidsChars({category, is_learned, sort_by})` — 字库列表
- `getKidsChar(id)` — 单字详情
- `reviewKidsChar(id, known)` — 记录复习，更新 mastery
- `generateKidsSession()` — 生成批次（≤5字，≤2新字，检查当日≤2次）
- `getTodayKidsSessions()` — 今日会话
- `createKidsSession(charIds)` — 创建会话
- `completeKidsSession(id)` — 完成会话
- `getKidsStats()` — 统计数据（总字数、已学、连续天数、正确率、日/周/月数据）

---

## API 路由（server.js）

```
GET  /kids                          → 返回 kids.html
GET  /api/kids/chars                → 字库列表（支持 category/is_learned/sort_by）
GET  /api/kids/chars/:id            → 单字详情
POST /api/kids/chars/:id/review     → 复习 {known: boolean}
POST /api/kids/sessions/generate    → 生成学习批次
GET  /api/kids/sessions/today       → 今日会话
POST /api/kids/sessions/:id/complete → 完成会话
GET  /api/kids/stats                → 统计数据
```

---

## 50个汉字库

| 分类 | 汉字 | 数量 |
|------|------|------|
| 数字 | 一二三四五六七八九十 | 10 |
| 人物 | 人大小男女爸妈我你他 | 10 |
| 自然 | 日月水火山木土天地云雨 | 11 |
| 动物 | 牛羊马鱼鸟猫狗 | 7 |
| 身体 | 手口耳目足头 | 6 |
| 生活 | 门车书米田家 | 6 |

---

## 前端（kids.html / kids.js / kids.css）

### 4个视图（底部 Tab 导航）
1. **首页** — 今日进度、开始学习按钮、连续打卡天数
2. **学习** — 全屏沉浸式卡片学习
3. **字库** — 字库浏览（筛选+排序）
4. **统计** — 学习数据展示

### 学习卡片流程
1. 进入全屏模式
2. 顶部进度条（X/5）
3. 大字显示（200px，动画入场）
4. 自动播放读音（0.5s 延迟）
5. 拼音显示
6. 2张配图卡（emoji + 文字说明，点击可听说明读音）
7. 3个组词（点击可听读音）
8. 底部：「认识 ✓」「不认识 ✗」按钮（点击有语音反馈）
9. 完成后：星星动画 + 鼓励语音

### 语音设计
- 读字：直接读汉字
- 读拼音：读拼音字符串
- 读组词：读词语 + 停顿 + 读例句
- 认识反馈：「太棒了！」
- 不认识反馈：「没关系，我们再学一遍！」
- 完成反馈：「你真棒！今天学了X个字！」

### 学习提示（轮播）
- 「跟着读一读！」
- 「看看图片，想想这个字！」
- 「你认识这个字吗？」

### 儿童 UI 风格
- 背景：渐变（`#667eea → #764ba2`）
- 卡片：白色圆角（24px），大阴影
- 主字体：200px，`font-weight: 900`，彩色渐变文字
- 按钮：超大（80px 高），圆角，鲜艳色
- 动画：弹跳入场、星星飞散、进度条动画
- 无小字，所有文字 ≥ 18px

### 字库页
- 网格布局（每行4个）
- 每格：大字 + 拼音 + 掌握度星星（0-5颗）
- 筛选：分类、已学/未学
- 排序：最近学习、掌握度、学习次数、正确率

### 统计页
- 总览卡片：已学字数、连续天数、总正确率
- 按日/周/月切换的学习量柱状图（CSS 实现）
- 分类掌握情况

---

## 会话限制逻辑
- 每天最多2次学习
- 每次最多5个字（最多2个新字 + 最多3个复习字）
- 两次学习间隔 ≥ 4小时
- 若已达上限，首页显示「今天学习完成啦！明天再来！」

---

## 验证方式
1. 启动服务器 `node server.js`
2. 访问 `http://localhost:3000` → 点击「儿童学习」入口
3. 访问 `http://localhost:3000/kids`
4. 点击「开始学习」→ 验证卡片显示、语音播放、按钮反馈
5. 完成一次学习 → 验证统计更新
6. 访问字库页 → 验证筛选排序
7. 访问统计页 → 验证数据展示
