#!/usr/bin/env node
// Entry point for the GitHub Action defined in action.yml.
import { runAction } from '../src/action.js';

try {
  const { result, files, updated, published } = await runAction(process.env);
  console.log(`shill: ${result.stats.kept} of ${result.stats.seen} commits kept, provider ${result.provider}`);
  console.log(`shill: wrote ${files.length} drafts${updated ? ', updated the release body' : ''}${published.length ? `, posted to ${published.map((p) => p.channel).join(', ')}` : ''}`);
  for (const w of result.warnings) console.log(`::warning::${w}`);
} catch (err) {
  console.log(`::error::${err.message}`);
  process.exitCode = 1;
}
