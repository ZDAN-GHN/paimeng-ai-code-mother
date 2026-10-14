<template>
  <a-layout id="basicLayout">
    <!-- 顶部导航栏 -->
    <GlobalHeader class="header" />
    <!-- 主要内容区域 -->
    <a-layout-content class="content">
      <router-view />
    </a-layout-content>
    <!-- 底部版权信息 -->
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
/* 页面主体 */
#basicLayout .content {
  width: 100%;
  padding: 0;
  background: none;
  margin: 0;
}
/* 页脚 */
#basicLayout .footer {
  padding: 16px;
  bottom: 0;
  left: 0;
  right: 0;
  text-align: center;
}
</style>
