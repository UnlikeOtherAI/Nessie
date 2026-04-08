import { scrypt as nodeScrypt, randomBytes, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(nodeScrypt)
const HASH_PREFIX = 'scrypt'
const KEY_LENGTH = 64

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16).toString('hex')
  const derivedKey = (await scrypt(password, salt, KEY_LENGTH)) as Buffer
  return `${HASH_PREFIX}$${salt}$${derivedKey.toString('hex')}`
}

export const verifyPassword = async (
  password: string,
  passwordHash: string,
): Promise<boolean> => {
  const [prefix, salt, encodedHash] = passwordHash.split('$')

  if (!prefix || !salt || !encodedHash || prefix !== HASH_PREFIX) {
    return false
  }

  const expectedHash = Buffer.from(encodedHash, 'hex')
  const actualHash = (await scrypt(password, salt, expectedHash.length)) as Buffer
  return timingSafeEqual(expectedHash, actualHash)
}
