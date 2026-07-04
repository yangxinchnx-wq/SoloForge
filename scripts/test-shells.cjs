const { exec } = require('child_process');

async function testShell(label, sh) {
  return new Promise((resolve) => {
    console.log(`\n=== ${label}: shell=${sh} ===`);
    exec('echo hi', { shell: sh, timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        console.log('ERR:', err.message);
        console.log('code:', err.code, 'errno:', err.errno);
      } else {
        console.log('OK stdout:', JSON.stringify(stdout));
        console.log('OK stderr:', JSON.stringify(stderr));
      }
      resolve();
    });
  });
}

(async () => {
  await testShell('undefined', undefined);
  await testShell('cmd', 'cmd.exe');
  await testShell('cmd full System32', 'C:\\Windows\\System32\\cmd.exe');
  await testShell('cmd full system32', 'C:\\WINDOWS\\system32\\cmd.exe');
  await testShell('powershell', 'powershell.exe');
  await testShell('pwsh', 'pwsh.exe');
})();