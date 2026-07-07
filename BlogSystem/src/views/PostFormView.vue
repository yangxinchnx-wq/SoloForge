<template>
  <div class="post-form-view">
    <h2>{{ isEdit ? '✏️ Edit Post' : '📝 New Post' }}</h2>
    <form @submit.prevent="handleSubmit" class="post-form">
      <div class="form-group">
        <label for="title">Title</label>
        <input
          id="title"
          v-model="form.title"
          type="text"
          placeholder="Enter post title..."
          required
        />
      </div>
      <div class="form-group">
        <label for="author">Author</label>
        <input
          id="author"
          v-model="form.author"
          type="text"
          placeholder="Author name..."
          required
        />
      </div>
      <div class="form-group">
        <label for="tags">Tags (comma separated)</label>
        <input
          id="tags"
          v-model="tagsInput"
          type="text"
          placeholder="e.g. vue, javascript, tutorial"
        />
      </div>
      <div class="form-group">
        <label for="content">Content</label>
        <textarea
          id="content"
          v-model="form.content"
          placeholder="Write your post content..."
          rows="12"
          required
        ></textarea>
      </div>
      <div class="form-actions">
        <button type="submit" class="btn btn-primary">
          {{ isEdit ? 'Update Post' : 'Create Post' }}
        </button>
        <router-link to="/" class="btn btn-cancel">Cancel</router-link>
      </div>
    </form>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { usePostsStore } from '../stores/posts'

const route = useRoute()
const router = useRouter()
const store = usePostsStore()

const isEdit = ref(false)
const tagsInput = ref('')
const form = reactive({
  title: '',
  author: '',
  content: ''
})

onMounted(() => {
  if (route.params.id) {
    isEdit.value = true
    const post = store.getPost(route.params.id)
    if (post) {
      form.title = post.title
      form.author = post.author
      form.content = post.content
      tagsInput.value = post.tags ? post.tags.join(', ') : ''
    }
  }
})

function handleSubmit() {
  const tags = tagsInput.value
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length > 0)

  if (isEdit.value) {
    store.updatePost(Number(route.params.id), {
      title: form.title,
      author: form.author,
      content: form.content,
      tags
    })
    router.push(`/post/${route.params.id}`)
  } else {
    store.addPost({
      title: form.title,
      author: form.author,
      content: form.content,
      tags
    })
    router.push('/')
  }
}
</script>

<style scoped>
.post-form-view {
  background: white;
  border-radius: 8px;
  padding: 32px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.post-form-view h2 {
  color: #42b883;
  margin-bottom: 24px;
}

.form-group {
  margin-bottom: 20px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  color: #555;
  font-size: 14px;
}

.form-group input,
.form-group textarea {
  width: 100%;
  padding: 10px 14px;
  border: 1px solid #ddd;
  border-radius: 6px;
  font-size: 15px;
  font-family: inherit;
  transition: border-color 0.2s;
}

.form-group input:focus,
.form-group textarea:focus {
  outline: none;
  border-color: #42b883;
  box-shadow: 0 0 0 3px rgba(66, 184, 131, 0.1);
}

.form-group textarea {
  resize: vertical;
  min-height: 200px;
}

.form-actions {
  display: flex;
  gap: 12px;
}

.btn {
  display: inline-block;
  padding: 10px 24px;
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

.btn-cancel {
  background-color: #eee;
  color: #666;
}

.btn-cancel:hover {
  background-color: #ddd;
}
</style>
