import assert from 'node:assert/strict';
import { chmod, copyFile, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { FuseVersion, FuseV1Options } from '@electron/fuses';

export default async function afterPack(context) {
  const { packager, appOutDir, electronPlatformName } = context;
  await packager.addElectronFuses(context, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  if (electronPlatformName !== 'linux') return;

  const name = packager.executableName;
  assert.ok(name && name === basename(name), 'expected a Linux executable filename');
  assert.ok(appOutDir, 'expected the unpacked application directory');
  const executable = join(appOutDir, name);
  await rename(executable, `${executable}.bin`);
  await copyFile(new URL('./linux-launcher.sh', import.meta.url), executable);
  await chmod(executable, 0o755);
}
