import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(projectRoot, 'public');
const outputDirectory = join(projectRoot, 'dist');
const postsDirectory = join(projectRoot, 'content', 'posts');
// 图床目录：和 Markdown 文件同级，`images/x.jpg` 这种相对写法在编辑器里也能直接预览。
const imageBankDirectory = join(postsDirectory, 'images');
// 记录每篇 Markdown 的修改时间，避免 CI 检出后时间戳变成构建时间。
const publishTimesPath = join(projectRoot, 'content', 'posts', '.publish-times.json');
const siteUrl = (process.env.SITE_URL ?? 'http://localhost:4173').replace(/\/$/, '');
const siteTimeZone = process.env.SITE_TIME_ZONE ?? 'Asia/Shanghai';
const refreshPublishTimes = /^(1|true|yes|refresh|force)$/i.test(
  String(process.env.PUBLISH_TIMES ?? '').trim(),
);
const templateTick = String.fromCharCode(96);
const imageBankUrl = '/images';
// giscus 评论：仓库讨论区承担存储，这里只放定位信息。
const giscus = {
  repo: process.env.GISCUS_REPO ?? 'chuxuehaocai/homepage',
  repoId: process.env.GISCUS_REPO_ID ?? 'R_kgDOTTfsLQ',
  category: process.env.GISCUS_CATEGORY ?? 'Announcements',
  categoryId: process.env.GISCUS_CATEGORY_ID ?? '',
  mapping: process.env.GISCUS_MAPPING ?? 'pathname',
  inputPosition: process.env.GISCUS_INPUT_POSITION ?? 'top',
  lang: process.env.GISCUS_LANG ?? 'zh-CN',
};
const warnings = new Set();
// giscus 分类 id 解析成功后写进这个文件，之后的构建（包括 CI）就不用再联网查。
const giscusCachePath = join(projectRoot, 'content', 'posts', '.giscus.json');
// 线上没配好评论就整段不渲染，避免把安装说明暴露给访客；`npm run dev` 时才保留提示。
const showGiscusSetupHint = process.argv.includes('--dev');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll(templateTick, '&#96;');
}

/* ------------------------------------------------------------------ *
 * 时间：发布时间 = 该 md 文件自身的修改时间（除非 frontmatter 显式给了 date）
 * ------------------------------------------------------------------ */

const zoneFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: siteTimeZone,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const postTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: siteTimeZone,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

const postDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: siteTimeZone,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

function padNumber(value) {
  return String(value).padStart(2, '0');
}

function zonedParts(date) {
  const parts = {};

  for (const part of zoneFormatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }

  return parts;
}

function zoneOffsetMinutes(date) {
  const parts = zonedParts(date);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

function toZonedIso(date) {
  const parts = zonedParts(date);
  const offset = zoneOffsetMinutes(date);
  const absolute = Math.abs(offset);

  return parts.year + '-' + padNumber(parts.month) + '-' + padNumber(parts.day) +
    'T' + padNumber(parts.hour) + ':' + padNumber(parts.minute) + ':' + padNumber(parts.second) +
    (offset < 0 ? '-' : '+') + padNumber(Math.floor(absolute / 60)) + ':' + padNumber(absolute % 60);
}

function wallTimeToInstant({ year, month, day, hour, minute, second }) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let instant = guess - zoneOffsetMinutes(new Date(guess)) * 60000;
  const adjusted = guess - zoneOffsetMinutes(new Date(instant)) * 60000;

  if (adjusted !== instant) instant = adjusted;

  return instant;
}

function parseTimestamp(value) {
  const text = String(value).trim();
  const pattern =
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/;
  const match = text.match(pattern);

  if (match) {
    const [, year, month, day, hour = '0', minute = '0', second = '0', zone] = match;
    const dateOnly = !match[4];
    let instant;

    if (zone) {
      const cleaned = zone.replace(':', '');
      const offset = zone === 'Z'
        ? 0
        : (cleaned.startsWith('-') ? -1 : 1) *
          (Number(cleaned.slice(1, 3)) * 60 + Number(cleaned.slice(3, 5)));
      instant = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) -
        offset * 60000;
    } else {
      instant = wallTimeToInstant({
        year: Number(year),
        month: Number(month),
        day: Number(day),
        hour: Number(hour),
        minute: Number(minute),
        second: Number(second),
      });
    }

    if (Number.isNaN(instant)) return null;

    return { instant, iso: toZonedIso(new Date(instant)), dateOnly };
  }

  const parsed = new Date(text);

  if (Number.isNaN(parsed.getTime())) return null;

  return { instant: parsed.getTime(), iso: toZonedIso(parsed), dateOnly: false };
}

function formatPostTime(post) {
  const date = new Date(post.instant);
  const formatter = post.dateOnly ? postDateFormatter : postTimeFormatter;
  return formatter.format(date);
}

/* ------------------------------------------------------------------ *
 * 图床：图片放在 content/posts/images/，构建后发布到 /images/
 * ------------------------------------------------------------------ */

const imageExtensions = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.jfif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);

function normalizeImageSource(value) {
  const source = String(value ?? '').trim();

  if (!source) return null;
  if (/^data:image\//i.test(source)) return source;
  if (/^https?:\/\//i.test(source) || source.startsWith('//')) return source;
  if (source.startsWith('/')) return source;

  // Markdown 位于 content/posts/，图床目录是 content/posts/images/，
  // 于是 images/x.jpg、./images/x.jpg、../images/x.jpg 都映射到站点根部的 /images/x.jpg。
  const bankMatch = source.replace(/\\/g, '/').match(/(?:^|\/)images\/(.+)$/i);

  if (bankMatch) return imageBankUrl + '/' + bankMatch[1];

  return null;
}

function renderImageTag({ src, alt = '', title = '', className = '' }) {
  const normalized = normalizeImageSource(src);

  if (!normalized) {
    if (src) warnings.add('图片路径无法解析，已按原文输出：' + src);
    return null;
  }

  if (/^https?:\/\//i.test(normalized)) {
    warnings.add('引用了站外图片，部署环境的 CSP 会拦截它，建议放进 content/posts/images/：' + normalized);
  }

  const attributes = [
    'class="' + escapeAttribute(['post-image', className].filter(Boolean).join(' ')) + '"',
    'src="' + escapeAttribute(normalized) + '"',
    'alt="' + escapeAttribute(alt) + '"',
    'loading="lazy"',
    'decoding="async"',
  ];

  if (title) attributes.push('title="' + escapeAttribute(title) + '"');

  return '<img ' + attributes.join(' ') + ' />';
}

const allowedTags = new Set([
  'a',
  'br',
  'code',
  'del',
  'div',
  'em',
  'figcaption',
  'figure',
  'hr',
  'img',
  'p',
  'span',
  'strong',
  'sub',
  'sup',
]);
// 这些标签独占一段时整体作为原始 HTML 块输出，不再包进 <p>。
const blockContainers = ['figure', 'div', 'p'];
const voidTags = new Set(['br', 'hr', 'img']);
const allowedAttributes = new Set([
  'align',
  'alt',
  'class',
  'decoding',
  'height',
  'href',
  'id',
  'lang',
  'loading',
  'rel',
  'src',
  'target',
  'title',
  'width',
]);
const alignmentClasses = new Map([
  ['center', 'post-image--center'],
  ['left', 'post-image--left'],
  ['right', 'post-image--right'],
]);

function safeUrl(value) {
  const url = String(value);
  return /^(https?:\/\/|\/|#)/i.test(url) ? url : '#';
}

function collectTagAttributes(tagName, attributeSource) {
  const attributes = new Map();
  const classes = [];
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
  let match;

  while ((match = pattern.exec(attributeSource)) !== null) {
    const key = match[1].toLowerCase();

    if (key.startsWith('on') || !allowedAttributes.has(key)) continue;

    const rawValue = match[2] ?? '';
    const value = rawValue
      ? (/^["']/.test(rawValue) ? rawValue.slice(1, -1) : rawValue)
      : '';

    if (!value) continue;

    if (key === 'src') {
      if (tagName !== 'img') continue;

      const normalized = normalizeImageSource(value);

      if (!normalized) {
        warnings.add('图片路径无法解析，已跳过该 <img>：' + value);
        return null;
      }

      if (/^https?:\/\//i.test(normalized)) {
        warnings.add('引用了站外图片，部署环境的 CSP 会拦截它，建议放进 content/posts/images/：' + normalized);
      }

      attributes.set('src', normalized);
      continue;
    }

    if (key === 'href') {
      const safe = safeUrl(value);

      if (safe === '#') warnings.add('链接地址不在允许范围内，已替换为 #：' + value);

      attributes.set('href', safe);
      continue;
    }

    if (key === 'align') {
      const alignment = value.toLowerCase();
      const imageClass = alignmentClasses.get(alignment);

      if (imageClass) {
        // img 的 align 无法真正居中，改写成 margin 类；其余标签交给 text-align。
        classes.push(tagName === 'img' ? imageClass : 'text-' + alignment);
      }

      continue;
    }

    if (key === 'class') {
      classes.push(...value.replace(/[^a-zA-Z0-9 _-]/g, ' ').split(/\s+/).filter(Boolean));
      continue;
    }

    if (key === 'target') {
      if (value === '_blank') attributes.set('target', '_blank');
      continue;
    }

    if (key === 'width' || key === 'height') {
      if (/^\d{1,4}(px|%)?$/.test(value)) attributes.set(key, value);
      continue;
    }

    attributes.set(key, value);
  }

  return { attributes, classes };
}

function sanitizeTag(rawTag) {
  const match = rawTag.match(/^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)([\s\S]*?)>$/);

  if (!match) return '';

  const closing = match[1] === '/';
  const name = match[2].toLowerCase();
  const attributeSource = match[3].replace(/\/\s*$/, '');

  if (!allowedTags.has(name)) {
    warnings.add('已忽略不支持的 HTML 标签：<' + name + '>');
    return '';
  }

  if (closing) return '</' + name + '>';

  const collected = collectTagAttributes(name, attributeSource);

  if (collected === null) return '';

  const { attributes, classes } = collected;

  if (name === 'img') {
    if (!attributes.has('src')) {
      warnings.add('发现没有 src 的 <img>，已跳过');
      return '';
    }

    classes.unshift('post-image');

    if (!attributes.has('alt')) attributes.set('alt', '');
    if (!attributes.has('loading')) attributes.set('loading', 'lazy');
    if (!attributes.has('decoding')) attributes.set('decoding', 'async');
  }

  if (name === 'a' && attributes.has('target') && !attributes.has('rel')) {
    attributes.set('rel', 'noopener noreferrer');
  }

  const serialized = [];

  if (classes.length) {
    serialized.push('class="' + escapeAttribute([...new Set(classes)].join(' ')) + '"');
  }

  for (const [key, value] of attributes) {
    serialized.push(key + '="' + escapeAttribute(value) + '"');
  }

  const markup = '<' + name + (serialized.length ? ' ' + serialized.join(' ') : '') + ' />';

  if (voidTags.has(name)) return markup;
  return markup.replace(/ \/>$/, '>');
}

/* ------------------------------------------------------------------ *
 * 内联与块级 Markdown 渲染
 * ------------------------------------------------------------------ */

function renderInline(value) {
  const source = String(value).replace(/<!--[\s\S]*?-->/g, '');
  const placeholders = [];
  const codePattern = new RegExp(templateTick + '([^' + templateTick + ']*)' + templateTick, 'g');

  // 占位符统一用「哨兵 + 序号 + 哨兵」，最后一步统一还原，避免转义顺序互相踩踏。
  const hold = (markup, sentinel) => {
    placeholders.push({ markup, sentinel });
    return sentinel + (placeholders.length - 1) + sentinel;
  };

  let html = source.replace(codePattern, (_, code) =>
    hold('<code>' + escapeHtml(code) + '</code>', '\u0000'),
  );

  // 写作时用 [<图片说明>] 占位，先整块保护起来，否则会被当成 HTML 标签吃掉。
  html = html.replace(/\[<[^\]>]*>\]/g, (span) => hold(escapeHtml(span), '\u0004'));

  // HTML 标签先抽出来单独消毒，剩下的文本再转义，避免 <img> 被当成普通文字。
  html = html.replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => hold(sanitizeTag(tag), '\u0001'));

  // Markdown 图片 / 链接必须在转义前处理，否则 "title" 里的引号会变成 &quot; 导致匹配失败。
  html = html.replace(
    /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"([^"]*)")?\s*\)/g,
    (whole, alt, src, title) => {
      const markup = renderImageTag({ src, alt, title });
      return markup === null ? whole : hold(markup, '\u0002');
    },
  );
  html = html.replace(
    /\[([^\]]+)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g,
    (_, label, url, title) => {
      const titleAttribute = title ? ' title="' + escapeAttribute(title) + '"' : '';
      return hold(
        '<a href="' + escapeAttribute(safeUrl(url)) + '"' + titleAttribute + '>' +
        renderInline(label) + '</a>',
        '\u0003',
      );
    },
  );

  html = escapeHtml(html);
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  return html.replace(/([\u0000-\u0004])(\d+)\1/g, (whole, sentinel, index) => {
    const entry = placeholders[Number(index)];
    return entry && entry.sentinel === sentinel ? entry.markup : whole;
  });
}

function renderQuoteText(texts) {
  const blocks = [];
  let paragraph = [];
  let listType = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push('<p>' + renderInline(paragraph.join(' ')) + '</p>');
      paragraph = [];
    }
  };

  const closeList = () => {
    if (listType) {
      blocks.push('</' + listType + '>');
      listType = null;
    }
  };

  for (const text of texts) {
    const trimmed = String(text).trim();

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const unorderedItem = trimmed.match(/^[-*]\s+(.+)$/);
    const orderedItem = trimmed.match(/^\d+\.\s+(.+)$/);

    if (unorderedItem || orderedItem) {
      flushParagraph();
      const nextListType = unorderedItem ? 'ul' : 'ol';

      if (listType !== nextListType) {
        closeList();
        listType = nextListType;
        blocks.push('<' + nextListType + '>');
      }

      blocks.push('<li>' + renderInline((unorderedItem ?? orderedItem)[1]) + '</li>');
      continue;
    }

    closeList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return blocks.join('\n');
}

function renderQuoteLevel(entries, level) {
  const output = [];
  let index = 0;

  while (index < entries.length) {
    if (entries[index].depth < level) {
      index += 1;
      continue;
    }

    if (entries[index].depth === level) {
      const texts = [];

      while (index < entries.length && entries[index].depth === level) {
        texts.push(entries[index].text);
        index += 1;
      }

      output.push(renderQuoteText(texts));
      continue;
    }

    const subtree = [];

    while (index < entries.length && entries[index].depth > level) {
      subtree.push(entries[index]);
      index += 1;
    }

    output.push('<blockquote>' + renderQuoteLevel(subtree, level + 1) + '</blockquote>');
  }

  return output.filter(Boolean).join('\n');
}

function renderQuotes(entries) {
  const inner = renderQuoteLevel(entries, 1);
  return inner ? '<blockquote>' + inner + '</blockquote>' : '';
}

function renderMarkdown(source) {
  const lines = String(source)
    .replace(/\r\n/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n');
  const html = [];
  let paragraph = [];
  let listType = null;
  let codeLines = null;
  let codeLanguage = '';
  let rawBlock = null;
  let quotes = [];
  const fencePattern = new RegExp('^' + templateTick.repeat(3) + '\\s*([\\w-]*)\\s*$');

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push('<p>' + renderInline(paragraph.join(' ')) + '</p>');
      paragraph = [];
    }
  };

  const flushQuotes = () => {
    if (quotes.length) {
      html.push(renderQuotes(quotes));
      quotes = [];
    }
  };

  const closeList = () => {
    if (listType) {
      html.push('</' + listType + '>');
      listType = null;
    }
  };

  // 一个块开始时把前面攒的段落、列表、引用一起收尾。
  const breakBlocks = () => {
    flushParagraph();
    closeList();
    flushQuotes();
  };

  const flushCode = () => {
    if (codeLines !== null) {
      const languageClass = codeLanguage
        ? ' class="language-' + escapeAttribute(codeLanguage) + '"'
        : '';
      html.push('<pre><code' + languageClass + '>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
      codeLines = null;
      codeLanguage = '';
    }
  };

  const openingBlockTag = (line) => {
    const match = line.match(/^\s*<([a-zA-Z][a-zA-Z0-9]*)[\s>]/);

    if (!match) return null;

    const tag = match[1].toLowerCase();
    return blockContainers.includes(tag) ? tag : null;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];

    // 多行 HTML 块（<p align="center">…</p>、<figure>…</figure>）整体输出，
    // 既不会把块级元素塞进 <p>，也让图片居中生效。
    if (rawBlock !== null) {
      rawBlock.lines.push(line.trim());

      if (new RegExp('</' + rawBlock.tag + '\\s*>', 'i').test(line)) {
        html.push(renderInline(rawBlock.lines.join(' ')));
        rawBlock = null;
      }

      continue;
    }

    const fence = line.match(fencePattern);

    if (fence) {
      breakBlocks();

      if (codeLines === null) {
        codeLines = [];
        codeLanguage = fence[1];
      } else {
        flushCode();
      }
      continue;
    }

    if (codeLines !== null) {
      codeLines.push(line);
      continue;
    }

    const isBlank = !line.trim();

    // 引用块：空行之后仍跟着 > 行时继续留在同一个引用里，否则收尾。
    if (!isBlank && !/^\s*</.test(line.trim())) {
      const blockquote = line.match(/^((?:>)+)\s?(.*)$/);

      if (blockquote) {
        // 只收掉段落和列表，引用本身要继续累积，不能整块 flush。
        flushParagraph();
        closeList();
        quotes.push({ depth: blockquote[1].length, text: blockquote[2] });
        continue;
      }
    }

    if (isBlank) {
      const nextNonBlank = lines.slice(lineIndex + 1).find((candidate) => candidate.trim());

      if (quotes.length && nextNonBlank && /^\s*>/.test(nextNonBlank)) {
        continue;
      }

      breakBlocks();
      continue;
    }

    if (/^\s*<figure[\s>]/i.test(line)) {
      breakBlocks();

      if (/<\/figure\s*>\s*$/i.test(line)) {
        html.push(renderInline(line.trim()));
      } else {
        rawBlock = { tag: 'figure', lines: [line.trim()] };
      }
      continue;
    }

    const blockTag = openingBlockTag(line);
    if (blockTag) {
      breakBlocks();

      if (new RegExp('</' + blockTag + '\\s*>', 'i').test(line)) {
        html.push(renderInline(line.trim()));
      } else {
        rawBlock = { tag: blockTag, lines: [line.trim()] };
      }
      continue;
    }

    // 单独占一行的图片 / 分隔线，直接作为块级 HTML 输出。
    if (/^\s*<(?:img|hr|br)\b[^>]*>\s*$/i.test(line)) {
      breakBlocks();
      html.push(renderInline(line.trim()));
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      breakBlocks();
      const level = heading[1].length;
      html.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      breakBlocks();
      html.push('<hr />');
      continue;
    }

    const unorderedItem = line.match(/^[-*]\s+(.+)$/);
    const orderedItem = line.match(/^\d+\.\s+(.+)$/);
    if (unorderedItem || orderedItem) {
      breakBlocks();
      const nextListType = unorderedItem ? 'ul' : 'ol';
      if (listType !== nextListType) {
        closeList();
        listType = nextListType;
        html.push('<' + listType + '>');
      }
      html.push('<li>' + renderInline((unorderedItem ?? orderedItem)[1]) + '</li>');
      continue;
    }

    // 引用块里的裸文本（含 markdown 列表行）继续归入引用，而不是新段落。
    if (quotes.length && listType === null && !paragraph.length) {
      quotes.push({ depth: 1, text: line });
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  if (rawBlock !== null) {
    html.push(renderInline(rawBlock.lines.join(' ')));
  }

  breakBlocks();
  flushCode();
  return html.join('\n');
}

/* ------------------------------------------------------------------ *
 * frontmatter 与文章元数据
 * ------------------------------------------------------------------ */

function parseScalar(value) {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

function makeSlug(value) {
  const normalized = String(value)
    .normalize('NFKD')
    .replace(/\p{Mark}+/gu, '')
    .toLowerCase();
  const asciiSlug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (asciiSlug) return asciiSlug;

  // File names made only of non-ASCII characters (e.g. 随笔.md) would otherwise
  // produce an empty slug, which joins to the blog root and overwrites index.html.
  return normalized
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

function deriveDescription(content, fallback) {
  for (const rawLine of String(content).split(/\r?\n/)) {
    let line = rawLine.trim();

    if (!line) continue;
    if (/^(#{1,6}\s|!\[|<|\||-{3,}|`{3})/.test(line)) continue;

    // 引用块里的文字照样可以当摘要，剥掉 > 标记即可。
    line = line.replace(/^(?:>\s?)+/, '').trim();

    const text = line
      .replace(/<[^>]*>/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (text) return truncateSummary(text, 120);
  }

  return fallback;
}

/** 摘要超过上限时按词边界截断，避免英文单词被切成半截。 */
function truncateSummary(text, limit) {
  if (text.length <= limit) return text;

  const cut = text.slice(0, limit);
  const boundary = cut.lastIndexOf(' ');
  const trimmed = boundary > limit * 0.6 ? cut.slice(0, boundary) : cut;

  return trimmed.replace(/[\s,，。.、:：;；-]+$/, '') + '…';
}

function parseFrontmatter(source, fileName) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);

  if (!match) {
    const body = source.trim();
    const heading = body.match(/^#\s+(.+)$/m);
    const title = heading?.[1]?.trim() || fileName.replace(/\.md$/, '');
    const content = body.replace(/^#\s+.+(?:\r?\n|$)/, '').trim();
    const slug = makeSlug(fileName.replace(/\.md$/, ''));

    if (!slug) {
      throw new Error('Post ' + fileName + ' has no usable slug; add a slug to its frontmatter');
    }

    return {
      title,
      description: deriveDescription(content, title),
      slug,
      tags: [],
      source: content || body,
      publishedAt: null,
    };
  }

  const metadata = {};

  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (key === 'tags') {
      metadata.tags = value
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .split(',')
        .map((tag) => parseScalar(tag))
        .filter(Boolean);
      continue;
    }

    metadata[key] = parseScalar(value);
  }

  const slug = makeSlug(metadata.slug ?? fileName.replace(/\.md$/, ''));
  const body = source.slice(match[0].length).trim();

  if (!metadata.title || !slug) {
    throw new Error('Post ' + fileName + ' needs title and a valid slug');
  }

  return {
    ...metadata,
    title: String(metadata.title),
    description: metadata.description
      ? String(metadata.description)
      : deriveDescription(body, String(metadata.title)),
    slug,
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    source: body,
    publishedAt: metadata.date === undefined ? null : String(metadata.date),
  };
}

/* ------------------------------------------------------------------ *
 * 文件遍历工具
 * ------------------------------------------------------------------ */

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const fullPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
      continue;
    }

    if (!entry.isFile()) continue;

    files.push({
      name: entry.name,
      path: fullPath,
      // 统一成 POSIX 风格，方便和 Markdown 里写的 URL 对比。
      relativePath: relative(directory, fullPath).split(sep).join('/'),
      size: (await stat(fullPath)).size,
    });
  }

  return files;
}

/* ------------------------------------------------------------------ *
 * 发布时间清单：保存 md 的修改时间，跨构建 / 跨部署保持不变
 * ------------------------------------------------------------------ */

const gitOptions = { cwd: projectRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 };
// 默认 core.quotePath=true 会把中文文件名转义成 "\351\232\217..."，关掉才能直接比对文件名。
const gitPrefix = ['-c', 'core.quotePath=false'];

/**
 * CI 检出后文件的 mtime 会变成 checkout 时间，本地修改时间全部丢失。
 * 这时退回 git 里该文件最后一次提交的时间，仍然贴近「原 md 的修改时间」。
 */
function gitLastCommitTimes() {
  const result = spawnSync(
    'git',
    [...gitPrefix, 'log', '--format=%cI', '--name-only', '--', 'content/posts'],
    gitOptions,
  );

  if (result.error || result.status !== 0) return null;

  // 输出形如：<提交时间行> 换行 <文件路径行...>，每个提交只记一次，取最新（第一次出现）。
  const times = new Map();
  let current = null;

  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) continue;

    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
      const parsed = parseTimestamp(trimmed);
      current = parsed ? parsed.iso : null;
      continue;
    }

    if (!current) continue;

    const name = trimmed.split('/').pop();

    if (name && !times.has(name)) times.set(name, current);
  }

  return times;
}

/** 列出工作区里有未提交改动（含未跟踪）的 md，这些文件的 mtime 才是「真正的修改时间」。 */
function gitDirtyPosts() {
  const result = spawnSync(
    'git',
    [...gitPrefix, 'status', '--porcelain', '--', 'content/posts'],
    gitOptions,
  );

  if (result.error || result.status !== 0) return null;

  const dirty = new Set();

  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const path = line.slice(3).trim();
    if (!path) continue;

    // 重命名会写成 "old -> new"，取新路径。
    const target = path.includes(' -> ') ? path.split(' -> ').pop() : path;
    const name = target.split('/').pop();
    if (name) dirty.add(name);
  }

  return dirty;
}

async function readPublishTimes() {
  try {
    const parsed = JSON.parse(await readFile(publishTimesPath, 'utf8'));

    if (parsed && typeof parsed === 'object' && parsed.posts && typeof parsed.posts === 'object') {
      return parsed.posts;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnings.add('无法读取 .publish-times.json，将按 md 当前修改时间重新计算：' + error.message);
    }
  }

  return {};
}

async function writePublishTimes(entries) {
  const sorted = {};

  for (const name of Object.keys(entries).sort()) sorted[name] = entries[name];

  const payload = JSON.stringify({ version: 1, posts: sorted }, null, 2) + '\n';
  const previous = await readFile(publishTimesPath, 'utf8').catch(() => null);

  if (previous === payload) return;

  await writeFile(publishTimesPath, payload);
  console.log('Updated ' + relative(projectRoot, publishTimesPath));
}

async function readPosts() {
  const entries = await readdir(postsDirectory, { withFileTypes: true }).catch(() => []);
  const storedTimes = await readPublishTimes();
  const collectedTimes = {};
  const posts = [];
  const slugs = new Map();
  const commitTimes = gitLastCommitTimes();
  const dirtyPosts = gitDirtyPosts();

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

    const filePath = join(postsDirectory, entry.name);
    const [rawSource, fileStats] = await Promise.all([readFile(filePath), stat(filePath)]);
    const source = rawSource.toString('utf8');
    const hash = createHash('sha256').update(rawSource).digest('hex');
    const modified = toZonedIso(fileStats.mtime);
    const stored = storedTimes[entry.name];
    const storedMatches = Boolean(
      stored &&
      stored.hash === hash &&
      typeof stored.modified === 'string' &&
      Number.isFinite(Date.parse(stored.modified)),
    );

    // 清单里已有同内容记录就直接沿用；否则以当前 mtime 为准。
    let preserved = storedMatches && !refreshPublishTimes ? stored.modified : modified;

    if (!(storedMatches && !refreshPublishTimes)) {
      const committed = commitTimes?.get(entry.name) ?? null;
      const mtimeAge = Date.now() - fileStats.mtime.getTime();
      // 只有「工作区里这个 md 没有未提交改动」且 mtime 看起来是刚检出时，
      // 才认为本地修改时间已丢失，改用 git 提交时间。
      const checkedOut = dirtyPosts ? !dirtyPosts.has(entry.name) : true;

      if (committed && checkedOut && mtimeAge < 60_000 && Date.parse(committed) < fileStats.mtime.getTime()) {
        preserved = committed;
      }
    }

    // 记下 md 文件本身的修改时间；文件内容变了才更新为新的修改时间。
    collectedTimes[entry.name] = { hash, modified: preserved };

    const post = parseFrontmatter(source, entry.name);
    if (post.published === false || post.draft === true) continue;

    if (slugs.has(post.slug)) {
      throw new Error(
        'Posts ' + slugs.get(post.slug) + ' and ' + entry.name +
        ' both resolve to slug "' + post.slug + '"; set a distinct slug in the frontmatter',
      );
    }
    slugs.set(post.slug, entry.name);

    const explicitTime = post.publishedAt ? parseTimestamp(post.publishedAt) : null;

    if (post.publishedAt && !explicitTime) {
      warnings.add('frontmatter 里的日期无法解析（' + entry.name + '）：' + post.publishedAt);
    }

    const publishTime = explicitTime ?? {
      instant: Date.parse(preserved),
      iso: preserved,
      dateOnly: false,
    };

    const plainSource = post.source
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/<[^>]*>/g, ' ');
    const words = plainSource.trim().split(/\s+/).filter(Boolean).length;

    post.instant = publishTime.instant;
    post.iso = publishTime.iso;
    post.dateOnly = publishTime.dateOnly;
    post.publishTimeSource = explicitTime ? 'frontmatter' : 'file';
    post.readingTime = Math.max(1, Math.ceil(words / 260));
    posts.push(post);
  }

  await writePublishTimes(collectedTimes);

  return posts.sort((a, b) => b.instant - a.instant || String(a.title).localeCompare(String(b.title), 'zh-CN'));
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

function tagsMarkup(tags) {
  return tags.length
    ? '<div class="post-tags">' + tags.map((tag) => '<span>' + escapeHtml(tag) + '</span>').join('') + '</div>'
    : '';
}

function timeMarkup(post) {
  return '<time datetime="' + escapeAttribute(post.iso) + '">' + escapeHtml(formatPostTime(post)) + '</time>';
}

function postCard(post) {
  return '<article class="post-card">' +
    '<div class="post-card-meta">' + timeMarkup(post) +
    '<span>' + post.readingTime + ' 分钟阅读</span></div>' +
    '<h3><a href="/blog/' + escapeAttribute(post.slug) + '/">' + escapeHtml(post.title) + '</a></h3>' +
    '<p>' + escapeHtml(post.description) + '</p>' +
    tagsMarkup(post.tags) +
    '</article>';
}

function themeToggle() {
  return '<button class="theme-toggle" id="theme-toggle" type="button" aria-label="切换到暗色模式">' +
    '<svg class="theme-icon theme-icon--moon" aria-hidden="true" viewBox="0 0 24 24" width="19" height="19"><path d="M20.2 15.4A8.5 8.5 0 0 1 8.6 3.8 8.5 8.5 0 1 0 20.2 15.4Z" /></svg>' +
    '<svg class="theme-icon theme-icon--sun" aria-hidden="true" viewBox="0 0 24 24" width="19" height="19"><circle cx="12" cy="12" r="3.7" /><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l-1.42 1.42M17.65 6.35l-1.42-1.42" /></svg>' +
    '</button>';
}

function pageTemplate({
  title,
  description,
  content,
  active = 'blog',
  canonicalPath = '/',
  publishedTime = null,
}) {
  const canonicalUrl = siteUrl + canonicalPath;

  return '<!doctype html>\n' +
    '<html lang="zh-CN">\n' +
    '  <head>\n' +
    '    <meta charset="UTF-8" />\n' +
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '    <meta name="color-scheme" content="light dark" />\n' +
    '    <meta name="theme-color" content="#f7f7f4" />\n' +
    '    <meta name="description" content="' + escapeAttribute(description) + '" />\n' +
    '    <meta property="og:title" content="' + escapeAttribute(title) + '" />\n' +
    '    <meta property="og:description" content="' + escapeAttribute(description) + '" />\n' +
    '    <meta property="og:type" content="article" />\n' +
    (publishedTime
      ? '    <meta property="article:published_time" content="' + escapeAttribute(publishedTime) + '" />\n'
      : '') +
    '    <link rel="canonical" href="' + escapeAttribute(canonicalUrl) + '" />\n' +
    '    <link rel="alternate" type="application/rss+xml" title="初雪的博客" href="/feed.xml" />\n' +
    '    <title>' + escapeHtml(title) + '</title>\n' +
    '    <script src="/theme-init.js"></script>\n' +
    '    <link rel="stylesheet" href="/styles.css" />\n' +
    '    <script src="/theme.js" defer></script>\n' +
    '    <script src="/giscus.js" defer></script>\n' +
    '  </head>\n' +
    '  <body>\n' +
    '    ' + themeToggle() + '\n' +
    '    <div class="site-shell">\n' +
    '      <header class="site-header">\n' +
    '        <a class="site-brand" href="/">初雪 <span>/ chuxuehaocai</span></a>\n' +
    '        <nav class="site-nav" aria-label="主导航">\n' +
    '          <a class="' + (active === 'home' ? 'is-active' : '') + '" href="/">首页</a>\n' +
    '          <a class="' + (active === 'blog' ? 'is-active' : '') + '" href="/blog/">文章</a>\n' +
    '          <a class="' + (active === 'images' ? 'is-active' : '') + '" href="/images/">图床</a>\n' +
    '        </nav>\n' +
    '      </header>\n' +
    '      ' + content + '\n' +
    '      <footer class="site-footer"><span>人の数だけ美学がある。</span><a href="/feed.xml">订阅 RSS</a></footer>\n' +
    '    </div>\n' +
    '  </body>\n' +
    '</html>';
}

function commentsMarkup() {
  // 线上没配好时干脆不渲染，避免把安装提示暴露给访客；本地预览才给提示。
  if (!giscus.categoryId && !showGiscusSetupHint) return '';

  const attributes = [
    ['data-giscus', ''],
    ['data-repo', giscus.repo],
    ['data-repo-id', giscus.repoId],
    ['data-category', giscus.category],
    ['data-category-id', giscus.categoryId],
    ['data-mapping', giscus.mapping],
    ['data-input-position', giscus.inputPosition],
    ['data-lang', giscus.lang],
  ]
    .map(([key, value]) => (value ? ' ' + key + '="' + escapeAttribute(value) + '"' : ' ' + key + '=""'))
    .join('');

  return '<section class="post-comments" aria-labelledby="post-comments-title">\n' +
    '  <div class="section-heading"><h2 id="post-comments-title">评论</h2>' +
    '<span>由 GitHub Discussions 提供</span></div>\n' +
    '  <div class="giscus-mount"' + attributes + '></div>\n' +
    '  <noscript><p class="comments-setup">评论需要启用 JavaScript。</p></noscript>\n' +
    '</section>';
}

/**
 * giscus 需要 Discussion 分类的 node id，这个 id 只能通过它自己的接口查。
 * 解析结果会缓存到 content/posts/.giscus.json，之后的构建不再依赖网络；
 * 仓库装好 giscus App 之前取不到，就退回占位提示，不影响构建。
 */
async function readGiscusCache() {
  if (giscus.categoryId) return;

  try {
    const cached = JSON.parse(await readFile(giscusCachePath, 'utf8'));

    if (cached?.repo === giscus.repo && typeof cached.categoryId === 'string' && cached.categoryId) {
      giscus.categoryId = cached.categoryId;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      warnings.add('无法读取 .giscus.json，将重新查询 giscus 分类：' + error.message);
    }
  }
}

async function writeGiscusCache() {
  if (!giscus.categoryId) return;

  const payload = JSON.stringify(
    { repo: giscus.repo, category: giscus.category, categoryId: giscus.categoryId },
    null,
    2,
  ) + '\n';
  const previous = await readFile(giscusCachePath, 'utf8').catch(() => null);

  if (previous !== payload) await writeFile(giscusCachePath, payload);
}

async function resolveGiscusCategory() {
  await readGiscusCache();
  if (giscus.categoryId) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(
      'https://giscus.app/api/discussions/categories?repo=' + encodeURIComponent(giscus.repo),
      { signal: controller.signal },
    );

    if (!response.ok) throw new Error('HTTP ' + response.status);

    const data = await response.json();
    const categories = Array.isArray(data.categories) ? data.categories : [];
    const match =
      categories.find((entry) => entry.name === giscus.category) ?? categories[0];

    if (match?.id) {
      giscus.categoryId = match.id;
      console.log('giscus category: ' + match.name + ' (' + match.id + ')');
      await writeGiscusCache();
      return;
    }

    throw new Error('分类列表为空');
  } catch (error) {
    warnings.add(
      '未能自动解析 giscus 分类 id（' + error.message + '）。' +
      '到 https://github.com/apps/giscus 给仓库安装 App，' +
      '或在构建时提供 GISCUS_CATEGORY_ID，评论区就会正常加载。',
    );
  } finally {
    clearTimeout(timer);
  }
}

async function writeBlog(posts, images) {
  const blogDirectory = join(outputDirectory, 'blog');
  await mkdir(blogDirectory, { recursive: true });

  const cards = posts.length
    ? posts.map(postCard).join('\n')
    : '<p class="empty-state">还没有文章。把第一篇放进 <code>content/posts/</code> 吧。</p>';

  const indexContent = '<main class="blog-page">\n' +
    '  <section class="blog-intro">\n' +
    '    <p class="eyebrow">writing / notes</p>\n' +
    '    <h1>把折腾过的东西，写下来。</h1>\n' +
    '    <p>这里放一些关于 JVM、Minecraft、后端、逆向工程，以及日常观察的记录。短一点也没关系，先留下来。</p>\n' +
    '  </section>\n' +
    '  <section class="post-list" aria-labelledby="recent-posts">\n' +
    '    <div class="section-heading"><h2 id="recent-posts">最近文章</h2><span>' + posts.length + ' 篇</span></div>\n' +
    '    ' + cards + '\n' +
    '  </section>\n' +
    '</main>';

  await writeFile(
    join(blogDirectory, 'index.html'),
    pageTemplate({
      title: 'Things.',
      description: '',
      content: indexContent,
      canonicalPath: '/blog/',
    }),
  );

  for (const post of posts) {
    const postDirectory = join(blogDirectory, post.slug);
    await mkdir(postDirectory, { recursive: true });

    const postContent = '<main class="post-page">\n' +
      '  <a class="back-link" href="/blog/">← 返回文章列表</a>\n' +
      '  <article>\n' +
      '    <header class="post-header">\n' +
      '      <div class="post-card-meta">' + timeMarkup(post) +
      '<span>' + post.readingTime + ' 分钟阅读</span></div>\n' +
      '      <h1>' + escapeHtml(post.title) + '</h1>\n' +
      '      <p class="post-summary">' + escapeHtml(post.description) + '</p>\n' +
      '      ' + tagsMarkup(post.tags) + '\n' +
      '    </header>\n' +
      '    <div class="post-content">' + renderMarkdown(post.source) + '</div>\n' +
      '  </article>\n' +
      '  ' + commentsMarkup() + '\n' +
      '  <footer class="post-navigation"><a href="/blog/">← 所有文章</a></footer>\n' +
      '</main>';

    await writeFile(
      join(postDirectory, 'index.html'),
      pageTemplate({
        title: post.title,
        description: post.description,
        content: postContent,
        canonicalPath: '/blog/' + post.slug + '/',
        publishedTime: post.iso,
      }),
    );
  }

  const rssItems = posts.map((post) =>
    '\n    <item>\n' +
    '      <title>' + escapeHtml(post.title) + '</title>\n' +
    '      <link>' + siteUrl + '/blog/' + post.slug + '/</link>\n' +
    '      <guid>' + siteUrl + '/blog/' + post.slug + '/</guid>\n' +
    '      <pubDate>' + new Date(post.instant).toUTCString() + '</pubDate>\n' +
    '      <description>' + escapeHtml(post.description) + '</description>\n' +
    '    </item>'
  ).join('');

  await writeFile(
    join(outputDirectory, 'feed.xml'),
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0"><channel>\n' +
    '  <title>初雪的博客</title>\n' +
    '  <link>' + siteUrl + '/blog/</link>\n' +
    '  <description></description>\n' +
    '  <language>zh-CN</language>' + rssItems + '\n' +
    '</channel></rss>\n',
  );

  await writeImageBankPage(images);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return (value >= 10 ? Math.round(value) : value.toFixed(1)) + ' ' + units[index];
}

function imageCard(image) {
  const url = imageBankUrl + '/' + image.relativePath;
  const reference = '<img src="images/' + image.relativePath + '" alt="" align="center">';

  return '<figure class="image-card">' +
    '<a class="image-card-preview" href="' + escapeAttribute(url) + '">' +
    '<img src="' + escapeAttribute(url) + '" alt="' + escapeAttribute(image.relativePath) + '" loading="lazy" decoding="async" />' +
    '</a>' +
    '<figcaption>' +
    '<span class="image-card-name">' + escapeHtml(image.relativePath) + '</span>' +
    '<span class="image-card-meta">' + formatFileSize(image.size) + ' · ' + escapeHtml(url) + '</span>' +
    '<code class="image-card-snippet">' + escapeHtml(reference) + '</code>' +
    '</figcaption>' +
    '</figure>';
}

async function writeImageBankPage(images) {
  const pictures = images.filter((image) =>
    imageExtensions.has(('.' + image.name.split('.').pop()).toLowerCase()),
  );

  const list = pictures.length
    ? '<div class="image-bank">\n' + pictures.map(imageCard).join('\n') + '\n</div>'
    : '<p class="empty-state">还没有图片。把图片放进 <code>content/posts/images/</code>，重新构建即可。</p>';

  const content = '<main class="blog-page">\n' +
    '  <section class="blog-intro">\n' +
    '    <p class="eyebrow">images / hotlink</p>\n' +
    '    <h1>图床。</h1>\n' +
    '    <p>这个博客同时充当图床：图片放进 <code>content/posts/images/</code>，构建后会发布到 <code>' +
    imageBankUrl + '/</code>，本站和站外都可以直接引用。</p>\n' +
    '  </section>\n' +
    '  <section class="post-list" aria-labelledby="image-list">\n' +
    '    <div class="section-heading"><h2 id="image-list">图床文件</h2><span>' + pictures.length + ' 张</span></div>\n' +
    '    ' + list + '\n' +
    '  </section>\n' +
    '</main>';

  await mkdir(join(outputDirectory, 'images'), { recursive: true });
  await writeFile(
    join(outputDirectory, 'images', 'index.html'),
    pageTemplate({
      title: '图床',
      description: '博客的图片目录，按 /images/ 路径直接引用。',
      content,
      active: 'images',
      canonicalPath: '/images/',
    }),
  );
}

/* ------------------------------------------------------------------ *
 * 静态文件
 * ------------------------------------------------------------------ */

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });

  const entries = await readdir(source, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(sourcePath, destinationPath);
      return;
    }

    if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath);
      return;
    }

    throw new Error('Unsupported entry in ' + source + ': ' + entry.name);
  }));
}

async function warnMissingImages(posts, images, publicFiles) {
  const available = new Set(images.map((image) => image.relativePath));
  const publicSet = new Set(publicFiles.map((file) => file.relativePath));
  const referenced = new Set();

  for (const post of posts) {
    const markup = renderMarkdown(post.source);

    for (const match of markup.matchAll(/src="\/images\/([^"]+)"/g)) {
      referenced.add(match[1]);
    }
  }

  for (const reference of referenced) {
    if (available.has(reference) || publicSet.has('images/' + reference)) continue;
    warnings.add(
      '文章引用了不存在的图片：' + imageBankUrl + '/' + reference +
      '（把文件放到 content/posts/images/' + reference + '）',
    );
  }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

const sourceStats = await stat(sourceDirectory).catch(() => null);

if (!sourceStats?.isDirectory()) {
  throw new Error('Static source directory not found: ' + sourceDirectory);
}

const images = await collectFiles(imageBankDirectory);
const publicFiles = await collectFiles(sourceDirectory);

await rm(outputDirectory, { recursive: true, force: true });
await copyDirectory(sourceDirectory, outputDirectory);

if (images.length) {
  await copyDirectory(imageBankDirectory, join(outputDirectory, 'images'));
}

const posts = await readPosts();

await resolveGiscusCategory();
await warnMissingImages(posts, images, publicFiles);
await writeBlog(posts, images);

console.log('Copied ' + sourceDirectory + ' to ' + outputDirectory);
console.log('Built ' + posts.length + ' posts and ' + images.length + ' image-bank files');

for (const warning of warnings) {
  console.warn('warning: ' + warning);
}
