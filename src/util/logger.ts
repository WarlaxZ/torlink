import { appendFile, rename, stat } from "node:fs/promises";
import { logFile } from "../config/paths";

export type LogLevel = "error" | "warn" | "info" | "debug";

// Cap the log at ~1 MB; on exceed we keep exactly one ".1" rollover.
export const MAX_LOG_BYTES = 1_000_000;

// A single log line: "<ISO> <LEVEL padded> <message>\n".
export function formatLine(level: LogLevel, message: string, now: Date): string {
  return `${now.toISOString()} ${level.toUpperCase().padEnd(5)} ${message}\n`;
}

// Rotate only when the file already has content AND this write would push it
// past the cap (so an empty file never rotates before its first line).
export function shouldRotate(currentBytes: number, addBytes: number, max: number): boolean {
  return currentBytes > 0 && currentBytes + addBytes > max;
}

export interface LoggerDeps {
  file: string;
  maxBytes?: number;
  enabled?: boolean;
  debug?: boolean;
  now?: () => Date;
  append?: (file: string, data: string) => Promise<void>;
  rotate?: (file: string) => Promise<void>;
  sizeOf?: (file: string) => Promise<number>;
}

export interface Logger {
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  debug(message: string): void;
  flush(): Promise<void>;
}

export function createLogger(deps: LoggerDeps): Logger {
  const max = deps.maxBytes ?? MAX_LOG_BYTES;
  const enabled = deps.enabled ?? true;
  const debugOn = deps.debug ?? false;
  const now = deps.now ?? ((): Date => new Date());
  const append = deps.append ?? ((f, d): Promise<void> => appendFile(f, d, "utf8"));
  const rotate =
    deps.rotate ?? ((f): Promise<void> => rename(f, `${f}.1`).then(() => undefined).catch(() => undefined));
  const sizeOf =
    deps.sizeOf ??
    (async (f): Promise<number> => {
      try {
        return (await stat(f)).size;
      } catch {
        return 0;
      }
    });

  let bytes = -1;
  let chain: Promise<void> = Promise.resolve();

  function write(level: LogLevel, message: string): void {
    if (!enabled) return;
    if (level === "debug" && !debugOn) return;
    const line = formatLine(level, message, now());
    const add = Buffer.byteLength(line, "utf8");
    chain = chain.then(async () => {
      try {
        if (bytes < 0) bytes = await sizeOf(deps.file);
        if (shouldRotate(bytes, add, max)) {
          await rotate(deps.file);
          bytes = 0;
        }
        await append(deps.file, line);
        bytes += add;
      } catch {
        // best-effort: a logging failure must never affect the app
      }
    });
  }

  return {
    error: (m): void => write("error", m),
    warn: (m): void => write("warn", m),
    info: (m): void => write("info", m),
    debug: (m): void => write("debug", m),
    flush: (): Promise<void> => chain,
  };
}

// Process-wide logger. Disabled under vitest so the test suite never writes to
// the real log; debug lines are gated behind TORLINK_DEBUG.
export const log = createLogger({
  file: logFile,
  enabled: !process.env["VITEST"],
  debug: !!process.env["TORLINK_DEBUG"],
});
