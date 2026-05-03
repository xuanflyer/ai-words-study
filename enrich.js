// 通过本机 `claude` CLI（haiku 模型）补全单词信息：phonetic / chinese / category / examples / synonyms。
// 输出严格 JSON。失败由调用方处理。

const { spawn } = require('child_process');

function buildPrompt(word) {
  return `你是一名 AI/ML 论文阅读场景下的英语词汇教师，需要为下列单词生成完整的学习信息。

单词: ${word}

请输出严格的 JSON（不要 markdown 代码块，不要任何多余文字）。格式：
{"phonetic":"/.../","chinese":"...","category":"...","examples":[{"en":"...","zh":"..."},{"en":"...","zh":"..."},{"en":"...","zh":"..."}],"synonyms":["...","..."]}

要求：
1. phonetic 为美式或国际音标，包含两侧斜杠
2. chinese 为简洁准确的中文释义（多义可用 / 或 ；分隔，最多 30 字）
3. category 从以下挑一项最贴切的：模型架构 / 训练优化 / 数据处理 / 评估指标 / 损失函数 / 自然语言处理 / 计算机视觉 / 强化学习 / 数学统计 / 通用学术 / 金融
4. examples 恰好 3 条，每条 en（12~30 词）+ zh（中文翻译），要求来自 AI/ML/金融论文语境，自然地道、场景多样
5. synonyms 给 0~3 个常见同义词或近义短语
6. 整段输出必须是合法 JSON，且只输出 JSON`;
}

function callClaude(prompt, model = 'haiku', timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', model, '--output-format=json'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      try {
        const env = JSON.parse(out);
        let result = (env.result || '').trim();
        result = result.replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();
        resolve(JSON.parse(result));
      } catch (e) {
        reject(new Error(`parse failed: ${e.message}; raw: ${out.slice(0, 300)}`));
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function validate(data) {
  if (!data || typeof data !== 'object') throw new Error('not an object');
  if (!data.chinese || typeof data.chinese !== 'string') throw new Error('chinese missing');
  if (!Array.isArray(data.examples) || data.examples.length === 0) throw new Error('examples missing');
  for (const ex of data.examples) {
    if (!ex || !ex.en || !ex.zh) throw new Error('example missing en/zh');
  }
  if (!Array.isArray(data.synonyms)) data.synonyms = [];
  return {
    phonetic: data.phonetic || '',
    chinese: data.chinese.trim(),
    category: (data.category || '通用学术').trim(),
    examples: data.examples,
    synonyms: data.synonyms
  };
}

async function enrichWord(word, { model = 'haiku', timeoutMs = 120000 } = {}) {
  const data = await callClaude(buildPrompt(word), model, timeoutMs);
  return validate(data);
}

// 简单的并发池
async function enrichBatch(words, { concurrency = 1, model = 'haiku', onItem } = {}) {
  const queue = words.slice();
  const results = [];
  async function worker() {
    while (queue.length) {
      const w = queue.shift();
      try {
        const data = await enrichWord(w, { model });
        const item = { word: w, ok: true, data };
        results.push(item);
        if (onItem) await onItem(item);
      } catch (e) {
        const item = { word: w, ok: false, error: e.message };
        results.push(item);
        if (onItem) await onItem(item);
      }
    }
  }
  const ws = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(ws);
  return results;
}

module.exports = { enrichWord, enrichBatch };
