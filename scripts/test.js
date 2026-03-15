/**
 * Test runner wrapper — runs Jest and filters out noisy worker warnings.
 */
const { spawn } = require('child_process');

const args = ['--runInBand', '--forceExit', ...process.argv.slice(2)];
const jest = spawn('npx', ['jest', ...args], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env, FORCE_COLOR: '1' },
});

const NOISE = [
  'worker process has failed to exit',
  'Force exiting Jest',
  'detectOpenHandles',
  'Jest has detected the following',
  'open handle potentially keeping',
];

function filterLine(line) {
  return !NOISE.some(n => line.includes(n));
}

jest.stdout.on('data', (data) => {
  const lines = data.toString().split('\n');
  const clean = lines.filter(filterLine).join('\n');
  if (clean.trim()) process.stdout.write(clean.endsWith('\n') ? clean : clean + '\n');
});

jest.stderr.on('data', (data) => {
  const lines = data.toString().split('\n');
  const clean = lines.filter(filterLine).join('\n');
  if (clean.trim()) process.stderr.write(clean.endsWith('\n') ? clean : clean + '\n');
});

jest.on('close', (code) => {
  process.exit(code);
});
