<script lang="ts">
  import { taskReputationInputSchema } from '@swarmroom/protocol';
  import type { TaskReputationReview } from '@swarmroom/protocol';
  import { api, ApiError } from './api';

  let { channelId, taskId, onReview }: { channelId: string; taskId: string; onReview: () => void } = $props();
  let canReview = $state(false);
  let review = $state<TaskReputationReview | null>(null);
  let loaded = $state(false);
  let busy = $state(false);
  let error = $state('');
  let feedback = $state<'helpful' | 'needs_work' | ''>('');
  let tests = $state<'passed' | 'failed' | ''>('');
  let mergedPullRequest = $state('');

  async function load() {
    if (busy || loaded) return;
    busy = true;
    error = '';
    try {
      ({ canReview, review } = await api.taskReputation(channelId, taskId));
      loaded = true;
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Could not load this task review.';
    } finally {
      busy = false;
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    const body = taskReputationInputSchema.safeParse({
      feedback: feedback || undefined, tests: tests || undefined,
      mergedPullRequest: mergedPullRequest.trim() || undefined,
    });
    if (!body.success) {
      error = 'Provide a review signal. Use a GitHub pull request URL for a merged PR.';
      return;
    }
    busy = true;
    error = '';
    try {
      review = await api.reviewTask(channelId, taskId, body.data);
      onReview();
    } catch (problem) {
      if (problem instanceof ApiError && problem.status === 409) {
        loaded = false;
      }
      error = problem instanceof Error ? problem.message : 'Could not save this task review.';
    } finally {
      busy = false;
    }
  }
</script>

<details ontoggle={(event) => { if (event.currentTarget.open) void load(); }}>
  <summary>Review task outcome</summary>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if busy && !loaded}<p role="status">Loading task review…</p>{/if}
  {#if review}
    <p role="status">Task review recorded.</p>
    {#if review.feedback}<p>Feedback · {review.feedback === 'helpful' ? 'Helpful' : 'Needs work'}</p>{/if}
    {#if review.tests}<p>Tests · {review.tests === 'passed' ? 'Passed' : 'Failed'}</p>{/if}
    {#if review.mergedPullRequest}<a href={review.mergedPullRequest} target="_blank" rel="noreferrer">Merged pull request</a>{/if}
  {:else if loaded && canReview}
    <form onsubmit={submit}>
      <label>Feedback
        <select bind:value={feedback}>
          <option value="">Skip feedback</option><option value="helpful">Helpful</option><option value="needs_work">Needs work</option>
        </select>
      </label>
      <label>Test outcome
        <select bind:value={tests}>
          <option value="">Skip tests</option><option value="passed">Passed</option><option value="failed">Failed</option>
        </select>
      </label>
      <label>Merged GitHub PR URL <input type="url" maxlength="320" bind:value={mergedPullRequest} /></label>
      <button type="submit" disabled={busy || (!feedback && !tests && !mergedPullRequest.trim())}>Save task review</button>
    </form>
  {:else if loaded}
    <p>Reviews are available for tasks completed by another person's agent.</p>
  {:else if !busy && error}
    <button type="button" onclick={load}>Reload task review</button>
  {/if}
</details>

<style>
  details { margin-top: .5rem; }
  form { display: flex; flex-wrap: wrap; align-items: end; gap: .75rem; margin-top: .5rem; }
  label { display: grid; gap: .25rem; }
  input { max-width: 100%; }
  p { margin: .4rem 0; }
</style>
