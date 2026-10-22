#!/usr/bin/env node
import { run } from '../src/cli.js';

if (process.stdout.setEncoding) process.stdout.setDefaultEncoding?.('utf8');
run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
