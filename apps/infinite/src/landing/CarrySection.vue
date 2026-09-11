<script setup lang="ts">
/**
 * `#mobile`, `#file`, `#qr` — the three halves of "it is yours and it travels".
 *
 * They are one section with three anchors because they are one argument: the agent is a file, the
 * file moves, and the phone is just another place it runs. The QR half says out loud which road is
 * live — the file road — and which one lights up when the relay is on (§7, live transfer).
 */
import TablerIcon from "../components/TablerIcon.vue";
</script>

<template>
  <div>
    <section id="mobile" class="landing-section">
      <p class="landing-eyebrow">It works on your phone</p>
      <h2 class="landing-h2">The same agent, in your pocket.</h2>
      <p class="landing-lead">
        It is a web app, so the phone needs nothing from a store. Add it to the home screen and it
        opens like anything else you installed — full screen, offline, with its own storage that the
        browser stops evicting once it is installed.
      </p>
      <div class="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <article class="landing-card" data-reveal>
          <TablerIcon name="device-laptop" :size="18" class="text-[var(--color-phosphor)]" />
          <h3 class="mt-3 text-[13.5px] font-semibold">One layout, two widths</h3>
          <p class="mt-1.5 landing-muted text-[13px]">The rail becomes a drawer and the tabs move to where a thumb is. No second app.</p>
        </article>
        <article class="landing-card" data-reveal>
          <TablerIcon name="download" :size="18" class="text-[var(--color-phosphor)]" />
          <h3 class="mt-3 text-[13.5px] font-semibold">Install as a PWA</h3>
          <p class="mt-1.5 landing-muted text-[13px]">Add to home screen on iOS or Android. It asks once, and never nags again.</p>
        </article>
        <article class="landing-card" data-reveal>
          <TablerIcon name="cpu" :size="18" class="text-[var(--color-phosphor)]" />
          <h3 class="mt-3 text-[13.5px] font-semibold">Small brains for small machines</h3>
          <p class="mt-1.5 landing-muted text-[13px]">A phone gets the 0.25 GB model, or answers from a brain you already pay for.</p>
        </article>
      </div>
    </section>

    <section id="file" class="landing-section">
      <p class="landing-eyebrow">The whole agent is one file</p>
      <h2 class="landing-h2">Download it. That is the backup.</h2>
      <p class="landing-lead">
        Everything the agent is — its files, its memory, its sessions, its identity — exports as one
        encrypted <code>.00agent</code>. You get a six-word code with it, and the code is never in a
        URL and never sent anywhere.
      </p>
      <div class="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <article class="landing-card" data-reveal>
          <TablerIcon name="file-text" :size="18" class="text-[var(--color-phosphor)]" />
          <h3 class="mt-3 text-[13.5px] font-semibold">Back up and restore</h3>
          <p class="mt-1.5 landing-muted text-[13px] leading-relaxed">
            Save the file where you keep things you would miss. Importing it into any browser brings
            the agent back exactly as it was, with the same name and the same memory.
          </p>
        </article>
        <article class="landing-card" data-reveal>
          <TablerIcon name="device-desktop" :size="18" class="text-[var(--color-phosphor)]" />
          <h3 class="mt-3 text-[13.5px] font-semibold">Move it to the Mac app</h3>
          <p class="mt-1.5 landing-muted text-[13px] leading-relaxed">
            The same bundle every 00 engine speaks. Open it in the 00 Mac app, give it the six words,
            and the agent carries on there. One live residence: the side you left keeps a receipt.
          </p>
        </article>
      </div>
    </section>

    <section id="qr" class="landing-section">
      <p class="landing-eyebrow">Bring it with you</p>
      <h2 class="landing-h2">Scan a code, and it is on the other device.</h2>
      <p class="landing-lead">
        The app shows a QR code that opens the receive flow on your phone, with the six words already
        in hand. Today that hand-over runs over the file: the phone receives the
        <code>.00agent</code> and unlocks it with the code.
      </p>
      <p class="landing-foot mt-5">
        The live hand-over — both devices online, no file in between — is built and waiting on the
        relay; it lights up the day that relay is switched on. The file road works now.
      </p>
    </section>
  </div>
</template>
