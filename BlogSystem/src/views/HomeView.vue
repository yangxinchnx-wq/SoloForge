<template>
  <div class="home-view">
    <div class="home-header">
      <h2>📋 All Posts</h2>
      <router-link to="/new" class="btn btn-primary">+ New Post</router-link>
    </div>

    <div v-if="posts.length === 0" class="empty-state">
      <p>No posts yet. Create your first post!</p>
    </div>

    <div class="posts-grid">
      <div v-for="post in posts" :key="post.id" class="post-card">
        <div class="post-card-header">
          <h3>
            <router-link :to="`/post/${post.id}`">{{ post.title }}</router-link>
          </h3>
          <span class="post-date">{{ post.createdAt }}</span>
        </div>
        <p class="post-excerpt">{{ excerpt(post.content) }}</p>
        <div class="post-card-footer">
          <span class="post-author">✍️ {{ post.author }}</span>
          <div class="post-tags">
            <span v-for="tag in post.tags" :key="tag" class="tag">{{ tag }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { usePostsStore } from '../stores/posts'
import { computed } from 'vue'

const store = usePostsStore()
const posts = computed(() => store.posts)

function excerpt(content, length = 120) {
  if (content.length <= length) return content
  return content.substring(0, length) + '...'
}
</script>

<style scoped>
.home-view {
  background: white;
  border-radius: 8px;
  padding: 32px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.home-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.home-header h2 {
  color: #42b883;
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

.btn-primary {
  background-color: #42b883;
  color: white;
}

.btn-primary:hover {
  background-color: #369970;
}

.empty-state {
  text-align: center;
  padding: 48px;
  color: #999;
}

.posts-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.post-card {
  border: 1px solid #eee;
  border-radius: 8px;
  padding: 20px;
  transition: box-shadow 0.2s;
}

.post-card:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.post-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}

.post-card-header h3 a {
  color: #333;
  text-decoration: none;
}

.post-card-header h3 a:hover {
  color: #42b883;
}

.post-date {
  color: #999;
  font-size: 13px;
  white-space: nowrap;
}

.post-excerpt {
  color: #666;
  line-height: 1.6;
  margin-bottom: 12px;
}

.post-card-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.post-author {
  font-size: 13px;
  color: #888;
}

.post-tags {
  display: flex;
  gap: 6px;
}

.tag {
  background-color: #f0f9f4;
  color: #42b883;
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 12px;
}
</style>
