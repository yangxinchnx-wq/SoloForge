const { exec } = require('child_process');
const sh = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
console.log('try with:', sh);
exec('echo hi', { shell: sh }, (err, stdout, stderr) => {
  if (err) {
    console.log('ERR message:', err.message);
    console.log('ERR code:', err.code);
    console.log('ERR errno:', err.errno);
    console.log('ERR path:', err.path);
    console.log('ERR syscall:', err.syscall);
  } else {
    console.log('OK:', stdout, stderr);
  }
});