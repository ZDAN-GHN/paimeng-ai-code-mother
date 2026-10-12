import type { Task } from '../types/task';

export default function TaskItem({ task, onToggle, onRemove }: { task: Task; onToggle: (id: string) => void; onRemove: (id: string) => void }) {
  return (
    <li className={task.completed ? 'task-item completed' : 'task-item'}>
      <label className="task-label">
        <input type="checkbox" checked={task.completed} onChange={() => onToggle(task.id)} />
        <span>{task.title}</span>
      </label>
      <button className="remove-button" type="button" aria-label={`删除任务：${task.title}`} onClick={() => onRemove(task.id)}>删除</button>
    </li>
  );
}
