// __test__/shutdown.test.js
import path from 'path';
import { jest } from '@jest/globals';


// make sure the app binds an ephemeral port and redis is off, before import
process.env.PORT = process.env.PORT || '0';
process.env.REDIS_ON = 'false';

const origSetTimeout = global.setTimeout;
const origExit = process.exit;

let app, server, io, db;

// import after env setup
beforeAll(async () => {
  ({ app, server, io, db } = await import('../server.js'));
});

afterAll(async () => {
  try { server.close(); } catch {}
  try { io.close(); } catch {}
});

afterEach(() => {
  // restore globals between tests
  global.setTimeout = origSetTimeout;
  process.exit = origExit;
  jest.restoreAllMocks();
});

function emitSignal(sig) {
  // ensure the process listeners run synchronously in tests
  process.emit(sig);
}

test('graceful shutdown: server.close callback → exit(0), timeout scheduled', async () => {
  // 1) make server.close call its callback immediately
  const closeSpy = jest.spyOn(server, 'close').mockImplementation(cb => {
    // simulate “server stopped accepting conns” and we finished cleanup
    if (typeof cb === 'function') cb();
    return server;
  });

  // 2) stub io/db to avoid noise (not strictly required)
  const ioSpy = jest.spyOn(io, 'close').mockImplementation(() => {});
  const dbSpy = jest.spyOn(db, 'close').mockImplementation(() => {});

  // 3) capture the shutdown banner
  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

  // 4) intercept exit
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

  // 5) don’t actually run the timeout; just ensure it’s scheduled with 8000ms
  const unrefMock = jest.fn();
  const setTimeoutSpy = jest
    .spyOn(global, 'setTimeout')
    .mockImplementation((cb, ms) => ({ unref: unrefMock, ref: jest.fn() })); // don’t call cb

  // trigger SIGTERM
  emitSignal('SIGTERM');

  // assertions
  expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^\[shutdown] SIGTERM$/));
  expect(closeSpy).toHaveBeenCalledTimes(1);
  expect(ioSpy).toHaveBeenCalledTimes(1);
  expect(dbSpy).toHaveBeenCalledTimes(1);

  // timeout was scheduled for 8000ms and unref() called
  expect(setTimeoutSpy).toHaveBeenCalled();
  const [, delay] = setTimeoutSpy.mock.calls[0];
  expect(delay).toBe(8000);
  expect(unrefMock).toHaveBeenCalled();

  // graceful exit(0) happened, and no exit(1)
  expect(exitSpy).toHaveBeenCalledWith(0);
  expect(exitSpy).not.toHaveBeenCalledWith(1);
});

test('hard exit: server.close never finishes → timeout fires → exit(1)', async () => {
  // 1) server.close never calls its callback
  const closeSpy = jest.spyOn(server, 'close').mockImplementation(() => server);

  // 2) intercept exit
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

  // 3) capture timeout callback so we can invoke it manually
  let timeoutCb;
  const unrefMock = jest.fn();
  jest.spyOn(global, 'setTimeout').mockImplementation((cb, ms) => {
    timeoutCb = cb;
    return { unref: unrefMock, ref: jest.fn() };
  });

  // trigger SIGINT (same behavior as SIGTERM)
  emitSignal('SIGINT');

  // nothing yet: close callback never fired
  expect(exitSpy).not.toHaveBeenCalled();

  // simulate “8 seconds later”
  expect(typeof timeoutCb).toBe('function');
  timeoutCb(); // hard-exit path

  // exit with code 1
  expect(exitSpy).toHaveBeenCalledWith(1);
  // also confirm server.close was attempted
  expect(closeSpy).toHaveBeenCalledTimes(1);
});