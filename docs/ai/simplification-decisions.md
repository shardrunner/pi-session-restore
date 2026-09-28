---
summary: Verified simplification review, implemented changes, and settled scope decisions.
read_when:
  - Reviewing or simplifying session-restore.
  - Considering changes to claims, reset, storage cleanup, or forget confirmation.
---

# Simplification review decisions

Reviewed the supplied whole-project review against `core.ts`, `index.ts`, both
unit suites, the PTY harness, README, package metadata, CI, and release checklist.
Implementation: `1cb773e`. This records decisions, not a claim that future changes
need no review. Reopen them for changed requirements or concrete failures, not
line-count preferences.

## Settled product scope

- Linux and persistent global installation are given constraints, not portability
  backlog items.
- Manual reset is acceptable. No launch timeout retry, daemon, watchdog, or fencing
  service is needed.
- No additional cross-project claim protection is required. The existing lock
  protects one agent directory's shared `saved.json`; tickets coordinate this
  extension's requests against that store. Retain these local mechanisms, not a
  new project registry or coordination across independent agent directories.
  This is not a general lock on conversation files or arbitrary Pi processes.
- No snapshots, backups, power-loss durability, or historical terminal snapshots.

## Assessment and dispositions

### 1. Restore handler decomposition — implemented, narrowly

The handler mixed picker/recovery policy, terminal setup, and per-entry launch
error handling. Extracted `resolveTerminal` and `claimAndLaunch` as private
functions inside `register`. They capture its existing dependencies and do not
receive the full command context. The handler retains selection, confirmation,
and final reporting. Launch count still means spawned launchers, not restoration.

Did not export helpers, introduce a service/options abstraction, or move tests
away from the command boundary just to avoid fixture registration. Existing
command tests are small and verify wiring as well as behavior. Added coverage
for no available terminal and cancellation of terminal selection. The helpers
perform I/O; they are not pure functions merely because they do not accept `ctx`.

### 2. Unify release/reset — declined

These small methods express different policies: spawn rollback silently ignores
an obsolete ticket, whereas a user-confirmed reset rejects a changed launch.
A `strict` flag would hide intent at call sites and move, rather than remove,
branching. Returning a boolean would require callers to recreate reset's error
policy. Keep the named operations and their distinct regression tests.

### 3. Replace cleanup aggregation — declined

The existing short, linear error collection attempts temporary-file cleanup and
unlock independently, reports both failures visibly, and preserves the primary
error. A plain `finally` can mask the original failure; nested `finally` only
ensures unlock is attempted, not that it succeeds. Preserving all diagnostics
with causes needs additional policy and is not clearly simpler. Do not add more
double-fault machinery, but do not rewrite this tested code to suppress errors.
The review supplies no production evidence that these failures are impossible.

### 4. Forget comparison — implemented with a correction

`JSON.stringify` does depend on property order, but whitespace/pretty-printing
alone does not affect this comparison: both records have already been parsed.
Normal current serialization is consistent, so this was a low-priority cleanup,
not an observed production data-loss incident.

Used Node's `isDeepStrictEqual` for complete, order-independent record comparison.
The suggested `(sessionId, status, ticket, savedAt)` comparison omits label, paths,
and other timestamps. `savedAt` is a wall-clock timestamp, not a unique revision.
Do not weaken confirmation checks or add a revision schema for this purpose.
Tests demonstrate reordered properties succeed and changed label/path values
still conflict even when identity, status, and saved timestamp match.

### 5–6. Diagnostics and terminal validation — no change

Live launch age, the current-vector diagnostic warning, terminal candidate list,
and `terminalArgs` validation all remain. No clock abstraction, terminal history,
or separate validation framework is justified. Header-only reading, canonical
paths, strict saved-state validation, and literal argv execution remain intact.
The PTY harness covers actual global discovery/startup and is not redundant with
mocked command tests.

## Evidence and validation

- Baseline: all 36 tests passed. The new property-order regression failed against
  the original implementation, then passed after the comparison change.
- After implementation: strict typecheck and all 39 tests passed on Node 26.9.0.
  Formatting and `git diff --check` passed. `npm pack --dry-run` includes only
  the intended seven runtime/documentation files, including this record.
- All three isolated real-Pi PTY scenarios passed using the package-pinned Pi
  0.85.1: restore/resave, expired ticket, and wrong-session ticket.
- The concurrent-claim tests assert exclusivity; this review did not mutation-test
  lock removal. In particular, `Promise.all` of synchronous mutation bodies is
  not by itself evidence of a cross-process race. The separate-process test and
  shared read-modify-write design justify retaining the lock.
- Desktop window behavior and Node 24 were not manually exercised here. Existing
  CI and the release checklist remain responsible for that coverage.

## Final review

Fresh-eyes review found no production regression in the extraction or comparison.
Strengthened the new terminal-cancellation test to assert a launch counter outside
the command handler: an assertion thrown by the launch stub could otherwise be
caught by normal error handling and let the test pass. No runtime changes needed.

Unrelated sibling-extension working-tree changes were left untouched.
