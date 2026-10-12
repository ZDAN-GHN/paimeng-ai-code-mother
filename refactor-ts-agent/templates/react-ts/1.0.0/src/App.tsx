import { type FormEvent, useState } from 'react';
import TaskItem from './components/TaskItem';
import { useTasks } from './hooks/useTasks';
import type { TaskFilter } from './types/task';

const filters: { value: TaskFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '待完成' },
  { value: 'completed', label: '已完成' },
];

export default function App() {
  const { filter, setFilter, visibleTasks, remaining, storageError, addTask, toggleTask, removeTask } = useTasks();
  const [title, setTitle] = useState('');
  const [inputError, setInputError] = useState('');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!addTask(title)) {
      setInputError('请先填写任务内容。');
      return;
    }
    setTitle('');
    setInputError('');
  }

  return (
    <main className="task-app">
      <header>
        <p className="eyebrow">把时间留给重要的事</p>
        <h1>今日计划</h1>
        <p className="intro">从一件小事开始，让今天更有条理。</p>
      </header>

      <section className="task-card" aria-label="任务清单">
        <form className="task-form" onSubmit={submit}>
          <label htmlFor="task-title">添加任务</label>
          <div className="input-row">
            <input id="task-title" value={title} maxLength={120} placeholder="接下来想做什么？" aria-invalid={Boolean(inputError)} aria-describedby={inputError ? 'task-error' : undefined} onChange={event => { setTitle(event.target.value); setInputError(''); }} />
            <button className="primary-button" type="submit">添加</button>
          </div>
          {inputError ? <p id="task-error" className="error" role="alert">{inputError}</p> : null}
        </form>

        <div className="list-toolbar">
          <p className="remaining" role="status">还有 {remaining} 项待完成</p>
          <div className="filters" role="toolbar" aria-label="筛选任务">
            {filters.map(item => <button key={item.value} type="button" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}
          </div>
        </div>

        {visibleTasks.length ? (
          <ul className="task-list">
            {visibleTasks.map(task => <TaskItem key={task.id} task={task} onToggle={toggleTask} onRemove={removeTask} />)}
          </ul>
        ) : <p className="empty-state">{filter === 'completed' ? '完成一项任务后，它会出现在这里。' : '这里暂时没有任务，留一点时间给自己。'}</p>}
        {storageError ? <p className="error" role="alert">{storageError}</p> : null}
      </section>
      <p className="storage-note">任务保存在当前浏览器中。</p>
    </main>
  );
}
