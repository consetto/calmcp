#!/usr/bin/env node
// The tool surface is what a model sees of calmcp: the server instructions and each tool's name,
// title, description, annotations and input schema. A change to it changes how models call the
// server, yet it hides in string literals across several files. This script makes it reviewable.
//
//   snapshot <server entry> <out.json>   start a built server over stdio, once read-only and once
//                                        with write access, and record what tools/list returns
//   diff <base.json> <head.json>         print a Markdown report of what changed, with sizes
//        [--brief]                       sizes only, for when the details exceed a PR comment
//
// Usage in CI: .github/workflows/tool-surface.yml snapshots main and the PR and comments the diff.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Marker that identifies the PR comment, so a later run updates it instead of adding another. */
export const MARKER = '<!-- calmcp-tool-surface -->';

/** The two deployments whose surfaces differ: default read-only, and write access switched on. */
const MODES = {
  readOnly: { label: 'Read-only (default)', env: {} },
  write: { label: 'With write access', env: { CALM_WRITE_ENABLED: 'true' } },
};

/** Start the server in one mode and return its instructions and tools. */
async function capture(entry, env) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [resolve(entry)],
    // Sandbox mode needs no tenant; nothing reaches Cloud ALM during tools/list.
    env: { PATH: process.env.PATH ?? '', CALM_SANDBOX: 'true', CALM_API_KEY: 'surface', ...env },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'calmcp-tool-surface', version: '1' });
  await client.connect(transport);
  const instructions = client.getInstructions() ?? '';
  const { tools } = await client.listTools();
  await client.close();
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { instructions, tools };
}

async function snapshot(entry, out) {
  const surface = {};
  for (const [mode, { env }] of Object.entries(MODES)) surface[mode] = await capture(entry, env);
  writeFileSync(out, `${JSON.stringify(surface, null, 2)}\n`);
}

/** Serialized size in bytes, the way a client receives it. */
const bytes = (value) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value)));

/** Rough token estimate; good enough to see whether a change is 10 tokens or 1000. */
const tokens = (n) => Math.round(n / 4);

function signed(n) {
  if (n === 0) return '0';
  return n > 0 ? `+${n}` : `${n}`;
}

/** Split prose into one sentence per line, so a diff shows which sentence changed. */
function sentences(text) {
  return (text ?? '').split(/(?<=[.!?])\s+/).filter(Boolean);
}

/** A minimal line diff (longest common subsequence), rendered as a `diff` code block body. */
function lineDiff(before, after) {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      lines.push(`  ${before[i]}`);
      i += 1;
      j += 1;
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      lines.push(`- ${before[i]}`);
      i += 1;
    } else {
      lines.push(`+ ${after[j]}`);
      j += 1;
    }
  }
  return lines.join('\n');
}

/** A fenced diff of two pieces of prose. */
function proseDiff(before, after) {
  return `\`\`\`diff\n${lineDiff(sentences(before), sentences(after))}\n\`\`\``;
}

/** The properties of a tool's input schema, keyed by name. */
const properties = (tool) => tool?.inputSchema?.properties ?? {};

/** What changed in one tool, as Markdown lines (empty when nothing did). */
function toolChanges(before, after) {
  const out = [];
  if (before.title !== after.title) out.push(`- title: \`${before.title}\` → \`${after.title}\``);
  if (JSON.stringify(before.annotations) !== JSON.stringify(after.annotations)) {
    out.push(
      `- annotations: \`${JSON.stringify(before.annotations)}\` → \`${JSON.stringify(after.annotations)}\``,
    );
  }
  if (before.description !== after.description) {
    out.push('- description:', '', proseDiff(before.description, after.description), '');
  }

  const was = properties(before);
  const is = properties(after);
  for (const name of Object.keys(is).filter((key) => !(key in was))) {
    out.push(`- parameter \`${name}\` added: ${is[name].description ?? ''}`);
  }
  for (const name of Object.keys(was).filter((key) => !(key in is))) {
    out.push(`- parameter \`${name}\` removed`);
  }
  for (const name of Object.keys(is).filter((key) => key in was)) {
    const { description: oldText, ...oldRest } = was[name];
    const { description: newText, ...newRest } = is[name];
    if (JSON.stringify(oldRest) !== JSON.stringify(newRest)) {
      out.push(
        `- parameter \`${name}\` schema: \`${JSON.stringify(oldRest)}\` → \`${JSON.stringify(newRest)}\``,
      );
    }
    if (oldText !== newText) {
      out.push(`- parameter \`${name}\` description:`, '', proseDiff(oldText, newText), '');
    }
  }
  const oldRequired = JSON.stringify(before.inputSchema?.required ?? []);
  const newRequired = JSON.stringify(after.inputSchema?.required ?? []);
  if (oldRequired !== newRequired) out.push(`- required: \`${oldRequired}\` → \`${newRequired}\``);
  return out;
}

/** Report one mode. Tools whose change was already shown for the read-only mode are skipped. */
function reportMode(base, head, shown) {
  const byName = (surface) => new Map(surface.tools.map((tool) => [tool.name, tool]));
  const was = byName(base);
  const is = byName(head);
  const names = [...new Set([...was.keys(), ...is.keys()])].sort();

  const rows = [];
  const details = [];
  for (const name of names) {
    const before = was.get(name);
    const after = is.get(name);
    const key = `${JSON.stringify(before)}→${JSON.stringify(after)}`;
    const delta = bytes(after) - bytes(before);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    const status = !before ? 'added' : !after ? 'removed' : changed ? 'changed' : '';
    rows.push(
      `| \`${name}\` | ${bytes(before)} | ${bytes(after)} | ${signed(delta)} | ${status} |`,
    );
    if (!changed || shown?.has(key)) continue;
    shown?.add(key);
    if (!before) details.push(`#### \`${name}\` (added)`, '', proseDiff('', after.description), '');
    else if (!after) details.push(`#### \`${name}\` (removed)`, '');
    else details.push(`#### \`${name}\``, '', ...toolChanges(before, after), '');
  }

  // The write-access instructions extend the read-only ones, so an edit to the shared part would
  // otherwise be reported twice. Compare the changed sentences, not the whole text.
  const sentenceKey = `${sentences(base.instructions)
    .filter((line) => !sentences(head.instructions).includes(line))
    .join('|')}→${sentences(head.instructions)
    .filter((line) => !sentences(base.instructions).includes(line))
    .join('|')}`;
  if (base.instructions !== head.instructions && !shown?.has(sentenceKey)) {
    shown?.add(sentenceKey);
    details.unshift(
      '#### Server instructions',
      '',
      proseDiff(base.instructions, head.instructions),
      '',
    );
  }

  const total = (surface) => bytes(surface.tools) + bytes(surface.instructions);
  const delta = total(head) - total(base);
  return {
    changed: details.length > 0,
    summary: `${total(base)} → ${total(head)} bytes (${signed(delta)}, about ${signed(tokens(delta))} tokens)`,
    table: [
      '| Tool | Before (bytes) | After (bytes) | Δ | |',
      '| --- | ---: | ---: | ---: | --- |',
      ...rows,
    ],
    details,
  };
}

function diff(basePath, headPath, brief) {
  const base = JSON.parse(readFileSync(basePath, 'utf8'));
  const head = JSON.parse(readFileSync(headPath, 'utf8'));
  const shown = new Set();
  const reports = Object.entries(MODES).map(([mode, { label }]) => ({
    label,
    ...reportMode(base[mode], head[mode], shown),
  }));
  const changed = reports.some((report) => report.changed);

  const lines = [MARKER, '## Tool surface', ''];
  if (!changed) {
    lines.push('No change to what models see: instructions, tools and schemas are identical.');
  } else {
    lines.push(
      'What a model sees of calmcp changes in this PR. Sizes are the serialized JSON.',
      '',
    );
    if (brief) lines.push('The full diff is too long for a comment: see the job summary.', '');
    for (const report of reports) {
      lines.push(`### ${report.label}: ${report.summary}`, '');
      if (!report.changed) {
        lines.push('No further change in this mode.', '');
        continue;
      }
      lines.push(...report.table, '');
      if (!brief) lines.push(...report.details);
    }
  }

  if (process.env.GITHUB_OUTPUT) {
    writeFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`, { flag: 'a' });
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'snapshot' && args.length === 2) {
  await snapshot(args[0], args[1]);
} else if (command === 'diff' && (args.length === 2 || args[2] === '--brief')) {
  diff(args[0], args[1], args[2] === '--brief');
} else {
  console.error('usage: tool-surface.mjs snapshot <server entry> <out.json>');
  console.error('       tool-surface.mjs diff <base.json> <head.json> [--brief]');
  process.exit(2);
}
