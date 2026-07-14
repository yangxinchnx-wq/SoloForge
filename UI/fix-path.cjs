const fs = require('fs');
const filePath = 'src/server/services/persistence/SurrealStore.ts';
let content = fs.readFileSync(filePath, 'utf8');
content = content.replace("'rocksdb://data/canvas_sessions_db'", "'rocksdb://data/canvas_surreal_db'");
content = content.replace("const relPath = 'data/canvas_sessions_db'", "const relPath = 'data/canvas_surreal_db'");
fs.writeFileSync(filePath, content, 'utf8');
console.log('Done: replaced canvas_sessions_db -> canvas_surreal_db');
