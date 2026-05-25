<template>
  <div class="toast" :class="[toast.type, { removing: toast.removing }]" @click="dismiss(toast.id)">
    <i class="fa-solid toast-icon" :class="iconClass"></i>
    <div class="toast-body">
      <div class="toast-title">{{ toast.title }}</div>
      <div v-if="toast.msg" class="toast-msg">{{ toast.msg }}</div>
    </div>
    <button type="button" class="toast-close" @click.stop="dismiss(toast.id)">
      <i class="fa-solid fa-xmark"></i>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useToast, type ToastItem } from '@/composables/useToast'

const props = defineProps<{ toast: ToastItem }>()
const { dismiss } = useToast()

const iconClass = computed(() => ({
  'fa-circle-check':        props.toast.type === 'success',
  'fa-circle-xmark':        props.toast.type === 'error',
  'fa-circle-info':         props.toast.type === 'info',
  'fa-triangle-exclamation': props.toast.type === 'warn'
}))
</script>
