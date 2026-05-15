<template>
  <RouterView />
  <Toast position="bottom-right" />
</template>

<script setup lang="ts">
import Toast from 'primevue/toast'
import { useSocket } from '@/composables/useSocket'
import { onMounted } from 'vue'

const { connect } = useSocket()
onMounted(() => connect())
</script>
