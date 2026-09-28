import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  mkdirSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, labelFor, terminalArgs } from "./core.ts";

test("invalid status metadata is rejected", () => {
  const { store, input, dir } = fixture();
  mkdirSync(join(dir, "state"));
  for (const metadata of [
    { status: "launching", ticket: "", launchedAt: new Date().toISOString() },
    { status: "launching", ticket: "ticket", launchedAt: "invalid" },
    { status: "restored", restoredAt: 42 },
    { status: "pending", ticket: "stray-ticket" },
  ]) {
    writeFileSync(
      join(dir, "state", "saved.json"),
      JSON.stringify({
        version: 1,
        sessions: [
          { ...input, savedAt: new Date().toISOString(), ...metadata },
        ],
      }),
    );
    assert.throws(() => store.list(), /Invalid/);
  }
});

test("forget removes only the saved reference and rejects changed records", async () => {
  const { store, input, file } = fixture();
  const saved = await store.save(input);
  const claimed = (await store.claim(input.sessionId))!;
  await assert.rejects(store.forget(saved), /changed/);
  await store.forget(claimed);
  assert.deepEqual(store.list(), []);
  assert.ok(existsSync(file));
  await assert.rejects(
    store.acknowledge(claimed.ticket!, input.sessionId, file),
    /expired/,
  );
});

test("forget compares record values, not property order", async () => {
  const { store, input, dir } = fixture();
  const saved = await store.save(input);
  const path = join(dir, "state", "saved.json");
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.sessions[0] = Object.fromEntries(Object.entries(saved).reverse());
  writeFileSync(path, JSON.stringify(state));
  await store.forget(saved);
  assert.deepEqual(store.list(), []);
});

test("forget still checks label and path when identity and timestamps match", async () => {
  const { store, input, dir } = fixture();
  const saved = await store.save(input);
  const path = join(dir, "state", "saved.json");
  for (const change of [
    { label: "changed" },
    { sessionFile: input.sessionFile + ".moved" },
  ]) {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, sessions: [{ ...saved, ...change }] }),
    );
    await assert.rejects(store.forget(saved), /changed/);
    assert.equal(store.list().length, 1);
  }
});

test("lock timeout is bounded and manual recovery permits subsequent writes", async () => {
  const { store, input, dir } = fixture();
  mkdirSync(join(dir, "state", "write.lock"), { recursive: true });
  await assert.rejects(store.save(input), /State locked/);
  rmSync(join(dir, "state", "write.lock"), { recursive: true });
  await store.save(input);
  assert.equal(store.list().length, 1);
});

test("canonical paths support symlink aliases and metacharacters", async () => {
  const { store, input, dir, file } = fixture();
  const alias = join(dir, "a space $(literal).jsonl");
  symlinkSync(file, alias);
  const saved = await store.save({ ...input, sessionFile: alias });
  assert.equal(saved.sessionFile, file);
  const claimed = (await store.claim(input.sessionId))!;
  await store.acknowledge(claimed.ticket!, input.sessionId, alias);
  assert.equal(store.list()[0].status, "restored");
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-restore-"));
  tempDirs.push(dir);
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    JSON.stringify({ type: "session", id: "test-id", cwd: dir }) + "\n",
  );
  return {
    dir,
    file,
    store: new Store(join(dir, "state")),
    input: { sessionId: "test-id", sessionFile: file, cwd: dir, label: "Work" },
  };
}

test("write and rename failures preserve state and release the lock", async () => {
  const { store, input, dir } = fixture();
  await store.save(input);
  const stateDir = join(dir, "state");
  const before = readFileSync(join(stateDir, "saved.json"), "utf8");
  for (const operation of ["write", "replace"] as const) {
    const broken = new Store(stateDir, {
      [operation]: () => {
        throw new Error(`${operation} failed`);
      },
    });
    await assert.rejects(broken.save({ ...input, label: "changed" }), /failed/);
    assert.equal(readFileSync(join(stateDir, "saved.json"), "utf8"), before);
    assert.equal(existsSync(join(stateDir, "write.lock")), false);
  }
  await store.save({ ...input, label: "recovered" });
  assert.equal(store.list()[0].label, "recovered");
});

test("cleanup failure preserves the original error and still releases the lock", async () => {
  const { store, input, dir } = fixture();
  await store.save(input);
  const broken = new Store(join(dir, "state"), {
    replace: () => {
      throw new Error("original rename failure");
    },
    remove: () => {
      throw new Error("cleanup failure");
    },
  });
  await assert.rejects(broken.save(input), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(String(error.errors[0]), /original rename failure/);
    assert.match(String(error.errors[1]), /cleanup failure/);
    return true;
  });
  assert.equal(existsSync(join(dir, "state", "write.lock")), false);
});

test("labels prefer explicit text, then session name, then directory and timestamp", () => {
  assert.equal(labelFor(' "My work" ', "Old", "/project", "TIME"), "My work");
  assert.equal(labelFor("", "Named", "/project", "TIME"), "Named");
  assert.equal(labelFor("", undefined, "/project", "TIME"), "project — TIME");
});

test("resave overwrites the same session across store instances", async () => {
  const { store, input, dir } = fixture();
  await store.save(input);
  const reopened = new Store(store.dir);
  const file = join(dir, "moved.jsonl");
  writeFileSync(
    file,
    JSON.stringify({ type: "session", id: input.sessionId }) + "\n",
  );
  const updated = await reopened.save({
    ...input,
    sessionFile: file,
    label: "Replacement",
  });
  assert.deepEqual(store.list(), [updated]);
  assert.equal(updated.sessionFile, file);
  assert.equal(updated.label, "Replacement");
  assert.equal(updated.status, "pending");
});

test("save deduplicates by session identity and rearms restored entries", async () => {
  const { store, input } = fixture();
  await store.save(input);
  const claim = await store.claim(input.sessionId);
  assert.ok(claim);
  await store.acknowledge(claim.ticket!, input.sessionId, input.sessionFile);
  assert.equal(store.list()[0].status, "restored");
  await store.save({ ...input, label: "Updated" });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].status, "pending");
  assert.equal(store.list()[0].label, "Updated");
});

test("concurrent claims launch only once; ack requires exact session and ticket", async () => {
  const { store, input } = fixture();
  await store.save(input);
  const claims = await Promise.all([
    store.claim(input.sessionId),
    store.claim(input.sessionId),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const claim = claims.find(Boolean)!;
  await assert.rejects(
    store.acknowledge(claim.ticket!, "wrong", input.sessionFile),
    /match/,
  );
  assert.equal(store.list()[0].status, "launching");
  await store.acknowledge(claim.ticket!, input.sessionId, input.sessionFile);
  assert.equal(await store.claim(input.sessionId), undefined);
});

test("launch failure releases only its own ticket; reset rejects late acknowledgement", async () => {
  const { store, input } = fixture();
  await store.save(input);
  const old = (await store.claim(input.sessionId))!;
  await store.reset(input.sessionId, old.ticket!);
  const next = (await store.claim(input.sessionId))!;
  await store.release(old.ticket!);
  assert.equal(store.list()[0].ticket, next.ticket);
  await assert.rejects(
    store.acknowledge(old.ticket!, input.sessionId, input.sessionFile),
    /expired/,
  );
  await store.release(next.ticket!);
  assert.equal(store.list()[0].status, "pending");
});

test("stale reset cannot invalidate a newer launch", async () => {
  const { store, input } = fixture();
  await store.save(input);
  const first = (await store.claim(input.sessionId))!;
  await store.reset(input.sessionId, first.ticket!);
  const second = (await store.claim(input.sessionId))!;
  await assert.rejects(store.reset(input.sessionId, first.ticket!), /changed/);
  assert.equal(store.list()[0].status, "launching");
  assert.equal(store.list()[0].ticket, second.ticket);
  await store.acknowledge(second.ticket!, input.sessionId, input.sessionFile);
  await assert.rejects(store.reset(input.sessionId, second.ticket!), /changed/);
  assert.equal(store.list()[0].status, "restored");
});

test("missing sessions and mismatched headers fail without consuming records", async () => {
  const { store, input, file } = fixture();
  await store.save(input);
  writeFileSync(file, '{"type":"session","id":"other"}\n');
  await assert.rejects(store.claim(input.sessionId), /identity/);
  assert.equal(store.list()[0].status, "pending");
  await assert.rejects(
    store.save({ ...input, sessionFile: file + ".missing" }),
    /ENOENT/,
  );
});

test("separate Store instances retain concurrent saves and corrupt state fails loudly", async () => {
  const { store, input, dir } = fixture();
  const second = new Store(join(dir, "state"));
  const otherFile = join(dir, "other.jsonl");
  writeFileSync(otherFile, '{"type":"session","id":"other"}\n');
  await Promise.all([
    store.save(input),
    second.save({ ...input, sessionId: "other", sessionFile: otherFile }),
  ]);
  assert.equal(store.list().length, 2);
  writeFileSync(join(dir, "state", "saved.json"), "{}");
  assert.throws(() => store.list(), /Invalid/);
});

test("state is private and atomic writes leave valid JSON", async () => {
  const { store, input, dir } = fixture();
  await store.save(input);
  assert.equal(
    JSON.parse(readFileSync(join(dir, "state", "saved.json"), "utf8")).version,
    1,
  );
  assert.equal(statSync(join(dir, "state", "saved.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "state")).mode & 0o777, 0o700);
});

test("cross-process restore claims are exclusive", async () => {
  const { store, input, dir } = fixture();
  await store.save(input);
  const modulePath = new URL("./core.ts", import.meta.url).href;
  const source = `import { Store } from ${JSON.stringify(modulePath)};
    const claimed = await new Store(process.argv[1]).claim('test-id');
    console.log(claimed ? 'claimed' : 'skipped');`;
  const run = () =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        source,
        join(dir, "state"),
      ]);
      let out = "",
        err = "";
      child.stdout.on("data", (data) => {
        out += data;
      });
      child.stderr.on("data", (data) => {
        err += data;
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve(out.trim()) : reject(new Error(err)),
      );
    });
  const results = await Promise.all([run(), run(), run(), run()]);
  assert.equal(results.filter((s) => s === "claimed").length, 1);
  assert.equal(results.filter((s) => s === "skipped").length, 3);
});

test("missing working directories do not consume saved sessions", async () => {
  const { store, input, dir } = fixture();
  await assert.rejects(
    store.save({ ...input, cwd: join(dir, "missing") }),
    /ENOENT/,
  );
  assert.equal(store.list().length, 0);
});

test("terminal arguments preserve spaces and shell metacharacters as literal arguments", () => {
  const args = terminalArgs(
    ["kitty", "--"],
    ["pi", "--session", "/a path/$(bad).jsonl"],
  );
  assert.deepEqual(args, [
    "kitty",
    "--",
    "pi",
    "--session",
    "/a path/$(bad).jsonl",
  ]);
  assert.throws(() => terminalArgs([], ["pi"]), /terminal/);
});
