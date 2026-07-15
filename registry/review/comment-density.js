// Advisory comment-density check for a worktree diff (see review.md
// "Comment-density advisory").
// Flags a file when its newly ADDED lines read as comment-heavy, via two
// independent heuristics: a raw comment-line ratio, and a "comment
// immediately before code, repeated" chunk count for the one-comment-
// per-step shape a raw ratio alone can miss. Per-line prefix checks on '+'
// diff lines only, keyed off file extension — not a real parser (misses
// comments inside a block the diff doesn't also open; ignores quoted/
// renamed diff paths). Thresholds calibrated against representative
// comment-heavy vs. clean diffs — see review.md for the measured ratios.

const EXT_STYLE = {
  js: { line: '//', block: true },
  jsx: { line: '//', block: true },
  ts: { line: '//', block: true },
  tsx: { line: '//', block: true },
  mjs: { line: '//', block: true },
  cjs: { line: '//', block: true },
  go: { line: '//', block: true },
  java: { line: '//', block: true },
  c: { line: '//', block: true },
  h: { line: '//', block: true },
  cpp: { line: '//', block: true },
  hpp: { line: '//', block: true },
  cc: { line: '//', block: true },
  scss: { line: '//', block: true },
  sh: { line: '#', block: false },
  bash: { line: '#', block: false },
  zsh: { line: '#', block: false },
  exp: { line: '#', block: false },
  py: { line: '#', block: false },
  rb: { line: '#', block: false },
  yml: { line: '#', block: false },
  yaml: { line: '#', block: false },
  sql: { line: '--', block: false },
};

const MIN_ADDED_LINES = 20;
const RATIO_THRESHOLD = 0.16;
const CHUNK_RATIO_THRESHOLD = 0.10;
const CHUNK_MIN_COUNT = 5;

function styleForFilePath(filePath) {
  const dot = filePath.lastIndexOf('.');
  const ext = dot === -1 ? '' : filePath.slice(dot + 1).toLowerCase();
  return EXT_STYLE[ext] || null;
}

// Resets on every `diff --git` so a file with no `+++` line (pure rename,
// mode change) can't leak added lines into the next file's bucket.
function addedLinesByFile(patchText) {
  const byFile = new Map();
  let currentFile = null;
  for (const line of patchText.split('\n')) {
    if (line.startsWith('diff --git ')) {
      currentFile = null;
    } else if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      currentFile = raw === '/dev/null' ? null : raw.replace(/^b\//, '');
    } else if (currentFile && line.startsWith('+')) {
      if (!byFile.has(currentFile)) {
        byFile.set(currentFile, []);
      }
      byFile.get(currentFile).push(line.slice(1));
    }
  }
  return byFile;
}

// One boolean per added line (null for blank). Block-comment state is
// seeded only by '/*' lines inside this same added-lines window, so a diff
// landing entirely inside a pre-existing block comment reads as code.
function classifyLines(lines, style) {
  let inBlock = false;
  return lines.map((raw) => {
    const trimmed = raw.trim();
    if (trimmed === '') {
      return null;
    }
    if (inBlock) {
      if (trimmed.includes('*/')) {
        inBlock = false;
      }
      return true;
    }
    if (style.block && trimmed.startsWith('/*')) {
      inBlock = !trimmed.includes('*/');
      return true;
    }
    return style.line !== null && trimmed.startsWith(style.line);
  });
}

// Counts comment-run -> code-run transitions: an approximation of "one
// comment per sequential step", not a precise measurement of it.
function countCommentChunks(flags) {
  const seq = flags.filter((flag) => flag !== null);
  let chunks = 0;
  let i = 0;
  while (i < seq.length) {
    if (!seq[i]) {
      while (i < seq.length && !seq[i]) i++;
      continue;
    }
    while (i < seq.length && seq[i]) i++;
    if (i < seq.length && !seq[i]) {
      chunks++;
      while (i < seq.length && !seq[i]) i++;
    }
  }
  return chunks;
}

function analyzeFile(filePath, addedLines) {
  const style = styleForFilePath(filePath);
  if (!style) {
    return null;
  }

  const flags = classifyLines(addedLines, style);
  const nonBlank = flags.filter((flag) => flag !== null);
  const total = nonBlank.length;
  if (total < MIN_ADDED_LINES) {
    return null;
  }

  const commentCount = nonBlank.filter(Boolean).length;
  const codeCount = total - commentCount;
  const ratio = commentCount / total;
  const chunkCount = countCommentChunks(flags);
  const chunkRatio = codeCount > 0 ? chunkCount / codeCount : 0;

  const ratioFlagged = ratio >= RATIO_THRESHOLD;
  const chunkFlagged = chunkCount >= CHUNK_MIN_COUNT && chunkRatio >= CHUNK_RATIO_THRESHOLD;
  if (!ratioFlagged && !chunkFlagged) {
    return null;
  }

  return {
    filePath, total, commentCount, codeCount, ratio, chunkCount, chunkRatio, chunkFlagged,
  };
}

function analyzeDiff(patchText) {
  const findings = [];
  for (const [filePath, addedLines] of addedLinesByFile(patchText)) {
    const finding = analyzeFile(filePath, addedLines);
    if (finding) {
      findings.push(finding);
    }
  }
  return findings;
}

module.exports = {
  EXT_STYLE,
  MIN_ADDED_LINES,
  RATIO_THRESHOLD,
  CHUNK_RATIO_THRESHOLD,
  CHUNK_MIN_COUNT,
  styleForFilePath,
  addedLinesByFile,
  classifyLines,
  countCommentChunks,
  analyzeFile,
  analyzeDiff,
};
