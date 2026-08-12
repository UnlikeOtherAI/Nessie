package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	codingConfigPath    = "/run/nessie-executor/tmux.conf"
	codingProfileRoot   = "/work"
	codingSessionName   = "nessie"
	codingSocketPath    = "/run/nessie-executor/tmux/session.sock"
	codingSessionTarget = "=nessie"
	codingTarget        = "=nessie:0.0"
	// Eight KiB keeps the worst-case JSON representation below the 64 KiB
	// authenticated guest-control frame cap, even when JSON must escape every
	// returned character.
	maxCodingObserveBytes = 8_192
	codingCommandTimeout  = 5 * time.Second
)

type codingAgent string

const (
	codingAgentClaude codingAgent = "claude"
	codingAgentCodex  codingAgent = "codex"
)

type codingObservation struct {
	Agent      codingAgent `json:"agent"`
	ExitStatus *int        `json:"exitStatus,omitempty"`
	Lifecycle  string      `json:"lifecycle"`
	Output     string      `json:"output"`
}

type codingCommandRunner func(path string, args, environment []string) ([]byte, error)

type codingRuntime struct {
	agentExecutables map[codingAgent]string
	agent            codingAgent
	environment      []string
	launched         bool
	mu               sync.Mutex
	run              codingCommandRunner
	socket           string
	tmux             string
	profileRoot      string
}

func newCodingRuntime(manifest *runtimeManifest) *codingRuntime {
	if manifest == nil || manifest.Entrypoints["tmux"] == "" {
		return nil
	}
	agents := map[codingAgent]string{}
	if entrypoint := manifest.Entrypoints["codex"]; entrypoint != "" {
		agents[codingAgentCodex] = filepath.Join("/runtime", filepath.FromSlash(entrypoint))
	}
	if entrypoint := manifest.Entrypoints["claude"]; entrypoint != "" {
		agents[codingAgentClaude] = filepath.Join("/runtime", filepath.FromSlash(entrypoint))
	}
	if len(agents) == 0 {
		return nil
	}
	return &codingRuntime{
		agentExecutables: agents,
		run:              runCodingCommand,
		socket:           codingSocketPath,
		tmux:             filepath.Join("/runtime", filepath.FromSlash(manifest.Entrypoints["tmux"])),
		profileRoot:      codingProfileRoot,
	}
}

func validCodingAgent(value codingAgent) bool {
	return value == codingAgentClaude || value == codingAgentCodex
}

func (runtime *codingRuntime) launch(agent codingAgent) error {
	if !validCodingAgent(agent) {
		return errInvalidFrame
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.launched || runtime.agentExecutables[agent] == "" || runtime.socketExists() {
		return errInvalidFrame
	}
	profile := filepath.Join(runtime.profileRoot, ".nessie-executor", "coding", string(agent))
	if err := secureBrowserProfile(runtime.profileRoot, profile); err != nil {
		return err
	}
	environment := codingEnvironment(agent, profile)
	if _, err := runtime.invoke([]string{
		"-f", codingConfigPath,
		"-S", runtime.socket,
		"new-session", "-d", "-s", codingSessionName, "--",
		runtime.agentExecutables[agent],
	}, environment); err != nil {
		return err
	}
	runtime.launched = true
	runtime.agent = agent
	runtime.environment = environment
	return nil
}

func (runtime *codingRuntime) observation() (codingObservation, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if !runtime.launched {
		return codingObservation{}, errInvalidFrame
	}
	lifecycle, exitStatus, err := runtime.lifecycle()
	if err != nil {
		return codingObservation{}, err
	}
	output, err := runtime.invoke([]string{
		"-S", runtime.socket,
		"capture-pane", "-p", "-t", codingTarget, "-S", "-200",
	}, runtime.environment)
	if err != nil {
		return codingObservation{}, err
	}
	clean, ok := sanitizeCodingOutput(output)
	if !ok {
		return codingObservation{}, errInvalidFrame
	}
	return codingObservation{Agent: runtime.agent, ExitStatus: exitStatus, Lifecycle: lifecycle, Output: clean}, nil
}

func (runtime *codingRuntime) close() error {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if !runtime.launched {
		return errInvalidFrame
	}
	if _, err := runtime.invoke([]string{"-S", runtime.socket, "kill-session", "-t", codingSessionTarget}, runtime.environment); err != nil {
		return err
	}
	runtime.launched = false
	runtime.agent = ""
	runtime.environment = nil
	return nil
}

func (runtime *codingRuntime) shutdown() {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.launched {
		_, _ = runtime.invoke([]string{"-S", runtime.socket, "kill-session", "-t", codingSessionTarget}, runtime.environment)
	}
	runtime.launched = false
	runtime.agent = ""
	runtime.environment = nil
}

func (runtime *codingRuntime) lifecycle() (string, *int, error) {
	output, err := runtime.invoke([]string{
		"-S", runtime.socket,
		"display-message", "-p", "-t", codingTarget, "#{pane_dead}\t#{pane_dead_status}",
	}, runtime.environment)
	if err != nil {
		return "", nil, err
	}
	parts := strings.Split(strings.TrimSuffix(string(output), "\n"), "\t")
	if len(parts) != 2 || (parts[0] != "0" && parts[0] != "1") {
		return "", nil, errInvalidFrame
	}
	if parts[0] == "0" {
		if parts[1] != "" {
			return "", nil, errInvalidFrame
		}
		return "running", nil, nil
	}
	status, ok := parseCodingExitStatus(parts[1])
	if !ok {
		return "", nil, errInvalidFrame
	}
	return "exited", &status, nil
}

func parseCodingExitStatus(value string) (int, bool) {
	if value == "" || len(value) > 3 {
		return 0, false
	}
	status := 0
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, false
		}
		status = status*10 + int(character-'0')
	}
	return status, status <= 255
}

func (runtime *codingRuntime) socketExists() bool {
	_, err := os.Lstat(runtime.socket)
	return err == nil || !errors.Is(err, os.ErrNotExist)
}

func (runtime *codingRuntime) invoke(args, environment []string) ([]byte, error) {
	if len(args) == 0 || runtime.run == nil {
		return nil, errInvalidFrame
	}
	return runtime.run(runtime.tmux, args, environment)
}

func codingEnvironment(agent codingAgent, profile string) []string {
	environment := []string{"HOME=" + profile, "TMPDIR=" + profile}
	if agent == codingAgentCodex {
		return append(environment, "CODEX_HOME="+filepath.Join(profile, "state"))
	}
	return append(environment, "CLAUDE_CONFIG_DIR="+filepath.Join(profile, "state"))
}

func runCodingCommand(path string, args, environment []string) ([]byte, error) {
	commandContext, cancel := context.WithTimeout(context.Background(), codingCommandTimeout)
	defer cancel()
	command := exec.CommandContext(commandContext, path, args...)
	command.Dir = "/work"
	if environment != nil {
		command.Env = environment
	}
	output := &boundedCodingOutput{maximum: maxCodingObserveBytes}
	command.Stdout = output
	command.Stderr = output
	err := command.Run()
	if commandContext.Err() != nil || output.overflowed || err != nil {
		return nil, errInvalidFrame
	}
	return output.Bytes(), nil
}

type boundedCodingOutput struct {
	bytes.Buffer
	maximum    int
	overflowed bool
}

func (output *boundedCodingOutput) Write(value []byte) (int, error) {
	if output.Len()+len(value) > output.maximum {
		output.overflowed = true
		return 0, errInvalidFrame
	}
	return output.Buffer.Write(value)
}

func sanitizeCodingOutput(output []byte) (string, bool) {
	if len(output) > maxCodingObserveBytes || !utf8.Valid(output) {
		return "", false
	}
	for _, character := range string(output) {
		if character == '\n' || character == '\t' {
			continue
		}
		if character < 0x20 || character == 0x7f || character == 0x1b {
			return "", false
		}
	}
	return strings.TrimSuffix(string(output), "\n"), true
}
