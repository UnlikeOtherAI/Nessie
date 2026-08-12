//go:build linux && arm64

package main

import (
	"os"
	"syscall"
)

const codingRuntimeDirectory = "/run/nessie-executor"

func rootOwnedRuntimeDirectory(path string) error {
	if err := os.Mkdir(path, 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o755 {
		return errInvalidFrame
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || metadata.Uid != 0 || metadata.Gid != 0 {
		return errInvalidFrame
	}
	return nil
}

func writeRootRuntimeFile(path, contents string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o444)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(contents); err != nil {
		_ = file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Chmod(path, 0o444); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o444 {
		return errInvalidFrame
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok || metadata.Uid != 0 || metadata.Gid != 0 {
		return errInvalidFrame
	}
	return nil
}

// prepareCodingRuntime creates the immutable tmux configuration before the
// guest drops privileges. The socket directory is private to the one guest
// identity; the configuration remains root-owned so a coding CLI cannot alter
// its lifecycle policy after launch.
func prepareCodingRuntime(identity guestIdentity, sessionProof string) error {
	if !validBootstrapToken(sessionProof) {
		return errInvalidFrame
	}
	if err := os.Mkdir("/run", 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	if err := rootOwnedRuntimeDirectory(codingRuntimeDirectory); err != nil {
		return err
	}
	if err := rootOwnedRuntimeDirectory(codingCodexHomePath); err != nil {
		return err
	}
	if err := writeRootRuntimeFile(codingConfigPath, "set-option -g remain-on-exit on\nset-option -g status off\n"); err != nil {
		return err
	}
	if err := writeRootRuntimeFile(codingCodexHomePath+"/config.toml", codingCodexConfig); err != nil {
		return err
	}
	if err := writeRootRuntimeFile(codingClaudeSettingsPath, codingClaudeSettings); err != nil {
		return err
	}
	if err := os.Mkdir("/run/nessie-executor/tmux", 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	if err := os.Chown("/run/nessie-executor/tmux", int(identity.userID), int(identity.groupID)); err != nil {
		return err
	}
	if err := os.Chmod("/run/nessie-executor/tmux", 0o700); err != nil {
		return err
	}
	socketDirectory, err := os.Lstat("/run/nessie-executor/tmux")
	if err != nil || !socketDirectory.IsDir() || socketDirectory.Mode()&os.ModeSymlink != 0 || socketDirectory.Mode().Perm() != 0o700 {
		return errInvalidFrame
	}
	socketMetadata, ok := socketDirectory.Sys().(*syscall.Stat_t)
	if !ok || socketMetadata.Uid != identity.userID || socketMetadata.Gid != identity.groupID {
		return errInvalidFrame
	}
	return nil
}
