import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 4173;

const MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.mp4', 'video/mp4'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requestedRoot = process.argv[2] ?? 'public';
const rootDirectory = resolve(projectRoot, requestedRoot);

function isInsideRoot(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

function sendText(response, statusCode, message, extraHeaders = {}) {
  const body = `${message}\n`;
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(body);
}

async function resolveRequestedPath(root, pathname) {
  let decodedPath;

  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return { error: 400 };
  }

  if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
    return { error: 400 };
  }

  const relativePath = decodedPath.replace(/^\/+/, '');
  const candidatePath = resolve(root, relativePath);

  if (!isInsideRoot(root, candidatePath)) {
    return { error: 404 };
  }

  const resolvedPath = await realpath(candidatePath).catch(() => null);

  if (!resolvedPath || !isInsideRoot(root, resolvedPath)) {
    return { error: 404 };
  }

  const candidateStats = await stat(resolvedPath).catch(() => null);

  if (!candidateStats) {
    return { error: 404 };
  }

  if (candidateStats.isDirectory()) {
    if (!pathname.endsWith('/')) {
      return { redirect: true };
    }

    const indexPath = await realpath(join(resolvedPath, 'index.html')).catch(
      () => null,
    );

    if (!indexPath || !isInsideRoot(root, indexPath)) {
      return { error: 404 };
    }

    const indexStats = await stat(indexPath).catch(() => null);

    if (!indexStats?.isFile()) {
      return { error: 404 };
    }

    return { filePath: indexPath, stats: indexStats };
  }

  if (!candidateStats.isFile()) {
    return { error: 404 };
  }

  return { filePath: resolvedPath, stats: candidateStats };
}

const realRoot = await realpath(rootDirectory).catch(() => null);

if (!realRoot || !(await stat(realRoot)).isDirectory()) {
  throw new Error(`Static directory not found: ${rootDirectory}`);
}

const server = createServer(async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendText(response, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }

  let requestUrl;

  try {
    requestUrl = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);
  } catch {
    sendText(response, 400, 'Bad Request');
    return;
  }

  const result = await resolveRequestedPath(realRoot, requestUrl.pathname);

  if (result.error) {
    sendText(response, result.error, result.error === 400 ? 'Bad Request' : 'Not Found');
    return;
  }

  if (result.redirect) {
    response.writeHead(308, {
      'Cache-Control': 'no-store',
      Location: `${requestUrl.pathname}/${requestUrl.search}`,
      'X-Content-Type-Options': 'nosniff',
    });
    response.end();
    return;
  }

  const contentType =
    MIME_TYPES.get(extname(result.filePath).toLowerCase()) ??
    'application/octet-stream';

  response.writeHead(200, {
    'Cache-Control': 'no-cache',
    'Content-Length': result.stats.size,
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(result.filePath);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${realRoot} at http://${HOST}:${PORT}`);
});
