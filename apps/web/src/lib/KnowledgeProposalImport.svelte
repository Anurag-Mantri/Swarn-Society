<script lang="ts">
  import { knowledgeProposalFileSchema } from '@swarmroom/protocol';
  import type { KnowledgeOverview } from '@swarmroom/protocol';
  import { api, type Channel } from './api';

  let { workspaceId, channels, sources, afterImport }: {
    workspaceId: string;
    channels: Channel[];
    sources: KnowledgeOverview['sources'];
    afterImport: () => Promise<void>;
  } = $props();
  let selected = $state('');
  let error = $state('');
  let notice = $state('');
  let saving = $state(false);
  const candidates = $derived(sources.filter((source) =>
    source.type === 'message.posted' && channels.some(({ id, kind }) => id === source.channelId && kind === 'task')));
  const source = $derived(candidates.find(({ id }) => id === selected));
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving || !(event.currentTarget instanceof HTMLFormElement)) return;
    const form = event.currentTarget;
    const file = new FormData(form).get('proposal');
    error = '';
    notice = '';
    if (!(file instanceof File) || !file.size || file.size > 4096) {
      error = 'Choose a proposal JSON file up to 4 KB.';
      return;
    }
    saving = true;
    try {
      const data: unknown = await file.text().then(JSON.parse).catch(() => null);
      const proposal = knowledgeProposalFileSchema.safeParse(data);
      if (!proposal.success || proposal.data.serverId !== workspaceId || !proposal.data.references.length) {
        error = 'Choose a proposal with at least one task reference for this workspace.';
        return;
      }
      const { inserted } = await api.importKnowledgeProposal(proposal.data);
      notice = inserted === 1 ? 'Added one relationship to the review queue.' :
        inserted > 1 ? `Added ${inserted} relationships to the review queue.` : 'These proposals are already in the workspace.';
      form.reset();
      await afterImport();
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Could not import the knowledge proposal.';
    } finally {
      saving = false;
    }
  }
</script>

<details>
  <summary>Propose task references</summary>
  <p>Download a message excerpt and recent task titles, then generate proposals using a configured host agent.</p>
  <label>Source message
    <select bind:value={selected}>
      <option value="">Choose a message</option>
      {#each candidates as item (item.id)}
        <option value={item.id}>
          {channels.find(({ id }) => id === item.channelId)?.name}
          · {date.format(new Date(item.occurredAt))}
          · {item.sourceId.slice(0, 8)}
        </option>
      {/each}
    </select>
  </label>
  {#if source?.channelId}
    <a href={api.extractionInputPath(source.channelId, source.sourceId)} download>Download extraction input</a>
  {/if}
  <form onsubmit={submit}>
    <label>Proposal JSON <input name="proposal" type="file" accept="application/json,.json" required /></label>
    <button type="submit" disabled={saving}>Import proposals</button>
  </form>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
</details>

<style>
  details { margin: .75rem 0; }
  form { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; margin-top: .75rem; }
  a { margin-left: .5rem; }
  select, input { max-width: 100%; }
</style>
