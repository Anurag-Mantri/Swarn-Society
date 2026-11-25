# External app extensions

External app support is opt-in. The MVP does not discover or control desktop applications.

## Scope
The host can connect a manually installed adapter for an application such as Blender, Photoshop, a video editor or a game.
An adapter reports a session, workspace resource or snapshot to the control plane. It does not become an agent tool automatically.

## Manifest
Each extension manifest declares:
- Extension name and protocol version
- Supported host operating systems
- Requested read and write capabilities
- Resource types and file extensions
- Approval requirements
- Snapshot format when snapshot access is requested

## Host permission
The server stores immutable manifest versions, and the registered host owner approves a subset of each version's capabilities. A new version requires its own approval. The manifest schema accepts structured capability and resource declarations. Commands, secrets, environment values, and filesystem paths are outside the manifest format.
An extension cannot run shell commands or access files outside declared paths without a separate approval.
Provider credentials stay in the host daemon’s OS keychain.

## Adapter interface
An adapter implements a small local protocol:
- `register`
- `start_session`
- `report_resource`
- `create_snapshot`
- `stop_session`

All inbound messages validate against Zod schemas in `packages/protocol`.
The server stores adapter metadata and snapshots according to server roles and retention rules.

## MVP boundary
No marketplace, plugin store or automatic application discovery.
No shared video or screen capture in the first adapter version.
No direct control of applications that provide no safe local API or documented file format.

## Examples
| Application | MVP integration |
|---|---|
| Blender | Saved project snapshot metadata ([setup](#blender-project-file)) |
| Photoshop | Document snapshot and export metadata |
| Video editor | Project manifest and export path |
| Game | Session status and shared assignment state |

## Validation
Test each adapter for permission denial, snapshot corruption, offline hosts and app process termination.
Adapters need explicit tests before a manifest is enabled for a server.

## Registration and approval API

- `GET /api/servers/:serverId/extensions` lists registered versions for workspace members with read access.
- `POST /api/servers/:serverId/extensions` registers an immutable manifest and requires agent-management permission.
- `GET /api/hosts/:hostId/extensions` lists the host owner's current approvals.
- `PUT /api/hosts/:hostId/extensions/:manifestId/approval` accepts `{capabilities}` and requires the registered host owner and workspace read access.
- `DELETE /api/hosts/:hostId/extensions/:manifestId/approval` revokes consent for that version.

Registration and approval record metadata. The [adapter session protocol](PROTOCOL.md#host-owned-adapter-sessions) enforces the approved subset and channel access. A host adapter executable still needs to be installed and started manually.

## Manual file adapter

The Linux host daemon can report a snapshot from a file saved by a local application. Configure the adapter on the host and select one file beneath a dedicated directory. This adapter reads that file and reports its declared type, size, and SHA-256 digest. The control plane receives metadata, while the filename, filesystem path, and contents stay local.

Register a manifest with protocol version 1, Linux support, a resource type and extension that match the file, and capabilities `resource.read` and `snapshot.create`. Use the `metadata-json` snapshot format. The host owner must approve both capabilities before the daemon can complete a report.

Set `SWARMROOM_FILE_ADAPTER` in the daemon's environment to a JSON object of this shape:

```json
{
  "adapterId": "00000000-0000-4000-8000-000000000001",
  "manifestId": "00000000-0000-4000-8000-000000000002",
  "channelId": "00000000-0000-4000-8000-000000000003",
  "root": "/home/host/workspace-notes",
  "file": "notes.txt",
  "resourceType": "document"
}
```

Use a new adapter UUID and the IDs of the registered manifest and a channel writable by the host owner. Start the daemon using its normal host token. It attempts one report per connection and waits for an acknowledgement between steps. Disconnects and acknowledgement timeouts stop the attempt while the daemon continues handling other host traffic. Removing this variable disables the adapter.

## Blender project file

Use the manual file adapter to report snapshot metadata for one saved Blender project on a Linux host. Save the project in a dedicated directory, then register this manifest for the workspace.

```json
{
  "slug": "blender-file",
  "name": "Blender project file",
  "version": "1.0.0",
  "protocolVersion": 1,
  "operatingSystems": ["linux"],
  "capabilities": ["resource.read", "snapshot.create"],
  "resources": [{ "type": "blend-project", "extensions": [".blend"] }],
  "snapshotFormat": "metadata-json"
}
```

Approve both capabilities on the host. In the [manual file adapter configuration](#manual-file-adapter), set `resourceType` to `blend-project`, `root` to the project directory, and `file` to the relative path of the saved `.blend` file. The project must be at most 32 MiB. Start or reconnect the daemon after saving the project to report a new snapshot.

The daemon reads the selected file and leaves Blender and the project unchanged. The control plane receives the declared project type, file extension, byte count, and SHA-256 digest.

This workflow was verified with Blender 4.5.17 LTS. Blender saved and reopened the test project, the approved daemon reported its snapshot over WebSocket, and the PostgreSQL record matched the saved file's size and digest. [Blender 4.5 LTS](https://www.blender.org/releases/4-5/)
