export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type LogThreshold = LogLevel | "silent";
export type LogFormat = "json" | "pretty";
export type LogFields = Record<string, unknown>;

const SEVERITY: Record<LogThreshold, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

export interface LoggerOptions {
  level?: LogThreshold;
  format?: LogFormat;
  bindings?: LogFields;
  write?: (line: string) => void;
}

export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
  isLevelEnabled(level: LogLevel): boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = SEVERITY[options.level ?? "info"];
  const format = options.format ?? (process.env.NODE_ENV === "production" ? "json" : "pretty");
  const write = options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const bindings = options.bindings ?? {};

  const log = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (SEVERITY[level] < threshold) return;
    const record = { ...bindings, ...fields };
    const time = new Date().toISOString();
    write(format === "json" ? formatJson(time, level, msg, record) : formatPretty(time, level, msg, record));
  };

  return {
    trace: (msg, fields) => log("trace", msg, fields),
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    fatal: (msg, fields) => log("fatal", msg, fields),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
    isLevelEnabled: (level) => SEVERITY[level] >= threshold,
  };
}

function serializeValue(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function formatJson(time: string, level: LogLevel, msg: string, fields: LogFields): string {
  return JSON.stringify({ time, level, msg, ...fields }, serializeValue);
}

function formatPretty(time: string, level: LogLevel, msg: string, fields: LogFields): string {
  const pairs = Object.entries(fields).map(([key, value]) => {
    const serialized = serializeValue(key, value);
    return `${key}=${typeof serialized === "string" ? serialized : JSON.stringify(serialized)}`;
  });
  const clock = time.slice(11, 23);
  return [clock, level.toUpperCase().padEnd(5), msg, ...pairs].join(" ");
}
