<script setup lang="ts">
import { ref } from 'vue';
import TaskItem from './components/TaskItem.vue';
import { useTasks } from './composables/useTasks';
import type { TaskFilter } from './types/task';

const { tasks, filter, visibleTasks, remaining, storageError, addTask, removeTask } = useTasks();
const title = ref('');
const inputError = ref('');
const filters: { value: TaskFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'active', label: '待完成' },
  { value: 'completed', label: '已完成' },
];

function submit() {
  if (!addTask(title.value)) {
    inputError.value = '请先填写任务内容。';
    return;
  }
  title.value = '';
  inputError.value = '';
}

function toggle(id: string) {
  const task = tasks.value.find(item => item.id === id);
  if (task) task.completed = !task.completed;
}
</script>

<template>
  <main class="task-app">
    <header>
      <p class="eyebrow">把时间留给重要的事</p>
      <h1>今日计划</h1>
      <p class="intro">从一件小事开始，让今天更有条理。</p>
    </header>

    <section class="task-card" aria-label="任务清单">
      <form class="task-form" @submit.prevent="submit">
        <label for="task-title">添加任务</label>
        <div class="input-row">
          <input id="task-title" v-model="title" maxlength="120" placeholder="接下来想做什么？" :aria-invalid="Boolean(inputError)" :aria-describedby="inputError ? 'task-error' : undefined" @input="inputError = ''" />
          <button class="primary-button" type="submit">添加</button>
        </div>
        <p v-if="inputError" id="task-error" class="error" role="alert">{{ inputError }}</p>
      </form>

      <div class="list-toolbar">
        <p class="remaining" role="status">还有 {{ remaining }} 项待完成</p>
        <div class="filters" role="toolbar" aria-label="筛选任务">
          <button v-for="item in filters" :key="item.value" type="button" :aria-pressed="filter === item.value" @click="filter = item.value">{{ item.label }}</button>
        </div>
      </div>

      <ul v-if="visibleTasks.length" class="task-list">
        <TaskItem v-for="task in visibleTasks" :key="task.id" :task="task" @toggle="toggle" @remove="removeTask" />
      </ul>
      <p v-else class="empty-state">{{ filter === 'completed' ? '完成一项任务后，它会出现在这里。' : '这里暂时没有任务，留一点时间给自己。' }}</p>
      <p v-if="storageError" class="error" role="alert">{{ storageError }}</p>
    </section>
    <p class="storage-note">任务保存在当前浏览器中。</p>
  </main>
</template>
