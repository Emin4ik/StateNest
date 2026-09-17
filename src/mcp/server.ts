#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { registerTools } from './tools.js';
import { readPackageVersion } from '../core/workspace.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Project Brain MCP server.
 *
 * This is how a coding agent reaches Project Brain without the user having to
 * remember CLI commands. It is read-mostly by design: the write tools record
 * memory (checkpoints, decisions, tasks, focus) and nothing else. There is no
 * tool that runs a shell command, connects to a server, or touches the user's
 * source repository - registering a VPS in Project Brain must never become a
 * way for a model to reach it.
 *
 * Every tool returns compact text. An agent that needs more asks for more;
 * paying context for history it did not ask for is the failure mode this whole
 * design is trying to avoid.
 */
async function main(): Promise<void> {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const version = await readPackageVersion(join(packageRoot, 'package.json'));

  const server = new McpServer(
    { name: 'project-brain', version },
    {
      instructions: [
        'Project Brain is the user\'s memory of their own projects: where each one lives,',
        'which machines and servers it is on, what was done, decided, and left unfinished.',
        '',
        'Use it when the user refers to past work ("what was I doing", "where did I leave off",',
        '"which server runs this"), when you need to know where a project is deployed, or when',
        'a session produced something worth remembering.',
        '',
        'Record a checkpoint when meaningful work is finished - not after every edit.',
        'Record a decision when a choice was made that would not be obvious from the diff.',
      ].join('\n'),
    },
  );

  registerTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Nothing may be written to stdout except MCP protocol traffic: stdout is the
 * transport, and a stray log line corrupts the JSON-RPC stream. Failures go to
 * stderr, which the host surfaces as a server error.
 */
main().catch((error: unknown) => {
  process.stderr.write(
    `project-brain MCP server failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

export { z };
