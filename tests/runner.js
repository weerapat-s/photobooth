import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const testFiles = [
  'tests/baseline.spec.js',
  'tests/startup.spec.js',
  'tests/security.spec.js',
  'tests/validation.spec.js',
  'tests/camera-guard.spec.js',
  'tests/manual-shutter.spec.js',
  'tests/recovery.spec.js',
  'tests/ipad-flow.spec.js',
  'tests/web-flow.spec.js',
  'tests/public-kiosk.spec.js',
  'tests/preflight.spec.js',
  'tests/retention.spec.js',
];

async function runAllTests() {
  console.log('====================================================');
  console.log('       PHOTO BOOTH FULL TEST SUITE RUNNER           ');
  console.log('====================================================\n');

  const results = [];

  for (const file of testFiles) {
    process.stdout.write(`Running ${file}... `);
    const start = Date.now();
    try {
      await execFileAsync('node', [file]);
      const duration = Date.now() - start;
      console.log(`PASSED (${duration}ms)`);
      results.push({ file, status: 'PASSED', duration });
    } catch (err) {
      const duration = Date.now() - start;
      console.log(`FAILED (${duration}ms)`);
      console.error(err.stdout || err.stderr || err.message);
      results.push({ file, status: 'FAILED', duration });
    }
  }

  console.log('\n====================================================');
  console.log('                   TEST SUMMARY                     ');
  console.log('====================================================');
  console.table(results);

  const hasFailures = results.some((r) => r.status === 'FAILED');
  if (hasFailures) {
    console.error('\nSOME TESTS FAILED! PLEASE REVIEW ERRORS ABOVE.');
    process.exit(1);
  } else {
    console.log('\nALL AUTOMATED VERIFICATION TESTS PASSED. DSLR ACCEPTANCE WITH A REAL CAMERA IS STILL REQUIRED.');
  }
}

runAllTests();
