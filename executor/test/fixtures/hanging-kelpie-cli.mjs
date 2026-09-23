#!/usr/bin/env node
/**
 * A Kelpie CLI whose `describe` never answers — an mDNS sweep that hangs — so
 * detection has to stop it. It writes its own pid to NESSIE_TEST_PID_FILE
 * first, which lets a test see whether the process under a `.cmd` shim was
 * stopped too or left behind when only the shim's `cmd.exe` was.
 */
import { writeFileSync } from 'node:fs'

if (process.env.NESSIE_TEST_PID_FILE) writeFileSync(process.env.NESSIE_TEST_PID_FILE, String(process.pid))
setInterval(() => undefined, 60_000)
