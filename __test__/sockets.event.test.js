// __test__/socket.events.test.js
/**
 * Verifies that the server logs a "client connected" line on socket connect
 * and a "client disconnected" line when the client disconnects.
 *
 * Requires: `socket.io-client` as a devDependency.
 *   npm i -D socket.io-client
 */

import { io as Client } from 'socket.io-client';
import { jest } from '@jest/globals';

let server, io, app;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForLogMatch(logSpy, regex, { timeoutMs = 1000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = logSpy.mock.calls.map(args => args.join(' ')).join('\n');
    const m = text.match(regex);
    if (m) return { text, match: m };
    await sleep(intervalMs);
  }
  const finalText = logSpy.mock.calls.map(args => args.join(' ')).join('\n');
  return { text: finalText, match: null };
}

beforeAll(async () => {
  // bind the HTTP server to an ephemeral port in tests
  process.env.PORT = process.env.PORT || '0';
  process.env.REDIS_ON = 'false'; // keep redis off in tests
  ({ app, server, io } = await import('../server.js'));
});

afterAll(async () => {
  try { server.close(); } catch {}
  try { io.close(); } catch {}
});
test('logs on socket connect and disconnect', async () => {
  jest.setTimeout(10000);

  const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

  const { port } = server.address();
  const url = `http://localhost:${port}`;

  const socket = Client(url, {
    transports: ['websocket'], // avoid polling noise
    reconnection: false,
    forceNew: true,
  });

  // wait for client connect
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 4000);
    socket.on('connect', () => { clearTimeout(t); resolve(); });
    socket.on('connect_error', (e) => { clearTimeout(t); reject(e); });
  });

  // wait until the connect log is present and capture the id
  const connected = await waitForLogMatch(
    logSpy,
    /\[socket\].*client connected.*"id"\s*:\s*"([^"]+)"/
  );
  expect(connected.match).toBeTruthy();
  const connectedId = connected.match[1];

  // now disconnect on the client side
  const clientSawDisconnect = new Promise((res) => socket.on('disconnect', res));
  socket.disconnect();
  await clientSawDisconnect;

  // poll logs until we see the server's disconnect line (and same id)
  const disconnected = await waitForLogMatch(
    logSpy,
    new RegExp(`\\[socket\\].*client disconnected.*"id"\\s*:\\s*"${connectedId}"`)
  );

  expect(disconnected.match).toBeTruthy();

  logSpy.mockRestore();
});