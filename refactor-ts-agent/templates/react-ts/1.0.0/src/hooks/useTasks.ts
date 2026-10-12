import { useEffect, useMemo, useState } from 'react';
import type { Task, TaskFilter } from '../types/task';

const storageKey = 'paimeng-react-ts-tasks-v1';
const initialTasks: Task[] = [
  { id: 'first', title: '写下今天最想完成的一件事', completed: false },
  { id: 'second', title: '为自己安排一次短暂休息', completed: false },
  { id: 'third', title: '打开你的新应用', completed: true },
];

function isTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<Task>;
  return typeof task.id === 'string' && typeof task.title === 'string' && typeof task.completed === 'boolean';
}

function loadTasks(): Task[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Array.isArray(saved) && saved.every(isTask)) return saved;
  } catch { /* A browser may disable storage or contain an older value. */ }
  return initialTasks.map(task => ({ ...task }));
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>(loadTasks);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [storageError, setStorageError] = useState('');
  const remaining = useMemo(() => tasks.filter(task => !task.completed).length, [tasks]);
  const visibleTasks = useMemo(() => tasks.filter(task => filter === 'all' || (filter === 'completed' ? task.completed : !task.completed)), [tasks, filter]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(tasks));
      setStorageError('');
    } catch {
      setStorageError('浏览器无法保存任务，关闭页面后本次修改可能丢失。');
    }
  }, [tasks]);

  function addTask(title: string) {
    const text = title.trim();
    if (!text) return false;
    setTasks(current => [...current, { id: crypto.randomUUID(), title: text, completed: false }]);
    setFilter('all');
    return true;
  }

  function toggleTask(id: string) {
    setTasks(current => current.map(task => (task.id === id ? { ...task, completed: !task.completed } : task)));
  }

  function removeTask(id: string) {
    setTasks(current => current.filter(task => task.id !== id));
  }

  return { filter, setFilter, visibleTasks, remaining, storageError, addTask, toggleTask, removeTask };
}
