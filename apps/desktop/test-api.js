// 直接在 Electron 环境中测试
console.log('测试开始...');
console.log('process.execPath:', process.execPath);
console.log('process.versions.electron:', process.versions.electron);
console.log('process.versions.chrome:', process.versions.chrome);

// 尝试访问 electron API
try {
  const electron = require('electron');
  console.log('require("electron") 类型:', typeof electron);
  console.log('require("electron") 结果:', electron);
} catch (e) {
  console.log('require("electron") 错误:', e.message);
}

// 检查 app 是否存在
try {
  console.log('app 是否存在:', typeof app !== 'undefined');
  console.log('app.whenReady 是否存在:', typeof app?.whenReady !== 'undefined');
} catch (e) {
  console.log('app 错误:', e.message);
}

console.log('测试结束');
