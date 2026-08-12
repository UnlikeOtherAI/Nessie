package main

import (
	"bytes"
	"encoding/json"
	"io"
)

const guestRuntimeControlVersion = 1

type runtimeControlRequest struct {
	Operation string `json:"operation"`
	Agent     string `json:"agent,omitempty"`
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
	coding   *codingRuntime
	manifest *runtimeManifest
}

func newRuntimeController(manifest *runtimeManifest) *runtimeController {
	if manifest == nil {
		return nil
	}
	return &runtimeController{browser: newBrowserRuntime(manifest), coding: newCodingRuntime(manifest), manifest: manifest}
}

func (controller *runtimeController) close() {
	if controller != nil && controller.browser != nil {
		controller.browser.close()
	}
	if controller != nil && controller.coding != nil {
		controller.coding.shutdown()
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
	case "runtime.inspect", "browser.observe", "coding.observe", "coding.close":
		if request.URL != "" || request.Agent != "" {
			return runtimeControlRequest{}, errInvalidFrame
		}
	case "browser.open":
		if request.Agent != "" || !validBrowserURL(request.URL) {
			return runtimeControlRequest{}, errInvalidFrame
		}
	case "coding.launch":
		if request.URL != "" || !validCodingAgent(codingAgent(request.Agent)) {
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
	if request.Operation == "browser.observe" {
		if controller.browser == nil {
			return runtimeControlUnavailable()
		}
		observation, err := controller.browser.observation()
		if err != nil {
			return runtimeControlUnavailable()
		}
		result, err := json.Marshal(struct {
			Observation browserObservation `json:"observation"`
			Version     int                `json:"version"`
		}{Observation: observation, Version: guestRuntimeControlVersion})
		if err != nil {
			return runtimeControlUnavailable()
		}
		return result
	}
	if request.Operation == "coding.launch" {
		if controller.coding == nil || controller.coding.launch(codingAgent(request.Agent)) != nil {
			return runtimeControlUnavailable()
		}
		result, err := json.Marshal(struct {
			Agent   codingAgent `json:"agent"`
			Status  string      `json:"status"`
			Version int         `json:"version"`
		}{Agent: codingAgent(request.Agent), Status: "started", Version: guestRuntimeControlVersion})
		if err != nil {
			return runtimeControlUnavailable()
		}
		return result
	}
	if request.Operation == "coding.observe" {
		if controller.coding == nil {
			return runtimeControlUnavailable()
		}
		observation, err := controller.coding.observation()
		if err != nil {
			return runtimeControlUnavailable()
		}
		result, err := json.Marshal(struct {
			Observation codingObservation `json:"observation"`
			Version     int               `json:"version"`
		}{Observation: observation, Version: guestRuntimeControlVersion})
		if err != nil {
			return runtimeControlUnavailable()
		}
		return result
	}
	if request.Operation == "coding.close" {
		if controller.coding == nil || controller.coding.close() != nil {
			return runtimeControlUnavailable()
		}
		return []byte(`{"status":"closed","version":1}`)
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
