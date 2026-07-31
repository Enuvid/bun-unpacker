#!/usr/bin/env node
import { main } from './run.js';

// `bun-unpacker --json | head` closes stdout early. That is not an
// error worth a stack trace.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    process.exit(0);
  }
  throw error;
});

process.exitCode = main(process.argv.slice(2));
