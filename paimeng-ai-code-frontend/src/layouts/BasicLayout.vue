<template>
  <a-layout id="basicLayout">
    <GlobalHeader class="header" />

    <a-layout-content class="content">
      <router-view />
    </a-layout-content>

    <GlobalFooter class="footer" />
  </a-layout>
</template>

<script setup lang="ts">
import GlobalHeader from '@/components/GlobalHeader.vue'
import GlobalFooter from '@/components/GlobalFooter.vue'
</script>

<style scoped>
#basicLayout {
  background: none;
}

#basicLayout .header {
  background: white;
  color: unset;
  padding-inline: 20px;
  margin-bottom: 1px;
}

#basicLayout .content {
  width: 100%;
  padding: 0;
  background: none;
  margin: 0;
}

#basicLayout .footer {
  padding: 16px;
  bottom: 0;
  left: 0;
  right: 0;
  text-align: center;
}
</style>
