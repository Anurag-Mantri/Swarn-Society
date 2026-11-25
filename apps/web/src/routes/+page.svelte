<script lang="ts">
  import { onMount } from 'svelte';
  import { errorSchema, initSchema, messageSchema, workspaceSsoIdSchema } from '@swarmroom/protocol';
  import VoiceRoom from '$lib/VoiceRoom.svelte';
  import WorkspaceMemory from '$lib/WorkspaceMemory.svelte';
  import KnowledgeOverview from '$lib/KnowledgeOverview.svelte';
  import TaskBoard from '$lib/TaskBoard.svelte';
  import WorkspaceFiles from '$lib/WorkspaceFiles.svelte';
  import Conversation from '$lib/Conversation.svelte';
  import { api, ApiError, type Channel, type Message, type Profile, type Workspace } from '$lib/api';
  import '../workspace.css';

  let profile = $state<Profile | null>(null);
  let loading = $state(true);
  let ssoWorkspace = $state<string | undefined>();
  let ssoError = $state(false);
  let workspaces = $state<Workspace[]>([]);
  let channels = $state<Channel[]>([]);
  let workspaceId = $state('');
  let view = $state<'chat' | 'files' | 'tasks' | 'knowledge' | 'memory'>('chat');
  let channelId = $state('');
  let messages = $state<Message[]>([]);
  let unread = $state<Record<string, number>>({});
  let root = $state<Message | null>(null);
  let replies = $state<Message[]>([]);
  let error = $state('');
  let status = $state<'connecting' | 'connected' | 'disconnected'>('disconnected');
  let workspaceName = $state('');
  let channelName = $state('');
  let channelKind = $state<Channel['kind']>('text');
  let busy = $state(false);
  let workspaceForm: HTMLDetailsElement | undefined = $state();
  let channelForm: HTMLDetailsElement | undefined = $state();
  let socket: WebSocket | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let channelRevision = 0;
  let threadRevision = 0;
  let unreadRevision = 0;
  let unreadTimer: ReturnType<typeof setTimeout> | undefined;
  let readTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingRead: { channelId: string; messageId: string } | undefined;
  let latestVisible: Message | undefined;
  const read = new Map<string, string>();

  const workspace = $derived(workspaces.find((item) => item.id === workspaceId));
  const availableChannels = $derived(channels.filter((item) => item.serverId === workspaceId));
  const channel = $derived(availableChannels.find((item) => item.id === channelId));

  function showError(problem: unknown) {
    error = problem instanceof Error ? problem.message : 'Something went wrong. Try again.';
  }

  function scheduleUnread() {
    if (!workspaceId || unreadTimer !== undefined) return;
    unreadTimer = setTimeout(() => {
      unreadTimer = undefined;
      const requestedWorkspace = workspaceId;
      const revision = ++unreadRevision;
      if (!requestedWorkspace) return;
      void api.unreadChannels(requestedWorkspace).then((rows) => {
        if (!disposed && requestedWorkspace === workspaceId && revision === unreadRevision) {
          unread = Object.fromEntries(rows.map(({ channelId, count }) => [channelId, count]));
        }
      }).catch(() => undefined);
    }, 1200);
  }

  async function flushRead() {
    clearTimeout(readTimer);
    readTimer = undefined;
    const mark = pendingRead;
    pendingRead = undefined;
    if (!mark || read.get(mark.channelId) === mark.messageId) return;
    try {
      await api.markChannelRead(mark.channelId, mark.messageId);
      read.set(mark.channelId, mark.messageId);
    } catch {
      // A later history refresh retries the cursor update.
    } finally {
      scheduleUnread();
    }
  }

  function scheduleRead(message?: Message) {
    if (message?.channelId === channelId) latestVisible = message;
    const last = latestVisible;
    if (view !== 'chat' || document.visibilityState !== 'visible' || !last || last.channelId !== channelId) return;
    if (read.get(channelId) === last.id) return;
    pendingRead = { channelId, messageId: last.id };
    clearTimeout(readTimer);
    readTimer = setTimeout(() => { void flushRead(); }, 500);
  }

  function resumeNotifications() {
    if (document.visibilityState !== 'visible') return;
    scheduleRead();
    scheduleUnread();
  }

  async function refreshChannel() {
    if (!channelId) return;
    const revision = ++channelRevision;
    try {
      const rows = await api.messages(channelId);
      if (revision === channelRevision) {
        messages = rows;
      }
    } catch (problem) {
      if (revision === channelRevision) showError(problem);
    }
  }

  async function refreshThread() {
    if (!root || !channelId) return;
    const revision = ++threadRevision;
    try {
      const rows = await api.messages(channelId, root.id);
      if (revision === threadRevision) replies = rows;
    } catch (problem) {
      if (revision === threadRevision) showError(problem);
    }
  }

  function closeThread() {
    threadRevision += 1;
    root = null;
    replies = [];
  }

  function chooseChannel(id: string) {
    void flushRead();
    channelRevision += 1;
    closeThread();
    channelId = id;
    view = channels.find((item) => item.id === id)?.kind === 'task' ? 'tasks' : 'chat';
    messages = [];
    latestVisible = undefined;
    error = '';
    void refreshChannel();
  }

  function chooseWorkspace(id: string) {
    unreadRevision += 1;
    unread = {};
    workspaceId = id;
    scheduleUnread();
    chooseChannel(channels.find((item) => item.serverId === id)?.id ?? '');
  }

  function openThread(message: Message) {
    closeThread();
    root = message;
    void refreshThread();
  }

  function connect() {
    if (disposed || !profile) return;
    clearTimeout(reconnect);
    const url = new URL('/ws', location.origin);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const connection = new WebSocket(url);
    socket = connection;
    status = 'connecting';
    connection.addEventListener('open', () => connection.send(JSON.stringify({ t: 'hello' })));
    connection.addEventListener('message', (event) => {
      if (socket !== connection || typeof event.data !== 'string') return;
      let frame: unknown;
      try { frame = JSON.parse(event.data); } catch { return; }
      const initial = initSchema.safeParse(frame);
      if (initial.success) {
        channels = initial.data.channels;
        status = 'connected';
        scheduleUnread();
        if (!channels.some((item) => item.id === channelId && item.serverId === workspaceId)) {
          chooseChannel(channels.find((item) => item.serverId === workspaceId)?.id ?? '');
        } else {
          void refreshChannel();
          void refreshThread();
        }
        return;
      }
      const failure = errorSchema.safeParse(frame);
      if (failure.success) {
        error = failure.data.message;
        return;
      }
      if (typeof frame !== 'object' || frame === null || !('t' in frame) || frame.t !== 'msg'
        || !('channelId' in frame)) return;
      const updatedChannel = frame.channelId;
      if ('threadId' in frame) {
        if (updatedChannel === channelId && frame.threadId === root?.id) void refreshThread();
        return;
      }
      if (channels.some((item) => item.id === updatedChannel && item.serverId === workspaceId)) scheduleUnread();
      if (updatedChannel === channelId) void refreshChannel();
    });
    connection.addEventListener('close', (event) => {
      if (socket !== connection || disposed) return;
      socket = undefined;
      status = 'disconnected';
      if (event.code === 1008) {
        error = 'Chat could not authenticate. Check the site address or sign in again.';
      } else {
        reconnect = setTimeout(connect, 2000);
      }
    });
  }

  function send(text: string, threadId?: string): boolean {
    const frame = messageSchema.safeParse({ t: 'msg', channelId, threadId, text });
    if (!frame.success || status !== 'connected' || socket?.readyState !== WebSocket.OPEN) return false;
    error = '';
    socket.send(JSON.stringify(frame.data));
    return true;
  }

  async function createWorkspace(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !workspaceName.trim()) return;
    busy = true;
    error = '';
    try {
      const created = await api.createWorkspace(workspaceName.trim());
      workspaces = [...workspaces, created].sort((a, b) => a.name.localeCompare(b.name));
      chooseWorkspace(created.id);
      workspaceName = '';
      if (workspaceForm) workspaceForm.open = false;
    } catch (problem) { showError(problem); }
    finally { busy = false; }
  }

  async function createChannel(event: SubmitEvent) {
    event.preventDefault();
    if (busy || !workspaceId || !channelName.trim()) return;
    const target = workspaceId;
    busy = true;
    error = '';
    try {
      const created = await api.createChannel(target, channelName.trim(), channelKind);
      channels = [...channels.filter((item) => item.id !== created.id), { ...created, serverId: target }];
      if (workspaceId === target) chooseChannel(created.id);
      channelName = '';
      if (channelForm) channelForm.open = false;
    } catch (problem) { showError(problem); }
    finally { busy = false; }
  }

  async function signOut() {
    try {
      await api.signOut();
      location.reload();
    } catch (problem) { showError(problem); }
  }

  onMount(() => {
    document.addEventListener('visibilitychange', resumeNotifications);
    const params = new URLSearchParams(location.search);
    ssoWorkspace = workspaceSsoIdSchema.safeParse(params.get('sso')).data;
    ssoError = params.get('ssoError') === '1';
    const requested = workspaceSsoIdSchema.safeParse(params.get('workspace')).data;
    void (async () => {
      try {
        const user = await api.profile();
        const directory = await api.workspaces();
        if (disposed) return;
        profile = user;
        workspaces = directory;
        workspaceId = directory.find(({ id }) => id === requested)?.id ?? directory[0]?.id ?? '';
        connect();
      } catch (problem) {
        if (!(problem instanceof ApiError && problem.status === 401)) showError(problem);
      } finally { loading = false; }
    })();
    return () => {
      disposed = true;
      clearTimeout(reconnect);
      clearTimeout(unreadTimer);
      clearTimeout(readTimer);
      document.removeEventListener('visibilitychange', resumeNotifications);
      socket?.close();
    };
  });
</script>

<svelte:head>
  <title>Swarmroom</title>
  <meta name="description" content="Team chat with locally hosted agents." />
</svelte:head>

{#if loading}
  <main class="entry"><p role="status">Opening Swarmroom…</p></main>
{:else if !profile}
  <main class="entry">
    <div>
      <h1>Swarmroom</h1>
      <p>Team chat with locally hosted agents.</p>
      {#if error}<p role="alert">{error}</p>{/if}
      {#if ssoWorkspace}
        {#if ssoError}<p role="alert">Workspace sign-in could not be completed. Try again or contact your workspace administrator.</p>{/if}
        <a class="primary" href={`/auth/sso/${ssoWorkspace}`} data-sveltekit-reload>Sign in with workspace SSO</a>
      {/if}
      <a class:primary={!ssoWorkspace} href="/auth/github" data-sveltekit-reload>Sign in with GitHub</a>
    </div>
  </main>
{:else}
  <div class="workspace-shell">
    <aside class="sidebar" aria-label="Workspace navigation">
      <div class="brand">Swarmroom</div>
      <details bind:this={workspaceForm}>
        <summary>Create a workspace</summary>
        <form onsubmit={createWorkspace}>
          <label for="workspace-name">Workspace name</label>
          <input id="workspace-name" bind:value={workspaceName} required />
          <button class="primary" disabled={busy}>Create workspace</button>
        </form>
      </details>
      {#if workspaces.length}
        <div class="workspace-picker">
          <label for="workspace-picker">Workspace</label>
          <select id="workspace-picker" value={workspaceId} onchange={(event) => chooseWorkspace(event.currentTarget.value)}>
            {#each workspaces as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
          </select>
        </div>
      {/if}
      {#if workspace}
        <div class="workspace-view" aria-label="Workspace view">
          <button type="button" aria-pressed={view === 'chat'} onclick={() => { view = 'chat'; scheduleRead(); }}>Chat</button>
          {#if channel?.kind === 'task'}
            <button type="button" aria-pressed={view === 'tasks'} onclick={() => { view = 'tasks'; }}>Tasks</button>
          {/if}
          <button type="button" aria-pressed={view === 'files'} onclick={() => { view = 'files'; }}>Files</button>
          <button type="button" aria-pressed={view === 'memory'} onclick={() => { view = 'memory'; }}>Memory</button>
          <button type="button" aria-pressed={view === 'knowledge'} onclick={() => { view = 'knowledge'; }}>Knowledge</button>
        </div>
        <nav aria-label="Channels">
          <h2>Channels</h2>
          {#each availableChannels as item (item.id)}
            {@const count = unread[item.id] ?? 0}
            {@const badge = count >= 100 ? '99+' : count}
            <button type="button" class:active={channelId === item.id}
              aria-current={channelId === item.id ? 'true' : undefined}
              aria-label={count ? `${item.name} ${item.kind}, ${badge} unread ${count === 1 ? 'message' : 'messages'}` : undefined} onclick={() => chooseChannel(item.id)}>
              <span>{item.name}</span>
              <small>
                {item.kind}
                {#if count}
                  <span class="unread-count" aria-hidden="true">{badge}</span>
                {/if}
              </small>
            </button>
          {/each}
        </nav>
        {#if workspace.ownerId === profile.id}
          <details bind:this={channelForm}>
            <summary>Create a channel</summary>
            <form onsubmit={createChannel}>
              <label for="channel-name">Channel name</label>
              <input id="channel-name" bind:value={channelName} required />
              <label for="channel-kind">Channel type</label>
              <select id="channel-kind" bind:value={channelKind}>
                <option value="text">Text</option><option value="voice">Voice</option><option value="task">Task</option>
              </select>
              <button class="primary" disabled={busy}>Create channel</button>
            </form>
          </details>
        {/if}
      {/if}
      <div class="account"><strong>{profile.handle}</strong><button type="button" onclick={signOut}>Sign out</button></div>
    </aside>

    <main class="main">
      <div class="connection" role="status">
        <span class:live={status === 'connected'}></span>
        {status === 'connected' ? 'Chat connected' : status === 'connecting' ? 'Connecting to chat' : 'Chat disconnected'}
        {#if status === 'disconnected'}<button type="button" onclick={connect}>Reconnect</button>{/if}
      </div>
      {#if error}<div class="alert" role="alert">{error}</div>{/if}
      {#if workspace && view === 'memory'}
        {#key workspaceId}<WorkspaceMemory {workspaceId} channels={availableChannels} />{/key}
      {:else if workspace && view === 'knowledge'}
        {#key workspaceId}<KnowledgeOverview {workspace} channels={availableChannels} {profile} />{/key}
      {:else if workspace && view === 'files'}
        {#key workspaceId}<WorkspaceFiles {workspaceId} handle={profile.handle} canExport={workspace.ownerId === profile.id} />{/key}
      {:else if view === 'tasks' && channel?.kind === 'task'}
        {#key channelId}<TaskBoard {channelId} name={channel.name} currentUser={profile.id} />{/key}
      {:else if channel}
        {#if channel.kind === 'voice' && workspace}
          {#key channelId}
            <VoiceRoom {channelId} {workspaceId} owner={workspace.ownerId === profile.id} />
          {/key}
        {/if}
        <div class="chat-layout" class:thread-open={root !== null}>
          {#key channelId}
            <Conversation title={channel.name} {messages} currentUser={profile.id} connected={status === 'connected'}
              {openThread} send={(text) => send(text)} onLatestVisible={scheduleRead} />
          {/key}
          {#if root}
            {#key root.id}
              <Conversation title="Thread" messages={[root, ...replies]} currentUser={profile.id} connected={status === 'connected'}
                close={closeThread} send={(text) => root !== null && send(text, root.id)} />
            {/key}
          {/if}
        </div>
      {:else}
        <div class="empty-workspace">
          <h1>{workspace ? workspace.name : 'Your workspaces'}</h1>
          <p>{workspace ? 'Choose a channel or create one to start chatting.' : 'Create a workspace to start chatting.'}</p>
        </div>
      {/if}
    </main>
  </div>
{/if}
