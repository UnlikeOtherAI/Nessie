#!/usr/bin/env node

import { loadConfig } from '@nessie/config'

const config = loadConfig()

console.log(`nessie cli ready (${config.mode})`)
