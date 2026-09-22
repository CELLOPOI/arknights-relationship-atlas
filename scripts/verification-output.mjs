import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function verificationDirectory(category) {
  const directory = process.env.OUTPUT_DIR
    ? path.resolve(process.env.OUTPUT_DIR)
    : fileURLToPath(new URL(`../.runtime/verification/${category}/`, import.meta.url));
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function verificationReport(category, filename) {
  if (process.env.OUTPUT_PATH) {
    const filename = path.resolve(process.env.OUTPUT_PATH);
    await mkdir(path.dirname(filename), { recursive: true });
    return filename;
  }
  return path.join(await verificationDirectory(category), filename);
}
