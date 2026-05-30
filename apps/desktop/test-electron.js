// 测试 electron 模块
const electron = require('electron');
console.log('electron 模块:', typeof electron);
console.log('electron.app:', typeof electron.app);
console.log('electron.BrowserWindow:', typeof electron.BrowserWindow);
console.log('electron keys:', Object.keys(electron));
