function test() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  .panel {
    width:100%;
  }
</style></head>
<body><div class="panel" id="app"></div>
<script>
  document.addEventListener('keydown', e => { if (e.key === 'Escape') console.log('esc'); });
</script>
</body></html>';
}
