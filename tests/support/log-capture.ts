import { Writable } from 'node:stream';

/** A pino destination that keeps every JSON line for assertions. */
export class LogCapture extends Writable {
  readonly lines: Record<string, unknown>[] = [];

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: () => void): void {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (line.trim()) this.lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    done();
  }

  get text(): string {
    return this.lines.map((l) => JSON.stringify(l)).join('\n');
  }
}
