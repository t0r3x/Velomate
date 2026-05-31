<template>
  <div class="goals-input-section">
    <div class="goals-header">
      <i class="fa-solid fa-bullseye"></i>
      <span class="goals-title">Goals &amp; preferences</span>
    </div>
    <p class="goals-hint">
      Share your goals, events, or constraints — e.g. "race in 8 weeks, 100 km ride in 8 weeks, no riding on Sundays, long rides max 2.5 h." The AI uses this as secondary input alongside your actual training data.
    </p>
    <textarea
      v-model="text"
      class="goals-textarea"
      placeholder="e.g. race in 6 weeks, 100 km ride in 8 weeks, no riding on Sundays…"
      maxlength="500"
      rows="3"
      @keydown.ctrl.enter="handleSave"
      @keydown.meta.enter="handleSave"
    ></textarea>
    <div class="goals-footer">
      <span class="goals-char-count" :class="{ 'goals-char-warn': text.length > 450 }">{{ text.length }}/500</span>
      <button
        class="btn btn-secondary btn-sm"
        :disabled="saving || text === savedText"
        @click="handleSave"
      >
        <span>{{ flash ? 'Saved' : 'Save' }}</span>
        <i class="fa-solid" :class="saving ? 'fa-spinner fa-spin' : flash ? 'fa-check' : 'fa-floppy-disk'"></i>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { getTrainingGoals, postTrainingGoals } from '@/api/client'

const text      = ref('')
const savedText = ref('')
const saving    = ref(false)
const flash     = ref(false)

onMounted(async () => {
  try {
    const data = await getTrainingGoals()
    text.value      = data.goals
    savedText.value = data.goals
  } catch { /* non-fatal — start empty */ }
})

async function handleSave() {
  if (saving.value || text.value === savedText.value) return
  saving.value = true
  try {
    await postTrainingGoals(text.value)
    savedText.value = text.value
    flash.value = true
    setTimeout(() => { flash.value = false }, 2000)
  } catch { /* ignore — user can retry */ }
  saving.value = false
}
</script>
