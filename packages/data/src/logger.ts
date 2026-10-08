import fs from "node:fs";
import path from "node:path";

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export interface LogEntry {
  timestamp: string;
  module: string;
  severity: LogLevel;
  operation: string;
  correlationId?: string;
  userId?: string;
  deviceId?: string;
  message: string;
  errorCode?: string;
  errorDetails?: string;
}

export class StructuredLogger {
  private readonly logFilePath: string;

  constructor(logDirectory: string) {
    fs.mkdirSync(logDirectory, { recursive: true });
    this.logFilePath = path.join(logDirectory, "app.log");
  }

  log(entry: Omit<LogEntry, "timestamp">): void {
    const fullEntry: LogEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };

    const line = JSON.stringify(fullEntry);
    fs.appendFileSync(this.logFilePath, `${line}\n`, "utf-8");
    console.log(line);
  }

  getLogFilePath(): string {
    return this.logFilePath;
  }

  readEntries(filters?: {
    level?: LogLevel | "ALL";
    module?: string;
    fromDate?: string;
    toDate?: string;
  }): LogEntry[] {
    if (!fs.existsSync(this.logFilePath)) {
      return [];
    }

    const lines = fs
      .readFileSync(this.logFilePath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const entries = lines
      .map((line) => {
        try {
          return JSON.parse(line) as LogEntry;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is LogEntry => Boolean(entry));

    return entries.filter((entry) => {
      if (filters?.level && filters.level !== "ALL" && entry.severity !== filters.level) {
        return false;
      }
      if (filters?.module && entry.module !== filters.module) {
        return false;
      }
      if (filters?.fromDate && entry.timestamp < filters.fromDate) {
        return false;
      }
      if (filters?.toDate && entry.timestamp > filters.toDate) {
        return false;
      }
      return true;
    });
  }
}
