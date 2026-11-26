/**
 * 构建自检：验证图床渲染、HTML 消毒与「发布时间取 md 修改时间」的行为。
 *
 *   npm run check
 *
 * 会在 content/posts/ 里临时放一篇文章，跑完自动删除并重建 dist。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = (...parts) => join(projectRoot, ...parts);
const fixtureName = '_self-check.md';
const fixturePath = projectPath('content', 'posts', fixtureName);
const manifestPath = projectPath('content', 'posts', '.publish-times.json');

const fixture = [
  '---',
  'title: "构建自检"',
  'slug: "self-check"',
  '---',
  '',
  '# 构建自检',
  '',
  '<img src="images/ZkmDefault.png" alt="" align="center">',
  '',
  '![md 语法](images/ZkmCracked.png "标题")',
  '',
  '<img src="images/ZkmDefault.png" alt="绝对" width="480" align="left">',
  '',
  '<figure>',
  '  <img src="images/ZkmCracked.png" alt="fig">',
  '  <figcaption>图注</figcaption>',
  '</figure>',
  '',
  '<div align="center"><img src="images/ZkmDefault.png" alt="div"></div>',
  '',
  '文本里 <img src="images/ZkmCracked.png" alt="inline"> 行内图。',
  '',
  '<script>alert(1)</script><iframe src="x"></iframe>',
  '',
  '- 列表项一',
  '- 列表项二',
  '- 列表项三',
  '',
  '1. 有序一',
  '2. 有序二',
  '',
  '中文编码检查：你好。',
  '',
].join('\n');

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : ''));
};

const build = (env = {}) => execFileSync(process.execPath, [projectPath('scripts', 'build.mjs')], {
  cwd: projectRoot,
  encoding: 'utf8',
  env: { ...process.env, ...env },
  stdio: ['ignore', 'pipe', 'pipe'],
});

const readManifest = () => JSON.parse(readFileSync(manifestPath, 'utf8')).posts;

const originalManifest = readFileSync(manifestPath, 'utf8');

mkdirSync(dirname(fixturePath), { recursive: true });
writeFileSync(fixturePath, fixture, 'utf8');

try {
  build();

  const html = readFileSync(projectPath('dist', 'blog', 'self-check', 'index.html'), 'utf8');
  const body = html.slice(html.indexOf('post-content'), html.indexOf('</article>'));
  const imageCount = (body.match(/<img /g) ?? []).length;

  record('`<img src="images/…" align="center">` 解析为居中图片',
    /class="post-image post-image--center" src="\/images\/ZkmDefault\.png"/.test(body));
  record('Markdown 图片语法与 title 正常',
    /alt="md 语法"[^>]*title="标题"/.test(body));
  record('相对 / 绝对路径统一映射到 /images/',
    /src="\/images\/ZkmCracked\.png"/.test(body) && !/src="images\//.test(body));
  record('align 与 width 保留为样式类与尺寸',
    /post-image--left[^>]*width="480"/.test(body));
  record('figure + figcaption 图注',
    /<figure>[\s\S]*<figcaption>图注<\/figcaption>/.test(body));
  record('div align="center" 转为 text-center',
    /<div class="text-center">/.test(body));
  record('行内图片不被拆成独立段落',
    /文本里 <img class="post-image"[^>]*\/> 行内图。/.test(body));
  record('script / iframe 被丢弃',
    !/<script/i.test(body) && !/<iframe/i.test(body));
  record('所有图片都带 loading="lazy"',
    imageCount > 0 && imageCount === (body.match(/ loading="lazy"/g) ?? []).length,
    imageCount + ' 张');
  record('文章页含 article:published_time',
    html.includes('article:published_time'));
  record('配置了分类即渲染评论区',
    html.includes('post-comments') && /data-category-id="[^"]+"/.test(html));

  // 提供了分类 id 时才挂 giscus，且属性齐全。
  build({ GISCUS_CATEGORY_ID: 'DIC_test_category' });
  const withComments = readFileSync(
    projectPath('dist', 'blog', 'self-check', 'index.html'),
    'utf8',
  );
  record('配置分类后挂载 giscus',
    withComments.includes('class="giscus-mount"') &&
      withComments.includes('data-category-id="DIC_test_category"') &&
      withComments.includes('data-repo-id="R_kgDOTTfsLQ"') &&
      withComments.includes('data-mapping="pathname"'));
  record('评论区在正文之后、页脚之前',
    withComments.indexOf('post-comments') > withComments.indexOf('post-content') &&
      withComments.indexOf('post-comments') < withComments.indexOf('post-navigation'));
  record('giscus 脚本随页面加载', withComments.includes('src="/giscus.js"'));

  // 正文与 Header 用同一套字体：两者都必须走 --font-sans，不再出现衬线正文。
  const css = readFileSync(projectPath('public', 'styles.css'), 'utf8');
  const ruleBody = (css.match(/\.post-content\s*\{[^}]*\}/) ?? [''])[0];
  const ruleHeader = (css.match(/\.post-content h2,\s*\.post-content h3\s*\{[^}]*\}/) ?? [''])[0];
  const ruleRoot = (css.match(/:root\s*\{[^}]*--font-sans[^}]*\}/) ?? [''])[0];
  record('.post-content 使用 --font-sans', /font-family:\s*var\(--font-sans\)/.test(ruleBody));
  record('正文标题使用 --font-sans', /font-family:\s*var\(--font-sans\)/.test(ruleHeader));
  record('--font-sans 与 body 同源',
    /--font-sans:/.test(ruleRoot) && /body\s*\{[^}]*font-family:\s*var\(--font-sans\)/.test(css));
  record('正文不再使用衬线字族',
    !/Noto Serif CJK SC|Source Han Serif SC|Songti SC|STSong/.test(css));

  // 列表必须合并成一整个 <ul>/<ol>，不能每项新开一个。
  const ulBlocks = body.match(/<ul>[\s\S]*?<\/ul>/g) ?? [];
  const olBlocks = body.match(/<ol>[\s\S]*?<\/ol>/g) ?? [];
  record('连续无序列表合并为单个 <ul>',
    ulBlocks.length === 1 && (ulBlocks[0].match(/<li>/g) ?? []).length === 3,
    ulBlocks.length + ' 个 ul, ' + (ulBlocks[0]?.match(/<li>/g) ?? []).length + ' 项');
  record('连续有序列表合并为单个 <ol>',
    olBlocks.length === 1 && (olBlocks[0].match(/<li>/g) ?? []).length === 2);

  // 编码回归：中文必须原样出现，且不得有替换字符或 mojibake 特征。
  record('中文按 UTF-8 正确渲染', body.includes('中文编码检查：你好。'));
  record('无 U+FFFD 替换字符', !body.includes('\uFFFD'));
  record('无 mojibake 特征字', !/浣|鎴|鈥|锛|銆|鐨|浠|涓|鏄/.test(body));

  // RSS：链接必须是正式域名，不能把内网地址写进线上 feed。
  const feed = readFileSync(projectPath('dist', 'feed.xml'), 'utf8');
  record('feed 不含 localhost / 127.0.0.1',
    !/localhost|127\.0\.0\.1|\[::1\]/.test(feed));
  record('feed 条目指向正式域名',
    /<link>https:\/\/naominet\.dev\/blog\/self-check\/<\/link>/.test(feed),
    (feed.match(/<link>([^<]+)<\/link>/) ?? [])[1]);
  record('feed 声明 atom:link 自身地址',
    /<atom:link href="https:\/\/naominet\.dev\/feed\.xml" rel="self"/.test(feed));
  record('feed 的中文 slug 已百分号编码',
    /<link>https:\/\/naominet\.dev\/blog\/%E9%9A%8F%E7%AC%94\/<\/link>/.test(feed));
  record('feed 是可解析的 XML（UTF-8 无坏字节）',
    !feed.includes('\uFFFD') && feed.startsWith('<?xml'));

  // canonical 必须与 feed 用同一个站点地址。
  record('canonical 指向正式域名',
    html.includes('<link rel="canonical" href="https://naominet.dev/blog/self-check/" />'));

  // 只动 mtime、不动内容：发布时间必须保持不变。
  const hashBefore = createHash('sha256').update(readFileSync(fixturePath)).digest('hex');
  const timeBefore = readManifest()[fixtureName].modified;
  const bumped = new Date(Date.now() + 3_600_000);
  utimesSync(fixturePath, bumped, bumped);
  build();
  const timeAfterMtime = readManifest()[fixtureName].modified;
  record('仅改动 mtime 时发布时间不变', timeBefore === timeAfterMtime,
    timeBefore + ' -> ' + timeAfterMtime);

  // 内容变化后应改用新的修改时间。
  writeFileSync(fixturePath, fixture + '追加一行。\n', 'utf8');
  const touched = new Date(Date.now() + 7_200_000);
  utimesSync(fixturePath, touched, touched);
  build();
  const timeAfterEdit = readManifest()[fixtureName].modified;
  const hashAfter = createHash('sha256').update(readFileSync(fixturePath)).digest('hex');
  record('内容改动后发布时间更新', timeAfterEdit !== timeAfterMtime,
    timeAfterMtime + ' -> ' + timeAfterEdit);
  record('内容哈希随改动更新', hashAfter !== hashBefore);
} finally {
  rmSync(fixturePath, { force: true });
  writeFileSync(manifestPath, originalManifest, 'utf8');
  build();
}

record('删除文章后发布时间清单同步清理',
  !(fixtureName in readManifest()));

const failed = results.filter((entry) => !entry.ok).length;

console.log(failed === 0 ? '\n全部通过（' + results.length + ' 项）' : '\n' + failed + ' 项失败');
process.exit(failed === 0 ? 0 : 1);
