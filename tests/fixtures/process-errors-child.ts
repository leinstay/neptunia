// A process with the core's guard that throws the error named on its command line outside any promise, as a stream's
// 'error' event with no listener does, and then says it lives. tests/process-errors.test.ts runs it.
import { guardProcessErrors } from '../../src/process-errors.ts';

guardProcessErrors({ warn() {}, error() {} });
setImmediate(() => {
  throw Object.assign(new Error('synthetic'), { code: process.argv[2] });
});
setTimeout(() => {
  process.stdout.write('alive');
}, 50);
