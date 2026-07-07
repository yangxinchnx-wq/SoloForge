<template>
  <div class="post-detail" v-if="post">
    <div class="post-header">
      <h2>{{ post.title }}</h2>
      <div class="post-meta">
        <span>✍️ {{ post.author }}</span>
        <span>📅 {{ post.createdAt }}</span>
      </div>
      <div class="post-tags" v-if="post.tags && post.tags.length">
        <span v-for="tag in post.tags" :key="tag" class="tag">{{ tag }}</span>
      </div>
    </div>
    <div class="post-body">
      <p v-for="(para, i) in paragraphs" :key="i">{{ para }}</p>
    </div>
    <div class="post-actions">
      <router-link :to="`/edit/${post.id}`" class="btn btn-edit">✏️ Edit</router-link>
      <button @click="removePost" class="btn btn-delete">🗑️ Delete</button>
      <router-link to="/" class="btn btn-back">← Back</router-link>
    </div>
  </div>
  <div v-else class="not-found">
    <h2>Post not found</h2>
    <router-link to="/" class="btn btn-back">← Back to Home</router-link>
  </div>
</template>

<script setup>
import { useRoute, useRouter } from 'vue-router'
import { computed } from 'vue'
import { usePostsStore } from '../stores/posts'

const route = useRoute()
const router = useRouter()
const store = usePostsStore()

const post = computed(() => store.getPost(route.params.id))
const paragraphs = computed(() => post.value ? post.value.content.split('\n').filter(p => p.trim()) : [])

function removePost() {
  if (confirm('Are you sure you want to delete this post?')) {
    store.deletePost(post.value.id)
    router.push('/')
  }
}
</script>

<style scoped>
.post-detail {
  background: white;
  border-radius: 8px;
  padding: 32px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.post-header {
  margin-bottom: 24px;
  border-bottom: 1px solid #eee;
  padding-bottom: 16px;
}

.post-header h2 {
  color: #333;
  margin-bottom: 8px;
}

.post-meta {
  display: flex;
  gap: 16px;
  color: #888;
  font-size: 14px;
  margin-bottom: 8px;
}

.post-tags {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}

.tag {
  background-color: #f0f9f4;
  color: #42b883;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 12px;
}

.post-body {
  line-height: 1.8;
  color: #444;
  margin-bottom: 32px;
}

.post-body p {
  margin-bottom: 16px;
}

.post-actions {
  display: flex;
  gap: 12px;
  padding-top: 16px;
  border-top: 1px solid #eee;
}

.btn {
  display: inline-block;
  padding: 8px 20px;
  border-radius: 6px;
  text-decoration: none;
  font-weight: 500;
  font-size: 14px;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-edit {
  background-color: #3498db;
  color: white;
}

.btn-edit:hover {
  background-color: #2980b9;
}

.btn-delete {
  background-color: #e74c3c;
  color: white;
}

.btn-delete:hover {
  background-color: #c0392b;
}

.btn-back {
  background-color: #eee;
  color: #666;
  margin-left: auto;
}

.btn-back:hover {
  background-color: #ddd;
}

.not-found {
  background: white;
  border-radius: 8px;
  padding: 48px;
  text-align: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.not-found h2 {
  color: #999;
  margin-bottom: 16px;
}
</style>
