import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirectory = join(projectRoot, 'public');
const outputDirectory = join(projectRoot, 'dist');

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });

  const entries = await readdir(source, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
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

      throw new Error(`Unsupported entry in public/: ${entry.name}`);
    }),
  );
}

const sourceStats = await stat(sourceDirectory).catch(() => null);

if (!sourceStats?.isDirectory()) {
  throw new Error(`Static source directory not found: ${sourceDirectory}`);
}

await copyDirectory(sourceDirectory, outputDirectory);
console.log(`Copied ${sourceDirectory} to ${outputDirectory}`);
