# ovh-boot-loader

CLI to manage the **EFI boot loader path** (`efiBootloaderPath`) on OVH dedicated
servers via the [OVH API](https://api.ovh.com/).

This was built to fix a [Proxmox 9.2 regression](https://forum.proxmox.com/threads/memtest-as-default-eefind-option.184148/post-858394)
where Proxmox's update drops a `memtest86+.efi` binary into the EFI System
Partition, which then becomes the most recent ESP entry. rEFInd (the [OVH boot
loader](https://docs.ovhcloud.com/en/guides/bare-metal-cloud/dedicated-servers/boot-process)) picks the most recently-modified `.efi` file, so the server boots into
memtest instead of the actual Proxmox installer. The fix is to set
`efiBootloaderPath = \efi\systemd\systemd-bootx64.efi` on the OVH backend, which
forces rEFInd to launch systemd-boot regardless of ESP timestamps.

## Install

Requirements: [Bun](https://bun.sh/) 1.3+.

```bash
git clone <this repo>
cd ovh-boot-loader
bun install
```

Or build a single static binary and drop it on your `$PATH`:

```bash
bun run build
sudo cp build/ovh-boot-loader /usr/local/bin/
```

## Get an OVH API key

You need three values: an `appKey`, an `appSecret`, and a `consumerKey`. The
app identifies your tool, the secret signs every request, and the consumer key
is a per-user token that carries the granted permissions.

### 1. Create an application

In the OVH API console, create a new application. Pick whichever region your
account uses (CA or EU). Note the **Application Key** and **Application
Secret** — these go into the `[ovh]` section of your config.

### 2. Request a consumer key

A consumer key is a per-user token that you request on the user's behalf. The
request returns a **validation URL** the user must click to authorize the
rights; after authorization, the same response gives you the **Consumer Key**.

Request one with `curl` (replace the placeholder appKey/secret with your own):

```bash
curl -X POST \
  -H "X-Ovh-Application: YOUR_APP_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "accessRules": [
      {"method": "GET",  "path": "/dedicated/server"},
      {"method": "GET",  "path": "/dedicated/server/*"},
      {"method": "PUT",  "path": "/dedicated/server/*"}
    ],
    "redirection": "https://example.com"
  }' \
  https://ca.api.ovh.com/1.0/auth/credential
```

> **Important**: OVH's glob `/dedicated/server/*` does **not** match the bare
> `/dedicated/server` list endpoint. You need all three rules above, not just
> the wildcard ones.

The response looks like:

```json
{
  "validationUrl": "https://ca.api.ovh.com/auth/?credentialToken=...",
  "consumerKey": "abc123...",
  "state": "pendingValidation"
}
```

Open `validationUrl` in a browser, log in as the OVH account holder, and click
**Authorize**. After that, `state` becomes `validated` and the `consumerKey` is
ready to use.

### 3. Configure

```bash
cp config.toml.example config.toml
$EDITOR config.toml
```

The config format is:

```toml
[ovh]
appKey = "..."
appSecret = "..."
consumerKey = "..."

# Optional. Defaults to "ca" (ca.api.ovh.com). Use "eu" for the European
# endpoint. The consumer key must be created on the same region.
# region = "eu"
```

## Usage

```bash
ovh-boot-loader [--config <path>] [--debug] [--env production|development] <command>
```

Default config path: `/etc/ovh-boot-loader/config.toml`. Override with
`--config ./config.toml` for local development.

### `whoami`

Verify the configured credentials are valid and reachable. Hits
`GET /auth/currentCredential` (works with any validated consumer key) and
prints the appKey, status, and creation/expiration dates. Use this first if
anything else 403s.

```bash
ovh-boot-loader whoami
# endpoint:        https://ca.api.ovh.com/1.0
# appKey:          yourAppKey
# status:          validated
# applicationId:   12345
# scope:           ...
# creation:        2026-06-24T...
# lastLogin:       2026-06-24T...
# expiration:      2027-06-24T...
```

### `list`

List all OVH dedicated servers on the account, with the IAM `displayName` next
to the service name when set. Fans out one `GET /dedicated/server/{name}` per
server in parallel.

```bash
ovh-boot-loader list
# ns1234.ip-1-2-3.eu
# vmh01.server       vmh01 - Proxmox hypervisor
# vmh02.server       vmh02 - Proxmox hypervisor
```

### `get`

Show the current boot configuration for a single server. Always prints
`efiBootloaderPath` — `(unset)` if the OVH API returns `null` (which is the
default state for Proxmox 9.2 servers before this fix), the actual path
otherwise. Also shows `iam.urn` for cross-referencing with IAM policies.

```bash
ovh-boot-loader get vmh01.server
# serviceName        vmh01.server
# name               vmh01 - Proxmox hypervisor
# state              ok
# efiBootloaderPath  (unset)                ← this is the bug state
# bootId             (unset)
# bootScript         (unset)
# iam.urn            urn:v1:ca:resource:dedicatedServer:vmh01.server
```

After running `fix-proxmox`, the same command will show:

```
# efiBootloaderPath  \efi\systemd\systemd-bootx64.efi
```

### `set`

Set `efiBootloaderPath` to an arbitrary path on a single server. Use
`fix-proxmox` for the Proxmox 9.2 known-good value; `set` is for everything
else.

```bash
ovh-boot-loader set <serviceName> <efiBootloaderPath>

ovh-boot-loader set vmh01.server '\efi\proxmox\grubx64.efi'
# [vmh01.server]
#   current efiBootloaderPath: \efi\systemd\systemd-bootx64.efi
#   new     efiBootloaderPath: \efi\proxmox\grubx64.efi
#   ✓ updated
```

The path is sent verbatim and JSON-encoded for the API. Use the Windows-style
backslashes the OVH backend expects, not Linux forward slashes.

### `fix-proxmox`

Convenience command for the Proxmox 9.2 rEFInd/memtest bug. Sets
`efiBootloaderPath` to `\efi\systemd\systemd-bootx64.efi` on one or more
servers.

```bash
ovh-boot-loader fix-proxmox vmh01.server vmh02.server vmh03.server
# [vmh01.server]
#   current efiBootloaderPath: (unset)
#   new     efiBootloaderPath: \efi\systemd\systemd-bootx64.efi
#   ✓ updated
#
# [vmh02.server]
#   current efiBootloaderPath: (unset)
#   new     efiBootloaderPath: \efi\systemd\systemd-bootx64.efi
#   ✓ updated
#
# [vmh03.server]
#   ...
```

Use GRUB installations instead? Override with the explicit `set` command and
`\efi\proxmox\grubx64.efi`.

## Troubleshooting

### `OVH API 403: NOT_GRANTED_CALL` on `list`

The consumer key doesn't have `GET /dedicated/server` (the bare list path).
Re-create the consumer key with all three rights — see step 2 above. The
wildcard `/dedicated/server/*` does **not** match the bare path.

### `OVH API 403: NOT_GRANTED_CALL` on `set` or `fix-proxmox`

The consumer key has `GET` rights but no `PUT` on `/dedicated/server/*`. Re-create
the consumer key with the `PUT` rule.

### `OVH API 401`

Either the appKey/appSecret/consumerKey triple is wrong, or the consumer key
hasn't been validated yet. Run `ovh-boot-loader whoami` to check the status
— it should print `status: validated`. If it's `pendingValidation`, the user
hasn't clicked the validation URL yet.

### Works on one server, fails on another with `This server does not exist`

The service name is wrong. `ovh-boot-loader list` prints the actual service
names on the account. The naming format is typically `ns1234.ip-1-2-3.eu` or
`abc123.server` depending on the OVH legacy vs. new range.

### Wrong region

The default endpoint is `ca.api.ovh.com`. If your account is on the European
endpoint, set `region = "eu"` in the config. Consumer keys are region-scoped
— a CA consumer key won't work on the EU endpoint and vice versa.

## Development

```bash
bun install
bun test           # run the OVH lib test suite
bun run type-check # tsc --noEmit
bun run build      # produce a single binary in build/ovh-boot-loader
```

The OVH client lives in `src/ovh-lib.ts`; the CLI subcommands are in the
`src/ovh-boot-loader-*.ts` files. There's no global state — `createOvhClient`
captures credentials in its closure and returns a stateless request function.

## License

MIT
