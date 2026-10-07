#!/usr/bin/env node
/*
 * chrome-mcp - print ready-to-paste MCP client configuration for THIS install.
 * Works on Windows, macOS and Linux; needs only Node. Paths are resolved from this file's location,
 * so quoting/escaping is always right for the machine it runs on.
 *
 *   node show-config.js          human-readable instructions
 *   node show-config.js --json   machine-readable (for AI tools / scripts)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const stdio = path.join(root, 'native-server', 'dist', 'mcp', 'mcp-server-stdio.js');
const cli = path.join(root, 'native-server', 'dist', 'cli.js');
const ext = path.join(root, 'chrome-extension');
const EXTENSION_ID = 'gnkfbbmfkabopdomoedaamfpgnakoici';
const plat = process.platform;

const desktopConfigPath =
  plat === 'win32'
    ? 'Claude Desktop: Settings > Developer > Edit Config (opens the right file; on the Microsoft Store/MSIX build it is not the plain %APPDATA% path)'
    : plat === 'darwin'
      ? '~/Library/Application Support/Claude/claude_desktop_config.json (or Claude Desktop: Settings > Developer > Edit Config)'
      : '~/.config/Claude/claude_desktop_config.json';

const server = { command: 'node', args: [stdio] };
const serverAbsNode = { command: process.execPath, args: [stdio] };
const problems = [];
if (!fs.existsSync(stdio))
  problems.push('missing ' + stdio + ' (is this the inner package folder?)');
if (!fs.existsSync(path.join(ext, 'manifest.json')))
  problems.push('missing ' + ext + path.sep + 'manifest.json');
if (parseInt(process.versions.node, 10) < 20)
  problems.push('Node ' + process.versions.node + ' is too old; need 20+');

if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      {
        platform: plat,
        packageRoot: root,
        extensionFolder: ext,
        extensionId: EXTENSION_ID,
        doctorCommand: ['node', cli, 'doctor'],
        claudeCodeCommand: [
          'claude',
          'mcp',
          'add',
          'chrome-mcp',
          '-s',
          'user',
          '--',
          'node',
          stdio,
        ],
        mcpServersEntry: { 'chrome-mcp': server },
        mcpServersEntryAbsoluteNode: { 'chrome-mcp': serverAbsNode },
        claudeDesktopConfigFile: desktopConfigPath,
        problems,
      },
      null,
      2,
    ),
  );
  process.exit(problems.length ? 1 : 0);
}

const q = (p) => '"' + p + '"';
console.log('chrome-mcp client configuration for this machine (' + plat + ')\n');
if (problems.length) console.log('PROBLEMS:\n  - ' + problems.join('\n  - ') + '\n');
console.log(
  'Chrome extension folder (Load unpacked):\n  ' +
    ext +
    '\n  expected extension ID: ' +
    EXTENSION_ID +
    '\n',
);
console.log('Claude Code (run once, then start a NEW session):');
console.log('  claude mcp add chrome-mcp -s user -- node ' + q(stdio));
console.log('  (already added the HTTP version? first: claude mcp remove chrome-mcp -s user)\n');
console.log(
  'Claude Desktop and most other MCP clients (Cursor, Cline, Windsurf, ...): add to "mcpServers" in\n  ' +
    desktopConfigPath +
    '\n',
);
console.log(JSON.stringify({ mcpServers: { 'chrome-mcp': server } }, null, 2) + '\n');
console.log(
  'If the client reports "spawn node ENOENT" (GUI apps often lack your shell PATH, e.g. nvm),',
);
console.log('use the absolute Node path instead:\n');
console.log(JSON.stringify({ mcpServers: { 'chrome-mcp': serverAbsNode } }, null, 2) + '\n');
console.log('Verify the native side any time:\n  node ' + q(cli) + ' doctor');
