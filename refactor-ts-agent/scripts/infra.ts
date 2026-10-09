import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
await mkdir('runtime', { recursive: true });
const child = spawn('docker', ['compose', '--env-file', '.env', '-f', 'compose.yaml', 'up', '-d', '--wait'], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
