---
summary: Manual Pi session saving and restoration in separate terminal windows, with individual labels and startup acknowledgement.
read_when:
  - Using or changing /save, /restore, or /restore-terminal.
  - Debugging saved-session state or unacknowledged terminal launches.
---

# Session restore

The README is the canonical operational guide:

- [Requirements](../../README.md#requirements) and [installation](../../README.md#install): supported environment and persistent global registration; do not install a second discovered copy.
- [Use](../../README.md#use): commands, saved references, and [terminal configuration](../../README.md#terminal-configuration).
- [Recovery and diagnostics](../../README.md#recovery-and-diagnostics): uncertain launches and manual reset; also read [state and locking](../../README.md#state-and-locking) and [safety boundaries](../../README.md#safety-boundaries) before recovery.
- [Engineering decisions](../../README.md#engineering-decisions): lifecycle, ticket-scoped transitions, and resource boundaries.
- [Development and testing](../../README.md#development-and-testing): canonical validation commands and automated coverage limits.
- [Simplification decisions](simplification-decisions.md): historical review outcomes and settled scope; preserve the distinct claim, reset, and cleanup guarantees.
- [Release checklist](release-checklist.md): release checks and required manual desktop validation before claiming terminal compatibility.

Additional invariants:

- Switching sessions after saving does not retarget that reference; save the new conversation separately.
- Ephemeral sessions, missing session files or working directories, and mismatched session headers fail rather than create replacement conversations.
- Ordinary startup registers commands and checks the internal flag without scanning sessions or reading saved state. Filesystem operations occur on commands and restore acknowledgement; lock retries occur only while a command is active.
