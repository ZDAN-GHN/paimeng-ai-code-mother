import { computed, ref, watch } from 'vue';
import type { Task, TaskFilter } from '../types/task';

const storageKey = 'paimeng-vue-ts-tasks-v1';
const initialTasks: Task[] = [
  { id: 'first', title: '写下今天最想完成的一件事', completed: false },
  { id: 'second', title: '为自己安排一次短暂休息', completed: false },
  { id: 'third', title: '打开你的新应用', completed: true },
];

function loadTasks(): Task[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Array.isArray(saved) && saved.every(task => task && typeof task.id === 'string' && typeof task.title === 'string' && typeof task.completed === 'boolean')) return saved;
  } catch { /* A browser may disable storage or contain an older value. */ }
  return initialTasks.map(task => ({ ...task }));
}

export function useTasks() {
  const tasks = ref<Task[]>(loadTasks());
  const filter = ref<TaskFilter>('all');
  const storageError = ref('');
  const remaining = computed(() => tasks.value.filter(task => !task.completed).length);
  const visibleTasks = computed(() => tasks.value.filter(task => filter.value === 'all' || (filter.value === 'completed' ? task.completed : !task.completed)));

  watch(tasks, value => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
      storageError.value = '';
    } catch {
      storageError.value = '浏览器无法保存任务，关闭页面后本次修改可能丢失。';
    }
  }, { deep: true });

  function addTask(title: string) {
    const text = title.trim();
    if (!text) return false;
    tasks.value.push({ id: crypto.randomUUID(), title: text, completed: false });
    filter.value = 'all';
    return true;
  }

  function removeTask(id: string) {
    tasks.value = tasks.value.filter(task => task.id !== id);
  }

  return { tasks, filter, visibleTasks, remaining, storageError, addTask, removeTask };
}
