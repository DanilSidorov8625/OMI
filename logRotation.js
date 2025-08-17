// logRotation.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import cron from 'node-cron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_DIR = path.join(__dirname, 'logs');
const ZIPPED_DIR = path.join(__dirname, 'zippedLogs');
const MAX_LOG_SIZE_MB = 50;

if (!fs.existsSync(ZIPPED_DIR)) fs.mkdirSync(ZIPPED_DIR);

function getFolderSize(folderPath) {
  const files = fs.readdirSync(folderPath);
  let total = 0;
  for (const file of files) {
    const filePath = path.join(folderPath, file);
    const stat = fs.statSync(filePath);
    if (stat.isFile()) total += stat.size;
    else if (stat.isDirectory()) total += getFolderSize(filePath);
  }
  return total;
}

function zipLogs() {
  return new Promise((resolve, reject) => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const zipPath = path.join(ZIPPED_DIR, `logs-${timestamp}.zip`);

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => {
      fs.rmSync(LOG_DIR, { recursive: true, force: true });
      fs.mkdirSync(LOG_DIR);
      resolve();
    });

    archive.on('error', err => reject(err));
    archive.pipe(output);
    archive.directory(LOG_DIR, false);
    archive.finalize();
  });
}

function scheduleLogRotation() {
  cron.schedule('0 * * * *', async () => {
    try {
      if (!fs.existsSync(LOG_DIR)) return;
      const sizeBytes = getFolderSize(LOG_DIR);
      const sizeMB = sizeBytes / (1024 * 1024);
      if (sizeMB > MAX_LOG_SIZE_MB) {
        await zipLogs();
      }
    } catch (err) {
      console.error('[logs] Check error:', err);
    }
  });
}

export { scheduleLogRotation, zipLogs, getFolderSize, LOG_DIR, ZIPPED_DIR, MAX_LOG_SIZE_MB };
