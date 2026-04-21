"""
为只有1个例句的单词批量添加3个AI/ML领域例句，并补充中文释义。
"""
import json
import time
import anthropic

client = anthropic.Anthropic()

SYSTEM_PROMPT = """你是一位专业的AI/ML学术词汇专家。
我会给你一个英文单词或短语，请为它：
1. 提供准确的中文释义（格式：词性缩写. 中文意思，如 "n. 稀疏性" 或 "v. 促进"）
2. 提供3个例句，例句需来自以下领域：
   - 机器学习/深度学习论文
   - 大语言模型/智能体（LLM/Agent）论文
   - AI应用场景：搜索、广告、推荐、营销、金融信贷

要求：
- 例句必须是地道的学术英语，贴近真实论文表达
- 例句长度适中（15-30词）
- 每个例句覆盖不同子领域

请严格按以下JSON格式返回，不要有任何其他文字：
{
  "chinese": "词性. 中文释义",
  "examples": [
    {"en": "例句1", "zh": ""},
    {"en": "例句2", "zh": ""},
    {"en": "例句3", "zh": ""}
  ]
}"""


def enrich_word(word: str, existing_example: str) -> dict | None:
    """为单个单词生成中文释义和3个例句"""
    user_msg = f'单词/短语："{word}"\n已有例句参考："{existing_example}"'

    try:
        response = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )
        text = response.content[0].text.strip()
        # 提取JSON
        start = text.find("{")
        end = text.rfind("}") + 1
        if start == -1 or end == 0:
            print(f"  [警告] 无法解析JSON: {text[:100]}")
            return None
        return json.loads(text[start:end])
    except Exception as e:
        print(f"  [错误] {e}")
        return None


def main():
    with open("data/vocabulary.json", "r") as f:
        data = json.load(f)

    # 找出只有1个例句的单词
    targets = [(i, item) for i, item in enumerate(data) if len(item.get("examples", [])) == 1]
    print(f"需要处理 {len(targets)} 个单词\n")

    updated = 0
    for idx, (i, item) in enumerate(targets):
        word = item["word"]
        existing_en = item["examples"][0]["en"]
        print(f"[{idx+1}/{len(targets)}] {word} ...", end=" ", flush=True)

        result = enrich_word(word, existing_en)
        if result is None:
            print("跳过")
            continue

        # 更新中文释义（若当前为空）
        if not item.get("chinese") and result.get("chinese"):
            data[i]["chinese"] = result["chinese"]
        elif result.get("chinese") and item.get("chinese", "").strip() in ("", "n. ", "v. ", "adj. ", "adv. "):
            data[i]["chinese"] = result["chinese"]

        # 保留原有例句，追加新的3个
        new_examples = result.get("examples", [])
        if new_examples:
            data[i]["examples"] = [item["examples"][0]] + new_examples
            updated += 1
            print(f"✓ ({data[i]['chinese']})")
        else:
            print("无新例句")

        # 每10个单词保存一次
        if (idx + 1) % 10 == 0:
            with open("data/vocabulary.json", "w") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f"  → 已保存进度 ({idx+1}/{len(targets)})")

        time.sleep(0.3)  # 避免触发限速

    # 最终保存
    with open("data/vocabulary.json", "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\n完成！共更新 {updated}/{len(targets)} 个单词")


if __name__ == "__main__":
    main()
