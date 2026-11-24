<script lang="ts">
  import { onMount } from 'svelte';
  import type { WorkspaceFile } from './api';

  let { file, handle }: { file: WorkspaceFile; handle: string } = $props();
  let container: HTMLDivElement;
  let status = $state('Connecting to the workspace…');
  let peers = $state<string[]>([]);
  let failed = $state(false);

  const languages: Record<string, string> = {
    css: 'css', html: 'html', js: 'javascript', json: 'json', md: 'markdown',
    py: 'python', sh: 'shell', ts: 'typescript', yaml: 'yaml', yml: 'yaml'
  };

  onMount(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      const [monaco, worker, { MonacoBinding }, { HocuspocusProvider }, Y] = await Promise.all([
        import('monaco-editor/esm/vs/editor/editor.api.js'),
        import('monaco-editor/esm/vs/editor/editor.worker.js?worker'),
        import('y-monaco'),
        import('@hocuspocus/provider'),
        import('yjs'),
        import('monaco-editor/esm/vs/basic-languages/monaco.contribution.js')
      ]);
      if (disposed) return;
      self.MonacoEnvironment = { getWorker: () => new worker.default() };
      const extension = file.path.split('.').pop()?.toLowerCase() ?? '';
      const model = monaco.editor.createModel('', languages[extension] ?? 'plaintext');
      const editor = monaco.editor.create(container, {
        model,
        ariaLabel: `Edit ${file.path}`,
        automaticLayout: true,
        minimap: { enabled: false },
        readOnly: true,
        scrollBeyondLastLine: false
      });
      const document = new Y.Doc();
      const url = new URL('/collaboration', location.origin);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      let canEdit = false;
      let ready = false;
      const provider = new HocuspocusProvider({
        name: file.id,
        url: url.href,
        document,
        onAuthenticated({ scope }) {
          canEdit = scope === 'read-write';
        },
        onSynced({ state }) {
          ready = state;
          editor.updateOptions({ readOnly: !state || !canEdit });
          status = state ? (canEdit ? 'Connected' : 'Read only') : 'Syncing edits…';
        },
        onAuthenticationFailed() {
          failed = true;
          status = 'This file could not be opened. Check your workspace access.';
        },
        onDisconnect({ event }) {
          ready = false;
          editor.updateOptions({ readOnly: true });
          if (failed) return;
          status = event.code === 1009 ? 'The file exceeds the workspace size limit.' : 'Reconnecting…';
        },
        onUnsyncedChanges({ number }) {
          if (ready && canEdit) status = number > 0 ? 'Syncing edits…' : 'Connected';
        }
      });
      const awareness = provider.awareness;
      awareness?.setLocalStateField('user', { name: handle });
      const updatePeers = () => {
        const names = new Set<string>();
        for (const [clientId, state] of awareness?.getStates() ?? []) {
          if (clientId === document.clientID) continue;
          const user: unknown = state.user;
          if (typeof user === 'object' && user !== null && 'name' in user && typeof user.name === 'string') {
            names.add(user.name.slice(0, 50));
          }
        }
        peers = [...names].sort();
      };
      awareness?.on('change', updatePeers);
      const binding = new MonacoBinding(document.getText('content'), model, new Set([editor]), awareness ?? undefined);
      cleanup = () => {
        awareness?.off('change', updatePeers);
        binding.destroy();
        provider.destroy();
        editor.dispose();
        model.dispose();
        document.destroy();
      };
    })().catch(() => {
      if (!disposed) {
        failed = true;
        status = 'The editor could not load. Reopen this file to retry.';
      }
    });

    return () => {
      disposed = true;
      cleanup?.();
    };
  });
</script>

<section class="file-editor" aria-label={file.path}>
  <header>
    <h1>{file.path}</h1>
    <p role={failed ? 'alert' : 'status'}>{status}</p>
    {#if peers.length}<p>Also editing: {peers.join(', ')}</p>{/if}
  </header>
  <div class="editor-surface" bind:this={container}></div>
</section>

<style>
  .file-editor { display: grid; grid-template-rows: auto 1fr; flex: 1; min-height: 24rem; min-width: 0; }
  header { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; padding: .65rem 1.25rem; border-bottom: 1px solid var(--line); }
  h1 { font-size: 1rem; margin: 0; overflow-wrap: anywhere; }
  p { color: var(--muted); margin: 0; font-size: .875rem; }
  .editor-surface { min-height: 20rem; }
  :global(.yRemoteSelection) { background: #bad3f0aa; }
  :global(.yRemoteSelectionHead) { border-left: 2px solid #355ec2; }
</style>
