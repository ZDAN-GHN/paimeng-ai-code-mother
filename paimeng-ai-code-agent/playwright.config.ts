import { defineConfig, devices } from '@playwright/test';
import { appOrigin } from './tests/e2e/support/app-origin';
export default defineConfig({testDir:'tests/e2e',globalSetup:'./tests/e2e/support/require-server.ts',timeout:60000,expect:{timeout:15000},workers:1,fullyParallel:false,use:{baseURL:appOrigin(),trace:'retain-on-failure'},projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}],reporter:[['list'],['html',{open:'never'}]]});
