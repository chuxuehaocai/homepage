import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(projectRoot, 'public');
const outputDirectory = join(projectRoot, 'dist');
const postsDirectory = join(projectRoot, 'content', 'posts');
const siteUrl = (process.env.SITE_URL ?? 'http://localhost:4173').replace(/\/$/, '');
const templateTick = String.fromCharCode(96);

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
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseFrontmatter(source, fileName, fallbackDate) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);

  if (!match) {
    const body = source.trim();
    const heading = body.match(/^#\s+(.+)$/m);
    const title = heading?.[1]?.trim() || fileName.replace(/\.md$/, '');
    const content = body.replace(/^#\s+.+(?:\r?\n|$)/, '').trim();
    const description = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#')) || title;

    return {
      title,
      description,
      date: fallbackDate,
      slug: makeSlug(fileName.replace(/\.md$/, '')),
      tags: [],
      source: content || body,
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

  if (!metadata.title || !metadata.date || !slug) {
    throw new Error('Post ' + fileName + ' needs title, date, and a valid slug');
  }

  return {
    ...metadata,
    slug,
    tags: Array.isArray(metadata.tags) ? metadata.tags : [],
    source: source.slice(match[0].length).trim(),
  };
}
function safeUrl(value) {
  const url = String(value);
  return /^(https?:\/\/|\/|#)/i.test(url) ? url : '#';
}

function renderInline(value) {
  let html = escapeHtml(value);
  const inlineCode = [];
  const codePattern = new RegExp(templateTick + '([^' + templateTick + ']*)' + templateTick, 'g');

  html = html.replace(codePattern, (_, code) => {
    inlineCode.push('<code>' + code + '</code>');
    return '\u0000' + (inlineCode.length - 1) + '\u0000';
  });
  html = html.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g, (_, label, url, title) => {
    const titleAttribute = title ? ' title="' + escapeAttribute(title) + '"' : '';
    return '<a href="' + escapeAttribute(safeUrl(url)) + '"' + titleAttribute + '>' + label + '</a>';
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');

  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => inlineCode[Number(index)]);
}

function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let listType = null;
  let codeLines = null;
  let codeLanguage = '';
  const fencePattern = new RegExp('^' + templateTick.repeat(3) + '\\s*([\\w-]*)\\s*$');

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push('<p>' + renderInline(paragraph.join(' ')) + '</p>');
      paragraph = [];
    }
  };

  const closeList = () => {
    if (listType) {
      html.push('</' + listType + '>');
      listType = null;
    }
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

  for (const line of lines) {
    const fence = line.match(fencePattern);

    if (fence) {
      flushParagraph();
      closeList();

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

    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      closeList();
      html.push('<hr />');
      continue;
    }

    const blockquote = line.match(/^>\s?(.*)$/);
    if (blockquote) {
      flushParagraph();
      closeList();
      html.push('<blockquote><p>' + renderInline(blockquote[1]) + '</p></blockquote>');
      continue;
    }

    const unorderedItem = line.match(/^[-*]\s+(.+)$/);
    const orderedItem = line.match(/^\d+\.\s+(.+)$/);
    if (unorderedItem || orderedItem) {
      flushParagraph();
      const nextListType = unorderedItem ? 'ul' : 'ol';
      if (listType !== nextListType) {
        closeList();
        listType = nextListType;
        html.push('<' + listType + '>');
      }
      html.push('<li>' + renderInline((unorderedItem ?? orderedItem)[1]) + '</li>');
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  closeList();
  flushCode();
  return html.join('\n');
}

function formatDate(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(date + 'T00:00:00'));
}

function tagsMarkup(tags) {
  return tags.length
    ? '<div class="post-tags">' + tags.map((tag) => '<span>' + escapeHtml(tag) + '</span>').join('') + '</div>'
    : '';
}

function postCard(post) {
  return '<article class="post-card">' +
    '<div class="post-card-meta"><time datetime="' + escapeAttribute(post.date) + '">' +
    escapeHtml(formatDate(post.date)) + '</time><span>' + post.readingTime + ' 分钟阅读</span></div>' +
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

function pageTemplate({ title, description, content, active = 'blog', canonicalPath = '/' }) {
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
    '    <link rel="canonical" href="' + escapeAttribute(canonicalUrl) + '" />\n' +
    '    <link rel="alternate" type="application/rss+xml" title="初雪的博客" href="/feed.xml" />\n' +
    '    <title>' + escapeHtml(title) + '</title>\n' +
    '    <script src="/theme-init.js"></script>\n' +
    '    <link rel="stylesheet" href="/styles.css" />\n' +
    '    <script src="/theme.js" defer></script>\n' +
    '  </head>\n' +
    '  <body>\n' +
    '    ' + themeToggle() + '\n' +
    '    <div class="site-shell">\n' +
    '      <header class="site-header">\n' +
    '        <a class="site-brand" href="/">初雪 <span>/ chuxuehaocai</span></a>\n' +
    '        <nav class="site-nav" aria-label="主导航">\n' +
    '          <a class="' + (active === 'home' ? 'is-active' : '') + '" href="/">首页</a>\n' +
    '          <a class="' + (active === 'blog' ? 'is-active' : '') + '" href="/blog/">文章</a>\n' +
    '        </nav>\n' +
    '      </header>\n' +
    '      ' + content + '\n' +
    '      <footer class="site-footer"><span>人の数だけ美学がある。</span><a href="/feed.xml">订阅 RSS</a></footer>\n' +
    '    </div>\n' +
    '  </body>\n' +
    '</html>';
}

async function readPosts() {
  const entries = await readdir(postsDirectory, { withFileTypes: true }).catch(() => []);
  const posts = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const filePath = join(postsDirectory, entry.name);
    const source = await readFile(filePath, 'utf8');
    const fileStats = await stat(filePath);
    const fallbackDate = fileStats.mtime.toISOString().slice(0, 10);
    const post = parseFrontmatter(source, entry.name, fallbackDate);
    if (post.published === false || post.draft === true) continue;

    const words = post.source.trim().split(/\s+/).filter(Boolean).length;
    post.readingTime = Math.max(1, Math.ceil(words / 260));
    posts.push(post);
  }

  return posts.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

async function writeBlog(posts) {
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
      '      <div class="post-card-meta"><time datetime="' + escapeAttribute(post.date) + '">' +
      escapeHtml(formatDate(post.date)) + '</time><span>' + post.readingTime + ' 分钟阅读</span></div>\n' +
      '      <h1>' + escapeHtml(post.title) + '</h1>\n' +
      '      <p class="post-summary">' + escapeHtml(post.description) + '</p>\n' +
      '      ' + tagsMarkup(post.tags) + '\n' +
      '    </header>\n' +
      '    <div class="post-content">' + renderMarkdown(post.source) + '</div>\n' +
      '  </article>\n' +
      '  <footer class="post-navigation"><a href="/blog/">← 所有文章</a></footer>\n' +
      '</main>';

    await writeFile(
      join(postDirectory, 'index.html'),
      pageTemplate({
        title: post.title + '',
        description: post.description,
        content: postContent,
        canonicalPath: '/blog/' + post.slug + '/',
      }),
    );
  }

  const rssItems = posts.map((post) =>
    '\n    <item>\n' +
    '      <title>' + escapeHtml(post.title) + '</title>\n' +
    '      <link>' + siteUrl + '/blog/' + post.slug + '/</link>\n' +
    '      <guid>' + siteUrl + '/blog/' + post.slug + '/</guid>\n' +
    '      <pubDate>' + new Date(post.date + 'T08:00:00+08:00').toUTCString() + '</pubDate>\n' +
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
}

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

    throw new Error('Unsupported entry in public/: ' + entry.name);
  }));
}

const sourceStats = await stat(sourceDirectory).catch(() => null);

if (!sourceStats?.isDirectory()) {
  throw new Error('Static source directory not found: ' + sourceDirectory);
}

await rm(outputDirectory, { recursive: true, force: true });
await copyDirectory(sourceDirectory, outputDirectory);
await writeBlog(await readPosts());
console.log('Copied ' + sourceDirectory + ' to ' + outputDirectory);
