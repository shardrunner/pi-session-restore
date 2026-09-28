# Pi Session Restore

Bookmark [Pi](https://pi.dev) conversations and reopen them in separate terminal
windows, with cross-process claim protection and startup acknowledgement.

Pi's `/resume` switches the conversation in the current instance. This extension
keeps an explicit queue of conversations you want to reopen later, one per new
window. It is a small, opinionated Linux desktop tool: manual saving, manual
restoration, no daemon, and no model calls.

## Requirements

- Linux, GNU `env` with `--chdir`, and `pi` available on `PATH`.
- Requires Pi **0.87.1+**; development dependencies pin **0.87.1**. Newer versions are intended targets, not a guarantee against upstream API changes.
- Node **24+** for development; CI checks Node 24 and 26.
- A desktop terminal capable of executing an argument vector in a new window.
- **Persistent global installation** of this extension in the same Pi agent directory.

macOS, Windows, project-only installations, and temporary `pi -e` loading are not
supported restore configurations. A child starts plain `pi`, so it must discover
the extension globally to acknowledge its ticket. Custom Pi startup flags and
project-specific extension configuration are not copied from the original process.

## Install

Clone this repository, then register its directory globally:

```bash
cd /path/to/pi-session-restore
pi install "$PWD"
```

Run `/reload` in existing Pi instances. No runtime dependency installation is
needed for the extension itself; it uses Node built-ins and Pi's extension API.
Keep the checkout at the registered location. Do not also install a second copy
under Pi's auto-discovered extension directory.

Once hosted, Pi also supports installing a GitHub repository using
`pi install git:github.com/OWNER/REPOSITORY@TAG`.

## Use

In a conversation with persisted history:

```text
/save "Fix login"
```

Pi exits automatically after a successful save; a failed save leaves it open.
From another Pi instance:

```text
/restore
```

Choose the conversation or **Restore all pending**. Each starts in its saved
working directory. A record disappears from the picker only after the child Pi
instance acknowledges the exact session and launch ticket.

| Command                          | Purpose                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `/save [label]`                  | Save or replace the current conversation's reference, then exit Pi. Default label: session name, then directory and timestamp.   |
| `/restore`                       | Open pending conversations or reset uncertain launches. Never launch the current conversation.                                   |
| `/restore-forget`                | Forget any saved reference, including restored or missing sessions. Confirmation required; conversation files are never deleted. |
| `/restore-status`                | Show state location, session paths, launch timestamps/age, and diagnostic argument vectors.                                      |
| `/restore-terminal [JSON array]` | Show or configure the terminal command prefix.                                                                                   |

Re-saving the same session replaces its previous reference (matched by session ID,
not label), updates its label, and makes it pending again without creating a duplicate.
Labels need not be unique. Saving is **not a snapshot or backup**: it remembers
the latest persisted conversation in the original session file. It does not
preserve terminal scrollback, running tools, editor drafts, or window placement.
A brand-new conversation may not have a persisted file yet.

### Terminal configuration

Use `xdg-terminal-exec` automatically when available. Otherwise, the first restore
asks you to select an installed terminal and remembers your choice.

```text
/restore-terminal ["foot"]
/restore-terminal ["kitty", "--"]
/restore-terminal ["gnome-terminal", "--window", "--"]
```

Candidates also include Alacritty, WezTerm, Konsole, and Xterm. The prefix must
open a **new window** and execute the appended arguments literally, not interpret
them as a shell command. Your terminal's configuration can affect window reuse.
Candidate prefixes are not a claim of automated desktop compatibility testing.

The appended command is an argument vector equivalent to:

```text
env --chdir <cwd> PI_CODING_AGENT_DIR=<agent-directory> pi --session <file> --saved-session-ticket <ticket>
```

No shell interpolation and no prompt are involved. The agent directory is passed
explicitly through terminal-server boundaries. `pi` and `env` must also be
resolvable in the terminal's execution environment.

## Recovery and diagnostics

**A spawned launcher is not a restored session.** If a terminal starts but cannot
execute Pi, the saved entry stays `launching`.

1. Check for a startup/trust dialog in the new terminal.
2. Use `/restore-status` to inspect the state path, launch age and command arguments.
   The displayed vector uses the **current** terminal configuration; it is not a
   historical execution log. Do not execute it again while a launch is uncertain.
3. Close any corresponding terminal before selecting the awaiting-startup entry
   in `/restore` and confirming reset.
4. Invoke `/restore` again to retry. Reset alone never launches a window.

The current conversation is excluded from launch actions, but its uncertain
launch can still be reset. A stale confirmation cannot invalidate a newer ticket.
Forgetting an uncertain launch also invalidates its ticket.

Missing files and directories produce errors without consuming the entry. Use
`/restore-forget` to remove obsolete references. Restored references remain stored
until explicitly forgotten.

### State and locking

State lives outside the source tree:

```text
~/.pi/agent/session-restore/saved.json
```

`PI_CODING_AGENT_DIR` overrides the agent directory. New state directories are
0700 and files are 0600. Existing directory permissions are not changed.

An interrupted write can leave an empty `write.lock` directory. After a bounded
two-second wait, commands report its path. **Only after checking that no save or
restore operation is running**, remove that empty directory with `rmdir` and
retry. Never force-remove a potentially active lock. Failed cleanup may also
leave a `.saved-*.tmp` file; preserve it if investigating a failed write.

Malformed state fails visibly and is never silently replaced. Back up the file
before manually repairing it. Earlier unpublished prototype state is not a
supported compatibility contract: launching entries must have a nonempty ticket
and valid `launchedAt`; restored entries require `restoredAt`. Do not fabricate a
new ticket to recover an uncertain launch.

### Safety boundaries

- Close original instances before restoring their conversations. This extension
  coordinates **its own restore requests**, not arbitrary Pi processes writing
  the same session. It is not a general session lock.
- Invalid/expired tickets cause the child Pi to request shutdown. Pi may already
  have written startup metadata before the extension receives `session_start`;
  rejection is not a byte-for-byte read-only open.
- Other installed extensions retain their normal startup behavior and permissions.
- State and diagnostic output include labels, absolute paths and launch tickets.
  Do not publish them. Conversation contents are not copied into saved state.
- Custom terminal prefixes execute with your permissions. Configure only trusted
  executables. Argument-vector handling does not sandbox the chosen executable.
- Atomic rename prevents partial JSON reads, but is not a power-loss durability
  guarantee or a backup. The lock assumes a local filesystem with normal atomic
  directory creation and rename semantics.

## Engineering decisions

```text
/save → pending → claim a unique ticket → launching
launching → exact-session startup acknowledgement → restored
launching → confirmed reset / spawn failure → pending
restored → /save → pending
any saved entry → confirmed forget → reference removed
```

- **Acknowledgement instead of optimistic success:** terminal launchers and servers
  can succeed while the intended command fails.
- **Exclusive claims:** a directory lock serializes read-modify-write operations
  across Pi processes. Writes use a private temporary file and atomic rename.
- **Ticket-scoped transitions:** delayed acknowledgements and stale confirmations
  cannot consume or reset a different launch.
- **No automatic timeout retries:** a slow launch may still succeed; reopening it
  automatically risks two writers. Recovery deliberately requires a human decision.
- **Minimal architecture:** `core.ts` owns validation, storage and transitions;
  `index.ts` owns commands, dialogs and process launching. No runtime dependencies,
  polling, watchers, model tools, or background resources during ordinary startup.

The [simplification decision record](docs/ai/simplification-decisions.md) explains
which review proposals were implemented or rejected and why. Linux/global-only
installation and manual reset are settled constraints; no additional cross-project
claim coordination is planned.

## Development and testing

```bash
npm ci --ignore-scripts
npm run check
npm run format:check
npm run test:integration
```

`npm run check` runs strict TypeScript checking and Node's test runner. Native
TypeScript execution alone does not typecheck the source.

Tests cover concurrent cross-process claims, canonical paths, stale tickets,
current-session recovery, forgetting, terminal configuration, partial batch
failure, lock timeout, filesystem failures and cleanup. Filesystem operations
have a narrow injection seam for deterministic failure tests.

The Python integration test uses only the standard library. It loads the package
through isolated **global settings**, drives real Pi commands in PTYs, and uses a
fake terminal to execute the exact generated argv. It also verifies real Pi exits
on expired and wrong-session tickets. Each scenario has an isolated home/agent
directory, an allowlisted environment without provider credentials, offline mode,
and bounded cleanup. No desktop window or model prompt is created.

CI runs these checks on Linux with Node 24 and 26 and the pinned Pi version.
Before a release, manually verify your preferred desktop terminal using
[the release checklist](docs/ai/release-checklist.md). Automated PTY tests do not
verify actual window creation or terminal-server environment behavior.

## License

[MIT](LICENSE), © 2026 Michael Brunner.
