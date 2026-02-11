<script setup lang="ts">
import { ConfigProvider, theme as antdTheme } from 'ant-design-vue'
import BasicLayout from './layouts/BasicLayout.vue'
import { onMounted } from 'vue'
import { useLoginUserStore } from '@/stores/loginUser.ts'

const customTheme = {
  algorithm: antdTheme.defaultAlgorithm,
  token: {
    colorPrimary: '#cb573e',
    colorInfo: '#cb573e',
  },
}
// 项目加载的时候默认出用户
onMounted(() => {
  useLoginUserStore().fetchLoginUser()
})
</script>

<template>
  <div id="app">
    <ConfigProvider :theme="customTheme">
      <BasicLayout />
    </ConfigProvider>
  </div>
</template>

<style>
/* 全局样式优化 */
* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell',
    'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  overflow-x: hidden;
}

html {
  overflow-x: hidden;
}
</style>
