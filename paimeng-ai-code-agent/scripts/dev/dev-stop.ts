import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

type DevState = {
  parentPid: number;
  startedAt: string;
  children: { label: string; pid: number }[];
};

const root = resolve(import.meta.dirname, '../..');
const statePath = join(root, 'runtime', 'dev-processes.json');
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function signalGroup(pid: number, value: NodeJS.Signals): void {
  try { process.kill(-pid, value); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function commandsInGroup(groupId: number): string[] {
  try {
    const output = execFileSync('ps', ['-eo', 'pgid=,command='], { encoding: 'utf8' });
    return output.split('\n').flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      return match && Number(match[1]) === groupId ? [match[2]] : [];
    });
  } catch {
    return [];
  }
}

function isProjectProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    if (realpathSync(`/proc/${pid}/cwd`) === root) return true;
  } catch {
  }
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes(root);
  } catch {
    return false;
  }
}

function isProjectGroup(pid: number): boolean {
  if (!groupAlive(pid)) return false;
  const commands = commandsInGroup(pid);
  return commands.some((command) => command.includes(root) || command.includes('paimeng-ai-code-agent'));
}

function removeState(): void {
  try { unlinkSync(statePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`无法删除 ${statePath}：${(error as Error).message}`);
  }
}

if (!existsSync(statePath)) {
  console.log('没有发现开发进程记录；如果端口仍被占用，请手动检查占用进程。');
  process.exit(0);
}

let state: DevState;
try {
  state = JSON.parse(readFileSync(statePath, 'utf8')) as DevState;
} catch (error) {
  console.error(`无法读取 ${statePath}：${(error as Error).message}`);
  process.exit(1);
}

const parentPid = Number(state.parentPid);
const groups = (state.children ?? []).map((child) => child.pid).filter((pid) => Number.isInteger(pid) && pid > 0);
console.log(`上次开发进程启动于 ${state.startedAt}；父进程 ${parentPid}，子进程组 ${groups.join(', ') || '无'}`);

if (isProjectProcess(parentPid)) {
  try {
    process.kill(parentPid, 'SIGTERM');
    console.log(`已通知父进程 ${parentPid} 退出`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

const groupsToStop = groups.filter(isProjectGroup);
for (const pid of groupsToStop) signalGroup(pid, 'SIGTERM');
if (groupsToStop.length > 0) console.log(`已通知进程组 ${groupsToStop.join(', ')} 退出`);

const deadline = Date.now() + 5000;
while (groupsToStop.some(groupAlive) && Date.now() < deadline) await delay(100);

for (const pid of groupsToStop) {
  if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
}
if (isProjectProcess(parentPid)) {
  try { process.kill(parentPid, 'SIGKILL'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

const survivors = groupsToStop.filter(groupAlive);
removeState();
if (survivors.length > 0) {
  console.error(`仍有进程组未退出：${survivors.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('开发进程已清理。');
}
