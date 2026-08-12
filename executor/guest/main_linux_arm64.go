//go:build linux && arm64

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
	descriptor, err := syscall.Socket(syscall.AF_VSOCK, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, err
	}
	address := sockaddrVM{Family: syscall.AF_VSOCK, Port: port, CID: vmaddrCIDHost}
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

func mountGuestRuntimeIfRequested() (bool, error) {
	commandLine, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		return false, err
	}
	if !runtimeRequested(string(commandLine)) {
		return false, nil
	}
	if err := os.Mkdir("/runtime", 0o755); err != nil && !os.IsExist(err) {
		return true, err
	}
	return true, syscall.Mount("nessie-runtime", "/runtime", "virtiofs", syscall.MS_RDONLY|syscall.MS_NOSUID|syscall.MS_NODEV, "")
}

func main() {
	workspaceAttached, err := mountGuestWorkspaceIfRequested()
	if err != nil {
		os.Exit(1)
	}
	if _, err := mountGuestRuntimeIfRequested(); err != nil {
		os.Exit(1)
	}
	token, err := readBootstrapToken()
	if err != nil {
		os.Exit(1)
	}
	if err := dropGuestPrivileges(workspaceAttached); err != nil {
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
	if egressRequestedFromProc() {
		egressToken, err := deriveEgressToken(string(token))
		if err != nil {
			clearBytes(token)
			os.Exit(1)
		}
		if _, err := startGuestEgressProxy(guestEgressProxyAddress, egressToken, dialGuestEgress); err != nil {
			clearBytes(token)
			os.Exit(1)
		}
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
			Payload:   []byte(`{"code":"EXECUTOR_GUEST_CAPABILITY_UNAVAILABLE"}`),
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
