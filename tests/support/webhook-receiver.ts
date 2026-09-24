import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedWebhook {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

/**
 * A real HTTP endpoint for the dispatcher to call. `respond` picks the status
 * for the nth request (1-based), so tests can script failures.
 */
export const startWebhookReceiver = async (
  respond: (n: number) => number = () => 200,
  delayMs = 0,
) => {
  const received: ReceivedWebhook[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        headers: req.headers,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      });
      res.statusCode = respond(received.length);
      setTimeout(() => res.end(), delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      ),
  };
};

/** A URL nothing listens on: every dispatch fails with ECONNREFUSED. */
export const DEAD_WEBHOOK_URL = 'http://127.0.0.1:9/hook';
