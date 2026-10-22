/**
 * SSE client for /api/notifications/stream — live notifications from own backend.
 */
const http = require('http');
const https = require('https');
const config = require('./config.cjs');

function parseSseChunk(buffer) {
  const events = [];
  const parts = buffer.split('\n\n');
  const remainder = parts.pop() || '';

  for (const part of parts) {
    const dataLine = part
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('data:'));
    if (!dataLine) continue;
    const jsonText = dataLine.replace(/^data:\s?/, '');
    if (!jsonText) continue;
    try {
      events.push(JSON.parse(jsonText));
    } catch {
      /* ignore malformed chunk */
    }
  }

  return { events, remainder };
}

function connectNotificationStream(accessToken, handlers = {}) {
  const { onEvent, onError, onClose } = handlers;
  if (!accessToken) {
    onError?.(new Error('Missing access token'));
    return () => {};
  }

  const base = config.resolveApiUrl();
  const url = new URL(`${base}/api/notifications/stream`);
  const lib = url.protocol === 'https:' ? https : http;
  let stopped = false;
  let req = null;
  let buffer = '';
  let reconnectTimer = null;

  const scheduleReconnect = (ms) => {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, ms);
  };

  const connect = () => {
    if (stopped) return;

    req = lib.request(
      url,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          onError?.(new Error(`Notification stream failed (${res.statusCode})`));
          scheduleReconnect(5000);
          return;
        }

        res.on('data', (chunk) => {
          if (stopped) return;
          buffer += chunk.toString('utf8');
          const parsed = parseSseChunk(buffer);
          buffer = parsed.remainder;
          for (const event of parsed.events) {
            onEvent?.(event);
          }
        });

        res.on('end', () => {
          if (!stopped) {
            onClose?.();
            scheduleReconnect(3000);
          }
        });
      }
    );

    req.on('error', (err) => {
      if (stopped) return;
      onError?.(err);
      scheduleReconnect(5000);
    });

    req.end();
  };

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      req?.destroy();
    } catch {
      /* ignore */
    }
    req = null;
  };
}

module.exports = { connectNotificationStream };
