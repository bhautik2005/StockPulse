/** Temporary: prints ESLint JSON results (lint.json) as one line per problem. */
import { readFileSync } from 'node:fs';

for (const file of JSON.parse(readFileSync('lint.json', 'utf8'))) {
  const short = file.filePath.split(/client[\\/]/).pop().replace(/\\/g, '/');
  for (const message of file.messages) {
    console.log(`${short}:${message.line} [${message.ruleId}] ${message.message.split('\n')[0]}`);
  }
}