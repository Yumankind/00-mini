<script setup lang="ts">
/**
 * `#brains` — the models we serve, the roads to a stronger one, and the licences, named before the
 * download rather than after it: Gemma's terms bind the person who runs the weights.
 */
import { GEMMA_NOTICE_URL, GEMMA_TERMS_URL, MODELS } from "./sections.js";
</script>

<template>
  <section id="brains" class="landing-section">
    <p class="landing-eyebrow">The brains</p>
    <h2 class="landing-h2">On your own GPU, or on a key you already have.</h2>
    <p class="landing-lead">
      The models below run on this device through Google's LiteRT runtime, mirrored on our own bucket
      with a checksum for every file. The download is the only cost, and nothing you type leaves the
      machine. When you want something bigger, the same composer takes sponsored answers or your own
      provider key.
    </p>

    <div class="landing-table-wrap mt-8" data-reveal>
      <table class="landing-table">
        <thead>
          <tr>
            <th>Model</th>
            <th>Size</th>
            <th>What it is for</th>
            <th>Licence</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="model in MODELS" :key="model.name">
            <td class="whitespace-nowrap">
              {{ model.name }}
              <span v-if="model.vision" class="landing-tag">vision</span>
            </td>
            <td class="font-mono text-[12px] whitespace-nowrap landing-muted">{{ model.size }}</td>
            <td class="landing-muted">{{ model.role }}</td>
            <td class="whitespace-nowrap">
              <a
                v-if="model.gemma"
                :href="GEMMA_TERMS_URL"
                target="_blank"
                rel="noopener noreferrer"
                class="font-mono text-[12px] text-[var(--color-amber)] hover:underline"
                >{{ model.licence }}</a
              >
              <span v-else class="font-mono text-[12px] landing-muted">{{ model.licence }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="landing-foot mt-5 max-w-3xl">
      The Gemma 4 rows are Apache-2.0. The Gemma 3 and Gemma 3n rows are provided under and subject to
      the <a :href="GEMMA_TERMS_URL" target="_blank" rel="noopener noreferrer">Gemma Terms of Use</a>,
      with the <a :href="GEMMA_NOTICE_URL" target="_blank" rel="noopener noreferrer">NOTICE</a> beside
      the files. Nothing is modified; both are shown before a download starts.
    </p>

    <div class="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3.5">
      <article class="landing-card" data-reveal>
        <h3 class="text-[13.5px] font-semibold">Sponsored answers</h3>
        <p class="mt-1.5 landing-muted text-[13px] leading-relaxed">
          A stronger brain paid for by a sponsor, with the sponsor named in a line under the answer.
          A passkey, no email. This road needs our side switched on, and it is not live yet.
        </p>
      </article>
      <article class="landing-card" data-reveal>
        <h3 class="text-[13.5px] font-semibold">Your own keys</h3>
        <p class="mt-1.5 landing-muted text-[13px] leading-relaxed">
          Paste an OpenAI, Anthropic or OpenRouter key — or point it at your own endpoint — and it is
          sealed in the vault. The composer's chip always says which brain is about to answer.
        </p>
      </article>
    </div>
  </section>
</template>
