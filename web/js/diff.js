import { escapeHtml } from "./state.js";

const MAX_LCS_CELLS = 60000;

function computeMidOps(aMid, bMid) {
  const m = aMid.length;
  const n = bMid.length;
  if (m === 0 && n === 0) return [];
  if (m === 0) return [{ type: "ins", text: bMid.join("") }];
  if (n === 0) return [{ type: "del", text: aMid.join("") }];
  if (m * n > MAX_LCS_CELLS) {
    return [
      { type: "del", text: aMid.join("") },
      { type: "ins", text: bMid.join("") },
    ];
  }

  const cols = n + 1;
  const dp = new Uint32Array((m + 1) * cols);

  for (let i = 1; i <= m; i += 1) {
    const aChar = aMid[i - 1];
    const rowOffset = i * cols;
    const prevRowOffset = (i - 1) * cols;
    for (let j = 1; j <= n; j += 1) {
      if (aChar === bMid[j - 1]) {
        dp[rowOffset + j] = dp[prevRowOffset + (j - 1)] + 1;
      } else {
        const up = dp[prevRowOffset + j];
        const left = dp[rowOffset + (j - 1)];
        dp[rowOffset + j] = up >= left ? up : left;
      }
    }
  }

  const rawOps = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aMid[i - 1] === bMid[j - 1]) {
      rawOps.push({ type: "eq", char: aMid[i - 1] });
      i -= 1;
      j -= 1;
    } else if (i > 0 && (j === 0 || dp[(i - 1) * cols + j] >= dp[i * cols + (j - 1)])) {
      rawOps.push({ type: "del", char: aMid[i - 1] });
      i -= 1;
    } else {
      rawOps.push({ type: "ins", char: bMid[j - 1] });
      j -= 1;
    }
  }
  rawOps.reverse();

  // Coalesce contiguous runs and order del before ins between equal anchors
  const merged = [];
  let delBuf = [];
  let insBuf = [];
  const flushDiff = () => {
    if (delBuf.length) {
      merged.push({ type: "del", text: delBuf.join("") });
      delBuf = [];
    }
    if (insBuf.length) {
      merged.push({ type: "ins", text: insBuf.join("") });
      insBuf = [];
    }
  };

  let eqBuf = [];
  const flushEq = () => {
    if (eqBuf.length) {
      merged.push({ type: "eq", text: eqBuf.join("") });
      eqBuf = [];
    }
  };

  for (const op of rawOps) {
    if (op.type === "eq") {
      flushDiff();
      eqBuf.push(op.char);
    } else if (op.type === "del") {
      flushEq();
      delBuf.push(op.char);
    } else {
      flushEq();
      insBuf.push(op.char);
    }
  }
  flushEq();
  flushDiff();
  return merged;
}

export function buildCharDiffHtml(originalText, correctedText) {
  const orig = String(originalText ?? "");
  const corr = String(correctedText ?? "");

  if (orig === corr) {
    const safe = escapeHtml(orig);
    return {
      changed: false,
      originalHtml: safe,
      correctedHtml: safe,
      inlineHtml: safe,
    };
  }

  const aChars = Array.from(orig);
  const bChars = Array.from(corr);

  if (aChars.length * bChars.length > MAX_LCS_CELLS) {
    const delHtml = orig ? `<del class="diff-del">${escapeHtml(orig)}</del>` : "";
    const insHtml = corr ? `<ins class="diff-ins">${escapeHtml(corr)}</ins>` : "";
    return {
      changed: true,
      originalHtml: delHtml,
      correctedHtml: insHtml,
      inlineHtml: `${delHtml}${insHtml}`,
    };
  }

  let prefixLen = 0;
  const minLen = Math.min(aChars.length, bChars.length);
  while (prefixLen < minLen && aChars[prefixLen] === bChars[prefixLen]) {
    prefixLen += 1;
  }

  let suffixLen = 0;
  while (
    suffixLen < aChars.length - prefixLen &&
    suffixLen < bChars.length - prefixLen &&
    aChars[aChars.length - 1 - suffixLen] === bChars[bChars.length - 1 - suffixLen]
  ) {
    suffixLen += 1;
  }

  const ops = [];
  if (prefixLen > 0) {
    ops.push({ type: "eq", text: aChars.slice(0, prefixLen).join("") });
  }
  const midOps = computeMidOps(
    aChars.slice(prefixLen, aChars.length - suffixLen),
    bChars.slice(prefixLen, bChars.length - suffixLen),
  );
  ops.push(...midOps);
  if (suffixLen > 0) {
    ops.push({ type: "eq", text: aChars.slice(aChars.length - suffixLen).join("") });
  }

  const origParts = [];
  const corrParts = [];
  const inlineParts = [];

  for (const op of ops) {
    const safe = escapeHtml(op.text);
    if (op.type === "eq") {
      origParts.push(safe);
      corrParts.push(safe);
      inlineParts.push(safe);
    } else if (op.type === "del") {
      const wrapped = `<del class="diff-del">${safe}</del>`;
      origParts.push(wrapped);
      inlineParts.push(wrapped);
    } else {
      const wrapped = `<ins class="diff-ins">${safe}</ins>`;
      corrParts.push(wrapped);
      inlineParts.push(wrapped);
    }
  }

  return {
    changed: true,
    originalHtml: origParts.join(""),
    correctedHtml: corrParts.join(""),
    inlineHtml: inlineParts.join(""),
  };
}
