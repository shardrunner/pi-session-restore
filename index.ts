import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  Store,
  labelFor,
  terminalArgs,
  type Launching,
  type Saved,
} from "./core.ts";

const FLAG = "saved-session-ticket";

function executable(name: string): boolean {
  const paths = name.includes("/")
    ? [resolve(name)]
    : (process.env.PATH ?? "").split(":").map((dir) => join(dir, name));
  return paths.some((path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

export function restoreCommand(saved: Launching, agentDir: string): string[] {
  return [
    "env",
    "--chdir",
    saved.cwd,
    `PI_CODING_AGENT_DIR=${agentDir}`,
    "pi",
    "--session",
    saved.sessionFile,
    `--${FLAG}`,
    saved.ticket,
  ];
}

function description(saved: Saved): string {
  const age =
    saved.status === "launching"
      ? ` [awaiting startup ${Math.max(0, Math.floor((Date.now() - Date.parse(saved.launchedAt)) / 1000))}s; select to reset]`
      : "";
  return `${saved.label} — ${saved.cwd}${age}`;
}

export async function launch(argv: string[]): Promise<void> {
  // No shell: labels, paths, and user arguments cannot become shell commands.
  await new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export function register(
  pi: ExtensionAPI,
  store: Store,
  agentDir: string,
  start = launch,
  available = executable,
) {
  pi.registerFlag(FLAG, {
    type: "string",
    description: "Internal saved-session startup acknowledgement",
  });
  const report = (ctx: ExtensionContext, error: unknown) =>
    ctx.ui.notify(
      `Session restore: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );

  async function resolveTerminal(ui: Pick<ExtensionContext["ui"], "select">) {
    let terminal = store.terminal();
    if (!terminal && available("xdg-terminal-exec"))
      terminal = ["xdg-terminal-exec"];
    if (!terminal) {
      const candidates = [
        ["foot"],
        ["kitty", "--"],
        ["alacritty", "-e"],
        ["wezterm", "start", "--always-new-process", "--"],
        ["gnome-terminal", "--window", "--"],
        ["konsole", "--separate", "-e"],
        ["xterm", "-e"],
      ].filter((args) => available(args[0]));
      if (!candidates.length)
        throw new Error(
          'No default terminal launcher found. Configure /restore-terminal ["terminal", "execution-flag"].',
        );
      const names = candidates.map((args) => JSON.stringify(args));
      const chosen = await ui.select(
        "Choose terminal for new windows (saved for future restores)",
        names,
      );
      if (!chosen) return;
      terminal = candidates[names.indexOf(chosen)];
      await store.setTerminal(terminal);
    }
    if (!available(terminal[0]))
      throw new Error(`Terminal executable not found: ${terminal[0]}`);
    if (!available("pi")) throw new Error("pi is not on PATH.");
    if (!available("env")) throw new Error("env is not on PATH.");
    return terminal;
  }

  async function claimAndLaunch(
    selected: Saved[],
    terminal: string[],
    onError: (error: unknown) => void,
  ): Promise<number> {
    let launched = 0;
    for (const saved of selected) {
      let ticket: string | undefined;
      try {
        const claimed = await store.claim(saved.sessionId);
        if (!claimed) continue; // Another Pi instance claimed this while the picker was open.
        ticket = claimed.ticket;
        await start(terminalArgs(terminal, restoreCommand(claimed, agentDir)));
        launched++;
      } catch (error) {
        onError(error);
        if (ticket) {
          try {
            await store.release(ticket);
          } catch (releaseError) {
            onError(releaseError);
          }
        }
      }
    }
    return launched;
  }

  pi.on("session_start", async (event, ctx) => {
    const ticket = pi.getFlag(FLAG);
    if (event.reason !== "startup" || typeof ticket !== "string" || !ticket)
      return;
    try {
      if (ctx.mode !== "tui")
        throw new Error("Restoration requires an interactive terminal.");
      const file = ctx.sessionManager.getSessionFile();
      if (!file) throw new Error("Restored session has no file.");
      await store.acknowledge(ticket, ctx.sessionManager.getSessionId(), file);
      ctx.ui.notify("Saved session restored.", "info");
    } catch (error) {
      report(ctx, error);
      // Reject delayed launches before interactive use. Pi may already have written
      // startup metadata before this event; this is not a read-only session open.
      ctx.shutdown();
    }
  });

  pi.registerCommand("save", {
    description: "Save this conversation and exit Pi: /save [label]",
    handler: async (args, ctx) => {
      try {
        if (ctx.mode !== "tui")
          throw new Error("/save requires interactive Pi.");
        const file = ctx.sessionManager.getSessionFile();
        if (!file) throw new Error("Ephemeral sessions cannot be saved.");
        const label = labelFor(args, pi.getSessionName(), ctx.cwd);
        const saved = await store.save({
          sessionId: ctx.sessionManager.getSessionId(),
          sessionFile: file,
          cwd: ctx.cwd,
          label,
        });
        ctx.ui.notify(`Saved: ${saved.label}`, "info");
        ctx.shutdown();
      } catch (error) {
        report(ctx, error);
      }
    },
  });

  pi.registerCommand("restore-terminal", {
    description:
      'Set terminal command prefix as JSON, e.g. /restore-terminal ["foot"]',
    handler: async (args, ctx) => {
      try {
        if (ctx.mode !== "tui")
          throw new Error("/restore-terminal requires interactive Pi.");
        if (!args.trim()) {
          ctx.ui.notify(
            `Terminal: ${JSON.stringify(store.terminal() ?? ["xdg-terminal-exec"])}. Set a JSON argument array; Pi command is appended.`,
            "info",
          );
          return;
        }
        const terminal = JSON.parse(args);
        terminalArgs(terminal, []);
        if (!available(terminal[0]))
          throw new Error(`Terminal executable not found: ${terminal[0]}`);
        await store.setTerminal(terminal);
        ctx.ui.notify(`Terminal saved: ${JSON.stringify(terminal)}`, "info");
      } catch (error) {
        report(ctx, error);
      }
    },
  });

  pi.registerCommand("restore-forget", {
    description:
      "Forget a saved reference without deleting its conversation file",
    handler: async (_args, ctx) => {
      try {
        if (ctx.mode !== "tui")
          throw new Error("/restore-forget requires interactive Pi.");
        const records = store.list();
        if (!records.length) {
          ctx.ui.notify("No saved entries.", "info");
          return;
        }
        const choices = records.map(
          (saved, i) =>
            `${i + 1}. ${saved.label} — ${saved.cwd} [${saved.status}]`,
        );
        const choice = await ctx.ui.select("Forget saved reference", choices);
        if (!choice) return;
        const saved = records[choices.indexOf(choice)];
        if (!saved)
          throw new Error("Unknown selection. Reopen /restore-forget.");
        const warning =
          saved.status === "launching"
            ? " Close any corresponding terminal first. A delayed launch will be rejected."
            : "";
        if (
          !(await ctx.ui.confirm(
            "Forget saved reference?",
            `Forget “${saved.label}”? The conversation file will NOT be deleted.${warning}`,
          ))
        )
          return;
        await store.forget(saved);
        ctx.ui.notify(
          "Saved reference forgotten; conversation file untouched.",
          "info",
        );
      } catch (error) {
        report(ctx, error);
      }
    },
  });

  pi.registerCommand("restore-status", {
    description:
      "Show state location, launch age, and diagnostic argument vectors",
    handler: async (_args, ctx) => {
      try {
        if (ctx.mode !== "tui")
          throw new Error("/restore-status requires interactive Pi.");
        const terminal = store.terminal() ?? ["xdg-terminal-exec"];
        const records = store.list();
        const lines = [
          `State: ${join(store.dir, "saved.json")}`,
          `Configured terminal: ${JSON.stringify(terminal)}`,
        ];
        for (const saved of records) {
          lines.push(
            `${saved.status}: ${description(saved)}\nSession: ${saved.sessionFile}`,
          );
          if (saved.status === "launching") {
            lines.push(
              `Launch started: ${saved.launchedAt}`,
              `Command with current terminal configuration (diagnostic only): ${JSON.stringify(terminalArgs(terminal, restoreCommand(saved, agentDir)))}`,
            );
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (error) {
        report(ctx, error);
      }
    },
  });

  pi.registerCommand("restore", {
    description:
      "Pick a saved conversation or restore all pending sessions in new terminal windows",
    handler: async (_args, ctx) => {
      try {
        if (ctx.mode !== "tui")
          throw new Error("/restore requires interactive Pi.");
        const current = ctx.sessionManager.getSessionId();
        const records = store
          .list()
          .filter(
            (s) =>
              s.status === "launching" ||
              (s.status === "pending" && s.sessionId !== current),
          );
        if (!records.length) {
          ctx.ui.notify(
            "No pending sessions (the current conversation is excluded).",
            "info",
          );
          return;
        }
        const all = "Restore all pending";
        const choices = records.map((s, i) => `${i + 1}. ${description(s)}`);
        const choice = await ctx.ui.select("Restore saved sessions", [
          all,
          ...choices,
        ]);
        if (!choice) return;
        const selected =
          choice === all
            ? records.filter((s) => s.status === "pending")
            : [records[choices.indexOf(choice)]];
        if (selected.some((s) => !s))
          throw new Error("Unknown selection. Reopen /restore.");
        const launching = selected.find(
          (s): s is Launching => s.status === "launching",
        );
        if (launching) {
          const saved = launching;
          const ok = await ctx.ui.confirm(
            "Reset unacknowledged launch?",
            `Close any terminal opened for “${saved.label}” first. A delayed launch will be rejected. Reset to pending without launching?`,
          );
          if (ok) {
            await store.reset(saved.sessionId, saved.ticket);
            ctx.ui.notify("Reset to pending. Use /restore to retry.", "info");
          }
          return;
        }
        if (!selected.length) {
          ctx.ui.notify(
            "No pending sessions. Select an unacknowledged launch to reset it.",
            "info",
          );
          return;
        }
        const terminal = await resolveTerminal(ctx.ui);
        if (!terminal) return;
        const launched = await claimAndLaunch(selected, terminal, (error) =>
          report(ctx, error),
        );
        ctx.ui.notify(
          `Spawned ${launched} terminal launcher(s); this does not confirm restoration. Pi acknowledges startup separately. Use /restore for recovery or /restore-status for diagnostics.`,
          "info",
        );
      } catch (error) {
        report(ctx, error);
      }
    },
  });
}

export default function (pi: ExtensionAPI) {
  const agentDir = resolve(
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  );
  register(pi, new Store(join(agentDir, "session-restore")), agentDir);
}
