package main

import (
	"bytes"
	"testing"
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
