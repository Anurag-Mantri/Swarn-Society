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
- Snapshot command or file format
- Cleanup and uninstall behavior

## Host permission
The host owner approves the extension and its capabilities.
An extension cannot run shell commands or access files outside declared paths without a separate approval.
API keys and environment variables stay outside the extension manifest and OS keychain.

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
| Blender | Project file snapshot and task status |
| Photoshop | Document snapshot and export metadata |
| Video editor | Project manifest and export path |
| Game | Session status and shared assignment state |

## Validation
Test each adapter for permission denial, snapshot corruption, offline hosts and app process termination.
Adapters need explicit tests before a manifest is enabled for a server.
