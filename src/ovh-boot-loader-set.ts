import type { Command } from '@commander-js/extra-typings';
import { createLogger } from './logger';
import {
  createOvhClient,
  type GlobalOptions,
  getServer,
  loadOvhConfig,
  updateBootLoader,
} from './ovh-lib';

type BootLoaderGlobalOptions = GlobalOptions;

const PAD = 22;

/**
 * Register the `set` subcommand on the commander program.
 * Updates the EFI boot loader path on a single dedicated server.
 * @param program - Commander program instance to register the command on
 */
export function registerSetCommand(program: Command) {
  program
    .command('set')
    .description(
      'Set the EFI boot loader path on a dedicated server (e.g. \\efi\\systemd\\systemd-bootx64.efi)',
    )
    .argument('<serviceName>', 'OVH service name (e.g. abc123.server)')
    .argument('<efiBootloaderPath>', 'New EFI boot loader path')
    .action(async (serviceName: string, efiBootloaderPath: string) => {
      const opts = program.optsWithGlobals() as BootLoaderGlobalOptions;
      const logger = createLogger({
        debug: opts.debug,
        env: opts.env,
        moduleName: 'ovh-boot-loader',
      });
      const config = await loadOvhConfig(opts.config, logger);
      const client = createOvhClient(config);

      const before = await getServer(client, serviceName);
      const current = before.efiBootloaderPath ?? '(unset)';

      console.log(`[${serviceName}]`);
      console.log(`${'current efiBootloaderPath:'.padEnd(PAD)} ${current}`);
      console.log(
        `${'new     efiBootloaderPath:'.padEnd(PAD)} ${efiBootloaderPath}`,
      );

      await updateBootLoader(client, serviceName, efiBootloaderPath);

      console.log('  ✓ updated');
    });
}
