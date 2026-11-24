<script lang="ts">
  import { onMount } from 'svelte';
  import type { TaskClaimant, TaskPost, TaskResolution } from '@swarmroom/protocol';
  import { api, ApiError } from './api';
  import TaskBids from './TaskBids.svelte';

  let { channelId, name, currentUser }: { channelId: string; name: string; currentUser: string } = $props();
  let tasks = $state<TaskPost[]>([]);
  let agents = $state<TaskClaimant[]>([]);
  let selectedAgent = $state('');
  let openBids = $state<string | null>(null);
  let closingTask = $state<{ id: string; resolution: TaskResolution } | null>(null);
  let resolutionNotes = $state('');
  let title = $state('');
  let description = $state('');
  let error = $state('');
  let loading = $state(true);
  let busy = $state(false);

  function showError(problem: unknown) {
    error = problem instanceof Error ? problem.message : 'Could not update the task board.';
  }

  async function refresh() {
    loading = true;
    try {
      [tasks, agents] = await Promise.all([api.tasks(channelId), api.taskClaimants(channelId)]);
      if (!agents.some((agent) => agent.id === selectedAgent)) selectedAgent = agents[0]?.id ?? '';
    } catch (problem) { showError(problem); }
    finally { loading = false; }
  }

  async function post(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !title.trim()) return;
    busy = true;
    error = '';
    try {
      const task = await api.createTask(channelId, title, description);
      tasks = [task, ...tasks];
      title = '';
      description = '';
    } catch (problem) { showError(problem); }
    finally { busy = false; }
  }

  async function claim(taskId: string) {
    if (busy || !selectedAgent) return;
    busy = true;
    error = '';
    try {
      const claimed = await api.claimTask(channelId, taskId, selectedAgent);
      applyClaim(claimed);
    } catch (problem) {
      showError(problem);
      if (problem instanceof ApiError && problem.status === 409) await refresh();
    } finally { busy = false; }
  }

  function startResolution(task: TaskPost, resolution: TaskResolution) {
    closingTask = { id: task.id, resolution };
    resolutionNotes = '';
  }

  async function resolve(event: SubmitEvent) {
    event.preventDefault();
    if (!closingTask || busy) return;
    busy = true;
    error = '';
    try {
      const resolved = await api.resolveTask(channelId, closingTask.id, closingTask.resolution, resolutionNotes);
      applyClaim(resolved);
      closingTask = null;
    } catch (problem) {
      showError(problem);
      if (problem instanceof ApiError && problem.status === 409) await refresh();
    } finally { busy = false; }
  }

  function applyClaim(claimed: TaskPost) {
    tasks = tasks.map((task) => task.id === claimed.id ? claimed : task);
  }

  onMount(() => { void refresh(); });
</script>

<section class="task-board" aria-label={`${name} tasks`}>
  <header>
    <h1>{name} tasks</h1>
    <button type="button" disabled={loading || busy} onclick={refresh}>Refresh</button>
  </header>
  {#if error}<p class="alert" role="alert">{error}</p>{/if}
  <form onsubmit={post}>
    <label for="task-title">Task title</label>
    <input id="task-title" required maxlength="160" bind:value={title} />
    <label for="task-description">Description</label>
    <textarea id="task-description" rows="3" maxlength="4000" bind:value={description}></textarea>
    <button class="primary" disabled={busy || loading || !title.trim()}>Post task</button>
  </form>
  {#if agents.length}
    <div class="agent-choice">
      <label for="claim-agent">Your agent</label>
      <select id="claim-agent" bind:value={selectedAgent} disabled={busy}>
        {#each agents as agent (agent.id)}<option value={agent.id}>{agent.name}</option>{/each}
      </select>
    </div>
  {/if}
  {#if loading}
    <p role="status">Loading tasks…</p>
  {:else if !tasks.length}
    <p>No tasks have been posted in this channel.</p>
  {/if}
  <ul>
    {#each tasks as task (task.id)}
      <li>
        <h2>{task.title}</h2>
        {#if task.description}<p class="description">{task.description}</p>{/if}
        {#if task.resolution}
          <p>{task.resolution === 'done' ? 'Completed' : 'Cancelled'}</p>
          {#if task.result}<p class="description">{task.result}</p>{/if}
        {:else if task.claimedByAgentId}
          <p>Claimed by {task.claimedByAgentName ?? 'an agent'}</p>
        {:else if selectedAgent && task.createdBy === currentUser}
          <button type="button" disabled={busy || loading} onclick={() => claim(task.id)}>Claim task</button>
        {:else}
          <p>Open for claims</p>
        {/if}
        {#if !task.resolution}
          {#if task.claimedByAgentId && (task.createdBy === currentUser || agents.some((agent) => agent.id === task.claimedByAgentId))}
            <button type="button" disabled={busy} onclick={() => startResolution(task, 'done')}>Complete task</button>
          {/if}
          {#if task.createdBy === currentUser}
            <button type="button" disabled={busy} onclick={() => startResolution(task, 'cancelled')}>Cancel task</button>
          {/if}
        {/if}
        {#if closingTask?.id === task.id && !task.resolution}
          <form onsubmit={resolve}>
            <label for="resolution-notes">{closingTask.resolution === 'done' ? 'Result (optional)' : 'Cancellation reason (optional)'}</label>
            <textarea id="resolution-notes" rows="2" maxlength="4000" bind:value={resolutionNotes}></textarea>
            <div class="resolution-actions">
              <button class="primary" disabled={busy}>{closingTask.resolution === 'done' ? 'Confirm completion' : 'Confirm cancellation'}</button>
              <button type="button" onclick={() => { closingTask = null; }}>Keep open</button>
            </div>
          </form>
        {/if}
        <button type="button" aria-expanded={openBids === task.id}
          onclick={() => { openBids = openBids === task.id ? null : task.id; }}>
          {openBids === task.id ? 'Hide bids' : 'View bids'}
        </button>
        {#if openBids === task.id}
          {#key task.id}
            <TaskBids {task} {currentUser} {selectedAgent} onClaim={applyClaim} />
          {/key}
        {/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  .task-board { flex: 1; overflow: auto; min-width: 0; padding: 1.25rem; }
  header { display: flex; justify-content: space-between; align-items: start; gap: 1rem; }
  h1 { margin: 0; font-size: 1.25rem; overflow-wrap: anywhere; }
  label { font-weight: 600; }
  form { display: grid; gap: .5rem; margin: 1rem 0; max-width: 36rem; }
  form button { justify-self: start; }
  .resolution-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
  .agent-choice { display: flex; align-items: center; gap: .65rem; flex-wrap: wrap; }
  select { max-width: 100%; }
  ul { list-style: none; margin: .75rem 0; padding: 0; }
  li { padding: 1rem 0; border-top: 1px solid var(--line); }
  h2 { font-size: 1rem; margin: 0; overflow-wrap: anywhere; }
  p { color: var(--muted); }
  .description { white-space: pre-wrap; overflow-wrap: anywhere; }
  li > button { margin-top: .65rem; margin-right: .4rem; }
</style>
