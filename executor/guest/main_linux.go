//go:build linux

package main

import (
	"crypto/rand"
	"fmt"
	"net"
	"os"
	"syscall"
	"unsafe"
)

const (
	bootstrapTokenPath = "/etc/nessie/bootstrap-token"
	guestControlPort   = 49_152
	vmaddrCIDHost      = 2
	// Linux UAPI `AF_VSOCK`, which is 0x28 on every architecture: it is a
	// socket family in include/linux/socket.h, not an arch-specific number.
	// Go's syscall package only generates the constant for some targets — it
	// is absent on linux/amd64 — so the guest declares it once here rather
	// than growing a per-architecture file that would say the same thing.
	afVSock = 0x28
)

type sockaddrVM struct {
	Family    uint16
	Reserved1 uint16
	Port      uint32
	CID       uint32
	Flags     uint8
	Zero      [3]uint8
}

func connectGuestControl() (*os.File, error) {
	return connectGuestVirtioPort(guestControlPort, "nessie-guest-control")
}

func connectGuestEgress() (*os.File, error) {
	return connectGuestVirtioPort(guestEgressPort, "nessie-guest-egress")
}

func connectGuestVirtioPort(port uint32, name string) (*os.File, error) {
	descriptor, err := syscall.Socket(afVSock, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, err
	}
	address := sockaddrVM{Family: afVSock, Port: port, CID: vmaddrCIDHost}
	_, _, errno := syscall.Syscall(
		syscall.SYS_CONNECT,
		uintptr(descriptor),
		uintptr(unsafe.Pointer(&address)),
		unsafe.Sizeof(address),
	)
	if errno != 0 {
		_ = syscall.Close(descriptor)
		return nil, errno
	}
	return os.NewFile(uintptr(descriptor), name), nil
}

func dialGuestEgress() (net.Conn, error) {
	file, err := connectGuestEgress()
	if err != nil {
		return nil, err
	}
	connection, err := net.FileConn(file)
	closeErr := file.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		_ = connection.Close()
		return nil, closeErr
	}
	return connection, nil
}

func readBootstrapToken() ([]byte, error) {
	token, err := os.ReadFile(bootstrapTokenPath)
	if err != nil || !validBootstrapToken(string(token)) {
		return nil, errInvalidFrame
	}
	if err := os.Remove(bootstrapTokenPath); err != nil {
		return nil, err
	}
	return token, nil
}

func mountProc() error {
	if err := os.Mkdir("/proc", 0o555); err != nil && !os.IsExist(err) {
		return err
	}
	if err := syscall.Mount("proc", "/proc", "proc", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, ""); err != nil && err != syscall.EBUSY {
		return err
	}
	return nil
}

func mountGuestWorkspaceIfRequested() (bool, error) {
	if err := mountProc(); err != nil {
		return false, err
	}
	commandLine, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return false, err
	}
	if !workspaceRequested(string(commandLine)) {
		return false, nil
	}
	if err := os.Mkdir("/work", 0o700); err != nil && !os.IsExist(err) {
		return true, err
	}
	return true, syscall.Mount("nessie-cow", "/work", "virtiofs", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, "")
}

func mountGuestRuntimeIfRequested() (*runtimeManifest, error) {
	commandLine, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return nil, err
	}
	if !runtimeRequested(string(commandLine)) {
		return nil, nil
	}
	manifestDigest, ok := runtimeManifestDigest(string(commandLine))
	if !ok {
		return nil, errInvalidFrame
	}
	if err := os.Mkdir("/runtime", 0o755); err != nil && !os.IsExist(err) {
		return nil, err
	}
	if err := syscall.Mount("nessie-runtime", "/runtime", "virtiofs", syscall.MS_RDONLY|syscall.MS_NOSUID|syscall.MS_NODEV, ""); err != nil {
		return nil, err
	}
	manifest, err := verifyMountedGuestRuntime(manifestDigest)
	if err != nil {
		return nil, err
	}
	return &manifest, nil
}

func main() {
	if len(os.Args) >= 2 && os.Args[1] == codingConformanceProbeArgument {
		os.Exit(runCodingConformanceProbe(os.Args[2:]))
	}
	if len(os.Args) >= 2 && os.Args[1] == commandSandboxRunnerArgument {
		os.Exit(runCommandSandboxRunner(os.Args[2:]))
	}
	if len(os.Args) >= 2 && os.Args[1] == commandConformanceProbeArgument {
		os.Exit(runCommandConformanceProbe(os.Args[2:]))
	}
	workspaceAttached, err := mountGuestWorkspaceIfRequested()
	if err != nil {
		os.Exit(1)
	}
	runtimeManifest, err := mountGuestRuntimeIfRequested()
	if err != nil {
		os.Exit(1)
	}
	identity, err := guestIdentityForWorkspace(workspaceAttached)
	if err != nil {
		os.Exit(1)
	}
	runtimeController := newRuntimeController(runtimeManifest)
	defer runtimeController.close()
	if runtimeController != nil {
		if runtimeController.coding != nil && prepareCodingRuntime(identity) != nil {
			os.Exit(1)
		}
		if runtimeController.coding == nil && runtimeController.command != nil && prepareCommandRuntime(identity) != nil {
			os.Exit(1)
		}
	}
	token, err := readBootstrapToken()
	if err != nil {
		os.Exit(1)
	}
	if err := dropGuestPrivilegesTo(identity); err != nil {
		clearBytes(token)
		os.Exit(1)
	}
	requestID, err := newRequestID()
	if err != nil {
		clearBytes(token)
		os.Exit(1)
	}
	connection, err := connectGuestControl()
	if err != nil {
		clearBytes(token)
		os.Exit(1)
	}
	defer connection.Close()
	if egressRequestedFromProc() {
		egressToken, err := deriveEgressToken(string(token))
		if err != nil {
			clearBytes(token)
			os.Exit(1)
		}
		// The listener is live before hello makes the host session ready. The
		// Codex conformance probe can therefore distinguish a policy denial
		// from a merely absent loopback service.
		if _, err := startGuestEgressProxy(guestEgressProxyAddress, egressToken, dialGuestEgress); err != nil {
			clearBytes(token)
			os.Exit(1)
		}
	}
	if err := writeControlFrame(connection, controlEnvelope{
		Kind:         "hello",
		Payload:      []byte{},
		RequestID:    requestID,
		SessionToken: string(token),
		Version:      guestControlVersion,
	}); err != nil {
		clearBytes(token)
		os.Exit(1)
	}
	clearBytes(token)

	for {
		request, err := readControlFrame(connection)
		if err != nil || request.Kind == "close" {
			return
		}
		if request.Kind != "request" {
			return
		}
		if err := writeControlFrame(connection, controlEnvelope{
			Kind:      "response",
			Payload:   handleRuntimeControlRequest(request.Payload, runtimeController),
			RequestID: request.RequestID,
			Version:   guestControlVersion,
		}); err != nil {
			return
		}
	}
}

func clearBytes(value []byte) {
	for index := range value {
		value[index] = 0
	}
}

func newRequestID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf(
		"%08x-%04x-%04x-%04x-%012x",
		bytes[0:4],
		bytes[4:6],
		bytes[6:8],
		bytes[8:10],
		bytes[10:16],
	), nil
}
