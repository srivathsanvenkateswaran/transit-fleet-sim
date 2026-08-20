import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('source boundaries', () => {
  it('keeps hostnames, loopback names and service port defaults in config only', async () => {
    const files = await sourceFiles('src')
    const violations: string[] = []
    for (const file of files) {
      if (file.endsWith('/config.ts')) continue
      const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
      if (/localhost|127\.0\.0\.1|0\.0\.0\.0|:8080|:3000/.test(source)) violations.push(file)
    }
    expect(violations).toEqual([])
  })

  it('contains no unseeded random call in source', async () => {
    const forbidden = `Math.${'random'}`
    const violations: string[] = []
    for (const file of await sourceFiles('src')) {
      if ((await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')).includes(forbidden)) {
        violations.push(file)
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps explicit vehicle-class comparisons inside the three profile modules', async () => {
    const allowed = new Set(['src/sim/profile.ts', 'src/sim/device.ts', 'src/sim/duty.ts'])
    const violations: string[] = []
    for (const file of await sourceFiles('src')) {
      if (allowed.has(file)) continue
      const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
      if (/\.class\s*[!=]==?\s*['"](?:bus|metro)['"]/.test(source)) violations.push(file)
    }
    expect(violations).toEqual([])
  })
})

async function sourceFiles(directory: string): Promise<string[]> {
  const absolute = new URL(`../../${directory}/`, import.meta.url)
  const entries = await readdir(absolute, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)))
    else if (extname(entry.name) === '.ts') files.push(relative('.', path))
  }
  return files
}
