#!/usr/bin/env node
// 批量为 vocabulary.json 里只有 1 条且缺少中文翻译的词条补全 3 条例句 + 中文。
// 通过 `claude -p --model haiku` 调用，增量写回，可随时中断恢复。
//
// 用法:
//   node scripts/enrich_vocab.js            # 全量补全
//   node scripts/enrich_vocab.js --limit 20 # 只处理前 20 个
//   node scripts/enrich_vocab.js --concurrency 4
//
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const JSON_PATH = path.join(__dirname, '..', 'data', 'vocabulary.json');
const LOCK_PATH = JSON_PATH + '.lock';

const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
}
const LIMIT = parseInt(getArg('--limit', '0'), 10) || Infinity;
const CONCURRENCY = parseInt(getArg('--concurrency', '3'), 10);
const MODEL = getArg('--model', 'haiku');

function loadVocab() {
  return JSON.parse(fs.readFileSync(JSON_PATH, 'utf-8'));
}

function atomicWrite(data) {
  // 串行化写入 —— 防止并行 worker 互相覆盖
  while (fs.existsSync(LOCK_PATH)) {
    // busy wait very briefly; Node has no sync sleep, use deasync-ish trick
    const until = Date.now() + 50;
    while (Date.now() < until) {}
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  try {
    const tmp = JSON_PATH + '.tmp';
    // 保留原始的一行一词格式
    const lines = ['[\n'];
    data.forEach((w, i) => {
      const end = i < data.length - 1 ? ',' : '';
      lines.push('  ' + JSON.stringify(w, null, 0) + end + '\n');
    });
    lines.push(']\n');
    fs.writeFileSync(tmp, lines.join(''));
    fs.renameSync(tmp, JSON_PATH);
  } finally {
    try { fs.unlinkSync(LOCK_PATH); } catch (_) {}
  }
}

function needsUpdate(w) {
  const exs = w.examples || [];
  if (exs.length < 3) return true;
  return exs.some(ex => !(ex.zh || '').trim());
}

function buildPrompt(word) {
  const firstEn = (word.examples && word.examples[0] && word.examples[0].en) || '';
  return `你是一个英语词汇教师，为 AI/ML/金融 领域论文词汇生成学习例句。

单词: ${word.word}
中文释义: ${word.chinese}
分类: ${word.category}
已有英文例句 (可保留或替换): ${firstEn || '(无)'}

请输出严格的 JSON（不要 markdown 代码块，不要多余文字），格式:
{"examples":[{"en":"...","zh":"..."},{"en":"...","zh":"..."},{"en":"...","zh":"..."}]}

要求:
1. 恰好 3 条例句，每条包含英文 (en) 与中文翻译 (zh)
2. 例句必须来自 ${word.category} 或相关 AI 论文语境，自然地道
3. 3 条例句场景不同、用法多样，避免重复
4. 英文长度 12~30 词之间
5. 中文翻译准确、简洁、符合中文表达习惯
6. 只输出 JSON，任何其他字符都不要`;
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', MODEL, '--output-format=json'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err}`));
      try {
        const envelope = JSON.parse(out);
        let result = envelope.result || '';
        // 脱掉可能的 ```json fences
        result = result.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
        const data = JSON.parse(result);
        resolve(data);
      } catch (e) {
        reject(new Error(`parse failed: ${e.message}\nraw: ${out.slice(0, 400)}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function enrichOne(wordObj) {
  const prompt = buildPrompt(wordObj);
  const data = await callClaude(prompt);
  if (!data.examples || !Array.isArray(data.examples) || data.examples.length !== 3) {
    throw new Error('invalid examples shape');
  }
  for (const ex of data.examples) {
    if (!ex.en || !ex.zh) throw new Error('missing en/zh');
  }
  return data.examples;
}

async function worker(queue, state) {
  while (queue.length > 0) {
    const idx = queue.shift();
    const vocab = loadVocab();
    const w = vocab[idx];
    if (!needsUpdate(w)) continue;
    const t0 = Date.now();
    try {
      const examples = await enrichOne(w);
      const vocab2 = loadVocab();
      vocab2[idx].examples = examples;
      atomicWrite(vocab2);
      state.done += 1;
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[${state.done}/${state.total}] ✓ ${w.word} (${dt}s)`);
    } catch (e) {
      state.failed.push({ word: w.word, error: e.message });
      console.error(`[${state.done}/${state.total}] ✗ ${w.word}: ${e.message}`);
    }
  }
}

(async () => {
  const vocab = loadVocab();
  const targets = [];
  for (let i = 0; i < vocab.length; i++) {
    if (needsUpdate(vocab[i])) targets.push(i);
  }
  const queue = targets.slice(0, LIMIT);
  const state = { done: 0, total: queue.length, failed: [] };

  console.log(`Targets: ${queue.length} / need-update: ${targets.length} (concurrency=${CONCURRENCY}, model=${MODEL})`);

  const workers = Array.from({ length: CONCURRENCY }, () => worker(queue, state));
  await Promise.all(workers);

  console.log(`\nDone. Success: ${state.done - state.failed.length}, Failed: ${state.failed.length}`);
  if (state.failed.length) {
    const failPath = path.join(__dirname, '..', 'data', 'enrich_failed.json');
    fs.writeFileSync(failPath, JSON.stringify(state.failed, null, 2));
    console.log(`Failed list -> ${failPath}`);
  }
})();
