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
