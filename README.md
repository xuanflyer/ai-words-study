# AI 论文词汇学习系统

面向 AI/ML 论文阅读场景的英语词汇记忆工具，基于**艾宾浩斯遗忘曲线**实现智能复习调度。

## 主要功能

- **词库管理**：内置 AI 论文高频词汇，支持按分类/掌握程度筛选、搜索、手动添加/删除
- **艾宾浩斯复习**：8 级掌握体系（Level 0~7），复习间隔为 0→1→2→4→7→15→30 天；答错时退级，答对时晋级
- **智能批次调度**：基于遗忘率模型（SM-2 启发的 urgency 评分）动态选词，70% 复习词 + 30% 新词拉链交错
- **定时推送**：每天 08:00 / 12:00 / 18:00 / 20:00 自动生成学习批次（Asia/Shanghai）
- **学习会话**：记录每次学习批次，支持手动触发和完成标记
- **统计看板**：掌握度分布、分类进度、最近 7 天复习量、连续学习天数

## 快速开始

```bash
npm install
npm start          # 生产模式
npm run dev        # 文件监听模式（开发用）
```

服务默认运行在 `http://localhost:3000`，通过 `PORT` 环境变量可自定义端口。

### 日志级别

通过 `LOG_LEVEL` 环境变量控制输出粒度（默认 `info`）：

```bash
LOG_LEVEL=debug npm start   # 输出 DB 写入等详细信息
LOG_LEVEL=warn  npm start   # 只输出警告和错误
```

## 技术栈

| 层 | 技术 |
|---|---|
| Web 框架 | Express 4 |
| 数据库 | SQLite（better-sqlite3，WAL 模式） |
| 定时任务 | node-cron |
| 运行时 | Node.js |

## 数据模型

### `words` — 词汇表

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | INTEGER PK | 自增主键 |
| `word` | TEXT UNIQUE | 单词（不区分大小写） |
| `phonetic` | TEXT | 音标 |
| `chinese` | TEXT | 中文释义 |
| `category` | TEXT | 分类（默认"未分类"） |
| `examples` | TEXT | 例句列表（JSON） |
| `synonyms` | TEXT | 同义词列表（JSON） |
| `mastery_level` | INTEGER | 掌握等级 0~7 |
| `review_count` | INTEGER | 总复习次数 |
| `first_seen_at` | TEXT | 首次出现时间 |
| `last_reviewed_at` | TEXT | 上次复习时间 |
| `next_review_at` | TEXT | 下次复习时间 |
| `is_learned` | INTEGER | 是否已掌握（0/1） |

### `review_history` — 复习记录

| 字段 | 说明 |
|---|---|
| `word_id` | 关联单词 |
| `reviewed_at` | 复习时间 |
| `result` | `remembered` \| `forgotten` |
| `mastery_before/after` | 等级变化 |

### `study_sessions` — 学习会话

| 字段 | 说明 |
|---|---|
| `scheduled_time` | 计划时间（如 "08:00"） |
| `word_ids` | 单词 ID 列表（JSON） |
| `completed` | 是否完成（0/1） |

## API 列表

### 词汇

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/words` | 获取词汇列表（分页+筛选） |
| `GET` | `/api/words/:id` | 获取单词详情（含复习历史） |
| `POST` | `/api/words` | 添加新单词 |
| `DELETE` | `/api/words/:id` | 删除单词 |

#### `GET /api/words` 查询参数

| 参数 | 说明 | 示例 |
|---|---|---|
| `category` | 按分类筛选 | `?category=模型架构` |
| `is_learned` | 是否已学会 | `?is_learned=false` |
| `search` | 搜索单词/释义 | `?search=attention` |
| `page` | 页码（默认 1） | `?page=2` |
| `limit` | 每页条数（默认 50） | `?limit=20` |

#### `POST /api/words` 请求体

```json
{
  "word": "attention",
  "phonetic": "/əˈtenʃən/",
  "chinese": "注意力机制",
  "category": "模型架构",
  "examples": ["Self-attention is the core of Transformer."],
  "synonyms": ["focus"]
}
```

> `word` 和 `chinese` 为必填项。

---

### 复习（艾宾浩斯）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/words/:id/review` | 提交复习结果（记住/忘记） |
| `POST` | `/api/words/:id/learned` | 标记为已学会（直接升至 Level 7） |
| `POST` | `/api/words/:id/unlearn` | 取消已学会，重新加入学习 |
| `GET` | `/api/review/due` | 获取当前到期待复习单词 |

#### `POST /api/words/:id/review` 请求体

```json
{ "remembered": true }
```

#### `GET /api/review/due` 查询参数

| 参数 | 说明 | 默认 |
|---|---|---|
| `limit` | 返回条数 | 10 |

---

### 学习会话

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/sessions/generate` | 手动生成智能学习批次 |
| `GET` | `/api/sessions/latest` | 获取最新一次会话 |
| `GET` | `/api/sessions/today` | 获取今日所有会话 |
| `POST` | `/api/sessions/:id/complete` | 标记会话为已完成 |

#### `POST /api/sessions/generate` 请求体

```json
{ "size": 10 }
```

---

### 统计与配置

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/stats` | 整体学习统计 |
| `GET` | `/api/history` | 复习历史（分页） |
| `GET` | `/api/categories` | 所有单词分类列表 |
| `GET` | `/api/ebbinghaus` | 艾宾浩斯间隔配置说明 |

#### `GET /api/stats` 返回字段

```json
{
  "total": 500,
  "learned": 42,
  "inProgress": 120,
  "notStarted": 338,
  "dueForReview": 15,
  "todayReviews": 30,
  "streakDays": 7,
  "masteryDistribution": [{ "mastery_level": 1, "count": 20 }],
  "categoryDistribution": [{ "category": "模型架构", "total": 80, "learned": 5 }],
  "recentActivity": [{ "date": "2026-04-21", "total": 30, "remembered": 24, "forgotten": 6 }]
}
```

---

## 词库数据

词汇数据位于 `data/vocabulary.json`，格式：

```json
[
  {
    "word": "transformer",
    "phonetic": "/trænsˈfɔːrmər/",
    "chinese": "变换器，Transformer 模型",
    "category": "模型架构",
    "examples": ["The Transformer model relies entirely on self-attention."],
    "synonyms": []
  }
]
```

启动时自动导入（已存在的词条跳过，不重复写入）。

## 项目结构

```
ai-words-study/
├── server.js          # Express 服务 + API 路由 + cron 定时任务
├── db.js              # SQLite 数据层（VocabDB 类）
├── logger.js          # 轻量结构化日志（无外部依赖）
├── data/
│   └── vocabulary.json   # 初始词库
├── public/            # 前端静态文件（SPA）
│   ├── index.html
│   ├── css/
│   └── js/
└── vocab.db           # SQLite 数据库文件（运行后自动生成）
```
