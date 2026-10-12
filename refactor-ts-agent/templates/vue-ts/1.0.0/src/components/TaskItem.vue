<script setup lang="ts">
import type { Task } from '../types/task';

defineProps<{ task: Task }>();
const emit = defineEmits<{ toggle: [id: string]; remove: [id: string] }>();
</script>

<template>
  <li class="task-item" :class="{ completed: task.completed }">
    <label class="task-label">
      <input type="checkbox" :checked="task.completed" @change="emit('toggle', task.id)" />
      <span>{{ task.title }}</span>
    </label>
    <button class="remove-button" type="button" :aria-label="`删除任务：${task.title}`" @click="emit('remove', task.id)">删除</button>
  </li>
</template>
