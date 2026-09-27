import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { z } from 'zod'

const credentialsSchema = z.record(z.string(), z.union([
  z.object({ type: z.literal('api_key'), key: z.string().optional() }).passthrough(),
  z.object({ type: z.literal('oauth'), access: z.string(), refresh: z.string(), expires: z.number() }).passthrough(),
]))

type CredentialRecord = Record<string, Credential>

/** Explicit path only: neither the Pi home directory nor project config is discovered. */
export async function readCredentialFile(filePath: string): Promise<CredentialRecord> {
  if (constants.O_NOFOLLOW === undefined || process.getuid === undefined) {
    throw new Error('Secure credential file access requires a POSIX host')
  }
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
      throw new Error('Credential file must be owned by this process with private (0600) permissions')
    }
    // JSON cannot contain an own property whose value is undefined.
    return credentialsSchema.parse(JSON.parse(await file.readFile('utf8')) as unknown) as CredentialRecord
  } finally {
    await file.close()
  }
}

async function writeCredentialFile(filePath: string, credentials: CredentialRecord): Promise<void> {
  const tempPath = `${filePath}.${randomUUID()}.tmp`
  const file = await open(tempPath, 'wx', 0o600)
  try {
    try {
      await file.writeFile(`${JSON.stringify(credentials, null, 2)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(tempPath, filePath)
  } finally {
    await unlink(tempPath).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

/** Persist OAuth refreshes so a later Run cannot reuse a rotated refresh token. */
export class JsonCredentialStore implements CredentialStore {
  public constructor(private readonly filePath: string) {}

  public async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    this.assertActive(options)
    return (await readCredentialFile(this.filePath))[providerId]
  }

  public async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    this.assertActive(options)
    const credentials = await readCredentialFile(this.filePath)
    return Object.entries(credentials).map(([providerId, credential]) => ({ providerId, type: credential.type }))
  }

  public async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.withLock(async () => {
      const credentials = await readCredentialFile(this.filePath)
      const updated = await fn(credentials[providerId])
      this.assertActive(options)
      if (updated === undefined) return credentials[providerId]
      credentials[providerId] = updated
      await writeCredentialFile(this.filePath, credentials)
      return updated
    }, options)
  }

  public async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await this.withLock(async () => {
      const credentials = await readCredentialFile(this.filePath)
      if (!(providerId in credentials)) return
      delete credentials[providerId]
      await writeCredentialFile(this.filePath, credentials)
    }, options)
  }

  private assertActive(options?: AuthOperationOptions): void {
    if (options?.signal?.aborted) throw new Error('Credential access aborted')
  }

  private async withLock<T>(operation: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    const lockPath = `${this.filePath}.lock`
    for (let attempt = 0; attempt < 200; attempt++) {
      this.assertActive(options)
      let lock
      try {
        lock = await open(lockPath, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        await delay(50, undefined, { signal: options?.signal })
        continue
      }
      try {
        return await operation()
      } finally {
        await lock.close()
        await unlink(lockPath)
      }
    }
    throw new Error('Credential file is locked; verify the owner before removing a stale lock')
  }
}
