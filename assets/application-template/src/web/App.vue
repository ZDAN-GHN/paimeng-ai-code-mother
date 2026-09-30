<script setup lang="ts">
import { onMounted, ref } from 'vue'

type Item = { id: number; title: string; createdAt: string }
const items = ref<Item[]>([])
const title = ref('')
const pending = ref(false)
const error = ref('')
const apiUrl = `${import.meta.env.BASE_URL}api/items`

function isItem(value: unknown): value is Item {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'number'
    && 'title' in value && typeof value.title === 'string'
    && 'createdAt' in value && typeof value.createdAt === 'string'
}

async function loadItems() {
  try {
    error.value = ''
    const response = await fetch(apiUrl)
    if (!response.ok) throw new Error('Unable to load items')
    const data: unknown = await response.json()
    if (!Array.isArray(data) || !data.every(isItem)) throw new Error('Invalid server response')
    items.value = data
  } catch {
    error.value = 'Unable to load items. Please try again.'
  }
}

async function addItem() {
  const value = title.value.trim()
  if (!value || pending.value) return
  pending.value = true
  error.value = ''
  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: value }),
    })
    if (!response.ok) throw new Error('Unable to add item')
    title.value = ''
    await loadItems()
  } catch {
    error.value = 'Unable to add item. Please try again.'
  } finally {
    pending.value = false
  }
}

onMounted(loadItems)
</script>

<template>
  <main class="page">
    <header class="page-header"><h1>Items</h1><span>{{ items.length }} total</span></header>
    <form class="entry" @submit.prevent="addItem">
      <label for="item-title">New item</label>
      <div class="entry-row">
        <input id="item-title" v-model="title" maxlength="191" autocomplete="off" placeholder="Enter a title" />
        <button type="submit" :disabled="!title.trim() || pending">{{ pending ? 'Adding...' : 'Add item' }}</button>
      </div>
    </form>
    <p v-if="error" role="alert" class="error">{{ error }} <button type="button" @click="loadItems">Retry</button></p>
    <ul v-if="items.length" class="list">
      <li v-for="item in items" :key="item.id"><span>{{ item.title }}</span><time :datetime="item.createdAt">{{ new Date(item.createdAt).toLocaleDateString() }}</time></li>
    </ul>
    <p v-else-if="!error" class="empty">No items yet.</p>
  </main>
</template>
