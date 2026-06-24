import type { Command } from '@commander-js/extra-typings';
import { createLogger } from './logger';
import {
  createOvhClient,
  type GlobalOptions,
  getServer,
  listServers,
  loadOvhConfig,
} from './ovh-lib';

/** Shared CLI options type for boot-loader subcommands. */
export type BootLoaderGlobalOptions = GlobalOptions;

const SEP = '  ';

/**
 * Register the `list` subcommand on the commander program.
 * Lists all OVH dedicated servers on the account, showing the service name
 * and (when available) the IAM `displayName` next to it.
 * @param program - Commander program instance to register the command on
 */
export function registerListCommand(program: Command) {
  program
    .command('list')
    .description(
      'List all OVH dedicated servers, with IAM display name when available',
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

      const serviceNames = await listServers(client);

      const rows = await Promise.all(
        serviceNames.map(async (serviceName) => {
          try {
            const server = await getServer(client, serviceName);
            return {
              displayName: server.iam?.displayName ?? null,
              serviceName,
            };
          } catch (err) {
            logger.warn(
              `Failed to fetch ${serviceName}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return { displayName: null, serviceName };
          }
        }),
      );

      const width = Math.max(...rows.map((r) => r.serviceName.length));
      for (const row of rows) {
        const left = row.serviceName.padEnd(width);
        console.log(row.displayName ? `${left}${SEP}${row.displayName}` : left);
      }
    });
}
