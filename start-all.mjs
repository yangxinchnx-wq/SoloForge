import { execSync, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const dir = process.env.SOLOFORGE_AGENT_DIR || (() => {
  const _dirname = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(_dirname, 'solo-forge-agent');
})();

const javaHome = process.env.JAVA_HOME || 'java';
const javaBin = javaHome === 'java' ? '' : path.join(javaHome, 'bin');
const wrapperJar = path.join(dir, '.mvn', 'wrapper', 'maven-wrapper.jar');
const uiDir = process.env.SOLOFORGE_UI_DIR || (() => {
  const _dirname = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(_dirname, 'UI');
})();

function prereqCheck() {
  if (!fs.existsSync(dir)) {
    console.error(`❌ Agent 目录不存在: ${dir}`);
    console.error(`   请设置 SOLOFORGE_AGENT_DIR 环境变量指向 solo-forge-agent 目录`);
    process.exit(1);
  }
  if (!fs.existsSync(wrapperJar)) {
    console.error(`❌ Maven Wrapper JAR 不存在: ${wrapperJar}`);
    console.error(`   请先在 Agent 目录执行 mvn 或 ./mvnw`);
    process.exit(1);
  }
  if (javaHome === 'java') {
    console.warn('⚠️  JAVA_HOME 未设置，将使用系统 PATH 中的 java');
  } else if (!fs.existsSync(path.join(javaBin, 'java'))) {
    console.error(`❌ Java 可执行文件不存在: ${path.join(javaBin, 'java')}`);
    console.error(`   请检查 JAVA_HOME 环境变量: ${javaHome}`);
    process.exit(1);
  }
  if (!fs.existsSync(uiDir)) {
    console.error(`❌ UI 目录不存在: ${uiDir}`);
    console.error(`   请设置 SOLOFORGE_UI_DIR 环境变量`);
    process.exit(1);
  }
}

prereqCheck();

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  PATH: javaBin ? `${javaBin}${path.delimiter}${process.env.PATH}` : process.env.PATH,
};

console.log('=== Building Java Agent ===');
console.log(`   Agent dir : ${dir}`);
console.log(`   Java home : ${javaHome}`);
try {
  const javaExe = javaBin ? path.join(javaBin, 'java') : 'java';
  execSync(
    `"${javaExe}" -classpath "${wrapperJar}" -Dmaven.multiModuleProjectDirectory="${dir}" org.apache.maven.wrapper.MavenWrapperMain -DskipTests clean package`,
    { cwd: dir, stdio: 'inherit', env, shell: false }
  );
  console.log('BUILD OK');
} catch (e) { console.error('BUILD FAIL:', e.message); process.exit(1); }

const jar = path.join(dir, 'target', 'solo-forge-agent-1.0.0.jar');
console.log(`\n=== Starting Java Agent on :8770 ===`);

const javaExe = javaBin ? path.join(javaBin, 'java') : 'java';
const javaProc = spawn(javaExe, ['-jar', jar, '--server.port=8770'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env,
  shell: false,
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
console.log(`   UI dir: ${uiDir}`);

const nodeProc = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
  cwd: uiDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: false,
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
