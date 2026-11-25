# Knowledge graph

The knowledge graph records relationships between people, agents, tasks, decisions, files, channels and teams.
The MVP uses provenance and confidence. It does not claim that every inferred relationship is objective fact.

## Node types
- Person
- Agent
- Host
- Server
- Channel
- Task
- Decision
- File or repository
- Event

## Deterministic extraction
Build edges only from structured source records and recorded identifiers.
Examples:

| Relation | Source |
|---|---|
| `assigned_to` | Task assignment event |
| `mentioned_in` | Parsed message mention |
| `changed` | Workspace or commit event |
| `completed_by` | Task completion event |
| `decided_in` | Recorded decision and source message |
| `hosted_by` | Agent-host registration |

Each edge stores `source_type`, `source_id`, extraction timestamp and confidence.
Deterministic edges use confidence 100% unless the source has conflicting evidence.

`packages/knowledge-graph` accepts validated event identifiers and timestamps. It returns stable workspace-scoped node and edge IDs plus the source record, extraction method, confidence, and channel scope. Message mentions must already be resolved to recorded agent IDs. Extraction consumes no free-text content. The storage layer saves sources, nodes, edges, and their provenance links in a transaction. Replaying the same immutable source is idempotent. A channel source must belong to the same workspace as the source record. Graph reads must join through a visible source before returning a fact.

Live capture records new messages, posted and assigned tasks, completed tasks, file creation, and collaborative edits. Message and task records commit with their graph sources. File edits are aggregated by file, editor, and UTC minute and recorded when Yjs state is saved. The graph consumes identifiers and timestamps from these operations, while their text stays in the original application records.

The workspace Knowledge view lists deterministic relationships supported by the 20 most recent visible sources. Automatic acceptance requires a confidence of at least 90% and a relationship with no recorded conflict. Inferred relationships remain outside automatic acceptance. Readers can filter by a channel they can read and inspect which sources support each relationship.

## AI-assisted extraction
AI may extract possible relationships from transcripts and free-text logs.
AI-created edges start as pending hypotheses.

Apply this acceptance policy:
- 90% or higher and no conflict: ready for review or automatic acceptance if the source is deterministic.
- Below 90%: require a human approval and show source evidence.
- Any conflict: require human resolution.
- AI never changes deterministic edges.

Do not present confidence scores as calibrated probabilities unless they have a real evaluation dataset.

## Accuracy and evaluation
Measure graph quality against a labeled set of team events.
Track precision and recall separately for node extraction and edge extraction.
Block releases when precision for automatic edges falls below 90%.

Run the labeled structured-event benchmark after building the package.

```sh
pnpm --filter @swarmroom/knowledge-graph build
pnpm --filter @swarmroom/knowledge-graph evaluate
pnpm --filter @swarmroom/knowledge-graph evaluate /path/to/labeled-events.json
```

The benchmark counts predicted and expected facts separately for each source, then reports precision and recall for nodes and automatically accepted edges. The command fails if automatic edge precision is undefined or below 90%. CI also checks for any fixture regressions. The checked-in fixture covers synthetic examples. Before broad release, run the same command on representative, permission-cleared team metadata and record the results. Use the package's `evaluation/structured.json` as the dataset format.

## Privacy
Respect server, channel and role permissions when reading graph data.
Delete or anonymize graph nodes and sources when the underlying account or server data is deleted.
Never send API keys or environment variable values into graph extraction.

## MVP order
1. Import task, message, assignment and completion events.
2. Build the deterministic graph and explain every edge.
3. Add a review queue for low-confidence edges.
4. Add AI-assisted extraction for free-text sources.
5. Add timeline and impact queries after the graph is accurate.

## Rebuild a workspace

With the control plane's database configuration and a compiled server, run:

```sh
pnpm --filter @swarmroom/server knowledge:rebuild <workspace-uuid>
```

The operator command replays one workspace's stored structured events in a single transaction. It repairs missing facts and deterministic provenance links, removes unsupported derived facts when no review refers to them, and leaves inferred relationships and review records in place. The rebuild serializes with live graph writes for that workspace. On a large workspace, schedule it when write traffic is low.

## Backfill historical messages and tasks

With the control plane's database configuration and a compiled server, run:

```sh
pnpm --filter @swarmroom/server knowledge:backfill <workspace-uuid>
```

The operator command adds sources for existing messages, task posts, assignments, and completions in one workspace. It reads metadata in batches and reports the number of new sources. Repeating the command preserves existing sources. Legacy message records carry agent display names, so the backfill omits agent authorship when no immutable agent ID was recorded. Historical files have no per-change actor or timestamp, so the backfill leaves their history empty. New changes continue to be recorded as they occur.

## Import a GitHub snapshot commit receipt

After publishing a workspace snapshot, run on the host with the GitHub App key in its OS keychain.

```sh
pnpm --filter @swarmroom/daemon exec tsx src/github/cli.ts receipt <app-id> <installation-id> <repository-id> <workspace-uuid> > receipt.json
```

The command reads the workspace snapshot branch head using a repository-scoped installation token. The workspace owner imports the JSON from the Knowledge view. The graph records the owner as the person who reported the receipt. The control plane trusts that owner's attestation. GitHub credentials, file content, and Git author email stay out of the receipt.
