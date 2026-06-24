#!/usr/bin/env bun

import { Command, Option } from '@commander-js/extra-typings';
import { registerFixProxmoxCommand } from './ovh-boot-loader-fix-proxmox';
import { registerGetCommand } from './ovh-boot-loader-get';
import { registerListCommand } from './ovh-boot-loader-list';
import { registerSetCommand } from './ovh-boot-loader-set';
import { registerWhoamiCommand } from './ovh-boot-loader-whoami';

const program = new Command()
  .name('ovh-boot-loader')
  .description(
    'Manage OVH dedicated server EFI boot loader path (efiBootloaderPath)',
  )
  .version('1.0.0')
  .option(
    '-c, --config <path>',
    'Config file path',
    '/etc/ovh-boot-loader/config.toml',
  )
  .option('-d, --debug', 'Enable debug logging', false)
  .addOption(
    new Option('-e, --env <env>', 'Set environment')
      .choices(['production', 'development'])
      .default('production'),
  );

registerWhoamiCommand(program);
registerListCommand(program);
registerGetCommand(program);
registerSetCommand(program);
registerFixProxmoxCommand(program);

program.parse();
