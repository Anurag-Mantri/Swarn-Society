<script lang="ts">
  import { onMount } from 'svelte';
  import type { TaskBid, TaskBidCandidate, TaskPost } from '@swarmroom/protocol';
  import { api, ApiError } from './api';

  let { task, currentUser, selectedAgent, onClaim }:
    { task: TaskPost; currentUser: string; selectedAgent: string; onClaim: (claimed: TaskPost) => void } = $props();

  let bids = $state<TaskBid[]>([]);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let candidates = $state<TaskBidCandidate[]>([]);
  let candidate = $state('');
  let notice = $state('');
  let plan = $state('');
  let deliverable = $state('');
  let estimatedTokens = $state<number>();
  const hasBid = $derived(bids.some((bid) => bid.agentId === selectedAgent));
  const open = $derived(!task.claimedByAgentId && !task.resolution);

  const available = $derived(candidates.filter(({ id }) => !bids.some((bid) => bid.agentId === id)));

  async function loadCandidates() {
    if (!open || currentUser !== task.createdBy) return;
    try {
      candidates = await api.taskBidCandidates(task.channelId, task.id);
      if (!candidates.some(({ id }) => id === candidate)) candidate = candidates[0]?.id ?? '';
    } catch (problem) {
      if (!(problem instanceof ApiError) || (problem.status !== 403 && problem.status !== 409)) showError(problem);
    }
  }

  async function requestBid() {
    if (busy || !open || !available.some(({ id }) => id === candidate)) return;
    busy = true;
    error = '';
    notice = 'Requesting an agent bid…';
    try {
      const { bid } = await api.requestAgentBid(task.channelId, task.id, candidate);
      if (bid) {
        bids = [...bids, bid];
        candidate = available.find(({ id }) => id !== bid.agentId)?.id ?? '';
      }
      notice = bid ? 'Agent bid submitted for your approval.' : 'The agent declined to bid.';
    } catch (problem) {
      notice = '';
      showError(problem);
      if (problem instanceof ApiError && problem.status === 409) await refresh();
    } finally {
      busy = false;
    }
  }

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
      if (candidate === bid.agentId) candidate = available[0]?.id ?? '';
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

  onMount(() => { void Promise.all([refresh(), loadCandidates()]); });
</script>

<section aria-label="Task bids">
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if loading}
    <p role="status">Loading bids…</p>
  {:else if bids.length === 0}
    <p>No bids yet.</p>
  {/if}
  {#each bids as bid (bid.id)}
    <article>
      <strong>{bid.agentName}</strong>
      {#if bid.source === 'agent'}<p>Agent-generated bid</p>{/if}
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
  {#if open && available.length && !loading}
    <div class="agent-bid">
      <label for={`agent-bid-${task.id}`}>Agent to invite</label>
      <select id={`agent-bid-${task.id}`} bind:value={candidate} disabled={busy}>
        {#each available as agent (agent.id)}
          <option value={agent.id}>{agent.name} · {agent.role}</option>
        {/each}
      </select>
      <button type="button" onclick={requestBid} disabled={busy || !candidate}>Request agent bid</button>
    </div>
  {/if}
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
  .agent-bid { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
</style>
