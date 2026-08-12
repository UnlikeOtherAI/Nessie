package main

import (
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestCodingRuntimePinsClaudeSettingsAndSessionProof(t *testing.T) {
	root := t.TempDir()
	profile := filepath.Join(root, ".nessie-executor", "coding", "claude")
	var actualArgs, actualEnvironment []string
	runtime := &codingRuntime{
		agentExecutables: map[codingAgent]string{codingAgentClaude: "/runtime/bin/claude"},
		profileRoot:      root,
		run: func(_ string, args, environment []string) ([]byte, error) {
			actualArgs = append([]string{}, args...)
			actualEnvironment = append([]string{}, environment...)
			return nil, nil
		},
		sessionProof: testBootstrapToken,
		socket:       filepath.Join(root, "tmux.sock"),
		tmux:         "/runtime/bin/tmux",
	}
	if err := runtime.launch(codingAgentClaude); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actualArgs, []string{
		"-f", codingConfigPath,
		"-S", runtime.socket,
		"new-session", "-d", "-s", codingSessionName, "--",
		"/runtime/bin/claude", "--settings", codingClaudeSettingsPath,
	}) {
		t.Fatalf("unexpected Claude launch %#v", actualArgs)
	}
	if !reflect.DeepEqual(actualEnvironment, codingEnvironment(codingAgentClaude, profile, testBootstrapToken)) {
		t.Fatalf("unexpected Claude environment %#v", actualEnvironment)
	}
	if strings.Contains(strings.Join(actualEnvironment, "\x00"), "ANTHROPIC_API_KEY=") {
		t.Fatal("Claude launch received a raw provider key")
	}
	if !strings.Contains(codingCodexConfig, "command = \"/init\"") || strings.Contains(codingCodexConfig, testBootstrapToken) {
		t.Fatal("Codex configuration did not use the fixed credential helper")
	}
	if codingClaudeSettings != "{\"apiKeyHelper\":\"/init --coding-credential\"}\n" {
		t.Fatal("Claude settings are not the fixed credential helper")
	}
}

func TestCodingRuntimeRequiresAnInjectedSessionProof(t *testing.T) {
	manifest := &runtimeManifest{Entrypoints: map[string]string{
		"codex": "bin/codex",
		"tmux":  "bin/tmux",
	}}
	if newCodingRuntime(manifest, "") != nil {
		t.Fatal("coding runtime accepted a missing session proof")
	}
}
