import { defineStore } from 'pinia'
import { ref } from 'vue'

export const usePostsStore = defineStore('posts', () => {
  const posts = ref([
    {
      id: 1,
      title: 'Getting Started with Vue 3',
      content: 'Vue 3 is a progressive JavaScript framework for building user interfaces. It features a Composition API, better TypeScript support, and improved performance compared to Vue 2.\n\nIn this article, we\'ll explore the core concepts of Vue 3 and how to get started with your first project.',
      author: 'Admin',
      createdAt: '2024-01-15',
      tags: ['vue', 'javascript', 'frontend']
    },
    {
      id: 2,
      title: 'Understanding Pinia State Management',
      content: 'Pinia is the official state management library for Vue. It provides a simple, type-safe API for managing application state.\n\nKey features include:\n- Intuitive API\n- DevTools support\n- Hot module replacement\n- TypeScript support\n- Server-side rendering',
      author: 'Admin',
      createdAt: '2024-01-20',
      tags: ['vue', 'pinia', 'state-management']
    },
    {
      id: 3,
      title: 'Vue Router Deep Dive',
      content: 'Vue Router is the official router for Vue.js. It makes building Single Page Applications easy with its component-based routing system.\n\nAdvanced features include navigation guards, route matching, and dynamic route matching.',
      author: 'Admin',
      createdAt: '2024-02-01',
      tags: ['vue', 'router', 'spa']
    }
  ])

  let nextId = 4

  function addPost(post) {
    posts.value.unshift({
      ...post,
      id: nextId++,
      createdAt: new Date().toISOString().split('T')[0]
    })
  }

  function updatePost(id, updates) {
    const index = posts.value.findIndex(p => p.id === id)
    if (index !== -1) {
      posts.value[index] = { ...posts.value[index], ...updates }
    }
  }

  function deletePost(id) {
    posts.value = posts.value.filter(p => p.id !== id)
  }

  function getPost(id) {
    return posts.value.find(p => p.id === Number(id))
  }

  return { posts, addPost, updatePost, deletePost, getPost }
})
