# pi-session-restore

> **Disclaimer:** This extension is vibe coded for personal use. Use at your own risk.

Keep a list of [Pi](https://pi.dev) conversations to come back to later, and reopen
each one in its own terminal window.

A small Linux desktop tool with no background service and no model calls.

## Why

- When you juggle several conversations, closing terminals means losing track of which ones still need work.
- Pi's `/resume` lists all saved sessions and switches the current window. It doesn't keep a short list of the ones you meant to come back to, or open them in separate windows.

## Features

- `/save "Fix login"` saves a reference to the conversation and exits Pi.
- `/restore` reopens one or all saved conversations in new terminal windows, each in its
  original working directory.
- An entry is only marked as restored once the new Pi instance confirms it started with
  the right session and launch ticket.
- Safe when several Pi processes run at once: changes are locked, written atomically and
  tied to a single launch ticket.
- Any terminal that can run a command in a new window works (`xdg-terminal-exec`, foot,
  kitty, GNOME Terminal and others).

## Installation

Requirements:

- Linux, GNU `env` with `--chdir` and `pi` on `PATH`
- **Pi 0.87.1+** and **Node.js 24+**, with this extension **installed globally** in the same Pi agent directory
- A terminal that can run a command in a new window

The new window starts plain `pi`, so the extension has to be installed globally to
confirm the restore. macOS, Windows, project-only installs and temporary `pi -e`
loading are not supported.

```sh
pi install git:github.com/shardrunner/pi-session-restore
```

Run `/reload` in open Pi sessions. Update with `pi update --extensions`.
For local development, install a checkout instead (`pi install "$PWD"` from the clone)
and keep it at that location. Don't also put a copy in Pi's auto-discovered extensions
directory. No runtime dependencies, no build step.

## Usage

```text
/save "Fix login"     # in the conversation you want to come back to; Pi exits
/restore              # from any other Pi instance
```

| Command                          | Purpose                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `/save [label]`                  | Save or update the current conversation's reference, then exit. Default label: session name, else directory and time.           |
| `/restore`                       | Open a saved conversation, all pending ones, or reset a launch that never confirmed. Never relaunches the current conversation. |
| `/restore-forget`                | Remove a saved reference after confirmation. Conversation files are never deleted.                                              |
| `/restore-status`                | Show where state is stored, session paths, launch times and the command that would be run.                                      |
| `/restore-terminal [JSON array]` | Show or set the terminal command prefix.                                                                                        |

Saving the same session again replaces its entry and marks it pending. Saving keeps a
**reference, not a snapshot**: it doesn't preserve scrollback, running tools, editor
drafts or window placement. A brand-new conversation may not have a session file yet.

### Terminal configuration

The extension uses `xdg-terminal-exec` when it's available. Otherwise the first
`/restore` asks you to choose an installed terminal and remembers it:

```text
/restore-terminal ["foot"]
/restore-terminal ["kitty", "--"]
/restore-terminal ["gnome-terminal", "--window", "--"]
```

The prefix must open a **new window** and run the appended arguments as-is, without
passing them through a shell:

```text
env --chdir <cwd> PI_CODING_AGENT_DIR=<agent-directory> pi --session <file> --saved-session-ticket <ticket>
```

## Design

```text
/save → pending → claim a unique ticket → launching
launching → exact-session startup acknowledgement → restored
launching → confirmed reset / spawn failure → pending
restored → /save → pending
any saved entry → confirmed forget → reference removed
```

- **Wait for confirmation:** a terminal can open successfully while the command inside
  it fails, so an entry only counts as restored once the new Pi instance confirms it.
- **Exclusive claims:** a directory lock serializes changes across Pi processes, and
  writes go to a private temporary file followed by an atomic rename. This assumes a
  local filesystem with atomic directory creation and rename.
- **Ticket-scoped changes:** late confirmations and old reset requests can't affect a
  different launch.
- **No automatic retries:** a slow launch may still succeed, and opening it again would
  give the session two writers. Recovery is a deliberate manual step.
- **Small codebase:** `core.ts` handles validation, storage and state changes;
  `index.ts` handles commands, dialogs and launching. No runtime dependencies, polling
  or file watchers.

The [simplification decision record](docs/ai/simplification-decisions.md) lists which
review suggestions were adopted or rejected, and why.

## Behavior and limitations

### Recovery

**An opened terminal isn't a restored session.** If the terminal starts but Pi doesn't,
the entry stays `launching`. To recover:

1. Check the new terminal for a startup or trust dialog.
2. Use `/restore-status` to see the state path, launch age and command. It shows the
   _current_ terminal setting, not a history of what was run, so don't run it manually.
3. Close the related terminal, then pick the entry in `/restore` and confirm the reset.
4. Run `/restore` again to retry. A reset alone never opens a window.

Missing files or directories cause an error and keep the entry; use `/restore-forget`
to remove it.

### State and locking

State is stored in `~/.pi/agent/session-restore/saved.json` (or under
`PI_CODING_AGENT_DIR`), with permissions 0700 for new directories and 0600 for files. If
a write is interrupted, an empty `write.lock` directory can be left behind. **Make sure
no save or restore is running**, then remove it with `rmdir`. Never force-remove a lock
that might be in use. A corrupted state file causes a visible error and is never
replaced silently.

### Safety

- Close the original Pi instance before restoring its conversation. The extension only
  coordinates its own restores; it is not a general session lock.
- With an invalid or expired ticket, the new Pi shuts down. Pi may already have written
  startup metadata by then.
- State and diagnostic output contain labels, absolute paths and tickets, so don't
  publish them. Conversation content is never copied into the state file.
- A custom terminal prefix runs with your permissions. Only configure executables you
  trust.
- Atomic renames prevent half-written JSON, but they are no backup and don't protect
  against power loss.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run format:check
npm run test:integration
```

Requires Node.js 24+. `check` runs strict TypeScript checking and Node's test runner.
Unit tests cover concurrent claims across processes, outdated tickets, recovery, lock
timeouts and injected filesystem failures. The Python integration test (standard library
only) runs real Pi commands in pseudo-terminals with an isolated home directory, a fake
terminal and no credentials. CI runs on Linux with Node 24 and 26. Before a release,
check the result in a real desktop terminal using the
[release checklist](docs/ai/release-checklist.md).

## License

[MIT](LICENSE) © 2026 Michael Brunner
