---
summary: Manual Pi session saving and restoration in separate terminal windows, with individual labels and startup acknowledgement.
read_when:
  - Using or changing /save, /restore, or /restore-terminal.
  - Debugging saved-session state or unacknowledged terminal launches.
---

# Session restore

Global extension: `~/.pi/agent/extensions/session-restore/index.ts`.
Load it in existing Pi instances with `/reload`; new instances discover it automatically.
No installation, additional npm dependencies, Sway configuration, or separate script is needed.

## Commands

- `/save [label]`: save the current conversation for later restoration. Quotes around a label are optional. Without a label, use Pi's session name; otherwise use the project directory name and an ISO timestamp. Labels identify individual conversations, not groups.
- `/restore`: select one pending conversation or **Restore all pending**. Each opens in a separate terminal window in its saved working directory. The current conversation is excluded.
- `/restore-terminal [JSON argument array]`: configure the terminal command prefix. Without arguments, show the current configuration.

Examples:

```text
/save
/save "Fix login"
/restore
/restore-terminal ["foot"]
/restore-terminal ["kitty", "--"]
/restore-terminal ["gnome-terminal", "--window", "--"]
```

Saving remembers a session file, not a frozen copy. It restores the latest persisted conversation, not terminal scrollback, running tools, editor drafts, window geometry, or workspace placement. Session switching after saving does not retarget an existing save: save the new conversation separately. Saving the same session updates its label and makes it pending again; duplicate labels across different sessions are allowed.

An ephemeral session, missing session file, missing working directory, or mismatched session header produces an error rather than creating a replacement conversation. A brand-new Pi session may not have a file yet: save after it has persisted some conversation history.

Close original instances before restoring them elsewhere. This extension prevents duplicate **restore requests**, but deliberately does not monitor arbitrary running Pi instances. Do not concurrently edit the same session in an unmanaged instance.

## Terminal selection

On Linux, use `xdg-terminal-exec` if available. If it is absent, the first restore asks which installed terminal to use and remembers the choice. Foot, Kitty, Alacritty, WezTerm, GNOME Terminal, Konsole, and Xterm have candidate command prefixes; the extension is not bound to any one of them.

A custom prefix must open a **new window** and execute the appended argument vector, not interpret it as a shell string. Use `/restore-terminal` to override a launcher whose configuration reuses tabs/windows. Terminal adapter choices other than the test launcher are not end-to-end tested automatically.

The appended command uses GNU `env --chdir <cwd> PI_CODING_AGENT_DIR=<directory> pi --session <exact file> --saved-session-ticket <ticket>`. Thus `pi` and GNU `env` must be on PATH. It sends no prompt. The agent directory is explicitly passed through terminal-server boundaries.

## State and recovery

State is kept outside the extension source at:

```text
~/.pi/agent/session-restore/saved.json
```

`PI_CODING_AGENT_DIR` overrides the base agent directory. Newly created state directories are mode 0700; state files are mode 0600. Conversation contents are not copied into the state file.

Lifecycle:

```text
/save → pending → /restore claims ticket → launching
launching → exact session acknowledges startup → restored
/save again → pending
```

Restored entries remain in the JSON file but disappear from the picker. Another restore run does not reopen them. Cross-process file locking serializes state changes; atomic rename keeps readers from seeing partial JSON. Startup acknowledgements validate the ticket, session ID, and canonical session path. A delayed or invalidated launch is told to shut down instead of becoming a duplicate writable session.

A process-spawn error returns the entry to pending. A terminal that starts but fails to execute Pi cannot acknowledge startup: its entry stays **awaiting startup**. If startup is merely waiting for a trust dialog, finish that dialog first. Otherwise, close any corresponding terminal, select the entry in `/restore`, and confirm resetting it to pending. Run `/restore` again to retry. Reset does not itself launch a window. It only resets the ticket shown in the picker; if that launch changes during confirmation, it reports an error and leaves the current state untouched. No timeout automatically reopens uncertain launches.

An interrupted state write can leave an empty `write.lock` directory. Commands report its exact path after a bounded two-second wait. Only after checking that no save/restore operation is running, remove that empty directory with `rmdir` and retry. Invalid state fails loudly; it is never silently replaced. Files are atomically replaced but this is not a backup or a guarantee against hardware/power-loss corruption.

## Resource use

There is no idle daemon, timer, watcher, polling, automatic save, or automatic restoration. Ordinary startup registers commands and checks the internal flag; it does not scan sessions or read saved state. Filesystem operations happen on commands and restore acknowledgement. A contended write briefly retries its lock only while the command is active.

No LLM tools, prompts, context messages, or model calls are registered or sent. Save/restore has no token cost. Pi and other installed extensions retain their normal startup behavior.

## Validation

```bash
cd ~/.pi/agent/extensions
node --test session-restore/*.test.ts
python session-restore/smoke-test.py
```

The Node tests cover naming, duplicate saves, consumption/rearming, exact identity checks, cancellation, individual/all selection, spawn failure, state validation/privacy, and cross-process claim exclusion. They use Node's native TypeScript support (tested with Node 26).

The smoke test runs real Pi in an isolated PTY with an isolated agent directory, no credentials, offline mode, and no submitted model prompt. It verifies extension loading, custom CLI flag parsing, exact conversation restoration, and startup acknowledgement. It does not open desktop terminal windows.
