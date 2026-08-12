package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
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

func TestRuntimeMustBeExplicitlyRequestedByTheHostBootCommand(t *testing.T) {
	if !runtimeRequested("console=hvc0 rdinit=/init nessie.runtime=1") {
		t.Fatal("expected explicit runtime command-line flag")
	}
	if runtimeRequested("console=hvc0 rdinit=/init nessie.runtime=10") {
		t.Fatal("accepted a lookalike runtime command-line flag")
	}
}

func TestGuestRuntimeRechecksTheMountedManifestAndEveryFile(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	browser := []byte("browser")
	if err := os.WriteFile(filepath.Join(root, "bin", "browser"), browser, 0o700); err != nil {
		t.Fatal(err)
	}
	fileHash := sha256.Sum256(browser)
	manifest := []byte(`{"entrypoints":{"browser":"bin/browser"},"files":[{"executable":true,"path":"bin/browser","sha256":"` + hex.EncodeToString(fileHash[:]) + `"}],"version":1}`)
	if err := os.WriteFile(filepath.Join(root, "nessie-guest-runtime.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	manifestHash := sha256.Sum256(manifest)
	digest := "sha256:" + hex.EncodeToString(manifestHash[:])
	if err := verifyGuestRuntime(root, digest); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "browser"), []byte("tampered"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := verifyGuestRuntime(root, digest); err == nil {
		t.Fatal("accepted a changed mounted runtime file")
	}
	if err := os.WriteFile(filepath.Join(root, "bin", "browser"), browser, 0o700); err != nil {
		t.Fatal(err)
	}
	unknownEntrypoint := []byte(`{"entrypoints":{"browser":"bin/browser","hidden":"bin/browser"},"files":[{"executable":true,"path":"bin/browser","sha256":"` + hex.EncodeToString(fileHash[:]) + `"}],"version":1}`)
	if err := os.WriteFile(filepath.Join(root, "nessie-guest-runtime.json"), unknownEntrypoint, 0o600); err != nil {
		t.Fatal(err)
	}
	unknownHash := sha256.Sum256(unknownEntrypoint)
	if err := verifyGuestRuntime(root, "sha256:"+hex.EncodeToString(unknownHash[:])); err == nil {
		t.Fatal("accepted an unknown runtime entrypoint")
	}
}

func TestGuestRuntimeInspectionExposesOnlyDeclaredCapabilityNames(t *testing.T) {
	manifest := runtimeManifest{Entrypoints: map[string]string{
		"browser": "bin/browser",
		"codex":   "bin/codex",
		"tmux":    "bin/tmux",
	}}
	payload := []byte(`{"operation":"runtime.inspect","version":1}`)
	response := handleRuntimeControlRequest(payload, &manifest)
	var decoded struct {
		Inspection runtimeInspection `json:"inspection"`
		Version    int               `json:"version"`
	}
	if err := json.Unmarshal(response, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Version != guestRuntimeControlVersion || !decoded.Inspection.Browser || !decoded.Inspection.Codex || !decoded.Inspection.Tmux || decoded.Inspection.Claude {
		t.Fatalf("unexpected runtime inspection %#v", decoded)
	}
	if !bytes.Contains(handleRuntimeControlRequest([]byte(`{"operation":"browser.open","version":1}`), &manifest), []byte("CAPABILITY_UNAVAILABLE")) {
		t.Fatal("accepted an unimplemented runtime operation")
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
