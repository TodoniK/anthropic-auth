# OpenCode intermittent-test diagnosis

Base: `2349d7c51df06149db749b0d2fc90b7119e3192e`, common-auth 0.14.2.
All measurements used offline `ck-motor` jobs (2 vCPUs), Bun
`1.3.14 (0d9b296a)` at `/usr/local/bin/bun-1.3.14`, with a temporary `bun`
symlink prepended to PATH. Core was rebuilt before each batch. No test retries,
deadline increases, production changes, or global timer mocks were used.

## Baseline measurements

Each single-test attempt was a new process:

```sh
bun test packages/opencode/src/tests/FILE.test.ts --test-name-pattern 'EXACT NAME'
```

Each full-file attempt was also a new process, omitting the name filter.

| Target | Single-test failures / attempts | Target failures in full file | Entire-file failures / attempts |
| --- | ---: | ---: | ---: |
| custody: reconciles a real main without a resolved binding before serving OAuth | 21/100 | 2/10 | 2/10 |
| header push persists source headers and refreshes sidebar checkedAt without a usage poll | 2/100 | 0/10 | 8/10 |
| fast off emits info log and persists | 4/100 | 0/10 | 0/10 |

The other `index.test.ts` failures were varied polling/deadline failures, not
the header target. The custody failures included old-account assertions and
four timeouts; all four fast failures were 5-second timeouts, not assertions.

## Custody: cancellation is not discovery completion

The test opened `listingGate` and immediately disposed the stale plugin
(`packages/opencode/src/tests/custody-tombstone.test.ts:748`). Disposal could
abort the startup refresh's caller before its discovery operation released the
cross-runtime lease. The new runtime's refresh then legitimately returned the
last committed migration roster instead of starting another list.

The failure-only trace showed `list-waits-return`, client close, startup readiness,
and disposal, followed by discovery returning the **migration** view with the old
UUID; `list-answers-start` never occurred. This is outside the offline setup
transaction. Relevant implementation contracts:

- `packages/core/src/native-vault-runtime.ts:541-563`: shared refresh, shutdown
  cancellation, primary-pin publication, and cancellation of a caller's wait.
- common-auth 0.14.2 `dist/claustrum/roster.js:438-480`: the discovery lease covers
  list plus commit; a busy peer receives the committed roster; release is awaited
  in `finally`.
- `packages/core/src/native-vault-runtime.ts:833-839`: close aborts shutdown.
- `packages/opencode/src/index.ts:2876-2891`: `__fallbackRefreshReady` joins startup
  vault readiness and fallback refresh.

The fix opens the held listing and awaits that existing startup promise **before**
disposing the stale plugin. This is the actual dependency: discovery has completed
and relinquished its lease before the test asks another runtime to discover.
It does not change the supported peer-refresh or cancellation behavior.

## Header push: response completion is not sidebar publication

`packages/opencode/src/index.ts:2580-2619` starts detached quota persistence,
updates the quota cache, then schedules a sidebar refresh. That refresh performs
additional asynchronous reads before queuing the sidebar write
(`packages/opencode/src/index.ts:4101-4114`). The old test instead exhausted the
50-attempt polling helper (`packages/opencode/src/tests/index.test.ts:1795-1804`).

Failure-only diagnostics preserved the original polling failure, then observed
the publication: initial sidebar writes at 99 and 444 ms had null quota; the
persisted account already had source `headers` and utilization 78; the harvest
completed at 2189 ms and the sidebar containing 78 was renamed at 2205 ms. No
usage request was needed. This demonstrates a late publication, not a permanently
lost or overwritten one.

The fix uses the existing path-scoped `afterRename` hook
(`packages/opencode/src/sidebar-state.ts:452-473,607-639`) to signal a TestLifetime
gate when the written sidebar contains the pushed quota. The body awaits that
event, not a polling budget. All original assertions remain; source `headers`
and persisted checkedAt now have explicit assertions too. TestLifetime opens
gates before joining the body (`packages/core/src/tests/test-lifetime.ts:80-84`),
so a missing event cannot deadlock teardown or delete files under a late body.

## Fast-off: migration filesystem latency, unchanged

The command already awaits persistence and logs before returning success
(`packages/opencode/src/index.ts:4631-4639`,
`packages/opencode/src/rpc/rpc-server.ts:103-109`). The failure occurs earlier:
`migratedClaude` awaits real fixture migration before constructing the plugin
(`packages/opencode/src/tests/info-logs.test.ts:172-212`,
`packages/opencode/src/tests/native-fixture.ts:241-287`).

Temporary, test-scoped instrumentation timed migration steps, filesystem promises,
and FileHandle methods. Slow samples below had no observational timer; no
production files were instrumented. A normal sample was explicitly captured for
comparison. Times are milliseconds since body start unless labeled duration.

| Milestone / duration | Normal | Slow run 27 | Slow run 28 |
| --- | ---: | ---: | ---: |
| migration before runtime | 19.087 | 555.653 | 1913.870 |
| migration after runtime | 21.453 | 1161.783 | 2636.557 |
| runtime FileHandle.sync duration | 0.167 | 578.678 | 497.674 |
| migration before host write | 30.870 | 1351.603 | 4460.867 |
| migration after host write | 32.813 | 4760.987 | 4841.287 |
| host-auth FileHandle.sync duration | 0.092 | 3406.811 | 377.563 |
| fixture migration complete | 39.606 | 5785.816 | 5212.085 |
| plugin constructed | 49.493 | 5821.546 | 5397.031 |
| RPC apply complete | 86.589 | 6029.630 | 5980.935 |
| assertions complete | 86.633 | 6029.673 | 5980.978 |
| writeFile total awaited time across body | 8.239 | 2156.301 | 5223.984 |
| maximum writeFile duration | 0.920 | 447.232 | 413.964 |

FileHandle.sync is awaited directly at
`packages/core/src/native-runtime.ts:815-821` and
`packages/core/src/native-host-auth-write.ts:183-193`. Slow writes included the
lock-owner/eviction-marker files themselves, not just waiting to acquire a lock.
Pool-config/state hook sequences contained only release-marker acquisition and
owner-confirmed release pairs, with no stale-lock or renewal-loss events.
Read/rename maxima were below 1 ms in both slow samples; process CPU was about
0.2 s. These were fresh processes and unique empty fixture roots, with no earlier
test or plugin writer present. The synthetic process-fence callback only counts
checks (`packages/opencode/src/tests/native-fixture.ts:237-256`).

Both slow runs emitted exactly `fast mode changed { enabled: false }` and reached
every assertion; Bun reported `this test timed out after 5000ms`. The observed
delays are awaited filesystem operations, including a 3.407-second sync, not
an uncovered RPC/startup wait or a production retry/backoff loop. Timings include
Bun's filesystem dispatch, not only kernel execution. Two 100-run syscall-traced
batches did not reproduce the timeout; the untraced FileHandle probes did.

Fast-off and the fixture remain byte-for-byte unchanged. Moving migration into a
new hook budget, reducing durability, or adding an unrelated readiness wait would
hide or change the observed behavior. The reviewer approved leaving it unchanged
after reviewing both slow samples and the normal sample.

## Verification and first-attempt suite results

- After removing all diagnostic instrumentation: **100/100** fresh custody runs,
  **100/100** fresh header runs, **100/100** fresh unchanged fast-off runs passed.
  The two fixes are sequencing fixes, not production behavior changes.
- `bun run --cwd packages/core build`: 36 declaration assets, 114 modules,
  329 relative declaration edges, no producer dependency.
- `bun run --cwd packages/opencode types`: both source and scripts projects
  passed; TypeScript **7.0.2**, Bun **1.3.14**.
- Scoped diagnostics: 0 errors and 0 warnings for both changed test files.
- `bun run format:check`: Biome **2.5.14**, 401 files checked, passed after
  correcting formatting in the changed header test.
- Comment review: both new comment blocks reviewed; no clarity issues flagged.

The first unfiltered suite command, `bun test packages/opencode/src/tests`, ran
1935 tests: **1934 pass, 1 fail**, 8 snapshots and 22046 assertions. The only
failure was the network-required `opencode2-e2e.test.ts` installation hook:

```text
error: Packed OpenCode host verification requires npm registry access. Run this gate in network-enabled CI; no host checks ran.
(fail) (unnamed) [162.42ms]
```

That is the **opencode2-e2e registry refusal**, not any of the three targets.
It was not retried with network access. The first explicitly offline suite command
excluded only that file:

```sh
bun run --cwd packages/opencode test --path-ignore-patterns '**/opencode2-e2e.test.ts'
```

It ran 1934 tests: **1930 pass, 4 fail**, 8 snapshots and 22042 assertions.
All three requested targets passed. Each remaining failure is **something else**,
not one of the three targets and not the registry refusal. Their first-attempt raw
failure lines were:

```text
(fail) quota header feed extended integration > ordered fallback admission sends an unknown-quota OAuth account [5186.73ms]
  ^ a beforeEach/afterEach hook timed out for this test.
(fail) quota header feed extended integration > ordered fallback admission rejects unknown-quota OAuth under fail-closed [10001.12ms]
  ^ a beforeEach/afterEach hook timed out for this test.
(fail) auth.loader > profile hydration keeps its plugin-scoped fetch across test turnover [1097.34ms]
(fail) auth.loader > mock-environment opt-out prevents command profile network calls [9769.09ms]
  ^ a beforeEach/afterEach hook timed out for this test.
```

The profile-hydration failure was `Sidebar state did not match` (main quota null;
fallback profile visible). All four had passed in the earlier unfiltered run.
The baseline file repetitions also showed unrelated hook/poll deadline failures,
including the same profile-hydration test. Neither suite command used a retry
option; the offline command was not rerun. These failures are disclosed, not fixed
or asserted to be caused by the two edits.

Raw outputs and the reverted diagnostic patch are retained outside build outputs
in this worktree's ignored `captures/opencode-intermittent/` directory:
`baseline.log`, `custody-diagnostic.log`, `publication-and-migration.log`,
`fast-fs-phases.log`, `fast-normal-phases.log`, `diagnosis-patch.log`,
`verification-stdout.log`, `verification-stderr.log`, `offline-suite-stdout.log`,
and `offline-suite-stderr.log`. They contain synthetic fixtures only and are not
committed. No package manifests or lockfiles changed.
