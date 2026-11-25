# LiveKit voice

Voice channels support audio rooms alongside channel chat. A workspace member needs channel read access to join. Channel send permission enables microphone publishing. Microphones start muted and the client asks for browser permission when the user chooses to enable the microphone.

## Set up a voice host

1. Deploy LiveKit. Use a reachable TLS WebSocket URL in production, with the ports needed for media and TURN. For development on one machine, use LiveKit's loopback development mode. [Local development](https://docs.livekit.io/transport/self-hosting/local/) · [Deploying LiveKit](https://docs.livekit.io/transport/self-hosting/deployment/)
2. On a daemon host owned by the workspace owner, set the public connection configuration. The workspace allowlist controls where this host issues grants.

   ```text
   SWARMROOM_LIVEKIT_URL=wss://voice.example.com
   SWARMROOM_LIVEKIT_WORKSPACES=<workspace-uuid>
   ```

3. On that host, pipe the LiveKit credential from your credential manager to `pnpm --filter @swarmroom/daemon voice:key set` as JSON with `apiKey` and `apiSecret` fields. Store it through the OS keychain on the same account that runs the daemon. Restart the daemon to load the credential.
4. Create a voice channel. Open **Voice settings**, select the ready signing host, and save. The choice applies to all voice channels in the workspace.

If the signing host disconnects or voice is disabled, new joins fail until an eligible host is available. The app rechecks permissions for every new join. LiveKit manages established media sessions and token expiry affects the initial connection. Use LiveKit room administration for immediate removal from an active session. [LiveKit access tokens and grants](https://docs.livekit.io/home/server/generating-tokens)
