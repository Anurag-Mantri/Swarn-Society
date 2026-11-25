<script lang="ts">
  import { onMount } from 'svelte';
  import type { KnowledgeOverview } from '@swarmroom/protocol';
  import CommitReceiptImport from './CommitReceiptImport.svelte';
  import KnowledgeReviews from './KnowledgeReviews.svelte';
  import { api, type Channel, type Profile, type Workspace } from './api';

  let { workspace, channels, profile }: { workspace: Workspace; channels: Channel[]; profile: Profile } = $props();
  let data = $state<KnowledgeOverview | null>(null);
  let scope = $state('');
  let loading = $state(true);
  let error = $state('');
  let revision = 0;
  const nodes = $derived(new Map(data?.nodes.map((node) => [node.id, node])));
  const sources = $derived(new Map(data?.sources.map((source) => [source.id, source])));
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  async function load() {
    const request = ++revision;
    loading = true;
    error = '';
    data = null;
    try {
      const overview = await api.knowledge(workspace.id, scope || undefined);
      if (request === revision) data = overview;
    } catch (problem) {
      if (request === revision) error = problem instanceof Error ? problem.message : 'Could not load workspace knowledge.';
    } finally {
      if (request === revision) loading = false;
    }
  }

  function label(node: { kind: string; key: string } | undefined): string {
    if (!node) return 'Unknown record';
    if (node.kind === 'server') return workspace.name;
    if (node.kind === 'channel') return channels.find((channel) => channel.id === node.key)?.name ?? 'Channel';
    if (node.kind === 'person' && node.key === profile.id) return profile.handle;
    const category = node.key.startsWith('message:') ? 'message' : node.key.startsWith('commit:') ? 'commit' : node.kind;
    return `${category[0]?.toUpperCase()}${category.slice(1)} ${node.key.split(':').at(-1)?.slice(0, 8)}`;
  }

  onMount(() => { void load(); });
</script>

<section aria-label="Workspace knowledge">
  <header>
    <h1>Knowledge</h1>
    <div class="controls">
      <label for="knowledge-scope">Sources</label>
      <select id="knowledge-scope" bind:value={scope} onchange={load}>
        <option value="">All readable sources</option>
        {#each channels as channel (channel.id)}<option value={channel.id}>{channel.name}</option>{/each}
      </select>
      <button type="button" onclick={load} disabled={loading}>Refresh</button>
    </div>
  </header>
  {#if loading}
    <p role="status">Loading workspace knowledge…</p>
  {:else if error}
    <p role="alert">{error}</p>
  {:else if data && !data.edges.length}
    <p>No accepted relationships in the latest sources.</p>
  {:else if data}
    <ul>
      {#each data.edges as edge (edge.id)}
        <li>
          <details>
            <summary>
              <strong>{label(nodes.get(edge.fromId))}</strong>
              <span>{edge.relation.replaceAll('_', ' ')}</span>
              <strong>{label(nodes.get(edge.toId))}</strong>
            </summary>
            <p>Confidence {edge.confidence}%</p>
            <ul class="evidence">
              {#each edge.sourceIds as sourceId (sourceId)}
                {@const source = sources.get(sourceId)}
                {#if source}
                  <li>
                    <span>{source.type.replaceAll('.', ' ')}</span>
                    <time datetime={source.occurredAt}>{date.format(new Date(source.occurredAt))}</time>
                    <code>{source.sourceId}</code>
                  </li>
                {/if}
              {/each}
            </ul>
          </details>
        </li>
      {/each}
    </ul>
  {/if}
  {#if workspace.ownerId === profile.id}
    <CommitReceiptImport workspaceId={workspace.id} onImport={load} />
  {/if}
  <KnowledgeReviews workspaceId={workspace.id} {channels} sources={data?.sources ?? []} {label} onReview={load} />
</section>

<style>
  section { flex: 1; overflow: auto; min-width: 0; padding: 1.25rem; }
  header { display: flex; align-items: center; justify-content: space-between; gap: .75rem; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 1.25rem; }
  .controls { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  select { max-width: 100%; }
  ul { list-style: none; padding: 0; }
  li { border-top: 1px solid var(--line); padding: .7rem 0; }
  summary span { color: var(--muted); margin: 0 .35rem; }
  p, time { color: var(--muted); }
  .evidence li { display: flex; gap: .4rem .8rem; padding: .4rem 0; flex-wrap: wrap; }
  code { overflow-wrap: anywhere; }
</style>
