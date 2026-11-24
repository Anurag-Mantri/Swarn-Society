<script lang="ts">
  import type { TaskCoordinationMetrics } from '@swarmroom/protocol';
  import { api } from './api';

  let { channelId }: { channelId: string } = $props();
  let days = $state('30');
  let data = $state<TaskCoordinationMetrics | null>(null);
  let loading = $state(false);
  let error = $state('');
  let revision = 0;

  async function refresh() {
    const request = ++revision;
    loading = true;
    error = '';
    try {
      const metrics = await api.taskMetrics(channelId, days);
      if (revision === request) data = metrics;
    } catch (problem) {
      if (revision === request) {
        data = null;
        error = problem instanceof Error ? problem.message : 'Could not load task activity.';
      }
    } finally {
      if (revision === request) loading = false;
    }
  }

  function toggle(event: Event) {
    if (event.currentTarget instanceof HTMLDetailsElement && event.currentTarget.open && !data && !loading) {
      void refresh();
    }
  }

  function formatDuration(seconds: number | null): string {
    if (seconds === null) return 'No completions yet';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    return `${(seconds / 3600).toFixed(1)} hr`;
  }
</script>

<details ontoggle={toggle}>
  <summary>Task activity</summary>
  <div class="controls">
    <label for="metrics-window">Window</label>
    <select id="metrics-window" bind:value={days} onchange={() => void refresh()}>
      <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
    </select>
    <button type="button" disabled={loading} onclick={refresh}>Refresh activity</button>
  </div>
  {#if loading}
    <p role="status">Loading activity…</p>
  {:else if error}
    <p role="alert">{error}</p>
  {:else if data}
    <p>{data.from} through {data.through} (UTC)</p>
    <dl>
      <div><dt>Posted</dt><dd>{data.posted}</dd></div>
      <div><dt>Open</dt><dd>{data.open}</dd></div>
      <div><dt>In progress</dt><dd>{data.inProgress}</dd></div>
      <div><dt>Completed</dt><dd>{data.completed}</dd></div>
      <div><dt>Cancelled</dt><dd>{data.cancelled}</dd></div>
      <div><dt>Mean time to completion</dt><dd>{formatDuration(data.meanCompletionSeconds)}</dd></div>
      <div><dt>Duplicate intents blocked</dt><dd>{data.duplicateIntentAttempts}</dd></div>
      <div><dt>Busy agent assignments blocked</dt><dd>{data.busyAgentAttempts}</dd></div>
      <div><dt>Competing claims blocked</dt><dd>{data.competingClaimAttempts}</dd></div>
    </dl>
  {/if}
</details>

<style>
  details { margin: .75rem 0; padding: .65rem 0; border-block: 1px solid var(--line); }
  summary { font-weight: 600; }
  .controls { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; margin-top: .75rem; }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .6rem 1rem; }
  dt, p { color: var(--muted); }
  dd { margin: .25rem 0 0; font-weight: 650; }
</style>
