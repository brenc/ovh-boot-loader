import type { Command } from '@commander-js/extra-typings';
import { createLogger } from './logger';
import {
  createOvhClient,
  type GlobalOptions,
  getCurrentCredential,
  loadOvhConfig,
} from './ovh-lib';

type BootLoaderGlobalOptions = GlobalOptions;

const PAD = 14;

/**
 * Register the `whoami` subcommand on the commander program.
 * Verifies the configured OVH credentials are valid and reachable, and prints
 * the consumer key metadata (app, status, creation/expiration). Useful for
 * diagnosing `NOT_GRANTED_CALL` errors before touching dedicated servers.
 * @param program - Commander program instance to register the command on
 */
export function registerWhoamiCommand(program: Command) {
  program
    .command('whoami')
    .description(
      'Verify the configured OVH credentials are valid and print consumer key metadata',
    )
    .action(async () => {
      const opts = program.optsWithGlobals() as BootLoaderGlobalOptions;
      const logger = createLogger({
        debug: opts.debug,
        env: opts.env,
        moduleName: 'ovh-boot-loader',
      });
      const config = await loadOvhConfig(opts.config, logger);
      const client = createOvhClient(config);

      console.log(`${'endpoint:'.padEnd(PAD)} ${client.endpoint}`);
      console.log(`${'appKey:'.padEnd(PAD)} ${config.ovh.appKey}`);

      const cred = await getCurrentCredential(client);

      const rows: Array<[string, string | undefined]> = [
        ['status', cred.status],
        [
          'applicationId',
          cred.applicationId == null ? undefined : String(cred.applicationId),
        ],
        ['scope', cred.scope],
        ['creation', cred.creation],
        ['lastLogin', cred.lastLogin],
        ['expiration', cred.expiration],
      ];
      for (const [key, value] of rows) {
        if (value === undefined) continue;
        console.log(`${key.padEnd(PAD)} ${value}`);
      }
    });
}
