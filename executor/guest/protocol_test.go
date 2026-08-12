package main

import (
	"bytes"
	"io"
	"net"
	"testing"
	"time"
)

const testBootstrapToken = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func TestBootstrapTokenIsCanonical32ByteBase64URL(t *testing.T) {
	if !validBootstrapToken(testBootstrapToken) {
		t.Fatal("expected canonical token to validate")
	}
	if validBootstrapToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
		t.Fatal("accepted a non-canonical base64url token")
	}
}

func TestControlFramesRoundTripWithoutUnknownFields(t *testing.T) {
	original := controlEnvelope{
		Kind:      "request",
		Payload:   []byte(`{"operation":"bootstrap"}`),
		RequestID: "ab7ae325-8420-4b2a-9cee-20b07066a77d",
		Version:   guestControlVersion,
	}
	var wire bytes.Buffer
	if err := writeControlFrame(&wire, original); err != nil {
		t.Fatal(err)
	}
	actual, err := readControlFrame(&wire)
	if err != nil {
		t.Fatal(err)
	}
	if actual.Kind != original.Kind || actual.RequestID != original.RequestID || !bytes.Equal(actual.Payload, original.Payload) {
		t.Fatal("frame round trip changed control data")
	}
}

func TestControlFrameRejectsGuestTokenReuse(t *testing.T) {
	var wire bytes.Buffer
	if err := writeControlFrame(&wire, controlEnvelope{
		Kind:         "request",
		Payload:      []byte{},
		RequestID:    "ab7ae325-8420-4b2a-9cee-20b07066a77d",
		SessionToken: testBootstrapToken,
		Version:      guestControlVersion,
	}); err == nil {
		t.Fatal("accepted a bootstrap token on a normal request")
	}
}

func TestWorkspaceMustBeExplicitlyRequestedByTheHostBootCommand(t *testing.T) {
	if !workspaceRequested("console=hvc0 rdinit=/init nessie.workspace=1") {
		t.Fatal("expected explicit workspace command-line flag")
	}
	if workspaceRequested("console=hvc0 rdinit=/init nessie.workspace=10") {
		t.Fatal("accepted a lookalike workspace command-line flag")
	}
}

func TestEgressMustBeExplicitlyRequestedByTheHostBootCommand(t *testing.T) {
	if !egressRequested("console=hvc0 rdinit=/init nessie.egress=1") {
		t.Fatal("expected explicit egress command-line flag")
	}
	if egressRequested("console=hvc0 rdinit=/init nessie.egress=10") {
		t.Fatal("accepted a lookalike egress command-line flag")
	}
}

func TestGuestDropsToTheCOWOwnerOrAnUnprivilegedFallback(t *testing.T) {
	withoutWorkspace, err := selectGuestIdentity(false, 0, 0)
	if err != nil || withoutWorkspace.userID != guestFallbackID || withoutWorkspace.groupID != guestFallbackID {
		t.Fatal("guest without a workspace must use the unprivileged fallback identity")
	}
	withWorkspace, err := selectGuestIdentity(true, 501, 20)
	if err != nil || withWorkspace.userID != 501 || withWorkspace.groupID != 20 {
		t.Fatal("guest must use the mounted COW owner identity")
	}
	if _, err := selectGuestIdentity(true, 0, 20); err == nil {
		t.Fatal("guest must refuse a root-owned COW workspace identity")
	}
}

func TestEgressTokenIsDistinctAndStableForOneKnownBootstrapToken(t *testing.T) {
	egress, err := deriveEgressToken(testBootstrapToken)
	if err != nil {
		t.Fatal(err)
	}
	if egress != "AN43IKRZz4QAd6L6iE-D9mklr0Pm6SEq9jiiB9PAVPo" {
		t.Fatalf("unexpected egress token %q", egress)
	}
	if egress == testBootstrapToken {
		t.Fatal("egress token reused the bootstrap token")
	}
}

func TestEgressPreludeHasNoBootstrapCredentialOrControlFields(t *testing.T) {
	egress, err := deriveEgressToken(testBootstrapToken)
	if err != nil {
		t.Fatal(err)
	}
	var wire bytes.Buffer
	if err := writeGuestEgressPrelude(&wire, egress); err != nil {
		t.Fatal(err)
	}
	expected := append([]byte{'N', 'E', 'X', 'G', 1}, []byte(egress)...)
	if !bytes.Equal(wire.Bytes(), expected) || wire.Len() != guestEgressPreludeN {
		t.Fatalf("unexpected egress prelude %q", wire.Bytes())
	}
	if bytes.Contains(wire.Bytes(), []byte(testBootstrapToken)) {
		t.Fatal("egress prelude leaked the bootstrap token")
	}
}

func TestGuestEgressProxyForwardsOnlyThroughAnAuthenticatedTunnel(t *testing.T) {
	egress, err := deriveEgressToken(testBootstrapToken)
	if err != nil {
		t.Fatal(err)
	}
	upstream, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	received := make(chan []byte, 1)
	request := []byte("CONNECT app.example:443 HTTP/1.1\r\n\r\n")
	response := []byte("HTTP/1.1 200 Connection Established\r\n\r\n")
	go func() {
		connection, acceptErr := upstream.Accept()
		if acceptErr != nil {
			return
		}
		defer connection.Close()
		prelude := make([]byte, guestEgressPreludeN)
		if _, readErr := io.ReadFull(connection, prelude); readErr != nil {
			return
		}
		actualRequest := make([]byte, len(request))
		if _, readErr := io.ReadFull(connection, actualRequest); readErr != nil {
			return
		}
		received <- append(prelude, actualRequest...)
		_, _ = connection.Write(response)
	}()

	proxy, err := startGuestEgressProxy("127.0.0.1:0", egress, func() (net.Conn, error) {
		return net.Dial("tcp4", upstream.Addr().String())
	})
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	client, err := net.Dial("tcp4", proxy.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.Write(request); err != nil {
		client.Close()
		t.Fatal(err)
	}
	actualResponse := make([]byte, len(response))
	if _, err := io.ReadFull(client, actualResponse); err != nil {
		client.Close()
		t.Fatal(err)
	}
	if !bytes.Equal(actualResponse, response) {
		client.Close()
		t.Fatalf("unexpected proxy response %q", actualResponse)
	}
	_ = client.Close()

	select {
	case actual := <-received:
		expectedPrelude, preludeErr := preludeForTest(egress)
		if preludeErr != nil {
			t.Fatal(preludeErr)
		}
		if !bytes.Equal(actual, append(expectedPrelude, request...)) {
			t.Fatalf("proxy did not forward the authenticated tunnel stream: %q", actual)
		}
	case <-time.After(time.Second):
		t.Fatal("proxy did not reach the authenticated tunnel")
	}
}

func preludeForTest(sessionToken string) ([]byte, error) {
	var prelude bytes.Buffer
	if err := writeGuestEgressPrelude(&prelude, sessionToken); err != nil {
		return nil, err
	}
	return prelude.Bytes(), nil
}
