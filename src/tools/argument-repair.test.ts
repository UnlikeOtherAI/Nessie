import { describe, expect, it } from 'vitest'
import { repairSmartQuotedArgs } from './argument-repair.js'

describe('repairSmartQuotedArgs', () => {
  it('returns null for valid JSON with no smart quotes', () => {
    const input = '{"command": "ls", "description": "list files"}'
    expect(repairSmartQuotedArgs(input)).toBeNull()
  })

  it('repairs smart-quoted object keys and values', () => {
    const input = '{\u201ccommand\u201d: \u201cls\u201d, \u201cdescription\u201d: \u201clist files\u201d}'
    const result = repairSmartQuotedArgs(input)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ command: 'ls', description: 'list files' })
  })

  it('repairs escape sequences within smart-quoted strings', () => {
    const input = '{\u201ccontent\u201d: \u201cline1\\nline2\\ttabbed\u201d}'
    const result = repairSmartQuotedArgs(input)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ content: 'line1\nline2\ttabbed' })
  })

  it('repairs edit array with old_string/new_string objects', () => {
    const input = '[{\u201cold_string\u201d: \u201cfoo\u201d, \u201cnew_string\u201d: \u201cbar\u201d}]'
    const result = repairSmartQuotedArgs(input)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual([{ old_string: 'foo', new_string: 'bar' }])
  })

  it('uses tool-specific successor key detection for FileRead', () => {
    const input = '{\u201cfile_path\u201d: \u201c/path/to/file\u201d, \u201coffset\u201d: 10, \u201climit\u201d: 20}'
    const result = repairSmartQuotedArgs(input, 'FileRead')
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ file_path: '/path/to/file', offset: 10, limit: 20 })
  })

  it('uses tool-specific successor key detection for Bash', () => {
    const input = '{\u201ccommand\u201d: \u201cecho hello\u201d, \u201cdescription\u201d: \u201csay hi\u201d, \u201ctimeout\u201d: 5000}'
    const result = repairSmartQuotedArgs(input, 'Bash')
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ command: 'echo hello', description: 'say hi', timeout: 5000 })
  })

  it('returns null for unrepairable input', () => {
    const input = '{\u201ccommand\u201d: \u201cls\u201d' // missing closing brace
    expect(repairSmartQuotedArgs(input)).toBeNull()
  })

  it('returns null for completely broken JSON', () => {
    const input = 'this is not json at all'
    expect(repairSmartQuotedArgs(input)).toBeNull()
  })

  it('handles mixed smart and regular quotes', () => {
    const input = '{"command": \u201cls -la\u201d, "description": "list all"}'
    const result = repairSmartQuotedArgs(input)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ command: 'ls -la', description: 'list all' })
  })

  it('handles freeform text that contains what looks like a key', () => {
    // content is freeform; the word "description" inside it should NOT be treated as a key
    const input = '{\u201cfile_path\u201d: \u201cfoo.txt\u201d, \u201ccontent\u201d: \u201chello world description: test\u201d}'
    const result = repairSmartQuotedArgs(input, 'FileWrite')
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({
      file_path: 'foo.txt',
      content: 'hello world description: test',
    })
  })

  it('handles nested objects with smart quotes', () => {
    const input = '{\u201caction\u201d: \u201ccreate\u201d, \u201cname\u201d: \u201cMy Workflow\u201d, \u201cownerAgentId\u201d: \u201cmain\u201d}'
    const result = repairSmartQuotedArgs(input, 'Workflow')
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ action: 'create', name: 'My Workflow', ownerAgentId: 'main' })
  })

  it('handles smart single quotes', () => {
    const input = '{\u2018command\u2019: \u2018ls\u2019}'
    const result = repairSmartQuotedArgs(input)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ command: 'ls' })
  })

  it('handles backslashes inside smart-quoted strings', () => {
    const input = '{\u201ccommand\u201d: \u201cecho \\\\ hello\u201d}'
    const result = repairSmartQuotedArgs(input)
    expect(result).not.toBeNull()
    expect(JSON.parse(result!)).toEqual({ command: 'echo \\ hello' })
  })
})
