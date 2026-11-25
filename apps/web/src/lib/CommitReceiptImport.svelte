<script lang="ts">
  import { githubCommitReceiptSchema } from '@swarmroom/protocol';
  import { api } from './api';

  let { workspaceId, onImport }: { workspaceId: string; onImport: () => Promise<void> } = $props();
  let saving = $state(false);
  let error = $state('');
  let notice = $state('');

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (saving || !(event.currentTarget instanceof HTMLFormElement)) return;
    const form = event.currentTarget;
    const file = new FormData(form).get('receipt');
    error = '';
    notice = '';
    if (!(file instanceof File) || !file.size || file.size > 4096) {
      error = 'Choose a commit receipt JSON file up to 4 KB.';
      return;
    }
    saving = true;
    try {
      const value: unknown = await file.text().then(JSON.parse).catch(() => null);
      const receipt = githubCommitReceiptSchema.safeParse(value);
      if (!receipt.success || receipt.data.serverId !== workspaceId) {
        error = 'Choose a valid receipt for this workspace.';
        return;
      }
      const result = await api.importCommitReceipt(workspaceId, receipt.data);
      notice = result.inserted ? 'Commit receipt imported.' : 'This commit receipt is already in the workspace.';
      form.reset();
      await onImport();
    } catch (problem) {
      error = problem instanceof Error ? problem.message : 'Could not import the commit receipt.';
    } finally {
      saving = false;
    }
  }
</script>

<details>
  <summary>Import GitHub commit receipt</summary>
  <form onsubmit={submit}>
    <label>Receipt JSON <input name="receipt" type="file" accept="application/json,.json" required /></label>
    <button type="submit" disabled={saving}>Import receipt</button>
  </form>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
</details>

<style>
  details { margin-top: 1rem; }
  form { display: flex; gap: .75rem; align-items: center; flex-wrap: wrap; margin-top: .75rem; }
  input { max-width: 100%; }
</style>
