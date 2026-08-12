//go:build linux && arm64

package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

const (
	bootstrapTokenPath = "/etc/nessie/bootstrap-token"
	guestControlPort  = 49_152
	vmaddrCIDHost     = 2
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
	descriptor, err := syscall.Socket(syscall.AF_VSOCK, syscall.SOCK_STREAM, 0)
	if err != nil {
		return nil, err
	}
	address := sockaddrVM{Family: syscall.AF_VSOCK, Port: guestControlPort, CID: vmaddrCIDHost}
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
	return os.NewFile(uintptr(descriptor), "nessie-guest-control"), nil
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

func main() {
	token, err := readBootstrapToken()
	if err != nil {
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
