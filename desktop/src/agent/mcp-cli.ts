import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PackRegistry } from '../packs/registry.ts';
import { AgentTools } from './tools.ts';
import { buildMcpServer } from './mcp.ts';

function appDataDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'AutomationCAD');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'AutomationCAD');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'AutomationCAD');
}

function builtinPacksDir(): string {
  const candidates = [
    process.env.AUTOMATIONCAD_BUILTIN_PACKS,
    resolve(__dirname, '..', '..', 'packs', 'builtin'),
    resolve(process.cwd(), 'packs', 'builtin'),
    resolve(process.cwd(), '..', 'packs', 'builtin')
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

async function main(): Promise<void> {
  const userData = appDataDir();
  const registry = new PackRegistry({
    builtinDir: builtinPacksDir(),
    userDir: join(userData, 'packs'),
    stateFile: join(userData, 'packs-state.json')
  });
  const tools = new AgentTools(registry);
  const server = buildMcpServer(tools, {
    name: 'automation-cad',
    version: process.env.npm_package_version || '0.1.0'
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[mcp] AutomationCAD stdio ready · tools=${tools.list().length} · userData=${userData}`);

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error('[mcp] 启动失败', error);
  process.exit(1);
});
