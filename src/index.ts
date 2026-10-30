import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { PersonalApiClient, PersonalDataService } from './personal';
import { registerPersonalTools } from './tools/personal.tools';

const server = new McpServer({
  name: 'garmin-connect-mcp',
  version: '1.1.0',
});

const client = new PersonalApiClient();
const dataService = new PersonalDataService({ client });
registerPersonalTools(server, dataService);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Garmin Connect Personal API MCP server running on stdio');
}

main().catch((error: unknown) => {
  console.error('Fatal error starting server:', error instanceof Error ? error.message : 'Unknown error');
  process.exit(1);
});
