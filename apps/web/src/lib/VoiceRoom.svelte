<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { Room } from 'livekit-client';
  import { api, ApiError } from './api';
  import VoiceSettings from './VoiceSettings.svelte';

  let { channelId, workspaceId, owner }: { channelId: string; workspaceId: string; owner: boolean } = $props();
  let room: Room | undefined;
  let controller: AbortController | undefined;
  let audio: HTMLDivElement;
  let status = $state<'idle' | 'joining' | 'joined' | 'reconnecting'>('idle');
  let canPublish = $state(false);
  let microphone = $state(false);
  let micBusy = $state(false);
  let needsPlayback = $state(false);
  let speakers = $state<{ id: string; name: string }[]>([]);
  let error = $state('');

  function reset() {
    controller?.abort();
    controller = undefined;
    const previous = room;
    room = undefined;
    status = 'idle';
    canPublish = false;
    microphone = false;
    micBusy = false;
    needsPlayback = false;
    speakers = [];
    audio?.replaceChildren();
    if (previous) void previous.disconnect().catch(() => undefined);
  }

  async function join() {
    if (status !== 'idle') return;
    const request = new AbortController();
    controller = request;
    status = 'joining';
    error = '';
    try {
      const [grant, livekit] = await Promise.all([api.joinVoice(channelId, request.signal), import('livekit-client')]);
      if (request.signal.aborted) return;
      const { Room, RoomEvent, Track } = livekit;
      const active = new Room();
      room = active;
      canPublish = grant.canPublish;
      const updateSpeakers = () => {
        if (room !== active) return;
        const participants = [active.localParticipant, ...active.remoteParticipants.values()];
        speakers = participants.map(({ identity, name }) => ({ id: identity, name: name || identity }));
      };
      active
        .on(RoomEvent.ParticipantConnected, updateSpeakers)
        .on(RoomEvent.ParticipantDisconnected, updateSpeakers)
        .on(RoomEvent.TrackSubscribed, (track) => {
          if (room === active && track.kind === Track.Kind.Audio) audio?.append(track.attach());
        })
        .on(RoomEvent.TrackUnsubscribed, (track) => { for (const element of track.detach()) element.remove(); })
        .on(RoomEvent.AudioPlaybackStatusChanged, () => {
          if (room === active) needsPlayback = !active.canPlaybackAudio;
        })
        .on(RoomEvent.Reconnecting, () => { if (room === active) status = 'reconnecting'; })
        .on(RoomEvent.Reconnected, () => {
          if (room === active) status = 'joined';
          updateSpeakers();
        })
        .on(RoomEvent.Disconnected, () => {
          if (room === active && status !== 'joining') {
            reset();
            error = 'Voice disconnected. Join again to resume.';
          }
        });

      await active.connect(grant.url, grant.token, { maxRetries: 0 });
      if (request.signal.aborted || room !== active) {
        await active.disconnect();
        return;
      }
      updateSpeakers();
      needsPlayback = !active.canPlaybackAudio;
      status = 'joined';
    } catch (problem) {
      if (!request.signal.aborted) {
        reset();
        error = problem instanceof ApiError ? problem.message : 'Could not join LiveKit voice. Try again.';
      }
    }
  }

  async function toggleMicrophone() {
    const active = room;
    if (!active || !canPublish || micBusy) return;
    micBusy = true;
    error = '';
    try {
      await active.localParticipant.setMicrophoneEnabled(!microphone);
      if (room === active) microphone = active.localParticipant.isMicrophoneEnabled;
    } catch {
      if (room === active) error = 'Microphone unavailable. Check your browser permissions and try again.';
    } finally {
      if (room === active) micBusy = false;
    }
  }

  async function startPlayback() {
    try { await room?.startAudio(); }
    catch { error = 'Audio playback is blocked. Check your browser sound settings.'; }
  }

  onDestroy(reset);
</script>

<section aria-label="Voice call">
  <header>
    <div>
      <strong>Voice</strong>
      <span role="status">
        {status === 'joining' ? 'Joining voice…' : status === 'reconnecting' ? 'Reconnecting voice…' :
          status === 'joined' ? 'In voice channel' : 'Voice disconnected'}
      </span>
      {#if status === 'joined' && !canPublish}<span>Listen only</span>{/if}
    </div>
    <div class="controls">
      {#if status === 'idle'}
        <button type="button" class="primary" onclick={join}>Join voice</button>
      {:else}
        {#if status === 'joined' && canPublish}
          <button type="button" onclick={toggleMicrophone} disabled={micBusy}>
            {microphone ? 'Mute microphone' : 'Enable microphone'}
          </button>
        {/if}
        {#if needsPlayback}<button type="button" onclick={startPlayback}>Enable audio playback</button>{/if}
        <button type="button" onclick={reset}>{status === 'joining' ? 'Cancel join' : 'Leave voice'}</button>
      {/if}
    </div>
  </header>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if speakers.length}
    <ul aria-label="Voice participants">
      {#each speakers as speaker (speaker.id)}<li>{speaker.name}</li>{/each}
    </ul>
  {/if}
  <div bind:this={audio} aria-hidden="true"></div>
  {#if owner}<VoiceSettings {workspaceId} />{/if}
</section>

<style>
  section { padding: .7rem 1rem; border-bottom: 1px solid var(--line); }
  header, header div, ul { display: flex; align-items: center; flex-wrap: wrap; gap: .4rem .75rem; }
  header { justify-content: space-between; }
  span, ul { color: var(--muted); }
  ul { padding: 0; margin: .4rem 0; list-style: none; }
</style>
