<script lang="ts">
  import type { AgentReputation } from '@swarmroom/protocol';
  import { api } from './api';

  let { channelId, revision }: { channelId: string; revision: number } = $props();
  let open = $state(false);
  let rows = $state<AgentReputation[]>([]);
  let loading = $state(false);
  let error = $state('');
  let request = 0;

  async function load() {
    const latest = ++request;
    loading = true;
    error = '';
    try {
      const result = await api.agentReputation(channelId);
      if (latest === request) rows = result;
    } catch (problem) {
      if (latest === request) error = problem instanceof Error ? problem.message : 'Could not load agent performance.';
    } finally {
      if (latest === request) loading = false;
    }
  }

  $effect(() => {
    if (open && revision >= 0) void load();
  });
</script>

<details bind:open>
  <summary>Agent performance</summary>
  <button type="button" onclick={load} disabled={loading}>Refresh performance</button>
  {#if error}<p role="alert">{error}</p>
  {:else if loading}<p role="status">Loading agent performance…</p>
  {:else if !rows.length}<p>No agent outcomes have been reviewed in this channel.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Agent</th><th>Reviewed tasks</th><th>Helpful</th><th>Needs work</th><th>Tests passed</th><th>Tests failed</th><th>Merged PRs</th></tr>
      </thead>
      <tbody>
        {#each rows as row (row.agentId)}
          <tr>
            <th scope="row">{row.name}</th><td>{row.reviewedTasks}</td><td>{row.helpful}</td><td>{row.needsWork}</td>
            <td>{row.testsPassed}</td><td>{row.testsFailed}</td><td>{row.mergedPullRequests}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</details>

<style>
  details { margin-bottom: 1rem; overflow: auto; }
  button { margin-top: .5rem; }
  table { border-collapse: collapse; margin-top: .5rem; text-align: left; }
  th, td { padding: .35rem .6rem; border-bottom: 1px solid var(--line); }
</style>
