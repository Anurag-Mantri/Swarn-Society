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
