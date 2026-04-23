import type { PathPermissions } from '../agent/types.js'

/**
 * Check if a file path is allowed given the agent's path permissions.
 *
 * Rules:
 * - If permissions is undefined, all paths are allowed (backward compatible).
 * - If allow is set, the path must match at least one allow pattern.
 * - If block is set, the path is denied if it matches any block pattern.
 * - block takes precedence over allow.
 */
export function isPathAllowed(filePath: string, permissions?: PathPermissions): boolean {
  if (!permissions) return true

  // Normalize path separators to forward slashes for consistent pattern matching.
  const normalizedPath = filePath.replace(/\\/g, '/')

  // Check block patterns first — they always deny if matched.
  if (permissions.block && permissions.block.length > 0) {
    for (const pattern of permissions.block) {
      if (matchGlob(normalizedPath, pattern)) {
        return false
      }
    }
  }

  // If allow is set, path must match at least one allow pattern.
  if (permissions.allow && permissions.allow.length > 0) {
    for (const pattern of permissions.allow) {
      if (matchGlob(normalizedPath, pattern)) {
        return true
      }
    }
    // No allow pattern matched.
    return false
  }

  return true
}

/**
 * Match a path against a glob pattern using regex conversion.
 * Supports:
 * - **  (any directory depth)
 * - *   (any characters except /)
 * - ?   (single character except /)
 */
function matchGlob(path: string, pattern: string): boolean {
  const normalizedPattern = pattern.replace(/\\/g, '/')

  // Convert glob pattern to a regex:
  // - Escape all regex special chars first (except * and ?)
  // - Replace ** with a placeholder, then * and ?, then expand placeholder
  const regexPattern = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex metacharacters except * and ?
    .replace(/\*\*/g, '\x00DOUBLE_STAR\x00')  // placeholder for **
    .replace(/\*/g, '[^/]*')                 // * matches anything except /
    .replace(/\?/g, '[^/]')                  // ? matches single char except /
    .replace(/\x00DOUBLE_STAR\x00/g, '.*')   // ** matches anything including /

  const regex = new RegExp(`^${regexPattern}$`)
  return regex.test(path)
}