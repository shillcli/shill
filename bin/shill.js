#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { main } from '../src/cli.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
process.exitCode = await main(process.argv.slice(2), { version });
