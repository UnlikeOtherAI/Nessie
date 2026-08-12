package main

import (
	"bytes"
	"encoding/json"
	"io"
)

const guestRuntimeControlVersion = 1

type runtimeControlRequest struct {
	Operation string `json:"operation"`
	URL       string `json:"url,omitempty"`
	Version   int    `json:"version"`
}

type runtimeInspection struct {
	Browser bool `json:"browser"`
	Claude  bool `json:"claude"`
	Codex   bool `json:"codex"`
	Tmux    bool `json:"tmux"`
}

type runtimeController struct {
	browser  *browserRuntime
	manifest *runtimeManifest
}

func newRuntimeController(manifest *runtimeManifest) *runtimeController {
	if manifest == nil {
		return nil
	}
	return &runtimeController{browser: newBrowserRuntime(manifest), manifest: manifest}
}

func (controller *runtimeController) close() {
	if controller != nil && controller.browser != nil {
		controller.browser.close()
	}
}

func decodeRuntimeControlRequest(payload []byte) (runtimeControlRequest, error) {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	var request runtimeControlRequest
	if err := decoder.Decode(&request); err != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return runtimeControlRequest{}, errInvalidFrame
	}
	if request.Version != guestRuntimeControlVersion {
		return runtimeControlRequest{}, errInvalidFrame
	}
	switch request.Operation {
	case "runtime.inspect":
		if request.URL != "" {
			return runtimeControlRequest{}, errInvalidFrame
		}
	case "browser.open":
		if !validBrowserURL(request.URL) {
			return runtimeControlRequest{}, errInvalidFrame
		}
	default:
		return runtimeControlRequest{}, errInvalidFrame
	}
	return request, nil
}

func runtimeControlUnavailable() []byte {
	return []byte(`{"code":"EXECUTOR_GUEST_CAPABILITY_UNAVAILABLE"}`)
}

func handleRuntimeControlRequest(payload []byte, controller *runtimeController) []byte {
	request, err := decodeRuntimeControlRequest(payload)
	if err != nil || controller == nil {
		return runtimeControlUnavailable()
	}
	if request.Operation == "browser.open" {
		if controller.browser == nil || controller.browser.open(request.URL) != nil {
			return runtimeControlUnavailable()
		}
		return []byte(`{"status":"started","version":1}`)
	}
	result, err := json.Marshal(struct {
		Inspection runtimeInspection `json:"inspection"`
		Version    int               `json:"version"`
	}{
		Inspection: runtimeInspection{
			Browser: controller.manifest.Entrypoints["browser"] != "",
			Claude:  controller.manifest.Entrypoints["claude"] != "",
			Codex:   controller.manifest.Entrypoints["codex"] != "",
			Tmux:    controller.manifest.Entrypoints["tmux"] != "",
		},
		Version: guestRuntimeControlVersion,
	})
	if err != nil {
		return runtimeControlUnavailable()
	}
	return result
}
