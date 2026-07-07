<template>
  <div id="blog-app">
    <header class="app-header">
      <h1>📝 Blog System</h1>
      <nav>
        <router-link to="/">Home</router-link>
      </nav>
    </header>
    <main class="app-main">
      <router-view />
    </main>
    <footer class="app-footer">
      <p>&copy; 2024 Blog System. Built with Vue 3.</p>
    </footer>
  </div>
</template>

<script setup>
// App root component
</script>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background-color: #f5f5f5;
  color: #333;
}

.app-header {
  background-color: #42b883;
  color: white;
  padding: 16px 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.app-header h1 {
  font-size: 24px;
}

.app-header nav a {
  color: white;
  text-decoration: none;
  font-weight: 500;
  margin-left: 16px;
}

.app-header nav a:hover {
  text-decoration: underline;
}

.app-main {
  max-width: 960px;
  margin: 24px auto;
  padding: 0 16px;
}

.app-footer {
  text-align: center;
  padding: 16px;
  color: #999;
  font-size: 14px;
}
</style>
