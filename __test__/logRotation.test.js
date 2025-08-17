// __test__/logRotation.test.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { jest } from '@jest/globals';

// --- mock archiver (ESM-safe) ---
jest.unstable_mockModule('archiver', () => {
  let lastInstance;

  const factory = jest.fn(() => {
    const archive = new EventEmitter();

    archive._output = null;
    archive.pipe = jest.fn(dest => { archive._output = dest; });
    archive.directory = jest.fn();

    // schedule emitting 'close' on the *output* stream so zipLogs() resolves
    archive.finalize = jest.fn(() => {
      setTimeout(() => {
        if (archive._output) archive._output.emit('close');
      }, 5);
    });

    archive.pointer = jest.fn(() => 1234);

    lastInstance = archive;
    return archive;
  });

  // expose the last-created instance for tests that need to emit errors
  factory.__getLast = () => lastInstance;

  return { __esModule: true, default: factory };
});



// --- mock cron ---
jest.unstable_mockModule('node-cron', () => {
  return { __esModule: true, default: { schedule: jest.fn((_, cb) => (scheduleLogRotation._cb = cb)) } };
});

// import after mocks
const { zipLogs, scheduleLogRotation, getFolderSize, LOG_DIR, ZIPPED_DIR, MAX_LOG_SIZE_MB } = await import('../logRotation.js');
const archiver = (await import('archiver')).default;
const cron = (await import('node-cron')).default;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

beforeEach(() => {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);
  if (!fs.existsSync(ZIPPED_DIR)) fs.mkdirSync(ZIPPED_DIR);
});

afterEach(() => {
  if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
  if (fs.existsSync(ZIPPED_DIR)) fs.rmSync(ZIPPED_DIR, { recursive: true, force: true });
});

test('getFolderSize counts nested file sizes', () => {
  fs.writeFileSync(path.join(LOG_DIR, 'a.log'), 'abc');
  const sub = path.join(LOG_DIR, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'b.log'), '12345');
  const size = getFolderSize(LOG_DIR);
  expect(size).toBeGreaterThan(0);
});

test('zipLogs zips and clears logs', async () => {
  fs.writeFileSync(path.join(LOG_DIR, 'test.log'), 'abcdef');
  await zipLogs();
  const logsLeft = fs.readdirSync(LOG_DIR);
  expect(logsLeft.length).toBe(0);
  expect(archiver).toHaveBeenCalled();
});

test('zipLogs rejects on archive error', async () => {
  const archiver = (await import('archiver')).default;

  // start the operation, which will create an archiver instance internally
  const promise = zipLogs();

  // emit error on that exact instance
  setTimeout(() => archiver.__getLast().emit('error', new Error('fail')), 1);

  await expect(promise).rejects.toThrow('fail');
});


test('scheduleLogRotation calls cron.schedule', () => {
  scheduleLogRotation();
  expect(cron.schedule).toHaveBeenCalled();
});

test('scheduleLogRotation triggers zip when size > MAX_LOG_SIZE_MB', async () => {
  scheduleLogRotation();
  fs.writeFileSync(path.join(LOG_DIR, 'big.log'), 'x'.repeat((MAX_LOG_SIZE_MB + 1) * 1024 * 1024));
  await scheduleLogRotation._cb();
  const logsLeft = fs.readdirSync(LOG_DIR);
  expect(logsLeft.length).toBe(0);
});

test('scheduleLogRotation does nothing when folder small', async () => {
  scheduleLogRotation();
  fs.writeFileSync(path.join(LOG_DIR, 'small.log'), 'tiny');
  await scheduleLogRotation._cb();
  expect(fs.existsSync(path.join(LOG_DIR, 'small.log'))).toBe(true);
});

test('scheduleLogRotation handles error in getFolderSize', async () => {
  scheduleLogRotation();
  const spy = jest.spyOn(fs, 'readdirSync').mockImplementation(() => { throw new Error('bad'); });
  await scheduleLogRotation._cb(); // should not throw
  spy.mockRestore();
});
