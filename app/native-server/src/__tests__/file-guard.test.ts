import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { assertFetchableUrl, isInsideDir, isPublicAddress, sanitizeFileName } from '../file-guard';
import { FileHandler } from '../file-handler';

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'ff02::1',
    'not-an-ip',
  ])('rejects %s', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])('accepts %s', (ip) =>
    expect(isPublicAddress(ip)).toBe(true),
  );
});

describe('assertFetchableUrl', () => {
  const pub = async () => ['93.184.216.34'];
  it('accepts a public https host', async () => {
    await expect(assertFetchableUrl('https://example.com/a.png', pub)).resolves.toBeInstanceOf(URL);
  });
  it('rejects non-http schemes', async () => {
    await expect(assertFetchableUrl('file:///etc/passwd', pub)).rejects.toThrow(/scheme/);
    await expect(assertFetchableUrl('ftp://example.com/x', pub)).rejects.toThrow(/scheme/);
  });
  it('rejects literal private addresses', async () => {
    await expect(assertFetchableUrl('http://169.254.169.254/latest', pub)).rejects.toThrow(
      /Non-public/,
    );
    await expect(assertFetchableUrl('http://[::1]:8080/', pub)).rejects.toThrow(/Non-public/);
  });
  it('rejects a name that resolves to a private address', async () => {
    await expect(
      assertFetchableUrl('http://rebind.example/', async () => ['93.184.216.34', '10.0.0.1']),
    ).rejects.toThrow(/Non-public/);
  });
  it('rejects garbage', async () => {
    await expect(assertFetchableUrl('nope', pub)).rejects.toThrow(/Invalid/);
  });
});

describe('sanitizeFileName and isInsideDir', () => {
  it('keeps one segment', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('..\\..\\evil.dll')).toBe('evil.dll');
    expect(sanitizeFileName('report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('..')).toBeNull();
    expect(sanitizeFileName('')).toBeNull();
  });
  it('catches the string-prefix trap', () => {
    const dir = path.join(os.tmpdir(), 'chrome-mcp-uploads');
    expect(isInsideDir(dir, path.join(dir, 'a.txt'))).toBe(true);
    expect(isInsideDir(dir, `${dir}-sibling/a.txt`)).toBe(false);
    expect(isInsideDir(dir, path.join(dir, '..', 'x'))).toBe(false);
    expect(isInsideDir(dir, dir)).toBe(false);
  });
});

describe('FileHandler containment', () => {
  const handler = new FileHandler();
  const tempDir = path.join(os.tmpdir(), 'chrome-mcp-uploads');

  it('confines a traversing base64 file name to the temp dir', async () => {
    const res = await handler.handleFileRequest({
      action: 'prepareFile',
      base64Data: Buffer.from('hi').toString('base64'),
      fileName: '../../escaped-chrome-mcp-test.txt',
    });
    expect(res.success).toBe(true);
    expect(path.dirname(res.filePath)).toBe(tempDir);
    fs.unlinkSync(res.filePath);
  });

  it('refuses to read or clean up files outside the temp dir', async () => {
    const read = await handler.handleFileRequest({
      action: 'readBase64File',
      filePath: __filename,
    });
    expect(read.success).toBe(false);
    const clean = await handler.handleFileRequest({
      action: 'cleanupFile',
      filePath: `${tempDir}-sibling/x`,
    });
    expect(clean.success).toBe(false);
  });

  it('refuses a loopback file URL', async () => {
    await expect(
      handler.handleFileRequest({ action: 'prepareFile', fileUrl: 'http://127.0.0.1:9/x' }),
    ).resolves.toMatchObject({ success: false });
  });
});
