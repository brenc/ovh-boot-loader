import type { Command } from '@commander-js/extra-typings';
import { createLogger } from './logger';
import {
  createOvhClient,
  type DedicatedServer,
  type GlobalOptions,
  getServer,
  loadOvhConfig,
} from './ovh-lib';

type BootLoaderGlobalOptions = GlobalOptions;

const PAD = 18;

const UNSET = '(unset)';

/**
 * Format a server field for display. `null` and `undefined` are shown as
 * `(unset)` so the field is never silently hidden; this is critical for
 * `efiBootloaderPath` in particular since the Proxmox-9.2-memtest bug only
 * manifests when the value is unset and rEFInd falls back to scanning.
 * @param value - Raw field value from the OVH API
 * @returns Human-readable string
 */
function formatField(value: string | null | undefined): string {
  if (value === null || value === undefined) return UNSET;
  if (value === '') return '(empty)';
  return value;
}

/**
 * Register the `get` subcommand on the commander program.
 * Shows the current EFI boot loader path and other boot-related settings for a server.
 * @param program - Commander program instance to register the command on
 */
export function registerGetCommand(program: Command) {
  program
    .command('get')
    .description(
      'Show current EFI boot loader path and other boot settings for a server',
    )
    .argument('<serviceName>', 'OVH service name (e.g. abc123.server)')
    .action(async (serviceName: string) => {
      const opts = program.optsWithGlobals() as BootLoaderGlobalOptions;
      const logger = createLogger({
        debug: opts.debug,
        env: opts.env,
        moduleName: 'ovh-boot-loader',
      });
      const config = await loadOvhConfig(opts.config, logger);
      const client = createOvhClient(config);

      const server: DedicatedServer = await getServer(client, serviceName);

      const displayName = server.iam?.displayName ?? server.name;
      const iamUrn = server.iam?.urn;

      const fields: Array<[string, string]> = [
        ['serviceName', serviceName],
        ['name', formatField(displayName)],
        ['state', formatField(server.state)],
        ['efiBootloaderPath', formatField(server.efiBootloaderPath)],
        ['bootId', server.bootId == null ? UNSET : String(server.bootId)],
        ['bootScript', formatField(server.bootScript)],
        ['iam.urn', formatField(iamUrn)],
      ];

      for (const [key, value] of fields) {
        console.log(`${key.padEnd(PAD)} ${value}`);
      }
    });
}
