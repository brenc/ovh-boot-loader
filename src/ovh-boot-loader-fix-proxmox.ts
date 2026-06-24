import type { Command } from '@commander-js/extra-typings';
import { createLogger } from './logger';
import {
  createOvhClient,
  type GlobalOptions,
  getServer,
  loadOvhConfig,
  PROXMOX_BOOT_LOADER_PATHS,
  updateBootLoader,
} from './ovh-lib';

type BootLoaderGlobalOptions = GlobalOptions;

const PAD = 22;

/**
 * Register the `fix-proxmox` subcommand on the commander program.
 * Sets the EFI boot loader path to the Proxmox 9.2+ known-good value
 * (`\efi\systemd\systemd-bootx64.efi`) on one or more dedicated servers.
 * @param program - Commander program instance to register the command on
 */
export function registerFixProxmoxCommand(program: Command) {
  program
    .command('fix-proxmox')
    .description(
      'Set the EFI boot loader path to the Proxmox 9.2+ known-good value (\\efi\\systemd\\systemd-bootx64.efi) on one or more servers',
    )
    .argument(
      '<serviceName...>',
      'OVH service name(s) (e.g. abc123.server def456.server)',
    )
    .action(async (serviceNames: string[]) => {
      const opts = program.optsWithGlobals() as BootLoaderGlobalOptions;
      const logger = createLogger({
        debug: opts.debug,
        env: opts.env,
        moduleName: 'ovh-boot-loader',
      });
      const config = await loadOvhConfig(opts.config, logger);
      const client = createOvhClient(config);
      const targetPath = PROXMOX_BOOT_LOADER_PATHS.systemdBoot;

      for (const serviceName of serviceNames) {
        const before = await getServer(client, serviceName);
        const current = before.efiBootloaderPath ?? '(unset)';

        console.log(`[${serviceName}]`);
        console.log(`${'current efiBootloaderPath:'.padEnd(PAD)} ${current}`);
        console.log(
          `${'new     efiBootloaderPath:'.padEnd(PAD)} ${targetPath}`,
        );

        await updateBootLoader(client, serviceName, targetPath);

        console.log('  ✓ updated');
      }
    });
}
