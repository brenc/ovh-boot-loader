import { z } from 'zod';
import type { createLogger } from './logger';

const FETCH_TIMEOUT = 15_000;

/** OVH API endpoint URLs by region. */
export const OVH_ENDPOINTS = {
  ca: 'https://ca.api.ovh.com/1.0',
  eu: 'https://eu.api.ovh.com/1.0',
} as const;

/** OVH API region. The default `ca` matches the existing ddos-monitor deployment. */
export type OvHEndpoint = keyof typeof OVH_ENDPOINTS;

/** OVH API credentials used to sign requests (SHA1). */
export const OvhCredentialsSchema = z.object({
  appKey: z.string().min(1),
  appSecret: z.string().min(1),
  consumerKey: z.string().min(1),
});

/** OVH API credentials. */
export type OvhCredentials = z.infer<typeof OvhCredentialsSchema>;

/** Validated OVH client configuration. */
export interface OvhClientConfig {
  /** OVH API credentials. */
  ovh: OvhCredentials;
  /** API region. Defaults to `ca` to match ddos-monitor. */
  region?: OvHEndpoint;
}

/** Minimal signed-request client interface. */
export interface OvhClient {
  /** Base URL this client targets (depends on configured region). */
  endpoint: string;
  /**
   * Make a signed request to the OVH API.
   * @param method - HTTP method
   * @param path - API path (e.g. `/dedicated/server`)
   * @param body - Optional JSON-serializable body for PUT/POST
   * @returns Parsed JSON response, or `undefined` for empty 204 responses
   */
  request: <T>(method: string, path: string, body?: unknown) => Promise<T>;
}

/** OVH-only config schema (no Discord/state fields). */
export const OvhOnlyConfigSchema = z.object({
  ovh: OvhCredentialsSchema,
  region: z.enum(['ca', 'eu']).optional(),
});

/** Validated OVH-only config (just credentials + optional region). */
export type OvhOnlyConfig = z.infer<typeof OvhOnlyConfigSchema>;

/** Global CLI options shared across all OVH subcommands. */
export interface GlobalOptions {
  config: string;
  debug: boolean;
  env: 'production' | 'development';
}

/** Raw parsed TOML shape for the OVH-only config. */
interface RawOvhConfig {
  ovh?: {
    appKey?: unknown;
    appSecret?: unknown;
    consumerKey?: unknown;
  };
  region?: unknown;
}

/** State enum for OVH dedicated servers. */
const DedicatedServerStateSchema = z.enum([
  'ok',
  'error',
  'hacked',
  'hacking',
  'locked',
]);

/**
 * IAM resource metadata embedded in service models. The `displayName` is the
 * user-friendly name set in the OVH IAM/manager UI; the other fields are
 * read-only identifiers and tags.
 */
export const IamResourceMetadataSchema = z.object({
  displayName: z.string().nullable().optional(),
  id: z.string().optional(),
  state: z.string().nullable().optional(),
  tags: z.record(z.string(), z.string()).nullable().optional(),
  urn: z.string().optional(),
});

/** IAM resource metadata for a dedicated server. */
export type IamResourceMetadata = z.infer<typeof IamResourceMetadataSchema>;

/**
 * Subset of the dedicated server fields relevant to boot-loader management.
 * The full response includes many read-only identity fields that are ignored.
 */
export const DedicatedServerSchema = z.object({
  bootId: z.number().int().nullable().optional(),
  bootScript: z.string().nullable().optional(),
  efiBootloaderPath: z.string().nullable().optional(),
  iam: IamResourceMetadataSchema.nullable().optional(),
  name: z.string().optional(),
  state: DedicatedServerStateSchema.optional(),
});

/** Dedicated server details as returned by `GET /dedicated/server/{serviceName}`. */
export type DedicatedServer = z.infer<typeof DedicatedServerSchema>;

/**
 * Known-good EFI boot loader paths for Proxmox installations.
 * The OVH backend uses Windows-style backslash paths; values are sent verbatim
 * and JSON-encoded by the client.
 */
export const PROXMOX_BOOT_LOADER_PATHS = {
  /** Proxmox installations using GRUB. */
  grub: '\\efi\\proxmox\\grubx64.efi',
  /** Proxmox 9.2+ default (systemd-boot). */
  systemdBoot: '\\efi\\systemd\\systemd-bootx64.efi',
} as const;

/**
 * Create an OVH API client with SHA1 request signing.
 * Supports arbitrary HTTP methods; non-GET requests may carry a JSON body which
 * is included in the signature.
 * @param config - Validated config containing OVH credentials and optional region
 * @returns Client with a typed `request` method
 */
export function createOvhClient(config: OvhClientConfig): OvhClient {
  const { appKey, appSecret, consumerKey } = config.ovh;
  const baseUrl = OVH_ENDPOINTS[config.region ?? 'ca'];

  /**
   * Sign an OVH API request.
   * @param method - HTTP method
   * @param url - Full API URL
   * @param body - JSON-serialized body (empty string for GET/no-body requests)
   * @param timestamp - Current OVH server timestamp
   * @returns SHA1 signature prefixed with `$1$`
   */
  function sign(
    method: string,
    url: string,
    body: string,
    timestamp: number,
  ): string {
    const toSign = `${appSecret}+${consumerKey}+${method}+${url}+${body}+${timestamp}`;
    return Bun.SHA1.hash(toSign, 'hex');
  }

  /**
   * Make a signed request to the OVH API.
   * @param method - HTTP method
   * @param path - API path (e.g. `/dedicated/server`)
   * @param body - Optional JSON-serializable body for PUT/POST
   * @returns Parsed JSON response, or `undefined` for empty 204 responses
   */
  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const bodyStr = body !== undefined ? JSON.stringify(body) : '';

    const timeRes = await fetch(`${baseUrl}/auth/time`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!timeRes.ok) {
      throw new Error(`Failed to get OVH server time: ${timeRes.status}`);
    }
    const timestamp = (await timeRes.json()) as number;

    const signature = sign(method, url, bodyStr, timestamp);

    const headers: Record<string, string> = {
      'X-Ovh-Application': appKey,
      'X-Ovh-Consumer': consumerKey,
      'X-Ovh-Signature': `$1$${signature}`,
      'X-Ovh-Timestamp': String(timestamp),
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      body: bodyStr || undefined,
      headers,
      method,
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`OVH API ${res.status} on ${path}: ${errorBody}`);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    return (await res.json()) as T;
  }

  return { endpoint: baseUrl, request };
}

/**
 * Load and validate a TOML config file with OVH credentials.
 * @param configPath - Absolute path to the TOML config file
 * @param logger - Logger instance for error reporting
 * @returns Validated configuration object
 */
export async function loadOvhConfig(
  configPath: string,
  logger: ReturnType<typeof createLogger>,
): Promise<OvhOnlyConfig> {
  const text = await Bun.file(configPath).text();
  const raw: RawOvhConfig = Bun.TOML.parse(text);
  const result = OvhOnlyConfigSchema.safeParse(raw);
  if (!result.success) {
    logger.error(`Invalid config: ${result.error.message}`);
    process.exit(1);
  }
  return result.data;
}

/** Current OVH credential metadata, returned by `GET /auth/currentCredential`. */
export const CurrentCredentialSchema = z.object({
  applicationId: z.number().int().optional(),
  creation: z.string().optional(),
  expiration: z.string().optional(),
  lastLogin: z.string().optional(),
  oauth2ClientId: z.string().optional(),
  scope: z.string().optional(),
  status: z.enum(['expired', 'pendingValidation', 'validated']).optional(),
});

/** Current OVH credential metadata. */
export type CurrentCredential = z.infer<typeof CurrentCredentialSchema>;

/**
 * Fetch the metadata of the currently active consumer key.
 * Useful for verifying that the configured OVH credentials are valid and reachable
 * before exercising higher-privilege API calls.
 * @param client - OVH API client
 * @returns Current credential metadata
 */
export async function getCurrentCredential(
  client: OvhClient,
): Promise<CurrentCredential> {
  const raw = await client.request<unknown>('GET', '/auth/currentCredential');
  const result = CurrentCredentialSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Unexpected OVH response for /auth/currentCredential: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * List all OVH dedicated server service names on the account.
 * @param client - OVH API client
 * @returns Array of service names (e.g. `["ns1234.ip-1-2-3.eu"]`)
 */
export async function listServers(client: OvhClient): Promise<string[]> {
  return client.request<string[]>('GET', '/dedicated/server');
}

/**
 * Get details for a single dedicated server, including the current EFI boot loader path.
 * @param client - OVH API client
 * @param serviceName - OVH service name (e.g. `"abc123.server"`)
 * @returns Dedicated server details
 */
export async function getServer(
  client: OvhClient,
  serviceName: string,
): Promise<DedicatedServer> {
  const encoded = encodeURIComponent(serviceName);
  const raw = await client.request<unknown>(
    'GET',
    `/dedicated/server/${encoded}`,
  );

  const result = DedicatedServerSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Unexpected OVH response for ${serviceName}: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Update the EFI boot loader path on a dedicated server.
 * @param client - OVH API client
 * @param serviceName - OVH service name
 * @param efiBootloaderPath - New boot loader path
 *   (e.g. `"\\efi\\systemd\\systemd-bootx64.efi"` for Proxmox 9.2+ systemd-boot)
 */
export async function updateBootLoader(
  client: OvhClient,
  serviceName: string,
  efiBootloaderPath: string,
): Promise<void> {
  const encoded = encodeURIComponent(serviceName);
  await client.request<void>('PUT', `/dedicated/server/${encoded}`, {
    efiBootloaderPath,
  });
}
