import net from 'node:net';
import { describePortListener, isAddrInUse, portBusyError } from './port-in-use';

describe('isAddrInUse', () => {
  it('matches a direct EADDRINUSE code', () => {
    expect(isAddrInUse({ code: 'EADDRINUSE' })).toBe(true);
  });

  it('matches by message text', () => {
    expect(isAddrInUse(new Error('listen EADDRINUSE: address already in use :::13366'))).toBe(true);
  });

  it('follows the cause chain', () => {
    expect(isAddrInUse({ message: 'wrapper', cause: { code: 'EADDRINUSE' } })).toBe(true);
  });

  it('survives a cyclic cause chain', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(isAddrInUse(a)).toBe(false);
  });

  it('rejects unrelated errors and non-objects', () => {
    expect(isAddrInUse(new Error('boom'))).toBe(false);
    expect(isAddrInUse(null)).toBe(false);
    expect(isAddrInUse('EADDRINUSE')).toBe(false);
  });
});

describe('describePortListener', () => {
  it('returns null for invalid ports', () => {
    expect(describePortListener(0)).toBeNull();
    expect(describePortListener(70000)).toBeNull();
    expect(describePortListener(1.5)).toBeNull();
  });

  it('names this process when it holds the port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const owner = describePortListener(port);
      // lsof or netstat may be unavailable in sandboxes: only assert the shape when found.
      if (owner !== null) expect(owner).toMatch(/\(pid \d+\)|^pid \d+$/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('portBusyError', () => {
  it('says the port is busy and that no other port is chosen', () => {
    const err = portBusyError(1);
    expect(err.message).toContain('Port 1 is already in use');
    expect(err.message).toContain('will not choose another port');
    expect(err.message).toContain('CHROME_MCP_PORT');
  });
});
