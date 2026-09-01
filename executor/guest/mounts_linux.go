//go:build linux

package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"syscall"
)

// One guest binary, two share strategies. macOS gives it virtiofs devices;
// Firecracker and Hyper-V implement no virtio-fs at all, so there the same
// shares arrive as virtio-block images. Which one is in force is a structural
// fact on the kernel command line the host wrote (`nessie.shares=block`),
// never a probe: a guest that guessed would mount whatever happened to exist.
//
// # BLOCK DEVICE ORDER CONTRACT
//
// Firecracker's block devices appear in the guest in the order the host
// attached them, so the host attaches runtime, workspace, draft and the guest
// reads /dev/vda, /dev/vdb, /dev/vdc in that order. The host half of this
// contract is `GUEST_BLOCK_DEVICE_ORDER` in
// executor/src/firecracker/layout.ts; changing either without the other is a
// wrong mount. Because that ordering has been an upstream bug before
// (firecracker#1264, device-tree insertion order on aarch64), each image also
// carries an ext4 label and a device whose label is not the expected one is
// refused. The order decides; the label proves.
const (
	guestRuntimeMountPoint   = "/runtime"
	guestWorkspaceMountPoint = "/work"
	guestLowerMountPoint     = "/lower"
	guestDraftMountPoint     = "/draft"
	guestDraftUpperPath      = "/draft/upper"
	guestDraftWorkPath       = "/draft/work"

	guestVirtiofsWorkspaceTag = "nessie-cow"
	guestVirtiofsRuntimeTag   = "nessie-runtime"

	ext4SuperblockOffset = 1024
	ext4MagicOffset      = 0x38
	ext4LabelOffset      = 0x78
	ext4LabelBytes       = 16
	ext4Magic            = 0xEF53
)

type guestBlockDevice struct {
	device string
	label  string
}

var guestBlockDevices = struct {
	runtime   guestBlockDevice
	workspace guestBlockDevice
	draft     guestBlockDevice
}{
	runtime:   guestBlockDevice{device: "/dev/vda", label: "nessie-runtime"},
	workspace: guestBlockDevice{device: "/dev/vdb", label: "nessie-work"},
	draft:     guestBlockDevice{device: "/dev/vdc", label: "nessie-draft"},
}

// guestShares records what a boot actually mounted. `draftRoot` is empty under
// virtiofs, where the guest writes straight through to the host's own overlay
// directory and there is nothing to stream back.
type guestShares struct {
	draftRoot         string
	workspaceAttached bool
}

func mountProc() error {
	if err := os.Mkdir("/proc", 0o555); err != nil && !os.IsExist(err) {
		return err
	}
	err := syscall.Mount("proc", "/proc", "proc", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, "")
	if err != nil && err != syscall.EBUSY {
		return err
	}
	return nil
}

// CONFIG_DEVTMPFS_MOUNT does not apply to an initramfs, so the block device
// nodes exist only once the guest mounts /dev itself.
func mountDev() error {
	if err := os.Mkdir("/dev", 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	err := syscall.Mount("devtmpfs", "/dev", "devtmpfs", syscall.MS_NOSUID|syscall.MS_NOEXEC, "")
	if err != nil && err != syscall.EBUSY {
		return err
	}
	return nil
}

// ext4Label reads the volume name straight out of the superblock. The guest has
// no blkid, no udev and no shell, and this is 16 bytes at a fixed offset.
func ext4Label(device string) (string, error) {
	file, err := os.Open(device)
	if err != nil {
		return "", err
	}
	defer file.Close()
	header := make([]byte, ext4SuperblockOffset+ext4LabelOffset+ext4LabelBytes)
	if _, err := io.ReadFull(file, header); err != nil {
		return "", err
	}
	if binary.LittleEndian.Uint16(header[ext4SuperblockOffset+ext4MagicOffset:]) != ext4Magic {
		return "", errInvalidFrame
	}
	raw := header[ext4SuperblockOffset+ext4LabelOffset : ext4SuperblockOffset+ext4LabelOffset+ext4LabelBytes]
	if end := bytes.IndexByte(raw, 0); end >= 0 {
		raw = raw[:end]
	}
	return string(raw), nil
}

func assertGuestBlockDevice(expected guestBlockDevice) (string, error) {
	label, err := ext4Label(expected.device)
	if err != nil {
		return "", err
	}
	if label != expected.label {
		return "", errInvalidFrame
	}
	return expected.device, nil
}

func mountGuestRuntime(commandLine string) error {
	if err := os.Mkdir(guestRuntimeMountPoint, 0o755); err != nil && !os.IsExist(err) {
		return err
	}
	// The runtime is the one mount that is deliberately executable: a noexec
	// runtime would make a browser, tmux or CLI impossible.
	flags := uintptr(syscall.MS_RDONLY | syscall.MS_NOSUID | syscall.MS_NODEV)
	if blockSharesRequested(commandLine) {
		device, err := assertGuestBlockDevice(guestBlockDevices.runtime)
		if err != nil {
			return err
		}
		return syscall.Mount(device, guestRuntimeMountPoint, "ext4", flags, "")
	}
	return syscall.Mount(guestVirtiofsRuntimeTag, guestRuntimeMountPoint, "virtiofs", flags, "")
}

// The workspace is writable from inside the guest and never executable, so a
// workspace edit can never become guest execution.
const guestWorkspaceMountFlags = syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC

func mountGuestWorkspaceVirtiofs() (guestShares, error) {
	if err := os.Mkdir(guestWorkspaceMountPoint, 0o700); err != nil && !os.IsExist(err) {
		return guestShares{workspaceAttached: true}, err
	}
	err := syscall.Mount(
		guestVirtiofsWorkspaceTag, guestWorkspaceMountPoint, "virtiofs", guestWorkspaceMountFlags, "")
	return guestShares{workspaceAttached: true}, err
}

// mountGuestWorkspaceBlock layers the run's read-only snapshot under a writable
// draft image. Paths inside the guest are identical to the virtiofs strategy —
// the workload only ever sees /work — but every edit lands in the draft's upper
// layer, which the host later streams back over the control channel.
//
// `userxattr` puts overlayfs's own markers in the `user.` namespace instead of
// `trusted.`, which needs CAP_SYS_ADMIN to read. That is what lets the guest
// still report an emptied directory after it has dropped privileges. It
// requires Linux 5.11 or newer; the packaged guest kernel is 6.1.
func mountGuestWorkspaceBlock() (guestShares, error) {
	attached := guestShares{workspaceAttached: true}
	lower, err := assertGuestBlockDevice(guestBlockDevices.workspace)
	if err != nil {
		return attached, err
	}
	draft, err := assertGuestBlockDevice(guestBlockDevices.draft)
	if err != nil {
		return attached, err
	}
	for _, directory := range []string{guestLowerMountPoint, guestDraftMountPoint, guestWorkspaceMountPoint} {
		if err := os.Mkdir(directory, 0o700); err != nil && !os.IsExist(err) {
			return attached, err
		}
	}
	if err := syscall.Mount(
		lower, guestLowerMountPoint, "ext4", guestWorkspaceMountFlags|syscall.MS_RDONLY, ""); err != nil {
		return attached, err
	}
	if err := syscall.Mount(draft, guestDraftMountPoint, "ext4", guestWorkspaceMountFlags, ""); err != nil {
		return attached, err
	}
	// The merged root takes its owner from the upper layer, and that owner is
	// what the guest drops privileges to. The draft image's own root carries
	// the identity the host built it with, so the overlay layers inherit it
	// rather than staying root-owned — a root-owned workspace fails boot.
	info, err := os.Stat(guestDraftMountPoint)
	if err != nil {
		return attached, err
	}
	metadata, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return attached, errInvalidFrame
	}
	for _, directory := range []string{guestDraftUpperPath, guestDraftWorkPath} {
		if err := os.Mkdir(directory, 0o700); err != nil && !os.IsExist(err) {
			return attached, err
		}
		if err := os.Chown(directory, int(metadata.Uid), int(metadata.Gid)); err != nil {
			return attached, err
		}
	}
	options := "lowerdir=" + guestLowerMountPoint +
		",upperdir=" + guestDraftUpperPath +
		",workdir=" + guestDraftWorkPath +
		",userxattr"
	if err := syscall.Mount(
		"overlay", guestWorkspaceMountPoint, "overlay", guestWorkspaceMountFlags, options); err != nil {
		return attached, err
	}
	attached.draftRoot = guestDraftUpperPath
	return attached, nil
}

// mountGuestShares performs every boot mount the host asked for, in the one
// order that works: /proc first (the command line is read from it), then the
// device nodes the block strategy needs, then the workspace, then the runtime.
func mountGuestShares(commandLine string) (guestShares, *runtimeManifest, error) {
	block := blockSharesRequested(commandLine)
	if block {
		if err := mountDev(); err != nil {
			return guestShares{}, nil, err
		}
	}
	var shares guestShares
	if workspaceRequested(commandLine) {
		var err error
		if block {
			shares, err = mountGuestWorkspaceBlock()
		} else {
			shares, err = mountGuestWorkspaceVirtiofs()
		}
		if err != nil {
			return shares, nil, err
		}
	}
	if !runtimeRequested(commandLine) {
		return shares, nil, nil
	}
	manifestDigest, ok := runtimeManifestDigest(commandLine)
	if !ok {
		return shares, nil, errInvalidFrame
	}
	if err := mountGuestRuntime(commandLine); err != nil {
		return shares, nil, err
	}
	manifest, err := verifyMountedGuestRuntime(manifestDigest)
	if err != nil {
		return shares, nil, err
	}
	return shares, &manifest, nil
}
