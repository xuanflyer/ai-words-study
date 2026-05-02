#!/usr/bin/env node
// 将 pending_words 全部通过 enrich.js 补全后写入正式词库 words。
// 用法:
//   node scripts/enrich_pending.js
//   node scripts/enrich_pending.js --concurrency 2
//   node scripts/enrich_pending.js --model haiku

const path = require('path');
const { VocabDB } = require('../db');
const { enrichBatch } = require('../enrich');

const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
}
const CONCURRENCY = Math.max(1, Math.min(parseInt(getArg('--concurrency', '3'), 10), 5));
const MODEL = getArg('--model', 'haiku');

const DB_PATH = path.join(__dirname, '..', 'vocab.db');
const db = new VocabDB(DB_PATH);

(async () => {
  const pending = db.getPendingWords();
  if (pending.length === 0) {
    console.log('待添加词库为空，无需处理。');
    db.close();
    return;
  }

  console.log(`待处理: ${pending.length} 个词 (concurrency=${CONCURRENCY}, model=${MODEL})`);

  const batchId = db.createEnrichmentBatch();

  const toEnrich = [];
  for (const p of pending) {
    const existingId = db.wordExists(p.word);
    if (existingId) {
      console.log(`[跳过] "${p.word}" 已存在 (id=${existingId})`);
      db.recordBatchItem(batchId, { word: p.word, status: 'skipped', word_id: existingId });
      db.deletePendingByWord(p.word);
    } else {
      toEnrich.push(p.word);
    }
  }

  console.log(`需要补全: ${toEnrich.length} 个，已跳过: ${pending.length - toEnrich.length} 个\n`);

  let done = 0;
  await enrichBatch(toEnrich, {
    concurrency: CONCURRENCY,
    model: MODEL,
    onItem: (item) => {
      done++;
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
          const status = r.inserted ? 'added' : 'skipped';
          db.recordBatchItem(batchId, { word: item.word, status, word_id: r.id });
          db.deletePendingByWord(item.word);
          console.log(`[${done}/${toEnrich.length}] ✓ ${item.word} → ${item.data.chinese} [${status}]`);
        } catch (e) {
          db.recordBatchItem(batchId, { word: item.word, status: 'failed', error: e.message });
          console.error(`[${done}/${toEnrich.length}] ✗ ${item.word} 入库失败: ${e.message}`);
        }
      } else {
        db.recordBatchItem(batchId, { word: item.word, status: 'failed', error: item.error });
        console.error(`[${done}/${toEnrich.length}] ✗ ${item.word} 补全失败: ${item.error}`);
      }
    }
  });

  db.finalizeBatch(batchId);
  const batch = db.getEnrichmentBatch(batchId);

  console.log(`\n完成 (batchId=${batchId}):`);
  console.log(`  新增: ${batch.added_count}`);
  console.log(`  跳过: ${batch.skipped_count}`);
  console.log(`  失败: ${batch.failed_count}`);

  const remaining = db.getPendingWords();
  if (remaining.length > 0) {
    console.log(`\n仍在待添加列表中 (失败项): ${remaining.map(p => p.word).join(', ')}`);
  }

  db.close();
})();
