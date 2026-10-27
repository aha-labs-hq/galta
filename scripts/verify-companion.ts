#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { root, minimumMacOS, run } from './distribution/config'

if (process.platform !== 'darwin') throw new Error('Native companion verification requires macOS')
const output = join(root, 'output/companion-tests')
await mkdir(output, { recursive: true })
const binary = join(output, 'CompanionModelTests')
run(['/usr/bin/swiftc', '-parse-as-library', '-warnings-as-errors', '-target', `arm64-apple-macosx${minimumMacOS}`, 'native/companion/Models/RuntimeHealth.swift', 'native/companion/Models/InstallationModel.swift', 'native/companion/Models/BrowserModel.swift', 'native/companion/Support/InstallationPresentation.swift', 'native/companion/Services/BrowserLauncher.swift', 'native/companion/Services/RuntimeProcess.swift', 'tests/native/CompanionFixtures.swift', 'tests/native/CompanionModelTests.swift', '-o', binary])
console.log(run([binary, ...Bun.argv.slice(2)]))
