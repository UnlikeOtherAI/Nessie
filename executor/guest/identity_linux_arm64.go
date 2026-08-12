//go:build linux && arm64

package main

import (
	"os"
	"syscall"
)

func dropGuestPrivileges(workspaceAttached bool) error {
	var workspaceUserID uint32
	var workspaceGroupID uint32
	if workspaceAttached {
		info, err := os.Stat("/work")
		if err != nil {
			return err
		}
		metadata, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return errInvalidFrame
		}
		workspaceUserID = metadata.Uid
		workspaceGroupID = metadata.Gid
	}
	identity, err := selectGuestIdentity(workspaceAttached, workspaceUserID, workspaceGroupID)
	if err != nil {
		return err
	}
	if err := syscall.Setgroups([]int{int(identity.groupID)}); err != nil {
		return err
	}
	if err := syscall.Setgid(int(identity.groupID)); err != nil {
		return err
	}
	if err := syscall.Setuid(int(identity.userID)); err != nil {
		return err
	}
	if os.Geteuid() != int(identity.userID) || os.Getegid() != int(identity.groupID) {
		return errInvalidFrame
	}
	return nil
}
