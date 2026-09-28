---
summary: Release validation and manual desktop-terminal checks for session restore.
read_when:
  - Publishing a session-restore release.
  - Changing terminal launching, packaging, or the startup acknowledgement protocol.
---

# Release checklist

## Automated

- Run `npm ci --ignore-scripts`, `npm run check`, `npm run format:check`, and
  `npm run test:integration` from a clean checkout.
- Confirm CI passes on both supported Node versions.
- Run `npm pack --dry-run` and verify only intended runtime files are included.
- Keep the tested Pi version in the README and development dependencies aligned.
- Inspect the Git diff for credentials, personal paths and session data. Never
  include saved state, diagnostic output, or real conversations in the repository.
- Set the repository URL in package metadata when the GitHub destination is known.
  Add a CI badge only once it points to the real repository and successful workflow.

## Manual desktop check (required before claiming terminal compatibility)

1. Install the package globally into a disposable Pi agent directory. Use that
   same `PI_CODING_AGENT_DIR` for each test instance. Do not use personal sessions.
2. Create two test conversations with persisted history and save both. Confirm
   each Pi instance exits after saving. Prefer test project paths containing spaces.
3. Configure the terminal prefix under test. From another instance, restore one
   conversation. Confirm a **new window**, correct working directory and history,
   and `restored` status.
4. Rearm it with `/save`; confirm it replaces the existing reference and exits.
   Then restore all pending conversations. Confirm one new window per selected
   conversation and no second launch on another restore.
5. Configure a test wrapper that starts but exits without running Pi. Confirm the
   entry remains awaiting startup; inspect `/restore-status`, close any window,
   reset the entry, and retry with the working terminal.
6. Forget a saved reference and verify its conversation file still exists.
7. Record the OS, Pi, Node, terminal version, exact prefix and result in release
   notes. Do not claim untested terminal candidates as verified.

Do not run desktop tests during ordinary CI. The fake-terminal integration test
covers command construction and acknowledgement, not a desktop environment.
