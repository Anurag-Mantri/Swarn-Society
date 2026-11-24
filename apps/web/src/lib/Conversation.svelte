<script lang="ts">
  import type { Message } from './api';

  let { title, messages, connected, currentUser, openThread, close, send }:
    {
      title: string;
      messages: Message[];
      connected: boolean;
      currentUser: string;
      openThread?: (message: Message) => void;
      close?: () => void;
      send: (text: string) => boolean;
    } = $props();

  let draft = $state('');
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (text && send(text)) draft = '';
  }
</script>

<section class="conversation" aria-label={title}>
  <header>
    <h1>{title}</h1>
    {#if close}<button type="button" onclick={close}>Close</button>{/if}
  </header>
  <div class="messages">
    {#if messages.length === 0}
      <p class="empty">Start the conversation.</p>
    {/if}
    {#each messages as message (message.id)}
      <article>
        <div class="byline">
          <strong>{message.authorId === currentUser ? 'You' : message.authorKind === 'agent' ? message.authorId : message.authorKind === 'system' ? 'System' : 'Teammate'}</strong>
          <time datetime={message.createdAt}>{time.format(new Date(message.createdAt))}</time>
          {#if openThread}
            <button type="button" onclick={() => openThread?.(message)}>Thread</button>
          {/if}
        </div>
        <p>{message.body}</p>
      </article>
    {/each}
  </div>
  <form onsubmit={submit}>
    <label for={close ? 'thread-draft' : 'channel-draft'}>Message</label>
    <textarea id={close ? 'thread-draft' : 'channel-draft'} maxlength="4000" bind:value={draft} rows="2"></textarea>
    <button class="primary" disabled={!connected || !draft.trim()}>Send</button>
  </form>
</section>

<style>
  .conversation { display: grid; grid-template-rows: auto 1fr auto; min-width: 0; min-height: 26rem; height: 100%; }
  header { display: flex; align-items: center; justify-content: space-between; gap: .5rem; border-bottom: 1px solid var(--line); padding: 1rem 1.25rem; }
  h1 { margin: 0; font-size: 1.15rem; overflow-wrap: anywhere; }
  .messages { overflow: auto; padding: 1rem 1.25rem; }
  article { padding: .85rem 0; border-bottom: 1px solid var(--line); }
  article:last-child { border-bottom: 0; }
  .byline { display: flex; flex-wrap: wrap; gap: .65rem; align-items: center; }
  .byline button, time { color: var(--muted); font-size: .85rem; }
  article p { white-space: pre-wrap; overflow-wrap: anywhere; margin: .4rem 0 0; }
  .empty { color: var(--muted); }
  form { display: grid; gap: .5rem; padding: .9rem 1.25rem; border-top: 1px solid var(--line); }
  form button { justify-self: end; }
</style>
