<script lang="ts">
  import { onMount } from 'svelte';
  import type { KnowledgeReview, KnowledgeReviewCandidate } from '@swarmroom/protocol';
  import { api, ApiError } from './api';

  let { workspaceId, label, onReview }: {
    workspaceId: string;
    label: (node: KnowledgeReviewCandidate['from']) => string;
    onReview: () => Promise<void>;
  } = $props();
  let candidates = $state<KnowledgeReviewCandidate[]>([]);
  let available = $state(false);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state('');
  let notice = $state('');

  async function load() {
    loading = true;
    error = '';
    try {
      candidates = await api.knowledgeReviews(workspaceId);
      available = true;
    } catch (problem) {
      if (problem instanceof ApiError && problem.status === 403) {
        available = false;
        candidates = [];
      } else {
        error = problem instanceof Error ? problem.message : 'Could not load the review queue.';
      }
    } finally {
      loading = false;
    }
  }

  async function decide(event: SubmitEvent, edgeId: string) {
    event.preventDefault();
    if (saving || !(event.currentTarget instanceof HTMLFormElement)) return;
    const fields = new FormData(event.currentTarget, event.submitter);
    const decision = fields.get('decision');
    if (decision !== 'approved' && decision !== 'rejected') return;
    const review: KnowledgeReview = { decision, reason: String(fields.get('reason') ?? '') };
    saving = true;
    error = '';
    notice = '';
    try {
      await api.decideKnowledgeReview(workspaceId, edgeId, review);
      candidates = candidates.filter(({ id }) => id !== edgeId);
      notice = decision === 'approved' ? 'Relationship approved.' : 'Relationship rejected.';
      await Promise.all([load(), onReview()]);
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Could not save the review.';
    } finally {
      saving = false;
    }
  }

  onMount(() => { void load(); });
</script>

{#if available || error}
  <section aria-label="Knowledge review queue">
    <header>
      <h2>Review queue</h2>
      <button type="button" onclick={load} disabled={loading || saving}>Refresh queue</button>
    </header>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#if available && !candidates.length && !loading}<p>No relationships waiting for your review.</p>{/if}
    {#each candidates as edge (edge.id)}
      <details>
        <summary>{label(edge.from)} {edge.relation.replaceAll('_', ' ')} {label(edge.to)}</summary>
        <p>{edge.method === 'inferred' ? 'Inferred' : 'Deterministic'} · Confidence {edge.confidence}%{edge.hasConflict ? ' · Conflicting evidence' : ''}</p>
        <ul>
          {#each edge.sources as source (source.id)}
            <li>{source.type.replace('.', ' ')} <code>{source.sourceId}</code></li>
          {/each}
        </ul>
        <form onsubmit={(event) => decide(event, edge.id)}>
          <label>Reason (optional) <input name="reason" maxlength="2000" /></label>
          <button type="submit" name="decision" value="approved" disabled={saving}>Approve</button>
          <button type="submit" name="decision" value="rejected" disabled={saving}>Reject</button>
        </form>
      </details>
    {/each}
  </section>
{/if}

<style>
  section { border-top: 1px solid var(--line); margin-top: 1rem; padding-top: 1rem; }
  header, form { display: flex; align-items: center; flex-wrap: wrap; gap: .75rem; }
  header { justify-content: space-between; }
  details { padding: .65rem 0; }
  h2 { font-size: 1rem; margin: 0; }
  p { color: var(--muted); }
  code { overflow-wrap: anywhere; }
</style>
