const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const DESIGNS_DIR = path.join(ROOT_DIR, 'designs');
const TASKS_DIR = path.join(ROOT_DIR, 'tasks');
const ARRAY_FRONTMATTER_KEYS = new Set(['tasks']);

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function stripInlineComment(value) {
  return value.replace(/\s+#.*$/, '').trim();
}

function parseArrayValue(value) {
  const inner = value.slice(1, -1).trim();
  if (inner === '') {
    return [];
  }

  return inner
    .split(',')
    .map((item) => stripQuotes(item.trim()))
    .filter(Boolean);
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return {};
  }

  const data = {};
  let currentArrayKey = null;

  for (const rawLine of match[1].split('\n')) {
    const line = rawLine.replace(/\r$/, '');

    if (line.trim() === '') {
      continue;
    }

    const arrayItemMatch = line.match(/^\s*-\s*(.+)$/);
    if (currentArrayKey && arrayItemMatch) {
      data[currentArrayKey].push(stripQuotes(stripInlineComment(arrayItemMatch[1])));
      continue;
    }

    const keyValueMatch = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!keyValueMatch) {
      currentArrayKey = null;
      continue;
    }

    const [, key, rawValue] = keyValueMatch;
    const value = stripInlineComment(rawValue);

    if (value === '') {
      if (ARRAY_FRONTMATTER_KEYS.has(key)) {
        data[key] = [];
        currentArrayKey = key;
      } else {
        data[key] = '';
        currentArrayKey = null;
      }
      continue;
    }

    if (value === '[]') {
      data[key] = [];
      currentArrayKey = null;
      continue;
    }

    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = parseArrayValue(value);
      currentArrayKey = null;
      continue;
    }

    data[key] = stripQuotes(value);
    currentArrayKey = null;
  }

  return data;
}

function extractBody(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/);
  if (!match) {
    return content;
  }

  return content.slice(match[0].length);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSection(body, heading) {
  const startRegex = new RegExp(`^## ${escapeRegExp(heading)}\\s*$`, 'm');
  const startMatch = startRegex.exec(body);
  if (!startMatch) {
    return '';
  }

  const startIndex = startMatch.index + startMatch[0].length;
  const remainder = body.slice(startIndex);
  const endMatch = /^\n## /m.exec(remainder);
  const endIndex = endMatch ? endMatch.index : remainder.length;

  return remainder.slice(0, endIndex).trim();
}

function parseMarkdownTable(section) {
  const lines = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'));

  if (lines.length < 3) {
    return [];
  }

  return lines
    .slice(2)
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length > 0 && cells.some(Boolean));
}

function parseSubItems(body) {
  const section = extractSection(body, 'Sub-items');
  const rows = parseMarkdownTable(section);

  return rows
    .filter((cells) => cells.length >= 4)
    .map(([step, what, dependsOn, status]) => ({
      step,
      what,
      dependsOn,
      dependencies: parseDependencies(dependsOn),
      status,
    }));
}

function parseDependencies(value) {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '--') {
    return [];
  }

  return trimmed
    .split(',')
    .map((token) => token.trim())
    .flatMap(expandDependencyToken);
}

function expandDependencyToken(token) {
  const rangeMatch = token.match(/^([A-Z]+)(\d+)-([A-Z]+)?(\d+)$/);
  if (!rangeMatch) {
    return token ? [token] : [];
  }

  const [, startPrefix, startNumberRaw, endPrefixRaw, endNumberRaw] = rangeMatch;
  const endPrefix = endPrefixRaw || startPrefix;
  const startNumber = Number.parseInt(startNumberRaw, 10);
  const endNumber = Number.parseInt(endNumberRaw, 10);

  if (startPrefix !== endPrefix || Number.isNaN(startNumber) || Number.isNaN(endNumber) || endNumber < startNumber) {
    return [token];
  }

  const items = [];
  for (let value = startNumber; value <= endNumber; value += 1) {
    items.push(`${startPrefix}${value}`);
  }
  return items;
}

function parseOpenQuestions(body) {
  const section = extractSection(body, 'Open Questions');
  if (!section) {
    return [];
  }

  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- [ ] '))
    .map((line) => line.slice(6).trim());
}

function extractSubItemSection(body, subItem) {
  const headingRegex = new RegExp(`^###\\s+${escapeRegExp(subItem)}\\b.*$`, 'm');
  const headingMatch = headingRegex.exec(body);
  if (!headingMatch) {
    return '';
  }

  const startIndex = headingMatch.index;
  const remainder = body.slice(startIndex);
  const nextHeadingMatch = /\n###\s+/m.exec(remainder.slice(headingMatch[0].length));
  const nextSectionMatch = /\n##\s+/m.exec(remainder.slice(headingMatch[0].length));

  let endOffset = remainder.length;

  if (nextHeadingMatch) {
    endOffset = Math.min(endOffset, headingMatch[0].length + nextHeadingMatch.index);
  }

  if (nextSectionMatch) {
    endOffset = Math.min(endOffset, headingMatch[0].length + nextSectionMatch.index);
  }

  return remainder.slice(0, endOffset).trim();
}

function readTask(taskId) {
  const filePath = path.join(TASKS_DIR, `${taskId}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(readFile(filePath));
}

function readDesign(fdId) {
  const filePath = path.join(DESIGNS_DIR, `${fdId}.md`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Feature design not found: designs/${fdId}.md`);
  }

  const content = readFile(filePath);
  const frontmatter = parseFrontmatter(content);
  const body = extractBody(content);

  return {
    id: fdId,
    path: filePath,
    content,
    frontmatter,
    metadata: {
      repo: typeof frontmatter.repo === 'string' ? frontmatter.repo : '',
      providerHint: typeof frontmatter.provider_hint === 'string' ? frontmatter.provider_hint : '',
      profileHint: typeof frontmatter.profile_hint === 'string' ? frontmatter.profile_hint : '',
      branchSuffix: typeof frontmatter.branch_suffix === 'string' ? frontmatter.branch_suffix : '',
      verificationCommand: typeof frontmatter.verification_command === 'string' ? frontmatter.verification_command : '',
      tasks: Array.isArray(frontmatter.tasks) ? frontmatter.tasks : [],
    },
    body,
    subItems: parseSubItems(body),
    openQuestions: parseOpenQuestions(body),
  };
}

function readDesignIndex() {
  const indexPath = path.join(DESIGNS_DIR, 'INDEX.md');
  if (!fs.existsSync(indexPath)) {
    return [];
  }

  const content = readFile(indexPath);
  const lines = content.split('\n').map((line) => line.trim());

  return lines
    .filter((line) => /^\|\s*\[FD-\d+\]/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 6)
    .map(([fdCell, title, status, effort, priority, tasks]) => {
      const idMatch = fdCell.match(/\[(FD-\d+)\]/);
      const taskIds = tasks === '' ? [] : tasks.split(',').map((taskId) => taskId.trim()).filter(Boolean);

      return {
        id: idMatch ? idMatch[1] : fdCell,
        title,
        status,
        effort,
        priority,
        tasks: taskIds,
      };
    });
}

function getReadySubItems(design) {
  const statusByStep = new Map(design.subItems.map((item) => [item.step, item.status]));

  return design.subItems.filter((item) => {
    if (item.status !== 'todo') {
      return false;
    }

    return item.dependencies.every((dependency) => statusByStep.get(dependency) === 'done');
  });
}

module.exports = {
  DESIGNS_DIR,
  ROOT_DIR,
  TASKS_DIR,
  extractSection,
  extractSubItemSection,
  getReadySubItems,
  parseDependencies,
  parseFrontmatter,
  readDesign,
  readDesignIndex,
  readTask,
};
