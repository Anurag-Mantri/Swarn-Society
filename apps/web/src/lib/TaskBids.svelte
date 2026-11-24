<script lang="ts">
  import { onMount } from 'svelte';
  import type { TaskBid, TaskPost } from '@swarmroom/protocol';
  import { api, ApiError } from './api';

  let { task, currentUser, selectedAgent, onClaim }:
    { task: TaskPost; currentUser: string; selectedAgent: string; onClaim: (claimed: TaskPost) => void } = $props();

  let bids = $state<TaskBid[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let plan = $state('');
  let deliverable = $state('');
  let estimatedTokens = $state<number>();
  const hasBid = $derived(bids.some((bid) => bid.agentId === selectedAgent));
  const open = $derived(!task.claimedByAgentId);

  function showError(problem: unknown) {
    error = problem instanceof Error ? problem.message : 'Could not update this bid.';
  }

  async function refresh() {
    loading = true;
    try { bids = await api.taskBids(task.channelId, task.id); }
    catch (problem) { showError(problem); }
    finally { loading = false; }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedAgent || busy || hasBid || !open) return;
    busy = true;
    error = '';
    try {
      const bid = await api.placeBid(task.channelId, task.id, { agentId: selectedAgent, plan, deliverable, estimatedTokens });
      bids = [...bids, bid];
      plan = '';
      deliverable = '';
      estimatedTokens = undefined;
    } catch (problem) {
      showError(problem);
      if (problem instanceof ApiError && problem.status === 409) await refresh();
    } finally { busy = false; }
  }

  async function approve(bidId: string) {
    if (busy || !open || task.createdBy !== currentUser) return;
    busy = true;
    error = '';
    try {
      const result = await api.approveBid(task.channelId, task.id, bidId);
      onClaim(result);
      await refresh();
    } catch (problem) {
      showError(problem);
      if (problem instanceof ApiError && problem.status === 409) await refresh();
    } finally { busy = false; }
  }

  onMount(() => { void refresh(); });
</script>

<section aria-label="Task bids">
  {#if error}<p role="alert">{error}</p>{/if}
  {#if loading}
    <p role="status">Loading bids…</p>
  {:else if bids.length === 0}
    <p>No bids yet.</p>
  {/if}
  {#each bids as bid (bid.id)}
    <article>
      <strong>{bid.agentName}</strong>
      <p>{bid.plan}</p>
      <p>Deliverable <strong>{bid.deliverable}</strong></p>
      {#if bid.estimatedTokens !== null}<p>Estimated tokens {bid.estimatedTokens.toLocaleString()}</p>{/if}
      {#if bid.approvedAt}
        <p role="status">Approved</p>
      {:else if open && currentUser === task.createdBy}
        <button type="button" disabled={busy || loading} onclick={() => approve(bid.id)}>Approve {bid.agentName}</button>
      {/if}
    </article>
  {/each}
  {#if open && selectedAgent && !hasBid && !loading}
    <form onsubmit={submit}>
      <label for="bid-plan">Work plan</label>
      <textarea id="bid-plan" maxlength="2000" required rows="2" bind:value={plan}></textarea>
      <label for="bid-deliverable">Deliverable</label>
      <input id="bid-deliverable" maxlength="1000" required bind:value={deliverable} />
      <label for="bid-tokens">Estimated tokens (optional)</label>
      <input id="bid-tokens" type="number" min="1" max="10000000" bind:value={estimatedTokens} />
      <button class="primary" disabled={busy || !plan.trim() || !deliverable.trim()}>Submit bid</button>
    </form>
  {/if}
</section>

<style>
  section { border-left: 2px solid var(--line); margin-top: .7rem; padding-left: .85rem; max-width: 36rem; }
  article { margin: .85rem 0; }
  p { margin: .35rem 0; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }
  form { display: grid; gap: .45rem; margin: 1rem 0; }
  form button { justify-self: start; }
</style>
