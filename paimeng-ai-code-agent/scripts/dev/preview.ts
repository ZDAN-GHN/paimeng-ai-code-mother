import { getConfig } from '../../src/server/config';
import { createPreviewServer } from '../../src/server/preview';
const origin = new URL(getConfig().previewOrigin);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error('本地预览服务只绑定回环主机');
const server = await createPreviewServer();
server.listen(Number(origin.port) || 3001, origin.hostname, () => console.log(`隔离预览 ${origin.origin}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => server.close(() => process.exit(0)));
