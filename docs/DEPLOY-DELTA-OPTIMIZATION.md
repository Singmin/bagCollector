# Incremental deployment: dependency layers and dynamic SSH scheduling

## Measured baseline

The verified CI artifacts for `b70eb2a8cefc3197007d2993a63251900f4ef553`
and `83638ff4a76301d4d0fab3ece473a8b6d73c2508` contain 235 required objects.
Comparing their content keys reproduces the production log exactly: 71 new
objects, **47,913,283 compressed bytes**, and 77.929% byte reuse.

| Changed content | New compressed bytes |
| --- | ---: |
| API `COPY /app/node_modules` layer | 46,994,017 |
| Admin static assets | 554,079 |
| Other application layers and archive metadata | 365,187 |

The 189,248,000-byte dependency tar differs in only eight file records: seven
schema-dependent generated Prisma client files, and pnpm workspace bookkeeping.
The generated file sizes shifted fixed 4 MiB chunk boundaries, causing 41 new
objects in this layer despite unchanged third-party libraries/native engines.
This identifies the source of the large transfer; it is not a new dependency
installation or a failure of the server's incremental cache.

Replaying the same `b70eb2a -> 83638ff` source changes with the split layout
required **2,060,326 bytes**, 32 new objects and 99.051% byte reuse: **95.7%
less upload**. The stable dependency/native-engine layers were unchanged.
The real image acceptance also passed ordinary API/Admin edits, schema-only
edits, root-script-only edits and two cold builds, each below 10 MiB.

## Layer layout

The production install normalizes root development task scripts while retaining
install lifecycle hooks and dependency resolution fields. The complete manifest
remains available to the build and runtime stages. Pruning removes pnpm's unused
installation/workspace bookkeeping.

Generated `.prisma/client` files form a separate overlay copied to the same
runtime paths. Native engines remain in the stable dependency layer, including
the generated-client engine path; existing hardlink deduplication stays within
that layer. API/Worker resolution and migrations must pass real image checks.

## Transport and reports

Four SSH workers claim largest-first batches from one locked local queue. A
batch has at most 16 objects and about 4 MiB compressed data; oversized objects
are isolated. Each worker reuses its own SSH connection and claims another
batch when available. A failed batch stops that worker, but completed data is
ingested and verified before the next attempt computes a new missing list.
Three attempts and the existing 30-minute transfer budget are retained.

`transport_completed_bytes` measures successful rsync batches, **not** server
verification. Only `verified_complete` in `transfer-summary.json` confirms that
the final server missing list is empty. Reports include queue claims, worker
throughput, retry count, and cache/upload/verification/prepare/apply timings.
Actions uploads the reports even on failure, retaining them for 14 days.

## End-to-end release path

Source checks and API/Vision image builds run concurrently. The final image
verification waits for successful checks and builds, then validates runtime
contents, archive reconstruction, fingerprints, migrations and API readiness.
The expensive synthetic multi-build delta regressions run for pull requests or
an explicitly requested cold build; historical replay runs when its layer
inputs change. They do not repeat on every ordinary production release.

A release may reuse an unexpired verified image artifact only from a successful
run in this repository for the exact same commit, with all required check jobs
successful. Otherwise it runs the full CI workflow. This lets prepare-only and
the subsequent main release use the already validated images without rebuilding.

Docker archives are saved and reconstructed as raw tar files; the v2 objects
remain independently compressed and verified. Removing whole-archive gzip
compression before immediate decompression reduces export/import work without
changing the v2 manifest, object keys or legacy gzip import compatibility.

The first parallel CI run (`38403722415`, commit `1b95296`) passed in **5m31s**
from run creation to completion. The preceding serial verify job alone took
14m24s. These are measured runs, not a fixed completion-time guarantee.

Prepare-only run `38404912832` reused those exact verified images and completed
in **2m08s** including runner setup and cleanup. Against the warmed server cache,
it uploaded **561,229 bytes** in 17s, with 28s cache check and 12s verification
(57s total transfer stage); raw archive preparation/import took **26s**.
All checks succeeded and running services were left unchanged before main apply.

## Acceptance and rollout

The dedicated `codex/deploy-delta-scheduler` acceptance job downloads both
original verified artifacts, replays their source revisions with the new layer
layout, and verifies API edits, schema edits, root development scripts and two
cold builds. Stable layers must remain unchanged and each incremental case must
require at most 10 MiB. Reports attribute every new object to an archive member
and, where available, to its image and Dockerfile instruction.

The historic replay requires the two original Actions artifacts while they are
retained. General queue, checkpoint, corruption, layer-split, archive integrity
and retention tests run in ordinary CI without those historic artifacts.

First prepare establishes the new dependency/overlay layers and may upload more
than a steady-state release. Record it separately; then verify another real
small release against the warmed cache. Do not promise fixed completion times
on an overseas SSH link. The v2 object/manifest format and server validation are
unchanged, so old and new objects coexist and prior images remain available for
the existing rollback flow.

Initial cache establishment (`38399355354`, `e529d23`) uploaded 47,690,897
bytes in one attempt: 788s upload, 37s cache check, 13s verification, 838s total
transfer stage and 115s prepare. This is migration/cache establishment cost,
not evidence of steady-state acceleration. The four workers completed 3, 5, 4
and 3 batches respectively, confirming that faster workers claimed more work.
