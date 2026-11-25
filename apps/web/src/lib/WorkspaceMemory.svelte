<script lang="ts">
  import { onMount } from 'svelte';
  import type { MemoryNote, MemoryScope, TaskClaimant } from '@swarmroom/protocol';
  import { api, type Channel } from './api';

  let { workspaceId, channels }: { workspaceId: string; channels: Channel[] } = $props();
  let agents = $state<TaskClaimant[]>([]);
  let scope = $state<MemoryScope>('workspace');
  let target = $state('');
  let query = $state('');
  let body = $state('');
  let notes = $state<MemoryNote[]>([]);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let revision = 0;
  const targets = $derived(scope === 'channel' ? channels : agents);

  function showError(problem: unknown) {
    error = problem instanceof Error ? problem.message : 'Could not open this memory scope.';
  }

  async function search(event?: SubmitEvent) {
    event?.preventDefault();
    const request = ++revision;
    notes = [];
    error = '';
    if (scope !== 'workspace' && !target) {
      loading = false;
      return;
    }

    loading = true;
    try {
      const result = await api.memory(workspaceId, scope, query, target || undefined);
      if (request === revision) notes = result;
    } catch (problem) {
      if (request === revision) showError(problem);
    } finally {
      if (request === revision) loading = false;
    }
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (saving) return;
    saving = true;
    error = '';
    try {
      await api.saveMemory(workspaceId, scope, body, target || undefined);
      body = '';
      query = '';
      await search();
    } catch (problem) { showError(problem); }
    finally { saving = false; }
  }

  function chooseScope(event: Event & { currentTarget: HTMLSelectElement }) {
    const value = event.currentTarget.value;
    if (value !== 'workspace' && value !== 'channel' && value !== 'agent') return;
    scope = value;
    target = scope === 'workspace' ? '' : targets[0]?.id ?? '';
    void search();
  }

  onMount(() => {
    void search();
    void api.memoryAgents(workspaceId).then((result) => { agents = result; }).catch(showError);
  });
</script>

<section aria-label="Workspace memory">
  <h1>Memory</h1>
  <div class="controls">
    <label for="memory-scope">Scope</label>
    <select id="memory-scope" value={scope} onchange={chooseScope} disabled={saving}>
      <option value="workspace">Workspace</option>
      <option value="channel" disabled={!channels.length}>Channel</option>
      <option value="agent" disabled={!agents.length}>My agents</option>
    </select>
    {#if scope !== 'workspace'}
      <label for="memory-target">{scope === 'channel' ? 'Channel' : 'Agent'}</label>
      <select id="memory-target" value={target} onchange={(event) => { target = event.currentTarget.value; void search(); }} disabled={saving}>
        {#each targets as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
      </select>
    {/if}
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  <form class="controls" onsubmit={search}>
    <label for="memory-search">Search notes</label>
    <input id="memory-search" maxlength="200" bind:value={query} />
    <button disabled={loading || saving}>Search</button>
  </form>
  <form class="write" onsubmit={save}>
    <label for="memory-note">New note</label>
    <textarea id="memory-note" required rows="3" maxlength="4000" bind:value={body}></textarea>
    <button class="primary" disabled={saving || !body.trim() || (scope !== 'workspace' && !target)}>Save note</button>
  </form>
  {#if loading}<p role="status">Loading notes…</p>
  {:else if !notes.length && !error}<p>No matching notes.</p>{/if}
  <ul>
    {#each notes as note (note.id)}
      <li><p>{note.body}</p><time datetime={note.createdAt}>{new Date(note.createdAt).toLocaleString()}</time></li>
    {/each}
  </ul>
</section>

<style>
  section { flex: 1; overflow: auto; padding: 1.25rem; min-width: 0; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  .controls { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin: .75rem 0; }
  .write { display: grid; gap: .5rem; max-width: 40rem; }
  .write button { justify-self: start; }
  ul { padding: 0; list-style: none; }
  li { border-top: 1px solid var(--line); padding: .75rem 0; }
  li p { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0 0 .35rem; }
  time { color: var(--muted); font-size: .875rem; }
</style>
