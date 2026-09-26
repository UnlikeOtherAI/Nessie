import assert from 'node:assert/strict'
import test from 'node:test'

import { isAnnouncementAdministrator } from '../src/channel-announcement-authority.js'

const base = {
  channelType: 'standard', systemChannelType: null,
  isOrganizationAdmin: false, externalOrgId: 'org-1',
  externalTeamId: 'team-1',
}

test('only the exact live UOA team admin or an org admin may control announcements', () => {
  assert.equal(isAnnouncementAdministrator({
    ...base, uoaTeamRoles: { 'team-1': 'admin' },
  }), true)
  assert.equal(isAnnouncementAdministrator({
    ...base, uoaTeamRoles: { 'team-2': 'admin', 'team-1': 'member' },
  }), false)
  assert.equal(isAnnouncementAdministrator({
    ...base, uoaTeamRoles: { 'team-1': 'lead' },
  }), false)
  assert.equal(isAnnouncementAdministrator({
    ...base, isOrganizationAdmin: true,
  }), true)
  assert.equal(isAnnouncementAdministrator({
    ...base, channelType: 'dm', isOrganizationAdmin: true,
  }), false)
  assert.equal(isAnnouncementAdministrator({
    ...base, systemChannelType: 'personal_assistant', isOrganizationAdmin: true,
  }), false)
})

test('local team admins may control their standard channels', () => {
  assert.equal(isAnnouncementAdministrator({
    ...base, externalOrgId: null, externalTeamId: null, localTeamRole: 'owner',
  }), true)
  assert.equal(isAnnouncementAdministrator({
    ...base, externalOrgId: null, externalTeamId: null, localTeamRole: 'member',
  }), false)
})
