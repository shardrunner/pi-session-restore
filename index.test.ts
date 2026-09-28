import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Store } from "./core.ts";
import { register, launch } from "./index.ts";

interface Context {
  mode: ExtensionContext["mode"];
  cwd: string;
  sessionManager: { getSessionFile?: () => string; getSessionId: () => string };
  shutdown: () => void;
  ui: {
    notify: (text: string) => void;
    select: (title: string, choices: string[]) => Promise<string | undefined>;
    confirm: (title: string, message: string) => Promise<boolean>;
  };
}
type Handler = (args: string, ctx: Context) => Promise<void>;
type StartHandler = (event: { reason: string }, ctx: Context) => Promise<void>;

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi-restore-ui-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "saved $(literal) file.jsonl");
  writeFileSync(file, '{"type":"session","id":"saved"}\n');
  const store = new Store(join(dir, "state"));
  const commands = new Map<string, Handler>();
  const events = new Map<string, StartHandler>();
  const notices: string[] = [];
  const launches: string[][] = [];
  let choice: string | undefined = "Restore all pending";
  let ticket: string | undefined;
  let shutdown = false;
  // Single SDK boundary cast: the fixture implements only APIs used by this extension.
  const pi = {
    registerCommand: (name: string, command: { handler: Handler }) =>
      commands.set(name, command.handler),
    registerFlag: () => {},
    getFlag: () => ticket,
    getSessionName: () => "Session title",
    on: (name: string, callback: StartHandler) => events.set(name, callback),
  } as unknown as ExtensionAPI;
  const ctx: Context = {
    mode: "tui",
    cwd: dir,
    sessionManager: { getSessionFile: () => file, getSessionId: () => "saved" },
    shutdown: () => {
      shutdown = true;
    },
    ui: {
      notify: (text) => {
        notices.push(text);
      },
      select: async () => choice,
      confirm: async () => true,
    },
  };
  register(
    pi,
    store,
    dir,
    async (argv) => {
      launches.push(argv);
    },
    () => true,
  );
  const other = (): Context => ({
    ...ctx,
    sessionManager: { getSessionId: () => "other" },
  });
  const command = (name: string, args = "", context = ctx) => {
    const handler = commands.get(name);
    assert.ok(handler, `Missing command ${name}`);
    return handler(args, context);
  };
  const start = (reason = "startup") => {
    const handler = events.get("session_start");
    assert.ok(handler);
    return handler({ reason }, ctx);
  };
  return {
    pi,
    dir,
    file,
    store,
    notices,
    launches,
    ctx,
    other,
    command,
    start,
    setChoice: (value: string | undefined) => {
      choice = value;
    },
    setTicket: (value: string) => {
      ticket = value;
    },
    isShutdown: () => shutdown,
  };
}

test("current launching session remains available for recovery", async (t) => {
  const f = fixture(t);
  await f.command("save");
  await f.store.claim("saved");
  f.ctx.ui.select = async (_title, choices) => choices[1];
  await f.command("restore");
  assert.equal(f.store.list()[0].status, "pending");
  assert.equal(f.launches.length, 0);
});

test("save closes only after persisting the reference", async (t) => {
  const f = fixture(t);
  let persistedAtShutdown = false;
  f.ctx.shutdown = () => {
    persistedAtShutdown = f.store.list()[0]?.label === "Saved before exit";
  };
  await f.command("save", "Saved before exit");
  assert.equal(persistedAtShutdown, true);
});

test("failed save reports the error and keeps Pi open", async (t) => {
  const f = fixture(t);
  register(
    f.pi,
    new Store(f.store.dir, {
      write: () => {
        throw new Error("disk full");
      },
    }),
    f.dir,
  );
  await f.command("save");
  assert.equal(f.isShutdown(), false);
  assert.deepEqual(f.store.list(), []);
  assert.ok(f.notices.some((s) => s.includes("disk full")));
});

test("save uses session name and supports quoted labels without model APIs", async (t) => {
  const f = fixture(t);
  await f.command("save");
  assert.equal(f.store.list()[0].label, "Session title");
  await f.command("save", '"Individual label"');
  assert.equal(f.store.list()[0].label, "Individual label");
  assert.equal(f.store.list().length, 1);
});

test("restore all passes the exact argument vector and consumes only on acknowledgement", async (t) => {
  const f = fixture(t);
  await f.command("save");
  await f.command("restore", "", f.other());
  const saved = f.store.list()[0];
  assert.equal(saved.status, "launching");
  assert.deepEqual(f.launches, [
    [
      "xdg-terminal-exec",
      "env",
      "--chdir",
      f.dir,
      `PI_CODING_AGENT_DIR=${f.dir}`,
      "pi",
      "--session",
      f.file,
      "--saved-session-ticket",
      saved.ticket,
    ],
  ]);
  await f.command("restore", "", f.other());
  assert.equal(f.launches.length, 1);
  f.setTicket(saved.ticket!);
  await f.start();
  assert.equal(f.store.list()[0].status, "restored");
  await f.command("restore", "", f.other());
  assert.equal(f.launches.length, 1);
  let shutdownOnReload = false;
  f.ctx.shutdown = () => {
    shutdownOnReload = true;
  };
  await f.start("reload");
  assert.equal(shutdownOnReload, false);
});

test("cancel and restoring the current pending session never launch a window", async (t) => {
  const f = fixture(t);
  await f.command("save");
  await f.command("restore");
  assert.equal(f.launches.length, 0);
  f.setChoice(undefined);
  await f.command("restore", "", f.other());
  assert.equal(f.launches.length, 0);
  assert.equal(f.store.list()[0].status, "pending");
});

test("expired ticket and mismatched session startup shut down", async (t) => {
  const f = fixture(t);
  await f.command("save");
  const claimed = (await f.store.claim("saved"))!;
  f.setTicket(claimed.ticket);
  f.ctx.sessionManager.getSessionId = () => "wrong";
  await f.start();
  assert.equal(f.isShutdown(), true);
  assert.ok(f.notices.some((s) => s.includes("does not match")));
  f.setTicket("expired-ticket");
  await f.start();
  assert.ok(f.notices.some((s) => s.includes("expired")));
});

test("noninteractive save fails visibly without state changes", async (t) => {
  const f = fixture(t);
  await f.command("save", "", { ...f.ctx, mode: "rpc" });
  assert.equal(f.store.list().length, 0);
  assert.match(f.notices[0], /interactive/);
});

test("failed launches return to pending and are reported", async (t) => {
  const f = fixture(t);
  register(
    f.pi,
    f.store,
    f.dir,
    async () => {
      throw new Error("terminal failed");
    },
    () => true,
  );
  await f.command("save");
  await f.command("restore", "", f.other());
  assert.equal(f.store.list()[0].status, "pending");
  assert.ok(f.notices.some((s) => s.includes("terminal failed")));
});

test("individual selection restores only that entry, including duplicate labels", async (t) => {
  const f = fixture(t);
  await f.command("save", "Same label");
  const otherFile = join(f.dir, "second.jsonl");
  writeFileSync(otherFile, '{"type":"session","id":"second"}\n');
  await f.store.save({
    sessionId: "second",
    sessionFile: otherFile,
    cwd: f.dir,
    label: "Same label",
  });
  f.setChoice(`2. Same label — ${f.dir}`);
  await f.command("restore", "", f.other());
  assert.equal(f.launches.length, 1);
  assert.ok(f.launches[0].includes(otherFile));
  assert.equal(f.store.list()[0].status, "pending");
});

test("reset confirmation uses the displayed ticket, not a newer launch", async (t) => {
  const f = fixture(t);
  await f.command("save");
  const first = (await f.store.claim("saved"))!;
  f.ctx.ui.select = async (_title, choices) => choices[1];
  let secondTicket: string | undefined;
  f.ctx.ui.confirm = async () => {
    await f.store.reset("saved", first.ticket);
    secondTicket = (await f.store.claim("saved"))!.ticket;
    return true;
  };
  await f.command("restore", "", f.other());
  assert.equal(f.store.list()[0].ticket, secondTicket);
  assert.ok(f.notices.some((s) => s.includes("Launch changed")));
  assert.equal(f.launches.length, 0);
});

test("forget supports cancellation and does not delete conversation files", async (t) => {
  const f = fixture(t);
  await f.command("save");
  f.ctx.ui.select = async (_title, choices) => choices[0];
  f.ctx.ui.confirm = async () => false;
  await f.command("restore-forget");
  assert.equal(f.store.list().length, 1);
  f.ctx.ui.confirm = async () => true;
  await f.command("restore-forget");
  assert.equal(f.store.list().length, 0);
  assert.ok(existsSync(f.file));
});

test("diagnostics include launch age, state location and literal arguments", async (t) => {
  const f = fixture(t);
  await f.command("save");
  const claimed = (await f.store.claim("saved"))!;
  await f.command("restore-status");
  const output = f.notices.at(-1)!;
  assert.ok(output.includes(claimed.launchedAt));
  assert.ok(output.includes(JSON.stringify(f.file)));
  assert.ok(output.includes(join(f.store.dir, "saved.json")));
});

test("restore all continues after a missing session file", async (t) => {
  const f = fixture(t);
  await f.command("save");
  const valid = join(f.dir, "valid.jsonl");
  writeFileSync(valid, '{"type":"session","id":"valid"}\n');
  await f.store.save({
    sessionId: "valid",
    sessionFile: valid,
    cwd: f.dir,
    label: "valid",
  });
  rmSync(f.file);
  await f.command("restore", "", f.other());
  assert.equal(f.launches.length, 1);
  assert.ok(f.launches[0].includes(valid));
  assert.equal(f.store.list()[0].status, "pending");
  assert.ok(f.notices.some((s) => s.includes("ENOENT")));
});

test("terminal fallback selection is persisted and preserves its prefix", async (t) => {
  const f = fixture(t);
  register(
    f.pi,
    f.store,
    f.dir,
    async (argv) => {
      f.launches.push(argv);
    },
    (name) => ["kitty", "pi", "env"].includes(name),
  );
  await f.command("save");
  f.ctx.ui.select = async (_title, choices) => choices[0];
  await f.command("restore", "", f.other());
  assert.deepEqual(f.store.terminal(), ["kitty", "--"]);
  assert.deepEqual(f.launches[0].slice(0, 2), ["kitty", "--"]);
});

test("unavailable or cancelled terminal selection leaves sessions pending", async (t) => {
  for (const hasCandidate of [false, true]) {
    const f = fixture(t);
    let launches = 0;
    register(
      f.pi,
      f.store,
      f.dir,
      async () => {
        launches++;
      },
      (name) =>
        ["pi", "env", ...(hasCandidate ? ["kitty"] : [])].includes(name),
    );
    await f.command("save");
    f.ctx.ui.select = async (title, choices) =>
      title === "Restore saved sessions" ? choices[0] : undefined;
    await f.command("restore", "", f.other());
    assert.equal(f.store.list()[0].status, "pending");
    assert.equal(f.store.terminal(), undefined);
    assert.equal(launches, 0);
    if (!hasCandidate)
      assert.ok(
        f.notices.some((s) => s.includes("No default terminal launcher")),
      );
  }
});

test("terminal configuration rejects malformed arrays and missing executables", async (t) => {
  const f = fixture(t);
  register(
    f.pi,
    f.store,
    f.dir,
    async () => {},
    (name) => name === "foot",
  );
  for (const input of [
    "null",
    "[]",
    "[42]",
    '["missing"]',
    '["foot", "\\u0000"]',
  ]) {
    await f.command("restore-terminal", input);
    assert.equal(f.store.terminal(), undefined);
  }
  await f.command("restore-terminal", '["foot"]');
  assert.deepEqual(f.store.terminal(), ["foot"]);
});

test("missing launch dependencies do not claim sessions", async (t) => {
  for (const missing of ["pi", "env", "xdg-terminal-exec"]) {
    const f = fixture(t);
    await f.store.setTerminal(["xdg-terminal-exec"]);
    register(
      f.pi,
      f.store,
      f.dir,
      async () => {
        assert.fail("must not launch");
      },
      (name) => name !== missing,
    );
    await f.command("save");
    await f.command("restore", "", f.other());
    assert.equal(f.store.list()[0].status, "pending");
    assert.ok(f.notices.some((s) => s.includes(missing)));
  }
});

test("launch reports spawn errors", async () => {
  await assert.rejects(launch(["/nonexistent-pi-restore-terminal"]), /ENOENT/);
});
