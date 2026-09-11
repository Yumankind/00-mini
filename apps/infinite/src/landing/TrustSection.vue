<script setup lang="ts">
/** `#vault` and `#offline` — what is encrypted, and what is asked of you. Nothing, is the answer. */
import TablerIcon from "../components/TablerIcon.vue";
</script>

<template>
  <div>
    <section id="vault" class="landing-section">
      <p class="landing-eyebrow">Encrypted at rest</p>
      <h2 class="landing-h2">The vault opens with a passkey, or a password.</h2>
      <p class="landing-lead">
        Any key you give the agent — a provider key, a token — is sealed in a vault in this browser.
        It is opened by your passkey or your password, neither of which is stored anywhere, and it
        locks itself again when you stop using it.
      </p>
      <div class="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <article class="landing-card" data-reveal>
          <TablerIcon name="fingerprint" :size="18" class="text-[var(--color-phosphor)]" />
          <h3 class="mt-3 text-[13.5px] font-semibold">A passkey, or a password</h3>
          <p class="mt-1.5 landing-muted text-[13px]">Touch ID where the browser supports it; a password everywhere else.</p>
        </article>
        <article class="landing-card" data-reveal>
          <TablerIcon name="lock" :size="18" class="text-[var(--color-phosphor)]" />
          <h3 class="mt-3 text-[13.5px] font-semibold">It travels only if you say so</h3>
          <p class="mt-1.5 landing-muted text-[13px]">An export leaves the vault behind unless you tick the box that takes it.</p>
        </article>
        <article class="landing-card" data-reveal>
          <TablerIcon name="shield-check" :size="18" class="text-[var(--color-phosphor)]" />
          <h3 class="mt-3 text-[13.5px] font-semibold">Embedded agents have none</h3>
          <p class="mt-1.5 landing-muted text-[13px]">The widget on a website holds no secrets at all. There is nothing in it to take.</p>
        </article>
      </div>
    </section>

    <section id="offline" class="landing-section">
      <p class="landing-eyebrow">No account, and it works offline</p>
      <h2 class="landing-h2">Nothing of ours knows your agent exists.</h2>
      <p class="landing-lead">
        There is no sign-up, no email and no profile. The agent is generated on your first visit, in
        your browser, and after that first load the app opens with the network switched off — the
        things that genuinely need a connection grey out and say which one they wanted.
      </p>
      <ul class="mt-7 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2.5 max-w-3xl">
        <li class="landing-tick"><TablerIcon name="check" :size="14" /> One agent per browser profile.</li>
        <li class="landing-tick"><TablerIcon name="check" :size="14" /> Files, editor, terminal, Git and sessions, all local.</li>
        <li class="landing-tick"><TablerIcon name="check" :size="14" /> A local model answers with no network at all.</li>
        <li class="landing-tick"><TablerIcon name="check" :size="14" /> Nothing is uploaded — not your files, not your chats.</li>
      </ul>
    </section>
  </div>
</template>
