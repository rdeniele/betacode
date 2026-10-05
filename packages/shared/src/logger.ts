import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redactValue } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  log(level: LogLevel, event: string, data?: Record<string, unknown>): void;
}

export const nullLogger: Logger = { log() {} };

/** Structured JSON-lines logger. Everything is redacted before it is written. */
export class FileLogger implements Logger {
  constructor(private readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }
  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    const line = JSON.stringify(redactValue({ ts: new Date().toISOString(), level, event, ...data }));
    try {
      appendFileSync(this.file, line + "\n");
    } catch {
      /* logging must never crash the app */
    }
  }
}

export class MemoryLogger implements Logger {
  readonly entries: Array<{ level: LogLevel; event: string; data: Record<string, unknown> }> = [];
  log(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
    this.entries.push({ level, event, data: redactValue(data) });
  }
}
