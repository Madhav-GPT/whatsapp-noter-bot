import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { openLibrary } from './library.js';
import { createMcpServer } from './mcp-tools.js';

const library = await openLibrary();
serveStdio(() => createMcpServer(library));
process.on('SIGINT', () => { library.close(); process.exit(0); });
process.on('SIGTERM', () => { library.close(); process.exit(0); });
