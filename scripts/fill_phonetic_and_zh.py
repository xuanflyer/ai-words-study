"""
批量补全：
1. 缺失的音标（IPA）
2. 例句中缺失的中文翻译
使用批量请求以提高效率，每批处理多个单词。
"""
import json
import time
import anthropic

client = anthropic.Anthropic()

# ── 音标补全 ──────────────────────────────────────────────────────────────────

PHONETIC_SYSTEM = """你是英语音标专家。我会给你一批英文单词，请为每个单词提供美式英语IPA音标。
对于缩写词（如ROI、LTV、SFT）、复合词（如long-tail、top-k）、专业术语，按实际发音标注。
严格按JSON格式返回，不要有其他文字：
{"word1": "/音标/", "word2": "/音标/", ...}"""


def fill_phonetics_batch(words: list[str]) -> dict:
    """批量获取音标，每批20个"""
    result = {}
    batch_size = 20
    for i in range(0, len(words), batch_size):
        batch = words[i:i + batch_size]
        batch_num = i // batch_size + 1
        total = (len(words) + batch_size - 1) // batch_size
        print(f"  音标批次 {batch_num}/{total}: {batch[:3]}...", end=" ", flush=True)
        try:
            resp = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=1024,
                system=PHONETIC_SYSTEM,
                messages=[{"role": "user", "content": "单词列表：" + ", ".join(batch)}],
            )
            text = resp.content[0].text.strip()
            s, e = text.find("{"), text.rfind("}") + 1
            if s != -1 and e > 0:
                parsed = json.loads(text[s:e])
                result.update(parsed)
                print(f"✓ ({len(parsed)}个)")
            else:
                print("解析失败")
        except Exception as ex:
            print(f"错误: {ex}")
        time.sleep(0.5)
    return result


# ── 例句翻译补全 ───────────────────────────────────────────────────────────────

ZH_SYSTEM = """你是AI/ML领域学术翻译专家。我会给你一批编号的英文例句，请翻译成简洁准确的中文。
严格按JSON格式返回（key为编号字符串，value为中文翻译），不要有其他文字：
{"0": "翻译0", "1": "翻译1", ...}"""


def fill_zh_batch(sentences: list[str]) -> dict:
    """批量翻译例句，每批15条"""
    result = {}
    batch_size = 15
    for i in range(0, len(sentences), batch_size):
        batch = sentences[i:i + batch_size]
        batch_num = i // batch_size + 1
        total = (len(sentences) + batch_size - 1) // batch_size
        print(f"  翻译批次 {batch_num}/{total} ({len(batch)}条)...", end=" ", flush=True)
        payload = {str(idx): s for idx, s in enumerate(batch)}
        try:
            resp = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=2048,
                system=ZH_SYSTEM,
                messages=[{"role": "user", "content": "请翻译以下例句：\n" + json.dumps(payload, ensure_ascii=False)}],
            )
            text = resp.content[0].text.strip()
            s, e = text.find("{"), text.rfind("}") + 1
            if s != -1 and e > 0:
                parsed = json.loads(text[s:e])
                for idx, sent in enumerate(batch):
                    key = str(idx)
                    if key in parsed:
                        result[sent] = parsed[key]
                print(f"✓ ({len(result)}条累计)")
            else:
                print("解析失败")
        except Exception as ex:
            print(f"错误: {ex}")
        time.sleep(0.5)
    return result


def main():
    with open("data/vocabulary.json") as f:
        data = json.load(f)

    # ── 第一步：补全音标 ─────────────────────────────────────────────────────
    no_phonetic_words = [item["word"] for item in data if not item.get("phonetic", "").strip()]
    print(f"=== 补全音标：{len(no_phonetic_words)} 个单词 ===")
    phonetic_map = fill_phonetics_batch(no_phonetic_words)

    # 写回
    updated_phonetic = 0
    for item in data:
        if not item.get("phonetic", "").strip():
            w = item["word"]
            # 尝试匹配（模型可能返回原词或小写）
            ph = phonetic_map.get(w) or phonetic_map.get(w.lower()) or phonetic_map.get(w.upper())
            if ph:
                item["phonetic"] = ph
                updated_phonetic += 1

    print(f"音标已补全 {updated_phonetic}/{len(no_phonetic_words)} 个\n")

    # 中途保存
    with open("data/vocabulary.json", "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # ── 第二步：补全例句中文翻译 ─────────────────────────────────────────────
    missing_zh = []
    for item in data:
        for ex in item.get("examples", []):
            if not ex.get("zh", "").strip() and ex.get("en", "").strip():
                missing_zh.append(ex["en"])

    print(f"=== 补全例句翻译：{len(missing_zh)} 条 ===")
    zh_map = fill_zh_batch(missing_zh)

    # 写回
    updated_zh = 0
    for item in data:
        for ex in item.get("examples", []):
            if not ex.get("zh", "").strip():
                en = ex.get("en", "")
                zh = zh_map.get(en)
                if zh:
                    ex["zh"] = zh
                    updated_zh += 1

    print(f"翻译已补全 {updated_zh}/{len(missing_zh)} 条\n")

    # 最终保存
    with open("data/vocabulary.json", "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # ── 统计结果 ─────────────────────────────────────────────────────────────
    remaining_phonetic = sum(1 for item in data if not item.get("phonetic", "").strip())
    remaining_zh = sum(1 for item in data for ex in item.get("examples", []) if not ex.get("zh", "").strip())
    print(f"完成！剩余缺音标: {remaining_phonetic}，剩余缺翻译: {remaining_zh}")


if __name__ == "__main__":
    main()
