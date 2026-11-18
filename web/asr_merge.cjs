// 与 src/echotrace/minutes.py 的 merge_fragments 保持一致：
// 上一句没有以句末标点结束、两句间隔不超过 maxGap 秒时并成一句，
// 合并后的句子不超过 maxChars 字、maxDur 秒；时间段仍取首句开始到末句结束。
const SENTENCE_END = /[。？！?!]$/;

function mergeFragments(sentences, { maxGap = 0.3, maxChars = 40, maxDur = 12.0 } = {}) {
  const sorted = [...sentences].sort((a, b) => a.start - b.start || a.end - b.end);
  // 人工转写带 speaker，本身就是整句，不做合并
  if (sorted.some((sentence) => sentence.speaker != null)) {
    return sorted.map((sentence) => ({ ...sentence }));
  }

  const out = [];
  for (const sentence of sorted) {
    const prev = out[out.length - 1];
    if (
      prev &&
      !SENTENCE_END.test(String(prev.text).trim()) &&
      sentence.start - prev.end <= maxGap &&
      String(prev.text).length + String(sentence.text).length <= maxChars &&
      sentence.end - prev.start <= maxDur
    ) {
      prev.text += sentence.text;
      prev.end = Math.max(prev.end, sentence.end);
      prev.parts += 1;
    } else {
      out.push({ ...sentence, parts: 1 });
    }
  }
  return out;
}

// 只有 segmented 方案把合并后的句子交给模型并生成证据编号；
// baseline 的证据来自原句 quote 匹配，合并后反而对不上时间段。
function shouldMergeFragments(sentences, minutes) {
  if (!Array.isArray(sentences) || !sentences.length) return false;
  if (sentences.some((sentence) => sentence.speaker != null)) return false;
  if (minutes && minutes.method && minutes.method !== "segmented") return false;
  if (minutes && minutes.params && minutes.params.merge === false) return false;
  return true;
}

module.exports = { mergeFragments, shouldMergeFragments };
