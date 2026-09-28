import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const HEADER_LIMIT_BYTES = 65536;
const LOCK_TIMEOUT_MS = 2000;
const LOCK_RETRY_MS = 25;

export interface SaveInput {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  label: string;
}
interface BaseSaved extends SaveInput {
  savedAt: string;
}
export type Saved = BaseSaved &
  (
    | {
        status: "pending";
        ticket?: never;
        launchedAt?: never;
        restoredAt?: never;
      }
    | {
        status: "launching";
        ticket: string;
        launchedAt: string;
        restoredAt?: never;
      }
    | {
        status: "restored";
        ticket?: never;
        launchedAt?: never;
        restoredAt: string;
      }
  );
export type Launching = Extract<Saved, { status: "launching" }>;
interface State {
  version: 1;
  sessions: Saved[];
  terminal?: string[];
}

export function labelFor(
  args: string,
  name: string | undefined,
  cwd: string,
  time = new Date().toISOString(),
): string {
  let label = args.trim();
  if (
    (label.startsWith('"') && label.endsWith('"')) ||
    (label.startsWith("'") && label.endsWith("'"))
  ) {
    label = label.slice(1, -1).trim();
  }
  label = label || name?.trim() || `${basename(cwd) || cwd} — ${time}`;
  if (/[\x00-\x1f\x7f]/.test(label))
    throw new Error("Labels cannot contain control characters.");
  return label;
}

export function terminalArgs(terminal: unknown, command: string[]): string[] {
  if (
    !Array.isArray(terminal) ||
    !terminal.length ||
    terminal.some((s) => typeof s !== "string" || !s || s.includes("\0"))
  ) {
    throw new Error("Invalid terminal argument array.");
  }
  return [...terminal, ...command];
}

// Read only the header, not the potentially enormous conversation.
function validate(input: SaveInput): void {
  if (!isAbsolute(input.sessionFile) || !isAbsolute(input.cwd))
    throw new Error("Session and cwd must be absolute paths.");
  if (!statSync(input.cwd).isDirectory())
    throw new Error(`Not a directory: ${input.cwd}`);
  if (!statSync(input.sessionFile).isFile())
    throw new Error(`Not a regular file: ${input.sessionFile}`);
  const fd = openSync(input.sessionFile, "r");
  try {
    const bytes = Buffer.alloc(HEADER_LIMIT_BYTES);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    const text = bytes.subarray(0, size).toString("utf8");
    const end = text.indexOf("\n");
    if (end < 0 && size === bytes.length)
      throw new Error("Session header too large.");
    const header: unknown = JSON.parse(end < 0 ? text : text.slice(0, end));
    if (
      !object(header) ||
      header.type !== "session" ||
      header.id !== input.sessionId
    ) {
      throw new Error("Session identity does not match the saved record.");
    }
  } finally {
    closeSync(fd);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function validSaved(value: unknown): value is Saved {
  if (
    !object(value) ||
    !text(value.sessionId) ||
    !text(value.sessionFile) ||
    !text(value.cwd) ||
    !text(value.label) ||
    !timestamp(value.savedAt) ||
    !isAbsolute(value.sessionFile) ||
    !isAbsolute(value.cwd)
  )
    return false;
  switch (value.status) {
    case "pending":
      return (
        value.ticket === undefined &&
        value.launchedAt === undefined &&
        value.restoredAt === undefined
      );
    case "launching":
      return (
        text(value.ticket) &&
        timestamp(value.launchedAt) &&
        value.restoredAt === undefined
      );
    case "restored":
      return (
        timestamp(value.restoredAt) &&
        value.ticket === undefined &&
        value.launchedAt === undefined
      );
    default:
      return false;
  }
}
function base(saved: Saved): BaseSaved {
  return {
    sessionId: saved.sessionId,
    sessionFile: saved.sessionFile,
    cwd: saved.cwd,
    label: saved.label,
    savedAt: saved.savedAt,
  };
}

// Narrow injection seam for deterministic filesystem failure tests.
const storageIO = {
  write: (path: string, data: string) =>
    writeFileSync(path, data, { mode: 0o600, flag: "wx" }),
  replace: renameSync,
  remove: unlinkSync,
  unlock: rmdirSync,
};

export class Store {
  readonly dir: string;
  private readonly io: typeof storageIO;
  constructor(dir: string, operations: Partial<typeof storageIO> = {}) {
    this.dir = dir;
    this.io = { ...storageIO, ...operations };
  }
  private read(): State {
    const path = join(this.dir, "saved.json");
    if (!existsSync(path)) return { version: 1, sessions: [] };
    let state: unknown;
    try {
      state = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      throw new Error(`Cannot read session-restore state: ${path}`, { cause });
    }
    if (
      !object(state) ||
      state.version !== 1 ||
      !Array.isArray(state.sessions) ||
      !state.sessions.every(validSaved) ||
      new Set(state.sessions.map((s) => s.sessionId)).size !==
        state.sessions.length
    ) {
      throw new Error(`Invalid session-restore state: ${path}`);
    }
    return {
      version: 1,
      sessions: state.sessions,
      ...(state.terminal === undefined
        ? {}
        : { terminal: terminalArgs(state.terminal, []) }),
    };
  }
  private async mutate<T>(fn: (state: State) => T): Promise<T> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = join(this.dir, "write.lock");
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        mkdirSync(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `State locked: ${lock}. If no save/restore is running, remove this empty directory and retry.`,
          );
        await delay(LOCK_RETRY_MS);
      }
    }
    const temp = join(this.dir, `.saved-${randomUUID()}.tmp`);
    const errors: unknown[] = [];
    let result!: T;
    try {
      const state = this.read();
      result = fn(state);
      this.io.write(temp, JSON.stringify(state, null, 2) + "\n");
      this.io.replace(temp, join(this.dir, "saved.json"));
    } catch (error) {
      errors.push(error);
    }
    // Always attempt both cleanups, preserving the original failure first.
    try {
      if (existsSync(temp)) this.io.remove(temp);
    } catch (error) {
      errors.push(error);
    }
    try {
      this.io.unlock(lock);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(
        errors,
        errors.map((error) => String(error)).join("; "),
      );
    return result;
  }
  list(): Saved[] {
    return this.read().sessions;
  }
  terminal(): string[] | undefined {
    return this.read().terminal;
  }
  async setTerminal(args: string[]): Promise<void> {
    const terminal = terminalArgs(args, []);
    await this.mutate((state) => {
      state.terminal = terminal;
    });
  }
  async save(input: SaveInput): Promise<Saved> {
    validate(input);
    const canonical = {
      ...input,
      sessionFile: realpathSync(input.sessionFile),
      cwd: realpathSync(input.cwd),
    };
    return this.mutate((state) => {
      const old = state.sessions.find((s) => s.sessionId === input.sessionId);
      if (old?.status === "launching")
        throw new Error(
          "This session is being restored. Resolve that launch in /restore first.",
        );
      const saved: Saved = {
        ...canonical,
        status: "pending",
        savedAt: new Date().toISOString(),
      };
      if (!validSaved(saved)) throw new Error("Invalid saved session input.");
      state.sessions = [
        ...state.sessions.filter((s) => s.sessionId !== input.sessionId),
        saved,
      ];
      return saved;
    });
  }
  async claim(id: string): Promise<Launching | undefined> {
    return this.mutate((state) => {
      const index = state.sessions.findIndex((s) => s.sessionId === id);
      const saved = state.sessions[index];
      if (!saved || saved.status !== "pending") return undefined;
      validate(saved);
      const claimed: Launching = {
        ...base(saved),
        status: "launching",
        ticket: randomUUID(),
        launchedAt: new Date().toISOString(),
      };
      state.sessions[index] = claimed;
      return { ...claimed };
    });
  }
  async acknowledge(ticket: string, id: string, file: string): Promise<void> {
    await this.mutate((state) => {
      const index = state.sessions.findIndex(
        (s) => s.ticket === ticket && s.status === "launching",
      );
      const saved = state.sessions[index];
      if (!saved)
        throw new Error("Restore ticket expired or already consumed.");
      if (saved.sessionId !== id || saved.sessionFile !== realpathSync(file))
        throw new Error(
          `Restored session does not match: expected ${saved.sessionId} (${saved.sessionFile}), got ${id} (${file}).`,
        );
      state.sessions[index] = {
        ...base(saved),
        status: "restored",
        restoredAt: new Date().toISOString(),
      };
    });
  }
  async release(ticket: string): Promise<void> {
    await this.mutate((state) => {
      state.sessions = state.sessions.map((saved) =>
        saved.status === "launching" && saved.ticket === ticket
          ? { ...base(saved), status: "pending" }
          : saved,
      );
    });
  }
  async reset(id: string, ticket: string): Promise<void> {
    await this.mutate((state) => {
      const index = state.sessions.findIndex((s) => s.sessionId === id);
      const saved = state.sessions[index];
      if (saved?.status !== "launching" || !ticket || saved.ticket !== ticket) {
        throw new Error(
          "Launch changed while confirming. Reopen /restore to see its current state.",
        );
      }
      state.sessions[index] = { ...base(saved), status: "pending" };
    });
  }
  async forget(expected: Saved): Promise<void> {
    await this.mutate((state) => {
      const saved = state.sessions.find(
        (s) => s.sessionId === expected.sessionId,
      );
      if (!isDeepStrictEqual(saved, expected)) {
        throw new Error(
          "Saved entry changed while confirming. Reopen /restore-forget.",
        );
      }
      state.sessions = state.sessions.filter(
        (s) => s.sessionId !== expected.sessionId,
      );
    });
  }
}
