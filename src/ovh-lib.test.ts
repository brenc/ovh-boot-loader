import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createOvhClient,
  getCurrentCredential,
  getServer,
  listServers,
  loadOvhConfig,
  OVH_ENDPOINTS,
  PROXMOX_BOOT_LOADER_PATHS,
  updateBootLoader,
} from './ovh-lib';

const VALID_OVH = {
  appKey: 'testAppKey',
  appSecret: 'testAppSecret',
  consumerKey: 'testConsumerKey',
};

function baseConfig() {
  return { ovh: { ...VALID_OVH } };
}

interface CapturedRequest {
  body: string | undefined;
  headers: Record<string, string>;
  method: string;
  url: string;
}

function mockFetch(
  responder: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): { calls: CapturedRequest[]; restore: () => void } {
  const originalFetch = globalThis.fetch;
  const calls: CapturedRequest[] = [];

  globalThis.fetch = mock(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String(input);
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = init.headers as Record<string, string>;
        for (const [k, v] of Object.entries(h)) {
          headers[k] = v;
        }
      }
      calls.push({
        body: typeof init?.body === 'string' ? init.body : undefined,
        headers,
        method: init?.method ?? 'GET',
        url,
      });
      return responder(input, init);
    },
  ) as never;

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function timeResponder(timestamp: number) {
  return () =>
    Promise.resolve(new Response(String(timestamp), { status: 200 }));
}

describe('OVH_ENDPOINTS', () => {
  test('exposes CA and EU endpoint URLs', () => {
    expect(OVH_ENDPOINTS.ca).toBe('https://ca.api.ovh.com/1.0');
    expect(OVH_ENDPOINTS.eu).toBe('https://eu.api.ovh.com/1.0');
  });
});

describe('PROXMOX_BOOT_LOADER_PATHS', () => {
  test('uses Windows-style backslash paths', () => {
    expect(PROXMOX_BOOT_LOADER_PATHS.systemdBoot).toBe(
      '\\efi\\systemd\\systemd-bootx64.efi',
    );
    expect(PROXMOX_BOOT_LOADER_PATHS.grub).toBe('\\efi\\proxmox\\grubx64.efi');
  });
});

describe('createOvhClient', () => {
  test('exposes the resolved endpoint URL (defaults to CA)', () => {
    const client = createOvhClient(baseConfig());
    expect(client.endpoint).toBe('https://ca.api.ovh.com/1.0');
  });

  test('exposes the EU endpoint URL when region is "eu"', () => {
    const client = createOvhClient({ ...baseConfig(), region: 'eu' });
    expect(client.endpoint).toBe('https://eu.api.ovh.com/1.0');
  });

  test('signs GET requests with empty body and returns parsed JSON', async () => {
    const { calls, restore } = mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response(JSON.stringify(['ns1.example.com']), { status: 200 });
    });

    try {
      const client = createOvhClient(baseConfig());
      const result = await client.request<string[]>('GET', '/dedicated/server');

      expect(result).toEqual(['ns1.example.com']);
      expect(calls).toHaveLength(2);

      const timeCall = calls[0] as CapturedRequest;
      const apiCall = calls[1] as CapturedRequest;
      expect(timeCall.url).toBe('https://ca.api.ovh.com/1.0/auth/time');

      expect(apiCall.method).toBe('GET');
      expect(apiCall.url).toBe('https://ca.api.ovh.com/1.0/dedicated/server');
      expect(apiCall.body).toBeUndefined();
      expect(apiCall.headers['Content-Type']).toBeUndefined();
      expect(apiCall.headers['X-Ovh-Application']).toBe(VALID_OVH.appKey);
      expect(apiCall.headers['X-Ovh-Consumer']).toBe(VALID_OVH.consumerKey);
      expect(apiCall.headers['X-Ovh-Timestamp']).toBe('1234567890');
      expect(apiCall.headers['X-Ovh-Signature']).toMatch(/^\$1\$[a-f0-9]{40}$/);
    } finally {
      restore();
    }
  });

  test('uses the EU endpoint when region is "eu"', async () => {
    const { calls, restore } = mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response('[]', { status: 200 });
    });

    try {
      const client = createOvhClient({ ...baseConfig(), region: 'eu' });
      await client.request('GET', '/dedicated/server');

      const timeCall = calls[0] as CapturedRequest;
      const apiCall = calls[1] as CapturedRequest;
      expect(timeCall.url).toBe('https://eu.api.ovh.com/1.0/auth/time');
      expect(apiCall.url).toBe('https://eu.api.ovh.com/1.0/dedicated/server');
    } finally {
      restore();
    }
  });

  test('PUT request includes Content-Type, body, and body in signature', async () => {
    const { calls, restore } = mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    try {
      const client = createOvhClient(baseConfig());
      const result = await client.request<void>('PUT', '/dedicated/server/x', {
        efiBootloaderPath: '\\efi\\systemd\\systemd-bootx64.efi',
      });

      expect(result).toBeUndefined();
      const apiCall = calls[1] as CapturedRequest;
      expect(apiCall.method).toBe('PUT');
      expect(apiCall.body).toBe(
        '{"efiBootloaderPath":"\\\\efi\\\\systemd\\\\systemd-bootx64.efi"}',
      );
      expect(apiCall.headers['Content-Type']).toBe('application/json');
    } finally {
      restore();
    }
  });

  test('PUT body is included in the SHA1 signature', async () => {
    const { calls, restore } = mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    try {
      const client = createOvhClient(baseConfig());
      await client.request('PUT', '/x', { foo: 'bar' });

      const apiCall = calls[1] as CapturedRequest;
      const body = apiCall.body ?? '';
      const expected = Bun.SHA1.hash(
        `${VALID_OVH.appSecret}+${VALID_OVH.consumerKey}+PUT+https://ca.api.ovh.com/1.0/x+${body}+1234567890`,
        'hex',
      );
      expect(apiCall.headers['X-Ovh-Signature']).toBe(`$1$${expected}`);
    } finally {
      restore();
    }
  });

  test('returns parsed JSON for 200 responses with body', async () => {
    const { restore } = mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response(
        JSON.stringify({
          efiBootloaderPath: '\\efi\\systemd\\systemd-bootx64.efi',
        }),
        { status: 200 },
      );
    });

    try {
      const client = createOvhClient(baseConfig());
      const result = await client.request<{ efiBootloaderPath: string }>(
        'GET',
        '/dedicated/server/x',
      );
      expect(result.efiBootloaderPath).toBe(
        '\\efi\\systemd\\systemd-bootx64.efi',
      );
    } finally {
      restore();
    }
  });

  test('throws on server time failure', async () => {
    const { restore } = mockFetch(() => {
      return new Response('unavailable', { status: 503 });
    });

    try {
      const client = createOvhClient(baseConfig());
      await expect(client.request('GET', '/dedicated/server')).rejects.toThrow(
        'Failed to get OVH server time',
      );
    } finally {
      restore();
    }
  });

  test('throws on API error response with body included', async () => {
    let callCount = 0;
    const { restore } = mockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response('{"message":"Not found"}', { status: 404 });
    });

    try {
      const client = createOvhClient(baseConfig());
      await expect(
        client.request('GET', '/dedicated/server/missing'),
      ).rejects.toThrow('OVH API 404 on /dedicated/server/missing');
    } finally {
      restore();
    }
  });
});

describe('loadOvhConfig', () => {
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { force: true, recursive: true });
      tmpDir = '';
    }
  });

  function mockLogger() {
    const logs: Array<{ level: string; message: string }> = [];
    const handler = (level: string) => (msg: string) => {
      logs.push({ level, message: msg });
    };
    return {
      logger: {
        debug: handler('debug'),
        error: handler('error'),
        info: handler('info'),
        warn: handler('warn'),
      } as ReturnType<typeof import('./logger').createLogger>,
      logs,
    };
  }

  test('parses a valid OVH-only config', async () => {
    tmpDir = mkdtempSync('/tmp/ovh-lib-test-');
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(
      configPath,
      [
        '[ovh]',
        'appKey = "key"',
        'appSecret = "secret"',
        'consumerKey = "ckey"',
      ].join('\n'),
    );

    const { logger } = mockLogger();
    const config = await loadOvhConfig(configPath, logger);

    expect(config.ovh.appKey).toBe('key');
    expect(config.ovh.appSecret).toBe('secret');
    expect(config.ovh.consumerKey).toBe('ckey');
    expect(config.region).toBeUndefined();
  });

  test('parses region when provided', async () => {
    tmpDir = mkdtempSync('/tmp/ovh-lib-test-');
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(
      configPath,
      [
        'region = "eu"',
        '[ovh]',
        'appKey = "key"',
        'appSecret = "secret"',
        'consumerKey = "ckey"',
      ].join('\n'),
    );

    const { logger } = mockLogger();
    const config = await loadOvhConfig(configPath, logger);
    expect(config.region).toBe('eu');
  });

  test('exits when OVH section is missing', async () => {
    tmpDir = mkdtempSync('/tmp/ovh-lib-test-');
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(configPath, 'region = "ca"');

    const { logger, logs } = mockLogger();
    const exitSpy = mock(() => {});
    const originalExit = process.exit;
    process.exit = exitSpy as never;

    try {
      await loadOvhConfig(configPath, logger);
      expect(exitSpy).toHaveBeenCalled();
      expect(logs.some((l) => l.level === 'error')).toBe(true);
    } finally {
      process.exit = originalExit;
    }
  });

  test('exits when required OVH field is missing', async () => {
    tmpDir = mkdtempSync('/tmp/ovh-lib-test-');
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(
      configPath,
      ['[ovh]', 'appKey = "key"', 'appSecret = "secret"'].join('\n'),
    );

    const { logger } = mockLogger();
    const exitSpy = mock(() => {});
    const originalExit = process.exit;
    process.exit = exitSpy as never;

    try {
      await loadOvhConfig(configPath, logger);
      expect(exitSpy).toHaveBeenCalled();
    } finally {
      process.exit = originalExit;
    }
  });

  test('exits when region is invalid', async () => {
    tmpDir = mkdtempSync('/tmp/ovh-lib-test-');
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(
      configPath,
      [
        'region = "us"',
        '[ovh]',
        'appKey = "key"',
        'appSecret = "secret"',
        'consumerKey = "ckey"',
      ].join('\n'),
    );

    const { logger } = mockLogger();
    const exitSpy = mock(() => {});
    const originalExit = process.exit;
    process.exit = exitSpy as never;

    try {
      await loadOvhConfig(configPath, logger);
      expect(exitSpy).toHaveBeenCalled();
    } finally {
      process.exit = originalExit;
    }
  });
});

describe('listServers', () => {
  test('calls GET /dedicated/server and returns service names', async () => {
    const { calls, restore } = mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response(JSON.stringify(['abc123.server', 'def456.server']), {
        status: 200,
      });
    });

    try {
      const client = createOvhClient(baseConfig());
      const servers = await listServers(client);
      expect(servers).toEqual(['abc123.server', 'def456.server']);
      const apiCall = calls[1] as CapturedRequest;
      expect(apiCall.url).toBe('https://ca.api.ovh.com/1.0/dedicated/server');
    } finally {
      restore();
    }
  });
});

describe('getServer', () => {
  function mockServerResponder(
    server: Record<string, unknown>,
    timestamp = 1234567890,
  ) {
    return mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response(String(timestamp), { status: 200 });
      }
      return new Response(JSON.stringify(server), { status: 200 });
    });
  }

  test('returns parsed server details', async () => {
    const { restore } = mockServerResponder({
      bootId: 42,
      bootScript: null,
      efiBootloaderPath: '\\efi\\systemd\\systemd-bootx64.efi',
      name: 'vmh01',
      state: 'ok',
    });

    try {
      const client = createOvhClient(baseConfig());
      const server = await getServer(client, 'abc123.server');
      expect(server.efiBootloaderPath).toBe(
        '\\efi\\systemd\\systemd-bootx64.efi',
      );
      expect(server.bootId).toBe(42);
      expect(server.state).toBe('ok');
      expect(server.name).toBe('vmh01');
    } finally {
      restore();
    }
  });

  test('URL-encodes the service name in the path', async () => {
    const { calls, restore } = mockServerResponder({
      efiBootloaderPath: null,
      state: 'ok',
    });

    try {
      const client = createOvhClient(baseConfig());
      await getServer(client, 'foo bar.server');
      const apiCall = calls[1] as CapturedRequest;
      expect(apiCall.url).toBe(
        'https://ca.api.ovh.com/1.0/dedicated/server/foo%20bar.server',
      );
    } finally {
      restore();
    }
  });

  test('handles null efiBootloaderPath', async () => {
    const { restore } = mockServerResponder({
      efiBootloaderPath: null,
      state: 'ok',
    });

    try {
      const client = createOvhClient(baseConfig());
      const server = await getServer(client, 'abc123.server');
      expect(server.efiBootloaderPath).toBeNull();
    } finally {
      restore();
    }
  });

  test('exposes iam.displayName and iam.urn when present', async () => {
    const { restore } = mockServerResponder({
      efiBootloaderPath: null,
      iam: {
        displayName: 'vmh01 - Proxmox hypervisor',
        id: '11111111-2222-3333-4444-555555555555',
        state: 'OK',
        tags: { env: 'production', role: 'proxmox' },
        urn: 'urn:v1:eu:resource:dedicatedServer:vmh01.server',
      },
      name: 'vmh01',
      state: 'ok',
    });

    try {
      const client = createOvhClient(baseConfig());
      const server = await getServer(client, 'abc123.server');
      expect(server.iam?.displayName).toBe('vmh01 - Proxmox hypervisor');
      expect(server.iam?.urn).toBe(
        'urn:v1:eu:resource:dedicatedServer:vmh01.server',
      );
      expect(server.iam?.tags).toEqual({
        env: 'production',
        role: 'proxmox',
      });
    } finally {
      restore();
    }
  });

  test('falls back to bare name when iam is absent', async () => {
    const { restore } = mockServerResponder({
      name: 'vmh01',
      state: 'ok',
    });

    try {
      const client = createOvhClient(baseConfig());
      const server = await getServer(client, 'abc123.server');
      expect(server.iam).toBeUndefined();
      expect(server.name).toBe('vmh01');
    } finally {
      restore();
    }
  });

  test('throws on unexpected response shape', async () => {
    const { restore } = mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response(JSON.stringify({ state: 'thisIsNotAValidState' }), {
        status: 200,
      });
    });

    try {
      const client = createOvhClient(baseConfig());
      await expect(getServer(client, 'abc123.server')).rejects.toThrow(
        'Unexpected OVH response for abc123.server',
      );
    } finally {
      restore();
    }
  });
});

describe('updateBootLoader', () => {
  test('sends PUT with the correct body and path', async () => {
    const { calls, restore } = mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    try {
      const client = createOvhClient(baseConfig());
      await updateBootLoader(
        client,
        'abc123.server',
        '\\efi\\systemd\\systemd-bootx64.efi',
      );

      const apiCall = calls[1] as CapturedRequest;
      expect(apiCall.method).toBe('PUT');
      expect(apiCall.url).toBe(
        'https://ca.api.ovh.com/1.0/dedicated/server/abc123.server',
      );
      expect(apiCall.body).toBe(
        '{"efiBootloaderPath":"\\\\efi\\\\systemd\\\\systemd-bootx64.efi"}',
      );
      expect(apiCall.headers['Content-Type']).toBe('application/json');
    } finally {
      restore();
    }
  });

  test('URL-encodes the service name in the path', async () => {
    const { calls, restore } = mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response(null, { status: 204 });
    });

    try {
      const client = createOvhClient(baseConfig());
      await updateBootLoader(
        client,
        'foo bar.server',
        '\\efi\\proxmox\\grubx64.efi',
      );

      const apiCall = calls[1] as CapturedRequest;
      expect(apiCall.url).toBe(
        'https://ca.api.ovh.com/1.0/dedicated/server/foo%20bar.server',
      );
      expect(apiCall.body).toBe(
        '{"efiBootloaderPath":"\\\\efi\\\\proxmox\\\\grubx64.efi"}',
      );
    } finally {
      restore();
    }
  });

  test('propagates API errors', async () => {
    let callCount = 0;
    const { restore } = mockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response('{"message":"forbidden"}', { status: 403 });
    });

    try {
      const client = createOvhClient(baseConfig());
      await expect(
        updateBootLoader(client, 'abc123.server', '\\efi\\x\\y.efi'),
      ).rejects.toThrow('OVH API 403 on /dedicated/server/abc123.server');
    } finally {
      restore();
    }
  });
});

describe('getCurrentCredential', () => {
  test('returns parsed credential metadata', async () => {
    const { calls, restore } = mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response(
        JSON.stringify({
          applicationId: 12345,
          creation: '2026-01-01T00:00:00+00:00',
          expiration: '2027-01-01T00:00:00+00:00',
          lastLogin: '2026-06-01T00:00:00+00:00',
          scope: 'dedicated-server',
          status: 'validated',
        }),
        { status: 200 },
      );
    });

    try {
      const client = createOvhClient(baseConfig());
      const cred = await getCurrentCredential(client);

      expect(cred.applicationId).toBe(12345);
      expect(cred.status).toBe('validated');
      expect(cred.scope).toBe('dedicated-server');

      const apiCall = calls[1] as CapturedRequest;
      expect(apiCall.url).toBe(
        'https://ca.api.ovh.com/1.0/auth/currentCredential',
      );
      expect(apiCall.method).toBe('GET');
    } finally {
      restore();
    }
  });

  test('throws on unexpected response shape', async () => {
    const { restore } = mockFetch((input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.endsWith('/auth/time')) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'notAValidStatus' }), {
        status: 200,
      });
    });

    try {
      const client = createOvhClient(baseConfig());
      await expect(getCurrentCredential(client)).rejects.toThrow(
        'Unexpected OVH response for /auth/currentCredential',
      );
    } finally {
      restore();
    }
  });

  test('propagates 403 NOT_GRANTED_CALL for /auth/currentCredential', async () => {
    let callCount = 0;
    const { restore } = mockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return new Response('1234567890', { status: 200 });
      }
      return new Response(
        '{"class":"Client::Forbidden","message":"This call has not been granted","errorCode":"NOT_GRANTED_CALL"}',
        { status: 403 },
      );
    });

    try {
      const client = createOvhClient(baseConfig());
      await expect(getCurrentCredential(client)).rejects.toThrow(
        'OVH API 403 on /auth/currentCredential',
      );
    } finally {
      restore();
    }
  });
});

// Reference: timeResponder is exported above for clarity if more tests are added.
void timeResponder;
