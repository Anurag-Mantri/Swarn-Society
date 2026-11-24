<script lang="ts">
  import { workspaceSnapshotBranch } from '@swarmroom/protocol';
  import { onMount } from 'svelte';
  import { api, type WorkspaceFile } from './api';
  import WorkspaceEditor from './WorkspaceEditor.svelte';

  let { workspaceId, handle, canExport }: { workspaceId: string; handle: string; canExport: boolean } = $props();
  let files = $state<WorkspaceFile[]>([]);
  let current = $state<WorkspaceFile | null>(null);
  let path = $state('');
  let error = $state('');
  let busy = $state(false);
  let exporting = $state(false);

  onMount(() => {
    let closed = false;
    void api.files(workspaceId).then((rows) => {
      if (closed) return;
      files = rows;
      current = rows[0] ?? null;
    }).catch((problem: unknown) => {
      if (!closed) error = problem instanceof Error ? problem.message : 'Could not open workspace files.';
    });
    return () => { closed = true; };
  });

  async function downloadSnapshot() {
    if (exporting) return;
    exporting = true;
    error = '';
    try {
      const snapshot = await api.snapshot(workspaceId);
      const blob = new Blob([JSON.stringify(snapshot)], { type: 'application/json' });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `swarmroom-${workspaceId}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Could not download the snapshot.';
    } finally { exporting = false; }
  }

  async function createFile(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !path.trim()) return;
    busy = true;
    error = '';
    try {
      const file = await api.createFile(workspaceId, path);
      files = [...files, file].sort((left, right) => left.path.localeCompare(right.path));
      current = file;
      path = '';
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Could not create the file.';
    } finally { busy = false; }
  }
</script>

<div class="files-view">
  <aside aria-label="Workspace files">
    <form onsubmit={createFile}>
      <label for="new-file-path">New file path</label>
      <input id="new-file-path" placeholder="src/example.ts" maxlength="240" bind:value={path} required />
      <button disabled={busy} class="primary">Create file</button>
    </form>
    {#if canExport}
      <button type="button" disabled={exporting || !files.length} onclick={downloadSnapshot}>Download saved snapshot</button>
      <p class="branch">GitHub snapshot branch <code>{workspaceSnapshotBranch(workspaceId)}</code></p>
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <nav aria-label="Files">
      {#each files as file (file.id)}
        <button type="button" aria-current={current?.id === file.id ? 'true' : undefined}
          onclick={() => { current = file; }}>{file.path}</button>
      {/each}
    </nav>
  </aside>
  {#if current}
    {#key current.id}<WorkspaceEditor file={current} {handle} />{/key}
  {:else}
    <p class="empty">Create a file to start editing.</p>
  {/if}
</div>

<style>
  .files-view { display: grid; grid-template-columns: minmax(11rem, 15rem) minmax(0, 1fr); flex: 1; min-height: 0; }
  aside { border-right: 1px solid var(--line); padding: .75rem; overflow: auto; }
  form, nav { display: grid; gap: .45rem; margin-bottom: 1rem; }
  input { min-width: 0; }
  nav button { text-align: left; overflow-wrap: anywhere; }
  nav button[aria-current] { background: var(--active); }
  .branch { font-size: .875rem; overflow-wrap: anywhere; color: var(--muted); }
  .empty { padding: 1rem; color: var(--muted); }
  @media (max-width: 760px) {
    .files-view { grid-template-columns: minmax(0, 1fr); }
    aside { border-right: 0; border-bottom: 1px solid var(--line); }
  }
</style>
