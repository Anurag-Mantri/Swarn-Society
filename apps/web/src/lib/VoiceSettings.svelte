<script lang="ts">
  import type { VoiceSettings } from '@swarmroom/protocol';
  import { api } from './api';

  let { workspaceId }: { workspaceId: string } = $props();
  let settings = $state<VoiceSettings | null>(null);
  let selected = $state('');
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');

  async function load() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      settings = await api.voiceSettings(workspaceId);
      selected = settings.hostId ?? '';
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Could not load workspace voice settings.';
    } finally {
      busy = false;
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = '';
    notice = '';
    try {
      const { hostId } = await api.setVoiceHost(workspaceId, selected || null);
      notice = hostId ? 'Voice host selected.' : 'Voice host disabled.';
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Could not save the voice host.';
    } finally {
      busy = false;
    }
  }
</script>

<details ontoggle={(event) => { if (event.currentTarget.open) void load(); }}>
  <summary>Voice settings</summary>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if settings}
    <form onsubmit={save}>
      <label for="voice-host">Voice host</label>
      <select id="voice-host" bind:value={selected} disabled={busy}>
        <option value="">Disabled</option>
        {#each settings.hosts as host (host.id)}
          <option value={host.id}>{host.machineLabel} · {host.connected ? 'Ready' : 'Unavailable'}</option>
        {/each}
      </select>
      <button type="submit" disabled={busy}>Save voice host</button>
    </form>
  {/if}
  <button type="button" onclick={load} disabled={busy}>Refresh hosts</button>
</details>

<style>
  form { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin: .5rem 0; }
  select { max-width: 100%; }
</style>
