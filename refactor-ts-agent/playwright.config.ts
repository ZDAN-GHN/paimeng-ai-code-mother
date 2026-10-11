import { defineConfig, devices } from '@playwright/test';
export default defineConfig({testDir:'tests/e2e',timeout:60000,expect:{timeout:15000},workers:1,fullyParallel:false,use:{baseURL:process.env.APP_ORIGIN ?? 'http://localhost:3000',trace:'retain-on-failure'},projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],reporter:[['list'],['html',{open:'never'}]]});
