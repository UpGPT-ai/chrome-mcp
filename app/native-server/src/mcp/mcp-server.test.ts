import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from './mcp-server';

describe('createMcpServer', () => {
  it('returns a distinct server per call', () => {
    expect(createMcpServer()).not.toBe(createMcpServer());
  });

  it('lets two sessions connect without "Already connected to a transport"', async () => {
    const a = createMcpServer();
    const b = createMcpServer();
    const [, serverSideA] = InMemoryTransport.createLinkedPair();
    const [, serverSideB] = InMemoryTransport.createLinkedPair();
    await expect(a.connect(serverSideA)).resolves.toBeUndefined();
    await expect(b.connect(serverSideB)).resolves.toBeUndefined();
    await a.close();
    await b.close();
  });

  it('refuses a second transport on the same server (why one server per session is needed)', async () => {
    const s = createMcpServer();
    const [, t1] = InMemoryTransport.createLinkedPair();
    const [, t2] = InMemoryTransport.createLinkedPair();
    await s.connect(t1);
    await expect(s.connect(t2)).rejects.toThrow(/Already connected/);
    await s.close();
  });
});
