package main

import (
	"bytes"
	"encoding/json"
	"io"
)

const guestRuntimeControlVersion = 1

type runtimeControlRequest struct {
	Operation string `json:"operation"`
	Version   int    `json:"version"`
}

type runtimeInspection struct {
	Browser bool `json:"browser"`
	Claude  bool `json:"claude"`
	Codex   bool `json:"codex"`
	Tmux    bool `json:"tmux"`
}

func decodeRuntimeControlRequest(payload []byte) (runtimeControlRequest, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var request runtimeControlRequest
	if err := decoder.Decode(&request); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return runtimeControlRequest{}, errInvalidFrame
	}
	if request.Version != guestRuntimeControlVersion || request.Operation != "runtime.inspect" {
		return runtimeControlRequest{}, errInvalidFrame
	}
	return request, nil
}

func handleRuntimeControlRequest(payload []byte, manifest *runtimeManifest) []byte {
	if _, err := decodeRuntimeControlRequest(payload); err != nil || manifest == nil {
		return []byte(`{"code":"EXECUTOR_GUEST_CAPABILITY_UNAVAILABLE"}`)
	}
	result, err := json.Marshal(struct {
		Inspection runtimeInspection `json:"inspection"`
		Version    int               `json:"version"`
	}{
		Inspection: runtimeInspection{
			Browser: manifest.Entrypoints["browser"] != "",
			Claude:  manifest.Entrypoints["claude"] != "",
			Codex:   manifest.Entrypoints["codex"] != "",
			Tmux:    manifest.Entrypoints["tmux"] != "",
		},
		Version: guestRuntimeControlVersion,
	})
	if err != nil {
		return []byte(`{"code":"EXECUTOR_GUEST_CAPABILITY_UNAVAILABLE"}`)
	}
	return result
}
