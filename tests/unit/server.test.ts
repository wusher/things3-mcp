// ABOUTME: Unit tests for the Things3 MCP server
// ABOUTME: Tests server initialization, tool listing, and tool execution

import { Things3Server } from '../../src/server';

// Mock the MCP SDK Server class to capture request handlers
const mockSetRequestHandler = jest.fn();
const mockRegisterCapabilities = jest.fn();
const mockConnect = jest.fn();
const mockClose = jest.fn();

jest.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: jest.fn().mockImplementation(() => ({
    setRequestHandler: mockSetRequestHandler,
    registerCapabilities: mockRegisterCapabilities,
    connect: mockConnect,
    close: mockClose,
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn().mockImplementation(() => ({})),
}));

describe('Things3Server', () => {
  let server: Things3Server;
  let consoleErrorSpy: jest.SpyInstance;
  let listToolsHandler: (request: unknown) => Promise<unknown>;
  let callToolHandler: (request: unknown) => Promise<unknown>;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();

    // Capture the request handlers when they're registered
    mockSetRequestHandler.mockImplementation((schema: unknown, handler: (request: unknown) => Promise<unknown>) => {
      // The schema object has a shape property we can check
      const schemaObj = schema as { shape?: { method?: { value?: string } } };
      if (schemaObj?.shape?.method?.value === 'tools/list') {
        listToolsHandler = handler;
      } else if (schemaObj?.shape?.method?.value === 'tools/call') {
        callToolHandler = handler;
      }
    });

    server = new Things3Server();
  });

  afterEach(async () => {
    await server.stop();
    consoleErrorSpy.mockRestore();
  });

  describe('initialization', () => {
    it('should create a server instance', () => {
      expect(server).toBeInstanceOf(Things3Server);
    });

    it('should start without errors', async () => {
      await expect(server.start()).resolves.not.toThrow();
      expect(mockConnect).toHaveBeenCalled();
    });

    it('should stop without errors', async () => {
      await server.start();
      await expect(server.stop()).resolves.not.toThrow();
      expect(mockClose).toHaveBeenCalled();
    });

    it('should register all 25 tools via registry pattern', () => {
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Registering Things3 tools...'));
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Registered 25 tools via registry'));
    });

    it('should register capabilities with all tools', () => {
      expect(mockRegisterCapabilities).toHaveBeenCalled();
      const capabilities = mockRegisterCapabilities.mock.calls[0][0];
      expect(Object.keys(capabilities.tools)).toHaveLength(25);
    });
  });

  describe('tools/list handler', () => {
    it('should return all registered tools', async () => {
      const result = await listToolsHandler({});

      expect(result).toHaveProperty('tools');
      const { tools } = result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
      expect(tools).toHaveLength(25);

      // Verify each tool has required properties
      for (const tool of tools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
      }
    });

    it('should include todos_list tool', async () => {
      const result = await listToolsHandler({});
      const { tools } = result as { tools: Array<{ name: string }> };

      const todosTool = tools.find(t => t.name === 'todos_list');
      expect(todosTool).toBeDefined();
    });
  });

  describe('tools/call handler', () => {
    it('should return MCP-compliant response with content array for successful calls', async () => {
      // Mock the registry to return a successful result
      const mockResult = { items: [{ id: '1', title: 'Test' }] };
      jest.spyOn(server['registry'], 'executeTool').mockResolvedValue(mockResult);
      jest.spyOn(server['registry'], 'getHandler').mockReturnValue(jest.fn());

      const result = await callToolHandler({
        params: { name: 'todos_list', arguments: { filter: 'today' } },
      });

      expect(result).toHaveProperty('content');
      const { content } = result as { content: Array<{ type: string; text: string }> };
      expect(content).toHaveLength(1);
      expect(content[0]!.type).toBe('text');
      expect(content[0]!.text).toBe(JSON.stringify(mockResult));
    });

    it('should serialize JSON result properly', async () => {
      const mockResult = {
        todos: [
          { id: 'abc123', title: 'My Task', status: 'open' },
          { id: 'def456', title: 'Another Task', status: 'completed' },
        ],
      };
      jest.spyOn(server['registry'], 'executeTool').mockResolvedValue(mockResult);
      jest.spyOn(server['registry'], 'getHandler').mockReturnValue(jest.fn());

      const result = await callToolHandler({
        params: { name: 'todos_list', arguments: {} },
      });

      const { content } = result as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed).toEqual(mockResult);
    });

    it('should throw protocol-level error for unknown tools', async () => {
      // Don't mock getHandler - let it return undefined for unknown tool
      jest.spyOn(server['registry'], 'getHandler').mockReturnValue(undefined);

      await expect(
        callToolHandler({
          params: { name: 'unknown_tool', arguments: {} },
        })
      ).rejects.toThrow('Unknown tool: unknown_tool');
    });

    it('should return isError: true for tool execution errors', async () => {
      const errorMessage = 'Things3 is not running';
      jest.spyOn(server['registry'], 'getHandler').mockReturnValue(jest.fn());
      jest.spyOn(server['registry'], 'executeTool').mockRejectedValue(new Error(errorMessage));

      const result = await callToolHandler({
        params: { name: 'todos_list', arguments: {} },
      });

      expect(result).toHaveProperty('isError', true);
      const { content } = result as { content: Array<{ type: string; text: string }>; isError: boolean };
      expect(content).toHaveLength(1);
      expect(content[0]!.type).toBe('text');

      const parsed = JSON.parse(content[0]!.text);
      expect(parsed).toHaveProperty('error', errorMessage);
    });

    it('should handle non-Error exceptions', async () => {
      jest.spyOn(server['registry'], 'getHandler').mockReturnValue(jest.fn());
      jest.spyOn(server['registry'], 'executeTool').mockRejectedValue('string error');

      const result = await callToolHandler({
        params: { name: 'todos_list', arguments: {} },
      });

      expect(result).toHaveProperty('isError', true);
      const { content } = result as { content: Array<{ type: string; text: string }> };
      const parsed = JSON.parse(content[0]!.text);
      expect(parsed).toHaveProperty('error', 'string error');
    });

    it('should log errors when tool execution fails', async () => {
      jest.spyOn(server['registry'], 'getHandler').mockReturnValue(jest.fn());
      jest.spyOn(server['registry'], 'executeTool').mockRejectedValue(new Error('Test error'));

      await callToolHandler({
        params: { name: 'todos_list', arguments: {} },
      });

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tool todos_list execution failed: Test error')
      );
    });
  });

  describe('tool handlers accessibility', () => {
    it('should expose todosTools', () => {
      expect(server.todosTools).toBeDefined();
    });

    it('should expose projectTools', () => {
      expect(server.projectTools).toBeDefined();
    });

    it('should expose areaTools', () => {
      expect(server.areaTools).toBeDefined();
    });

    it('should expose tagTools', () => {
      expect(server.tagTools).toBeDefined();
    });

    it('should expose bulkTools', () => {
      expect(server.bulkTools).toBeDefined();
    });

    it('should expose logbookTools', () => {
      expect(server.logbookTools).toBeDefined();
    });

    it('should expose systemTools', () => {
      expect(server.systemTools).toBeDefined();
    });
  });
});
