import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const dir = 'c:\\Users\\yangx\\Desktop\\SoloForge\\solo-forge-agent';
const javaHome = 'C:\\Program Files\\Java\\jdk-23';
const javaBin = path.join(javaHome, 'bin');
const wrapperJar = path.join(dir, '.mvn', 'wrapper', 'maven-wrapper.jar');
const env = { ...process.env, JAVA_HOME: javaHome, PATH: `${javaBin};${process.env.PATH}` };

console.log('=== Building Java Agent ===');
try {
  execSync(`"${path.join(javaBin, 'java')}" -classpath "${wrapperJar}" -Dmaven.multiModuleProjectDirectory="${dir}" org.apache.maven.wrapper.MavenWrapperMain -DskipTests clean package`, { cwd: dir, stdio: 'inherit', env, shell: true });
  console.log('BUILD OK');
} catch (e) { console.error('BUILD FAIL:', e.message); process.exit(1); }

const jar = path.join(dir, 'target', 'solo-forge-agent-1.0.0.jar');
console.log(`\n=== Starting Java Agent on :8770 ===`);
const javaProc = spawn(path.join(javaBin, 'java'), ['-jar', jar, '--server.port=8770'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
  shell: true,
});

let javaReady = false;
javaProc.stdout?.on('data', d => {
  const s = d.toString();
  if (s.includes('Started SoloForgeAgentApplication')) {
    javaReady = true;
    console.log('Java Agent READY on :8770');
  }
});
javaProc.stderr?.on('data', d => process.stderr.write(d));

await new Promise(r => setTimeout(r, 12000));
if (!javaReady) console.log('Java Agent starting...');

console.log('\n=== Starting Node.js Server ===');
const nodeProc = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
  cwd: 'c:\\Users\\yangx\\Desktop\\SoloForge',
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});

nodeProc.stdout?.on('data', d => {
  const s = d.toString();
  if (s.includes('listening') || s.includes('started') || s.includes('Server')) {
    console.log('Node.js:', s.trim());
  }
});
nodeProc.stderr?.on('data', d => process.stderr.write(d));

await new Promise(r => setTimeout(r, 5000));
console.log('\n=== Services Started ===');
console.log('Java Agent: http://localhost:8770');
console.log('Node.js:    http://localhost:3000');
console.log('\nPress Ctrl+C to stop');

process.on('SIGINT', () => {
  javaProc.kill();
  nodeProc.kill();
  process.exit(0);
});

await new Promise(() => {});
