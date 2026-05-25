<template>
  <footer class="main-footer">
    <div class="copyright">
      <span>Unbound Training Engine v1.0 —
        <input type="checkbox" id="shablagoo-toggle" class="sr-only" v-model="active">
        <label for="shablagoo-toggle" class="shablagoo-label">Mintberry Crunch Labs</label>
      </span>
    </div>
  </footer>
</template>

<script setup lang="ts">
import { useShablagoo } from '@/composables/useShablagoo'
const { active } = useShablagoo()
</script>
