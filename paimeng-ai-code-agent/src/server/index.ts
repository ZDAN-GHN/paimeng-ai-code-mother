import { loadConfig } from './config.js'
import { startProductionServer } from './runtime.js'

const config = loadConfig()

void startProductionServer(config).catch((err) => {
  console.error('[server] startup failed', err)
})
