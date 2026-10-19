# Mutation proofs for request guards

`mutations.toml` records edits that replace specified source blocks with broken
safeguards. Each break must fail an assertion in a test listed in that control's
`expect_red` field.

Run only from an isolated clone or worktree. `ckdev-mutate` is the mutation test
runner: it applies the configured edits and runs tests in that checkout, without
creating a scratch worktree. Do not reset or check out a target file during replay:
that can replace the mutant with healthy code mid-test and invalidate the result.
Never point builds at a live host installation.

## Toolchain and scope

Use Bun **1.3.14** and **ckdev-mutate 0.12.5**, pinned to the [CortexKit Commons repository](https://github.com/cortexkit/commons)
at `bd31bef35db3bd7b1c3f91b11409f927dd95283d` (the reviewed release).
`ckdev-mutate 0.12.5` passes descriptive test names as single arguments, including
interior spaces, and reads JUnit results from the full owning-package test run.
It can also take a testcase's collateral target from the JUnit `<testsuite>`
nesting rather than Bun's `classname` (`junit_class = "suites"`; see
[JUnit identity normalization](#junit-identity-normalization)).
The rows need no alternate test names or compatibility layer.

Install the runner under the checkout-local ignored directory
`node_modules/.cache/ckdev-mutate-0.12.5`. Keep `CARGO_HOME`, `CARGO_TARGET_DIR` and the
install `--root` there, and do not overwrite a global executable. The command
below installs ckdev-mutate 0.12.5 from that exact source revision:

```sh
CARGO_HOME="$PWD/node_modules/.cache/ckdev-mutate-0.12.5/cargo-home" \
CARGO_TARGET_DIR="$PWD/node_modules/.cache/ckdev-mutate-0.12.5/target" \
cargo install --locked --git https://github.com/cortexkit/commons \
  --rev bd31bef35db3bd7b1c3f91b11409f927dd95283d \
  --root "$PWD/node_modules/.cache/ckdev-mutate-0.12.5/install" cortexkit-mutate
```

Verify that `ckdev-mutate --version` reports 0.12.5 and its Cargo install metadata
records revision `bd31bef35db3bd7b1c3f91b11409f927dd95283d`. Put its install `bin`
directory and Bun 1.3.14 on `PATH`, including for nested build scripts. Another
`ckdev-mutate` already on `PATH` (for example an older global install) must come
after it.

Changes since 0.9.2 that matter here: 0.10.0 refuses duplicate control IDs;
0.12.1 makes `check` name every command row without a `list_command` as "test
names not verified" (no row here has one, so `check` lists all of them and still
exits 0; `check --strict` would fail); 0.12.4 adds a `baseline_failure` object to
ERROR rows whose clean baseline failed. `run --all`, `--diff`, `--broad`,
`--shard i/n`, the JSON report array, outcome names and exit statuses (0 when
every row passes, 1 when a row does not, 2 on a runner error) are unchanged for the commands the
workflow uses. Without `--shard-weights`, `--shard i/n` still assigns rows round
robin in byte-sorted ID order; the workflow does not pass `--shard-weights`.

These proofs send no HTTP requests to model providers and use no real credentials.
They do not change existing application tests, CI workflows, dependencies or
sibling repositories.

Examples of guards covered by the catalogue:

| Control | Runtime break | Assertion |
| --- | --- | --- |
| `history-refuses-meaningful-assistant` | Treat meaningful assistant trailers as removable empty trailers. | `refuses unknown or meaningful content 0 without mutating history` in Core request-history tests. |
| `fast-excludes-opus-46-47` | Widen `claude-opus-4-8` to `claude-opus-4-`, incorrectly enabling fast mode for Opus 4.6 and 4.7. | Core asserts that fast mode is not supported for Opus 4.6, 4.7 and `4.7[1m]`. |
| `thinking-binding-excludes-api-key` | Call `applyThinkingBindingControls(body, 'drop_block')` even when Pi has no OAuth identity, bypassing the check that excludes API-key routes. | `buildAnthropicRequest — Fable/Mythos thinking > does not add Fable 5.1 binding controls to an API-key request`. |
| `header-routing-current-credential-epoch` | Accept pending quota from a replaced login. | The next request must use the replacement OAuth token, not a paid API key. |
| `header-routing-raw-exhaustion-proof` | Treat raw utilization of 0.995 as exhausted. | Display rounding must not permit paid API fallback. |
| `local-quota-survives-token-refresh` | Reject writes containing only quota when the token rotates, although the account UUID and credential epoch are unchanged. | The account's quota must survive refresh; writes containing other metadata must still require the original token version. |
| `local-metadata-requires-token-version` | Apply the account-only quota exception to writes that also contain other metadata. | Writes containing metadata from the old token must still be refused after refresh, even when they also contain quota. |
| `profile-publication-refusal-is-not-io` | Label a rejected profile write as an I/O failure. | Stale-subject refusal must remain distinct from storage failure. |
| `profile-current-credential-display` | Omit the current-credential display check. | A fetched tier must not cross a token rotation after its write failed. |
| `runtime-owner-loss-is-publication-refusal` | Label runtime lease loss as storage I/O. | A failed ownership fence must never use the fresh-tier I/O exception. |
| `refresh-backoff-preserves-attempt-budget` | Start transient backoff after the first attempt. | A transient failure must leave the coordinator's remaining attempts available; 429 and permanent failures still back off immediately. |
| `native-activation-before-401-refresh` | Remove the activation check before transport reauthorization. | A revoked native host activation must trigger no token exchange. |
| `native-activation-after-authorization` | Remove the activation check after transport authorization. | An activation revoked during fresh token validation must prevent model dispatch. |
| `fallback-killswitch-polls-before-selection` | Choose an account without fetching its missing or expired quota first. | Hold the fallback's usage GET and prove no model dispatch or main poll occurs before its reading returns; then verify the route follows that reading. |
| `fallback-quota-sweeps-do-not-overlap` | Start another sweep before the previous sweep finishes. | A background sweep started during startup's held GET must read the stored result, not issue a second fallback GET from a stale snapshot. |
| `runtime-read-no-follow` | Follow a symlink installed between inspection and opening. | The runtime reader must reject the symlink. |
| `runtime-read-opened-mode` | Ignore the opened file's permissions. | A replacement with mode 0644 must be rejected. |
| `runtime-read-opened-owner` | Ignore the opened file's owner. | A foreign owner on the opened handle must be rejected. |

The `thinking-binding-excludes-api-key` guard is owned by Pi's converter at its
`applyThinkingBindingControls` call boundary. Pi imports the built Core helper,
which has no credential-route parameter. Changing Core's `account-default`
behavior alone would not reach Pi's API-key assertion because Pi never calls
`applyThinkingBindingControls` without an OAuth identity. The mutation adds that
call outside the identity gate while leaving OAuth metadata untouched.

## Current-source builds and exact dispatch

The root `prebuild` in `mutations.toml` runs `bun run --cwd packages/core build` from the
Git root. Replay rebuilds Core from the current clean source before baselines,
from the current mutated source before each mutation's test dispatch, and from
the exactly restored source at session end. Pi converter tests import Core's
dist. Reusing clean-source dist for a mutant is not evidence that the intended
assertion caught the mutation.
Run Core and host tests sequentially, never concurrently with another Core build.

Named commands receive the fixed repository-relative test-file path and the full
Bun descriptive name as separate argv elements, with no shell interpolation:

```sh
bun scripts/run-mutation-bun.ts packages/core/src/tests/fast.test.ts \
  'fast mode eligibility for claude-opus-4-7[1m] is false'
```

The wrapper accepts canonical `*.test.ts` files directly under the Core,
OpenCode or Pi package's `src/tests/` directory. It rejects empty,
control-character and boundary-whitespace names and unsafe/unsupported paths.
Bun prints nested scopes separated by ` > `, but its name filter joins those
scopes with spaces. The wrapper applies that observed convention, escapes regex
metacharacters, and anchors the entire filter. The printed result must still
match the original descriptive name exactly.

Each child uses the real Bun executable, explicit package cwd and package
`bunfig.toml`. Existing package preloads remain active. Import-time defaults are
sandboxed before spawn, inherited host overrides are cleared, and the sandbox is
removed only after child exit and both pipes settle. Cancellation kills owned
child work before waiting for those joins. No global timers are replaced.

Raw stdout/stderr stay on their original pipes. A single `CKDEV executed 1 tests`
record is emitted only for a verified pinned-Bun result with exactly one executed
test, matching pass/fail totals, a positive assertion count, the intended exact
name and a normal 0/1 status. A failing result must contain the selected normal
`expect` assertion diagnostic. Compilation/import/build errors, hook errors, timeouts,
crashes, signals, spawn failures, extra tests and ambiguous/zero summaries refuse
with status **126**. These failures are not evidence that the intended assertion
caught the mutation. Filtered, discovered and skipped tests are not counted.
At the end of a run with multiple failures, Bun prints each failed result again.
The wrapper compares these repeated lines with the original failure lines and
does not count them as additional test executions.

## Proof procedure and retained evidence

Run `scripts/tests/run-mutation-bun.test.ts` and the scripts typecheck:

```sh
bun test scripts/tests/run-mutation-bun.test.ts
./node_modules/.bin/tsc -p tsconfig.scripts.json
```

Keep the first raw stdout, stderr and exit status for every baseline, mutant and
restored run in an ignored checkout directory such as `tmp/mutation-proof`.
Record each target's original SHA-256, and compare the restored source bytes with
the original Git bytes as well as the hash. Each mutation anchor must occur
exactly once. `NON-VACUITY BREAK` comments appear in the catalogue's replacement
strings to mark temporary mutants; they must not remain in restored source.

For direct proofs, stage the exact live targets first, verify an empty unstaged
`git diff --stat`, apply one catalogue mutation and retain its non-empty diff.
Rebuild `packages/core` from the current mutated source, run every named expected assertion,
and independently run healthy companion assertions. Restore only after dispatch is finished with
`git checkout -- <target> && touch <target>`, verify empty unstaged diff and the
original source hash, then rebuild Core from the restored source. Never use stash.

The history companion checks that only provably empty trailing assistant messages
are removed from the owned history array, preserving the preceding user message.
Other healthy companions verify that fast mode remains supported for Opus
4.8/5/5.5 and that Pi still adds binding controls to signed-thinking OAuth
requests:
`buildAnthropicRequest — Fable/Mythos thinking > adds Fable 5.1 binding controls when compacted history replays signed thinking`.

A named-only proof does **not** observe package breadth. Under `--broad`, each
row runs its full owning unit directory: Core, OpenCode or Pi. Each uses its own
package cwd/config in a separate sequential Bun process and requires a clean
current baseline. These are unit-package domains, not workspace or E2E audits.
Core guards also affect OpenCode and Pi; auditing Core alone does **not** prove
absence of host/workspace collateral.

The supported fields are `broad_command`, `broad_report`, `broad_id = "{name}"`
and, on OpenCode rows, `junit_class = "suites"`.
Bun creates fresh JUnit XML at the owning package's `tmp/mutations/core.xml`,
`tmp/mutations/opencode.xml` or `tmp/mutations/pi.xml`.
The runner deletes the selected report before every invocation and validates the
complete XML, expected identities and baseline failures. Missing, empty, garbage,
ambiguous or mismatched reports are refused. Such reports are not evidence that
the intended assertion caught the mutation.

Broad runs record the observed package failures rather than proving the named
assertion again. A per-test timeout or ordinary thrown error is accepted with
status **1** only when its failed console event matches its JUnit testcase, just
like an assertion failure. Missing/mismatched JUnit, abnormal exits, signals,
spawn/version failures, compilation/import failures and skipped tests still
refuse with **126**. Named mode keeps the stricter assertion-only contract above.

Bun does not give an unhandled error between tests a JUnit testcase of its own.
Such errors remain in the raw audit output; the wrapper never invents a red identity
for them. They can accompany independently verified failed testcases, but an
error-only nonzero exit with no failed testcase is rejected with **126**. Broad
output cannot turn a missing named catch into a catch: the runner grades the separate strict
named checks before recording collateral from JUnit.

The pinned runner deliberately tolerates unrelated baseline-red testcases and
excludes them from mutant collateral. This repository's CI policy is stricter:
both shard verification and combined audit verification require an empty
`baseline_failures` map on every broad row. Any clean-package timeout or error
therefore fails the audit even if all named checks caught their mutants. This
check happens after runner replay, not before it; direct `ckdev-mutate` use
without `scripts/run-mutation-ci.ts` retains the runner's baseline-red policy.

### JUnit identity normalization

Real Bun 1.3.14 XML nests one `<testsuite>` per describe block inside each test
file's own `<testsuite>`, and gives each testcase its leaf `name` and a
`classname`. Top-level tests have an empty classname. The classname is only
reliable one describe deep: for deeper nesting Bun lists the describes
innermost first and escapes the joining ` > ` a second time (a test in describe
`inner` inside describe `outer` gets `classname="inner &amp;gt; outer"`).
The wrapper therefore builds each full descriptive name from the enclosing
`<testsuite>` names, outer to inner and without the file-level suite, followed
by ` > ` and the leaf; a top-level test keeps its leaf alone. That is the name
Bun prints on the console, also when a describe name itself contains ` > `.
Core has three duplicated leaf names in different classes, and Pi has two
repeated table-test names where Bun leaves `%s` unexpanded. The wrapper changes
**only** each testcase's `name` attribute to that full descriptive name.
Classnames (including Bun's reversed nested form), suite totals, case order,
statuses, failure/error bodies and all other bytes remain unchanged. A report
whose `<testsuite>` elements do not nest cleanly, or with a testcase outside a
file suite, returns 126.

Before changing name attributes or emitting a verified count, the wrapper compares
every testcase with the corresponding observed console event in execution order:
the source file, full descriptive name, pass/fail outcome and occurrence number
must agree. Matching aggregate counts alone are insufficient. XML that erases a
failure, moves it to another test or changes case identities returns 126; its raw
console output and original XML are retained without publishing a normalized
report. The source line used in a duplicate ID comes from Bun's original JUnit
attribute, and the occurrence is checked against the observed console order.

Repeated full names receive a deterministic document-order suffix:
` [case N at file:line]`. This distinguishes Bun's repeated table-case occurrences,
not their parameter values. No alias table or production test rename is involved.
The three rows' expected names are unique and remain exactly unchanged. A repeated
expected name would lose that exact identity and the runner must refuse it as
missing, rather than guess which occurrence guards the row. Final normalized-ID
collisions also refuse. Self-tests cover these collisions, native row identity,
entities, dollar punctuation and byte-preservation of failure bodies. Complete
XML structural validation remains the official runner's responsibility.

The wrapper retains raw and normalized XML, matched IDs, argv/cwd/status and raw
child stdout/stderr in separate invocation folders under `tmp/mutations/audits`.
A successful JUnit audit sets the runner JSON field `breadth_observed` to `true`.
Each testcase also gets a collateral target, its class: collateral in the
expected test's own target remains CAUGHT, and collateral in other targets can
yield CAUGHT_BROADLY. Those observed failures are evidence, not a claim of
unchanged behavior outside the declared package.

### Suite-path grading

Core and Pi rows use the default target, Bun's `classname`; a top-level test's
empty classname falls back to its source file. OpenCode rows set
`junit_class = "suites"`: their target is the `{suite}` path, the names of the
enclosing describe `<testsuite>` elements, outermost first, joined with ` > `
and without the file-level suite, falling back to the source file for a
top-level test. For a test one describe deep and a top-level test, both forms
give the same target unless a describe name contains characters that Bun
escapes twice. Beyond one describe the classname is reversed and escaped
(`quota header harvest &gt; auth.loader` for a test in `auth.loader > quota
header harvest`), so with the classname, collateral in the same nested describe
was graded against that reversed form. With suite targets the four nested
OpenCode rows (`header-routing-current-credential-epoch`,
`header-routing-raw-exhaustion-proof`, `local-quota-survives-token-refresh`,
`local-metadata-requires-token-version`) are graded against
`auth.loader > quota header harvest`, the path Bun prints. A future `hub_targets`
entry for an OpenCode row is written in that same ` > ` form.

All OpenCode rows set the field, not only the nested ones. The rule is the same
at every depth, and the runner shares one clean OpenCode baseline only among
rows with the same `broad_id` and `junit_class`, so a mixed set would rerun the
OpenCode suite's baseline within a shard.

The rows keep `broad_id = "{name}"` rather than the runner's `{suite} > {name}`.
The wrapper has already replaced each testcase `name` with the full
console name built from the same nesting, so `{name}` is the full id, and
`{suite} > {name}` would repeat the describe path. It would also give a
top-level test a leading ` > `.

The verified `history-refuses-meaningful-assistant` replay also fails 13 other
Core assertions in the same empty JUnit classname, while the empty-assistant
removal companion stays green. The `fast-excludes-opus-46-47` and
`thinking-binding-excludes-api-key` replays have no newly red collateral in their
declared unit-package audits. All three rows are CAUGHT; these outcomes do not
extend the coverage domains above.

Run the final supported gates sequentially:

```sh
ckdev-mutate --version
ckdev-mutate check
ckdev-mutate run --all --broad --report tmp/mutations/rows.json
```

Retain the first raw output when a check fails, diagnose the failure before
rerunning an affected check, and do not treat compile errors, timeouts or crashes
as evidence that the intended assertion caught the mutation.

Keep a durable archive of the raw console transcripts and original report bytes,
the source hashes and exact-byte restoration checks, the staged source diff, and
the runner's row reports. Store the archive outside ephemeral build caches so
reviewers can inspect the evidence and source comments before a commit. CI
integration is separate from this catalogue.

## Automated replay

The read-only `Mutation guards` workflow uses a separate checkout from the regular
CI job. Pull requests run `ckdev-mutate run --diff <base>`, comparing the committed
base to `HEAD`. The runner selects changed row targets, guarding test files and
parsed catalogue entries. Root prebuild changes also select all rows.

Changes to the Bun wrapper, its self-tests, the CI driver/workflow or shared test
configuration force `--all`, because the runner does not follow helper dependencies.
Main pushes run all named checks. Pull-request and push replays each run in one
`guards` job.

Scheduled and manually requested runs perform the `--broad` audit: each row also
runs its owning package's full unit suite (Core, OpenCode or Pi). These domains
still exclude workspace-wide and process E2E collateral. Each broad row costs a
whole package suite (on a 4-vCPU Linux runner, about 1.5 minutes for Core, 5 to
6 minutes for OpenCode and under a minute for Pi), so the audit is split into a
job matrix:

- `audit-plan` reads `mutations.toml` and plans `ceil(rows / 3)` shards
  (`BROAD_ROWS_PER_SHARD` in `scripts/run-mutation-ci.ts`), so the shard count
  changes as rows are added or removed. Three rows per shard keep even a shard
  of three OpenCode rows plus its OpenCode baseline under about 25 minutes,
  inside the 30-minute job limit. The plan grows with the catalogue, so a new
  row needs no workflow edit. The summary job refuses a shard count that does
  not match this plan.
- Each `audit (i/n)` job runs `ckdev-mutate run --all --broad --shard i/n`. The
  runner sorts rows by ID and gives shard `i` every `n`-th row starting at
  position `i - 1`, so every row lands in exactly one shard. Each shard is a
  separate runner with its own checkout, dependency install, Core and packed
  OpenCode build and runner install. Within its session, the runner runs the
  catalogue prebuild on the unmutated tree and collects a clean baseline of the
  package suites its rows use before any mutant; shards share no files or
  baselines. The driver checks that the shard reported exactly the rows assigned
  to it, and uploads its report as `mutation-<run>-<attempt>-shard-<i>`.
- `audit-summary` runs after every shard, even when some fail. It downloads all
  shard reports and fails if a shard job failed or was cancelled, if a shard's
  report is missing, or if the reports together omit, repeat or leave uncaught
  (for example `SURVIVED` or `ERROR`) any catalogue row, or lack breadth
  evidence. Its log lists each shard's expected row count and reported outcomes.

Shards run in parallel, so the audit's wall time is roughly its slowest shard
plus the plan and summary jobs. Each shard repeats setup and the clean baselines
of its packages, so the total runner time is higher than one sequential replay.
For a single shard elsewhere, run `ckdev-mutate run --all --broad --shard i/n`
from an isolated clone, as for any full replay.

The CI driver verifies the runner version and requires tests to detect each
mutation (`CAUGHT`, `CAUGHT_BROADLY` or `HUB`), rather than accepting skipped or
equivalent rows. Full replays must report every configured row. A PR with no affected
rows may report an empty selection; it is not recorded as a caught mutation.
Reports, invocation/status records and raw test evidence are uploaded even when
a replay fails. Runner installation is pinned to the public commons revision and
kept in checkout-local ignored storage; no private repository token is required.

## Setup authority and local-login omission controls

These catalogue rows guard [empty initialization](../opencode-2.md#empty-initialization),
legacy import and [OpenCode 1 admission](../custody-state-machine.md#opencode-1).

| Control | Runtime break | Assertion |
| --- | --- | --- |
| `setup-publishes-empty-init` | Omit `publishNativeEmptyInit`, leaving setup without local pool authority. | `acceptance 1: offline OC2 setup, registered fixture login and first native Bearer request` requires the registered login to succeed before the first native request. |
| `migration-capture-refuses-populated-pool` | Remove the capture-time `nativePoolHoldsAccountData` refusal. | `direct migration refuses populated empty-init before any write for every host slot` requires `pool-populated` before any journal write. |
| `custody-admits-separate-login-with-native-pool` | Remove the admission row for a separate OpenCode sign-in alongside a usable native pool. | `S1 populated real-login request uses native pool (same UUID)` requires a successful request carrying the native token, not the separate login's token. |
